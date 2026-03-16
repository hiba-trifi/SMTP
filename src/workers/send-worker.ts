import { Pool, PoolClient } from 'pg';
import { config } from '../config/env';
import { mailboxes } from '../config/mailboxes';
import { EmailJob, MailboxConfig, MailboxState, BounceClassification } from '../types';
import { sendEmail, closeAllTransporters } from '../services/mailer';
import { classifyBounce } from '../services/bounce-classifier';
import { getNextAttemptAt } from '../services/retry-policy';
import { bodyToMultipart } from '../services/template-engine';
import {
  claimMailbox,
  recordSendSuccess,
  recordHardFailure,
  recordSoftFailure,
  pauseMailbox,
  checkHealthAndPause,
} from '../services/mailbox-router';
import { logger } from '../utils/logger';
import { onShutdown, isShuttingDown } from '../utils/shutdown';

/* ── Credential lookup ─────────────────────────────────────── */

const credentialMap = new Map<string, MailboxConfig>();
for (const mb of mailboxes) {
  credentialMap.set(mb.email, mb);
}

/* ── Health check state ────────────────────────────────────── */

let cycleCount = 0;
let totalProcessed = 0;
let totalErrors = 0;
const startedAt = new Date();

/* ── Entry point ───────────────────────────────────────────── */

export async function startWorker(pool: Pool): Promise<void> {
  logger.info('Worker starting', {
    workerId: config.workerId,
    pollMs: config.pollIntervalMs,
    throttleMs: config.mailboxThrottleMs,
    dryRun: config.dryRun,
  });

  onShutdown(async () => {
    logger.info('Worker shutting down…', {
      cycleCount,
      totalProcessed,
      totalErrors,
    });
    closeAllTransporters();
    await pool.end();
  });

  // Recover stale locks on startup
  await recoverStaleLocks(pool);

  while (!isShuttingDown()) {
    try {
      cycleCount++;
      const processed = await processCycle(pool);

      // Periodic health log every 20 cycles
      if (cycleCount % 20 === 0) {
        logHealthCheck(pool);
      }

      if (processed === 0) {
        await sleep(config.pollIntervalMs);
      }
    } catch (err) {
      totalErrors++;
      logger.error('Worker cycle error', { error: (err as Error).message });
      await sleep(config.pollIntervalMs);
    }
  }
}

/* ── Health check logging ──────────────────────────────────── */

function logHealthCheck(pool: Pool): void {
  const uptimeMs = Date.now() - startedAt.getTime();
  const uptimeMin = Math.round(uptimeMs / 60_000);
  logger.info('Worker health check', {
    workerId: config.workerId,
    uptimeMinutes: uptimeMin,
    cycles: cycleCount,
    totalProcessed,
    totalErrors,
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  });
}

/* ── Stale lock recovery ───────────────────────────────────── */

export async function recoverStaleLocks(pool: Pool): Promise<number> {
  const lockTimeout = `${config.lockTimeoutMinutes} minutes`;
  const result = await pool.query(
    `UPDATE email_jobs
     SET status = 'pending',
         locked_by = NULL,
         locked_at = NULL,
         updated_at = NOW()
     WHERE status = 'sending'
       AND locked_at < NOW() - $1::interval
     RETURNING id`,
    [lockTimeout],
  );

  if (result.rows.length > 0) {
    logger.warn('Recovered stale locks', {
      count: result.rows.length,
      jobIds: result.rows.map((r: { id: number }) => r.id),
    });
  }

  return result.rows.length;
}

/* ── Cycle: claim as many mailbox+job pairs as possible ───── */

async function processCycle(pool: Pool): Promise<number> {
  let processed = 0;

  while (!isShuttingDown()) {
    const handled = await claimAndSendOne(pool);
    if (!handled) break;
    processed++;
    totalProcessed++;
  }

  return processed;
}

/* ── Atomic claim + send ───────────────────────────────────── */

