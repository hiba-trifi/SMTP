import './utils/shutdown'; // Register signal handlers early
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { seedMailboxes } from './db/seed';
import { importFromCsv } from './importers/csv-importer';
import { importFromJson } from './importers/json-importer';
import { startWorker, recoverStaleLocks } from './workers/send-worker';
import { resumeMailbox } from './services/mailbox-router';
import { logger } from './utils/logger';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  const pool = getPool();

  switch (command) {
    case 'migrate': {
      await runMigrations(pool);
      logger.info('Migrations complete');
      break;
    }

    case 'seed-mailboxes': {
      await seedMailboxes(pool);
      break;
    }

    case 'import-csv': {
      const filePath = args[0];
      if (!filePath) {
        console.error('Usage: import-csv <file.csv> [template-path] [default-subject] [batch-id]');
        process.exit(1);
      }
      const result = await importFromCsv(pool, filePath, {
        templatePath: args[1] || undefined,
        defaultSubject: args[2] || undefined,
        batchId: args[3] || undefined,
      });
      console.log('Import result:', JSON.stringify(result, null, 2));
      break;
    }

    case 'import-json': {
      const filePath = args[0];
      if (!filePath) {
        console.error('Usage: import-json <file.json> [template-path] [default-subject] [batch-id]');
        process.exit(1);
      }
      const result = await importFromJson(pool, filePath, {
        templatePath: args[1] || undefined,
        defaultSubject: args[2] || undefined,
        batchId: args[3] || undefined,
      });
      console.log('Import result:', JSON.stringify(result, null, 2));
      break;
    }

    case 'worker': {
      // Worker manages its own lifecycle & pool shutdown
      await startWorker(pool);
      return;
    }

    case 'resume-mailbox': {
      const email = args[0];
      if (!email) {
        console.error('Usage: resume-mailbox <mailbox-email>');
        process.exit(1);
      }
      const resumed = await resumeMailbox(pool, email);
      if (resumed) {
        console.log(`Mailbox ${email} resumed successfully.`);
      } else {
        console.log(`Mailbox ${email} not found or already active.`);
      }
      break;
    }

    case 'recover-locks': {
      const count = await recoverStaleLocks(pool);
      console.log(`Recovered ${count} stale lock(s).`);
      break;
    }

    case 'health': {
      const jobs = await pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM email_jobs
        GROUP BY status
        ORDER BY status
      `);
      const mailboxes = await pool.query(`
        SELECT email, status, total_sent, total_bounced, consecutive_failures, last_sent_at
        FROM mailbox_state
        ORDER BY email
      `);
      const stale = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM email_jobs
        WHERE status = 'sending'
          AND locked_at < NOW() - INTERVAL '30 minutes'
      `);

      console.log('\n=== Job Status Summary ===');
      for (const row of jobs.rows) {
        console.log(`  ${row.status}: ${row.count}`);
      }

      console.log('\n=== Mailbox Health ===');
      for (const row of mailboxes.rows) {
        console.log(`  ${row.email} [${row.status}] sent=${row.total_sent} bounced=${row.total_bounced} consecutive_fail=${row.consecutive_failures}`);
      }

      console.log(`\n=== Stale Locks: ${stale.rows[0].count} ===\n`);
      break;
    }

    default: {
      console.log(`
SMTP Support Sender — CLI

Commands:
  migrate                                           Run database migrations
  seed-mailboxes                                    Seed mailbox_state from env config
  import-csv  <file> [template] [subject] [batch]   Import recipients from CSV
  import-json <file> [template] [subject] [batch]   Import recipients from JSON
  worker                                            Start the send worker
  resume-mailbox <email>                            Resume a paused/blocked mailbox
  recover-locks                                     Release stale sending locks
  health                                            Show job & mailbox health summary
      `.trim());
      break;
    }
  }

  await closePool();
}

main().catch((err) => {
  logger.error('Fatal error', { error: (err as Error).message });
  closePool().finally(() => process.exit(1));
});
