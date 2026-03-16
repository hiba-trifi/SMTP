const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const SENSITIVE_KEYS = /pass|password|secret|token|key|auth|credential/i;
const BODY_KEYS = /^(body|html|text|message|content)$/i;

class Logger {
  private level: number;

  constructor(level: string) {
    this.level = LOG_LEVELS[level as LogLevel] ?? LOG_LEVELS.info;
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }
  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', msg, meta);
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] > this.level) return;

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };

    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (SENSITIVE_KEYS.test(k)) {
          entry[k] = '[REDACTED]';
        } else if (BODY_KEYS.test(k) && level !== 'debug') {
          entry[k] = `[${typeof v === 'string' ? v.length : 0} chars]`;
        } else {
          entry[k] = v;
        }
      }
    }

    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

export const logger = new Logger(process.env.LOG_LEVEL || 'info');
