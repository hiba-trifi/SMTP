import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface EnvConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  databaseUrl: string;
  defaultFromName: string;
  bounceReturnPath: string;
  logLevel: string;
  pollIntervalMs: number;
  mailboxThrottleMs: number;
  workerId: string;
  lockTimeoutMinutes: number;
  dryRun: boolean;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : fallback;
}

function loadConfig(): EnvConfig {
  const smtpPort = parseInt(optionalEnv('SMTP_PORT', '587'), 10);
  if (isNaN(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error('SMTP_PORT must be a valid port number (1–65535)');
  }

  const pollIntervalMs = parseInt(optionalEnv('POLL_INTERVAL_MS', '15000'), 10);
  if (isNaN(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error('POLL_INTERVAL_MS must be >= 1000');
  }

  const mailboxThrottleMs = parseInt(optionalEnv('MAILBOX_THROTTLE_MS', '180000'), 10);
  if (isNaN(mailboxThrottleMs) || mailboxThrottleMs < 0) {
    throw new Error('MAILBOX_THROTTLE_MS must be a non-negative number');
  }

  const lockTimeoutMinutes = parseInt(optionalEnv('LOCK_TIMEOUT_MINUTES', '10'), 10);
  if (isNaN(lockTimeoutMinutes) || lockTimeoutMinutes < 1) {
    throw new Error('LOCK_TIMEOUT_MINUTES must be >= 1');
  }

  return {
    smtpHost: requireEnv('SMTP_HOST'),
    smtpPort,
    smtpSecure: optionalEnv('SMTP_SECURE', 'false') === 'true',
    databaseUrl: requireEnv('DATABASE_URL'),
    defaultFromName: optionalEnv('DEFAULT_FROM_NAME', 'Support'),
    bounceReturnPath: optionalEnv('BOUNCE_RETURN_PATH', ''),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    pollIntervalMs,
    mailboxThrottleMs,
    workerId: `worker-${process.pid}-${Date.now()}`,
    lockTimeoutMinutes,
    dryRun: optionalEnv('DRY_RUN', 'false') === 'true',
  };
}

export const config = loadConfig();
