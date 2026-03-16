import crypto from 'crypto';
import fs from 'fs';
import csv from 'csv-parser';
import { Pool } from 'pg';
import { RecipientInput, ImportResult, ImportOptions } from '../types';
import { validateRecipient } from './validator';
import { loadTemplate, renderTemplate } from '../services/template-engine';
import { logger } from '../utils/logger';

export async function importFromCsv(
  pool: Pool,
  filePath: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const batchId = options.batchId || crypto.randomUUID();
  const template = options.templatePath ? loadTemplate(options.templatePath) : null;
  const result: ImportResult = { imported: 0, skipped: 0, suppressed: 0, errors: [] };

  logger.info('CSV import starting', { batchId, filePath });

  // Parse all rows first
  const rows: RecipientInput[] = await new Promise((resolve, reject) => {
    const parsed: RecipientInput[] = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row: Record<string, string>) => {
        parsed.push({
          recipient_email: (row.recipient_email ?? '').trim(),
          recipient_name: (row.recipient_name ?? '').trim() || undefined,
          subject: (row.subject ?? '').trim() || undefined,
          message: (row.message ?? '').trim() || undefined,
          sender_mailbox: (row.sender_mailbox ?? '').trim() || undefined,
          ticket_id: (row.ticket_id ?? '').trim() || undefined,
        });
      })
      .on('end', () => resolve(parsed))
      .on('error', reject);
  });

  // Insert valid rows as jobs
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const validation = validateRecipient(row);

    if (!validation.valid) {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: ${validation.errors.join('; ')}`);
      continue;
    }

    // Check suppression list
    const suppressed = await pool.query(
      'SELECT 1 FROM suppression_list WHERE email = $1',
      [row.recipient_email],
    );
    if (suppressed.rows.length > 0) {
      result.suppressed++;
      logger.debug(`Skipping suppressed recipient: ${row.recipient_email}`);
      continue;
    }

    const subject = row.subject || options.defaultSubject || 'Support Reply';
    let body: string;

    if (template) {
      body = renderTemplate(template, {
        name: row.recipient_name || '',
        email: row.recipient_email,
        ticket_id: row.ticket_id || '',
        message: row.message || '',
        subject,
      });
    } else {
      body = row.message || '';
    }

    // ON CONFLICT dedup: same batch + recipient + subject → skip
    const ins = await pool.query(
      `INSERT INTO email_jobs
         (recipient_email, recipient_name, subject, body, ticket_id, sender_mailbox,
          import_batch_id, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
       ON CONFLICT (import_batch_id, recipient_email, subject)
       WHERE import_batch_id IS NOT NULL
       DO NOTHING`,
      [
        row.recipient_email,
        row.recipient_name || null,
        subject,
        body,
        row.ticket_id || null,
        row.sender_mailbox || null,
        batchId,
      ],
    );

    if (ins.rowCount && ins.rowCount > 0) {
      result.imported++;
    } else {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: duplicate within batch`);
    }
  }

  logger.info('CSV import complete', {
    batchId,
    imported: result.imported,
    skipped: result.skipped,
    suppressed: result.suppressed,
    errorCount: result.errors.length,
  });

  return result;
}
