import { Pool, PoolClient } from 'pg';
import { MailboxState } from '../types';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Atomically claims the next available mailbox (active + throttle elapsed).
 * Uses FOR UPDATE SKIP LOCKED for safe concurrency.
 * The UPDATE sets last_sent_at = NOW() so the slot is reserved immediately.
 * If the outer transaction is rolled back the reservation is undone.
 */
export async function claimMailbox(client: PoolClient): Promise<MailboxState | null> {
  const throttle = `${config.mailboxThrottleMs} milliseconds`;

  const result = await client.query<MailboxState>(
    `UPDATE mailbox_state
     SET last_sent_at = NOW(), updated_at = NOW()
     WHERE email = (
       SELECT email FROM mailbox_state
       WHERE status = 'active'
         AND (last_sent_at IS NULL OR last_sent_at < NOW() - $1::interval)
       ORDER BY last_sent_at ASC NULLS FIRST
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [throttle],
  );

  return result.rows[0] ?? null;
}

/** Record a successful send for the mailbox (resets consecutive failures). */
export async function recordSendSuccess(client: PoolClient, email: string): Promise<void> {
  await client.query(
    `UPDATE mailbox_state
     SET total_sent = total_sent + 1,
         consecutive_failures = 0,
         updated_at = NOW()
     WHERE email = $1`,
    [email],
  );
}

/**
 * Record a hard bounce or generic failure for a mailbox.
 * Increments total_bounced AND consecutive_failures.
 */
export async function recordHardFailure(client: PoolClient, email: string): Promise<void> {
  await client.query(
    `UPDATE mailbox_state
     SET total_bounced = total_bounced + 1,
         consecutive_failures = consecutive_failures + 1,
         updated_at = NOW()
     WHERE email = $1`,
    [email],
  );
}

/**
 * Record a soft bounce for a mailbox.
 * Increments total_bounced but does NOT increment consecutive_failures.
 * Soft bounces are transient and should not degrade mailbox health.
 */
export async function recordSoftFailure(client: PoolClient, email: string): Promise<void> {
  await client.query(
    `UPDATE mailbox_state
     SET total_bounced = total_bounced + 1,
         updated_at = NOW()
     WHERE email = $1`,
    [email],
  );
}

/** Pause / block a mailbox immediately. */
export async function pauseMailbox(
  client: PoolClient,
  email: string,
  reason: string,
): Promise<void> {
  logger.warn(`Pausing mailbox`, { mailbox: email, reason });
  await client.query(
    `UPDATE mailbox_state
     SET status = 'blocked',
         total_blocked = total_blocked + 1,
         updated_at = NOW()
     WHERE email = $1`,
    [email],
  );
}

/**
 * If consecutive failures have reached the configured threshold,
 * automatically pause the mailbox.  Returns true when paused.
 * Only call this after hard failures / blocked — never after soft bounces.
 */
export async function checkHealthAndPause(
  client: PoolClient,
  email: string,
): Promise<boolean> {
  const res = await client.query<Pick<MailboxState, 'consecutive_failures' | 'failure_threshold'>>(
    'SELECT consecutive_failures, failure_threshold FROM mailbox_state WHERE email = $1',
    [email],
  );

  if (res.rows.length === 0) return false;

  const { consecutive_failures, failure_threshold } = res.rows[0];
  if (consecutive_failures >= failure_threshold) {
    await pauseMailbox(
      client,
      email,
      `Consecutive failures (${consecutive_failures}) reached threshold (${failure_threshold})`,
    );
    return true;
  }

  return false;
}

/**
 * Resume a paused/blocked mailbox back to active.
 * Resets consecutive_failures to 0.
 */
export async function resumeMailbox(pool: Pool, email: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE mailbox_state
     SET status = 'active',
         consecutive_failures = 0,
         updated_at = NOW()
     WHERE email = $1
       AND status IN ('paused', 'blocked')
     RETURNING email`,
    [email],
  );

  if (res.rows.length > 0) {
    logger.info('Mailbox resumed', { mailbox: email });
    return true;
  }
  return false;
}
