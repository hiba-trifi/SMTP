-- ============================================================
-- SMTP Support Sender — Initial Schema
-- ============================================================

-- Email Jobs: main send queue
CREATE TABLE IF NOT EXISTS email_jobs (
    id                SERIAL PRIMARY KEY,
    recipient_email   VARCHAR(320) NOT NULL,
    recipient_name    VARCHAR(255),
    sender_mailbox    VARCHAR(320),
    subject           TEXT NOT NULL,
    body              TEXT NOT NULL,
    ticket_id         VARCHAR(100),
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    retry_count       INTEGER NOT NULL DEFAULT 0,
    max_retries       INTEGER NOT NULL DEFAULT 4,
    smtp_code         VARCHAR(10),
    error_message     TEXT,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by         VARCHAR(100),
    locked_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at           TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_job_status CHECK (
        status IN (
            'pending','sending','sent',
            'soft_bounce','hard_bounce',
            'blocked','failed','suppressed'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_jobs_claimable
    ON email_jobs (next_attempt_at ASC)
    WHERE status IN ('pending','soft_bounce');

CREATE INDEX IF NOT EXISTS idx_jobs_recipient
    ON email_jobs (recipient_email);

CREATE INDEX IF NOT EXISTS idx_jobs_status
    ON email_jobs (status);

CREATE INDEX IF NOT EXISTS idx_jobs_stale_lock
    ON email_jobs (locked_at)
    WHERE status = 'sending';


-- Mailbox State: per-mailbox health & throttle tracking
CREATE TABLE IF NOT EXISTS mailbox_state (
    id                    SERIAL PRIMARY KEY,
    email                 VARCHAR(320) UNIQUE NOT NULL,
    display_name          VARCHAR(255),
    status                VARCHAR(20) NOT NULL DEFAULT 'active',
    last_sent_at          TIMESTAMPTZ,
    total_sent            INTEGER NOT NULL DEFAULT 0,
    total_bounced         INTEGER NOT NULL DEFAULT 0,
    total_blocked         INTEGER NOT NULL DEFAULT 0,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    failure_threshold     INTEGER NOT NULL DEFAULT 5,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_mailbox_status CHECK (
        status IN ('active','paused','warming','blocked')
    )
);


-- Send Logs: detailed per-attempt record
CREATE TABLE IF NOT EXISTS send_logs (
    id             SERIAL PRIMARY KEY,
    job_id         INTEGER NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
    mailbox        VARCHAR(320) NOT NULL,
    recipient      VARCHAR(320) NOT NULL,
    status         VARCHAR(20) NOT NULL,
    smtp_code      VARCHAR(10),
    smtp_response  TEXT,
    duration_ms    INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_send_logs_job
    ON send_logs (job_id);

CREATE INDEX IF NOT EXISTS idx_send_logs_mailbox
    ON send_logs (mailbox);


-- Suppression List: hard-bounced recipients never receive again
CREATE TABLE IF NOT EXISTS suppression_list (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(320) UNIQUE NOT NULL,
    reason          VARCHAR(255) NOT NULL,
    source_job_id   INTEGER REFERENCES email_jobs(id) ON DELETE SET NULL,
    smtp_code       VARCHAR(10),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppression_email
    ON suppression_list (email);


-- Bounce Events: detailed bounce log for diagnostics
CREATE TABLE IF NOT EXISTS bounce_events (
    id             SERIAL PRIMARY KEY,
    job_id         INTEGER NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
    mailbox        VARCHAR(320) NOT NULL,
    recipient      VARCHAR(320) NOT NULL,
    bounce_type    VARCHAR(20) NOT NULL,
    smtp_code      VARCHAR(10),
    smtp_response  TEXT,
    raw_error      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bounce_job
    ON bounce_events (job_id);

CREATE INDEX IF NOT EXISTS idx_bounce_type
    ON bounce_events (bounce_type);

CREATE INDEX IF NOT EXISTS idx_bounce_mailbox
    ON bounce_events (mailbox);