async function claimAndSendOne(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Claim an available mailbox (reserves the send slot)
    const mailbox = await claimMailbox(client);
    if (!mailbox) {
      await client.query('ROLLBACK');
      return false;
    }

    // 2. Claim a pending / retryable job — atomic within same transaction
    const lockTimeout = `${config.lockTimeoutMinutes} minutes`;
    const jobResult = await client.query<EmailJob>(
      `UPDATE email_jobs
       SET status         = 'sending',
           locked_by      = $1,
           locked_at      = NOW(),
           sender_mailbox = $2,
           updated_at     = NOW()
       WHERE id = (
         SELECT ej.id
         FROM email_jobs ej
         WHERE (
           (ej.status IN ('pending', 'soft_bounce') AND ej.next_attempt_at <= NOW())
           OR
           (ej.status = 'sending' AND ej.locked_at < NOW() - $3::interval)
         )
         AND NOT EXISTS (
           SELECT 1 FROM suppression_list sl WHERE sl.email = ej.recipient_email
         )
         ORDER BY ej.next_attempt_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [config.workerId, mailbox.email, lockTimeout],
    );

    if (jobResult.rows.length === 0) {
      // No jobs available — rollback releases the mailbox slot too
      await client.query('ROLLBACK');
      return false;
    }

    const job = jobResult.rows[0];
    await client.query('COMMIT');

    // 3. Send the email (outside the transaction)
    await processJob(pool, job, mailbox);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ── Process a single job ──────────────────────────────────── */

async function processJob(
  pool: Pool,
  job: EmailJob,
  mailboxState: MailboxState,
): Promise<void> {
  const creds = credentialMap.get(mailboxState.email);
  if (!creds) {
    logger.error('No credentials for mailbox', { mailbox: mailboxState.email });
    await markJobFailed(pool, job, null, 'Missing mailbox credentials');
    return;
  }

  const fromName = mailboxState.display_name || config.defaultFromName;

  // Generate multipart content (html + plain text)
  const { html, text } = bodyToMultipart(job.body);
  const result = await sendEmail(creds, job.recipient_email, job.subject, html, text, fromName);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Log the send attempt
    await client.query(
      `INSERT INTO send_logs (job_id, mailbox, recipient, status, smtp_code, smtp_response, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        job.id,
        mailboxState.email,
        job.recipient_email,
        result.success ? 'sent' : 'failed',
        result.smtp_code || null,
        result.smtp_response || null,
        result.duration_ms,
      ],
    );

    if (result.success) {
      await handleSuccess(client, job, mailboxState.email);
    } else {
      await handleFailure(client, job, mailboxState.email, result);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Error processing job result', {
      jobId: job.id,
      error: (err as Error).message,
    });
  } finally {
    client.release();
  }
}

/* ── Success path ──────────────────────────────────────────── */

async function handleSuccess(
  client: PoolClient,
  job: EmailJob,
  mailboxEmail: string,
): Promise<void> {
  await client.query(
    `UPDATE email_jobs
     SET status = 'sent', sent_at = NOW(),
         locked_by = NULL, locked_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [job.id],
  );
  await recordSendSuccess(client, mailboxEmail);
  logger.info('Job completed', { jobId: job.id, recipient: job.recipient_email });
}

/* ── Failure path ──────────────────────────────────────────── */

async function handleFailure(
  client: PoolClient,
  job: EmailJob,
  mailboxEmail: string,
  result: { smtp_code?: string; smtp_response?: string; error?: string },
): Promise<void> {
  const classification = classifyBounce(
    result.smtp_code ?? null,
    result.error ?? result.smtp_response ?? null,
  );

  // Log bounce event
  await client.query(
    `INSERT INTO bounce_events
       (job_id, mailbox, recipient, bounce_type, smtp_code, smtp_response, raw_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      job.id,
      mailboxEmail,
      job.recipient_email,
      classification.type,
      classification.smtp_code,
      result.smtp_response || null,
      result.error || null,
    ],
  );

  switch (classification.type) {
    case 'hard_bounce':
      await onHardBounce(client, job, mailboxEmail, classification);
      break;
    case 'soft_bounce':
      await onSoftBounce(client, job, mailboxEmail, classification);
      break;
    case 'blocked':
      await onBlocked(client, job, mailboxEmail, classification);
      break;
    default:
      await onGenericFailure(client, job, mailboxEmail, classification);
      break;
  }
}

/* ── Hard bounce: suppress recipient permanently ───────────── */

