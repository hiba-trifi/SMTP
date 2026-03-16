# SMTP Support Sender

Production-ready bulk support-reply email sending system.  
Database-backed job queue, per-mailbox throttling, bounce classification, automatic retries, and suppression — no Redis required.

---

## Architecture

```
src/
├── cli.ts                        CLI entry point
├── config/
│   ├── env.ts                    Environment validation & loading
│   └── mailboxes.ts              Mailbox credential loader (10 slots)
├── db/
│   ├── pool.ts                   PostgreSQL connection pool
│   ├── migrate.ts                SQL migration runner
│   └── seed.ts                   Seed mailbox_state rows
├── importers/
│   ├── csv-importer.ts           CSV → email_jobs
│   ├── json-importer.ts          JSON → email_jobs
│   └── validator.ts              Input validation
├── services/
│   ├── bounce-classifier.ts      SMTP error → bounce type
│   ├── mailer.ts                 Nodemailer SMTP wrapper
│   ├── mailbox-router.ts         Round-robin mailbox selection & health
│   ├── retry-policy.ts           Staged retry delays
│   └── template-engine.ts        {{placeholder}} template renderer
├── types/
│   └── index.ts                  Shared TypeScript types
├── utils/
│   ├── logger.ts                 Structured JSON logger (secrets redacted)
│   └── shutdown.ts               Graceful SIGTERM/SIGINT handler
└── workers/
    └── send-worker.ts            Database-backed send loop
```

---

## Prerequisites

| Component   | Version |
|-------------|---------|
| Node.js     | ≥ 18    |
| PostgreSQL  | ≥ 14    |
| npm         | ≥ 9     |

A running Postfix + Dovecot mail server with virtual mailboxes on your domain (configured separately).

---

## Quick Start

### 1. Clone & install

```bash
git clone <your-repo>
cd smtp-support-sender
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL, SMTP_HOST, and all SMTP_MAILBOX_N_USER/PASS values
```

### 3. Create the database

```bash
createdb smtp_sender            # or via psql
npm run migrate                 # applies sql/001_initial_schema.sql
```

### 4. Seed mailboxes

```bash
npm run seed:mailboxes          # inserts mailbox_state rows from .env
```

### 5. Import recipients

```bash
# CSV with template
npm run import:csv -- data/sample.csv data/templates/support-reply.html

# JSON (custom subject/body per row)
npm run import:json -- data/sample.json
```

### 6. Start the worker

```bash
npm run worker:start
```

The worker polls PostgreSQL, claims pending jobs, rotates mailboxes, sends via SMTP, and updates status — all in a single process.

---

## Production Deployment

### Build

```bash
npm run build                   # compiles to dist/
```

### Run compiled

```bash
node dist/cli.js migrate
node dist/cli.js seed-mailboxes
node dist/cli.js import-csv  data/sample.csv data/templates/support-reply.html
node dist/cli.js worker
```

Or use the `prod:*` npm scripts:

```bash
npm run prod:migrate
npm run prod:seed
npm run prod:import:csv -- data/sample.csv data/templates/support-reply.html
npm start                       # starts worker from dist/
```

### systemd service (recommended)

```ini
[Unit]
Description=SMTP Support Sender Worker
After=postgresql.service

[Service]
Type=simple
User=smtp-sender
WorkingDirectory=/opt/smtp-support-sender
ExecStart=/usr/bin/node dist/cli.js worker
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `migrate` | Run pending SQL migrations |
| `seed-mailboxes` | Upsert mailbox_state rows from env |
| `import-csv <file> [template] [subject]` | Import recipients from CSV |
| `import-json <file> [template] [subject]` | Import recipients from JSON |
| `worker` | Start the send worker loop |

---

## Input Formats

### CSV

```csv
recipient_email,recipient_name,subject,message,ticket_id
alice@example.com,Alice,Re: Ticket #1001,Your issue is resolved.,1001
```

### JSON

```json
[
  {
    "recipient_email": "alice@example.com",
    "recipient_name": "Alice",
    "subject": "Re: Ticket #1001",
    "message": "Your issue is resolved.",
    "ticket_id": "1001"
  }
]
```

All fields except `recipient_email` are optional.  
If a template is provided, `{{name}}`, `{{email}}`, `{{ticket_id}}`, `{{message}}`, and `{{subject}}` are replaced.

---

## Database Schema

Five tables created by `sql/001_initial_schema.sql`:

| Table | Purpose |
|-------|---------|
| `email_jobs` | Main job queue with status, retries, locking |
| `mailbox_state` | Per-mailbox health, throttle, counters |
| `send_logs` | Per-attempt delivery log |
| `suppression_list` | Hard-bounced recipients (permanent) |
| `bounce_events` | Detailed bounce diagnostics |

### Job statuses

`pending` → `sending` → `sent`  
`sending` → `soft_bounce` (retries) → `failed`  
`sending` → `hard_bounce` (suppressed)  
`sending` → `blocked` (mailbox paused)  

---

## Sending Rules

- **10 mailboxes** with independent credentials
- **1 email every 3 minutes** per mailbox (configurable via `MAILBOX_THROTTLE_MS`)
- Round-robin selection: least-recently-used active mailbox
- Blocked response → mailbox paused automatically
- Consecutive failure threshold → mailbox paused automatically

---

## Retry Policy

| Attempt | Delay |
|---------|-------|
| 1st retry | 30 minutes |
| 2nd retry | 2 hours |
| 3rd retry | 12 hours |
| 4th retry | 24 hours |
| After 4th | Marked `failed` |

---

## Bounce Classification

| Category | Triggers | Action |
|----------|----------|--------|
| **Hard bounce** | 550-554, "user unknown", "does not exist", etc. | Suppress recipient permanently |
| **Soft bounce** | 421-452, "mailbox full", "try again later", etc. | Retry with backoff |
| **Blocked** | "blacklisted", "spamhaus", "policy rejection", etc. | Pause mailbox, log alert |
| **Failed** | Unrecognized errors | Retry if attempts remain |

---

## Environment Variables

See [.env.example](.env.example) for the full list.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | Yes | — | Mail server hostname |
| `SMTP_PORT` | No | 587 | SMTP port |
| `SMTP_SECURE` | No | false | Use TLS on connect |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `DEFAULT_FROM_NAME` | No | Support | Display name for From header |
| `BOUNCE_RETURN_PATH` | No | — | Envelope sender for bounces |
| `LOG_LEVEL` | No | info | error / warn / info / debug |
| `POLL_INTERVAL_MS` | No | 10000 | Worker poll interval (ms) |
| `MAILBOX_THROTTLE_MS` | No | 180000 | Per-mailbox send interval (ms) |
| `LOCK_TIMEOUT_MINUTES` | No | 10 | Stale lock reclaim timeout |
| `SMTP_MAILBOX_N_USER` | Yes | — | Mailbox N username (N = 1..10) |
| `SMTP_MAILBOX_N_PASS` | Yes | — | Mailbox N password (N = 1..10) |

---

## Security

- All SQL queries use parameterized statements (no string interpolation)
- Passwords and secrets are redacted in log output
- Input is validated before database insertion
- Template rendering uses HTML escaping to prevent injection
- No `eval()` or dynamic code execution
- Job locking with `FOR UPDATE SKIP LOCKED` prevents duplicate sends
- Graceful shutdown on SIGTERM/SIGINT
- TLS verification enabled on SMTP connections

---

## License

Private / Internal Use
