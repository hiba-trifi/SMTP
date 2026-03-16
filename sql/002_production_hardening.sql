-- ============================================================
-- SMTP Support Sender — Production Hardening
-- ============================================================

-- Import batch tracking + dedup
ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS import_batch_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_jobs_batch
    ON email_jobs (import_batch_id);

-- Prevent duplicate jobs within the same import batch
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_batch_dedup
    ON email_jobs (import_batch_id, recipient_email, subject)
    WHERE import_batch_id IS NOT NULL;