async function onHardBounce(
  client: PoolClient,
  job: EmailJob,
  mailboxEmail: string,
  cls: BounceClassification,
): Promise<void> {
  await client.query(
    `INSERT INTO suppression_list (email, reason, source_job_id, smtp_code)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [job.recipient_email, cls.reason, job.id, cls.smtp_code],
  );

  await client.query(
    `UPDATE email_jobs
     SET status = 'hard_bounce',
         smtp_code = $2, error_message = $3,
         locked_by = NULL, locked_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, cls.smtp_code, cls.reason],
  );

  // Hard bounce: increment consecutive_failures (may eventually pause)
  await recordHardFailure(client, mailboxEmail);
  await checkHealthAndPause(client, mailboxEmail);

  logger.warn('Hard bounce — recipient suppressed', {
    jobId: job.id,
    recipient: job.recipient_email,
    reason: cls.reason,
  });
}

/* ── Soft bounce: retry with backoff ───────────────────────── */

async function onSoftBounce(
  client: PoolClient,
  job: EmailJob,
  mailboxEmail: string,
  cls: BounceClassification,
): Promise<void> {
  const nextAttempt = getNextAttemptAt(job.retry_count);
  const nextRetryCount = job.retry_count + 1;

  if (nextAttempt) {
    await client.query(
      `UPDATE email_jobs
       SET status = 'soft_bounce',
           retry_count = $2,
           next_attempt_at = $3,
           smtp_code = $4, error_message = $5,
           locked_by = NULL, locked_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, nextRetryCount, nextAttempt, cls.smtp_code, cls.reason],
    );

    logger.info('Soft bounce — retry scheduled', {
      jobId: job.id,
      retry: nextRetryCount,
      nextAttempt: nextAttempt.toISOString(),
    });
  } else {
    await client.query(
      `UPDATE email_jobs
       SET status = 'failed',
           smtp_code = $2, error_message = $3,
           locked_by = NULL, locked_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, cls.smtp_code, `Retries exhausted: ${cls.reason}`],
    );

    logger.warn('Soft bounce — retries exhausted', { jobId: job.id, retries: nextRetryCount });
  }

  // Soft bounce: increment total_bounced but NOT consecutive_failures
  await recordSoftFailure(client, mailboxEmail);
}

/* ── Blocked: pause sending mailbox immediately ────────────── */

async function onBlocked(
  client: PoolClient,
  job: EmailJob,
  mailboxEmail: string,
  cls: BounceClassification,
): Promise<void> {
  await client.query(
    `UPDATE email_jobs
     SET status = 'blocked',
         smtp_code = $2, error_message = $3,
         locked_by = NULL, locked_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, cls.smtp_code, cls.reason],
  );

  await pauseMailbox(client, mailboxEmail, cls.reason);

  logger.error('ALERT: Mailbox blocked', {
    jobId: job.id,
    mailbox: mailboxEmail,
    reason: cls.reason,
  });
}

/* ── Generic failure: retry if possible ────────────────────── */

async function onGenericFailure(
  client: PoolClient,
  job: EmailJob,
  mailboxEmail: string,
  cls: BounceClassification,
): Promise<void> {
  const nextAttempt = getNextAttemptAt(job.retry_count);
  const nextRetryCount = job.retry_count + 1;

  if (nextAttempt) {
    await client.query(
      `UPDATE email_jobs
       SET status = 'pending',
           retry_count = $2,
           next_attempt_at = $3,
           smtp_code = $4, error_message = $5,
           locked_by = NULL, locked_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, nextRetryCount, nextAttempt, cls.smtp_code, cls.reason],
    );

    logger.info('Generic failure — retry scheduled', {
      jobId: job.id,
      retry: nextRetryCount,
      nextAttempt: nextAttempt.toISOString(),
    });
  } else {
    await client.query(
      `UPDATE email_jobs
       SET status = 'failed',
           smtp_code = $2, error_message = $3,
           locked_by = NULL, locked_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, cls.smtp_code, `Retries exhausted: ${cls.reason}`],
    );

    logger.warn('Generic failure — retries exhausted', { jobId: job.id });
  }

  // Generic failure: increment consecutive_failures (may eventually pause)
  await recordHardFailure(client, mailboxEmail);
  await checkHealthAndPause(client, mailboxEmail);
}

/* ── Helpers ───────────────────────────────────────────────── */

async function markJobFailed(
  pool: Pool,
  job: EmailJob,
  smtpCode: string | null,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_jobs
     SET status = 'failed',
         smtp_code = $2, error_message = $3,
         locked_by = NULL, locked_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, smtpCode, reason],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
