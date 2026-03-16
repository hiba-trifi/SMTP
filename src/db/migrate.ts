import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export async function runMigrations(pool: Pool): Promise<void> {
  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const sqlDir = path.resolve(__dirname, '../../sql');
  if (!fs.existsSync(sqlDir)) {
    logger.warn('No sql/ directory found — skipping migrations');
    return;
  }

  const files = fs.readdirSync(sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const already = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file],
    );

    if (already.rows.length > 0) {
      logger.info(`Migration already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf-8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      logger.info(`Applied migration: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
