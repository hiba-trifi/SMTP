import { Pool } from 'pg';
import { mailboxes } from '../config/mailboxes';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export async function seedMailboxes(pool: Pool): Promise<void> {
  for (const mb of mailboxes) {
    await pool.query(
      `INSERT INTO mailbox_state (email, display_name, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (email) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             updated_at   = NOW()`,
      [mb.email, config.defaultFromName],
    );
    logger.info(`Seeded mailbox: ${mb.email}`);
  }

  logger.info(`Seeded ${mailboxes.length} mailbox(es) total`);
}
