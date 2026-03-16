import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config/env';
import { MailboxConfig, SendResult } from '../types';
import { logger } from '../utils/logger';

/* ── Transporter cache (one per mailbox) ──────────────────── */

const transporters = new Map<string, Transporter>();

function getTransporter(mailbox: MailboxConfig): Transporter {
  let t = transporters.get(mailbox.email);
  if (!t) {
    t = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: mailbox.credentials.user,
        pass: mailbox.credentials.pass,
      },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
      tls: { rejectUnauthorized: true },
    });
    transporters.set(mailbox.email, t);
  }
  return t;
}

/* ── Public API ────────────────────────────────────────────── */

export async function sendEmail(
  mailbox: MailboxConfig,
  to: string,
  subject: string,
  html: string,
  plainText: string,
  fromName: string,
): Promise<SendResult> {
  const start = Date.now();

  // Dry-run mode — simulate success without touching SMTP
  if (config.dryRun) {
    const duration = Date.now() - start;
    logger.info('Dry-run send (not sent)', {
      to,
      mailbox: mailbox.email,
      subject,
      duration,
    });
    return {
      success: true,
      messageId: `dry-run-${Date.now()}@${mailbox.email}`,
      smtp_response: 'DRY_RUN',
      duration_ms: duration,
    };
  }

  const transporter = getTransporter(mailbox);

  try {
    // Always set envelope sender for proper bounce routing
    const envelopeFrom = config.bounceReturnPath || mailbox.email;

    const info = await transporter.sendMail({
      from: `"${fromName}" <${mailbox.email}>`,
      to,
      subject,
      html,
      text: plainText,
      envelope: {
        from: envelopeFrom,
        to,
      },
      headers: config.bounceReturnPath
        ? { 'Return-Path': config.bounceReturnPath }
        : undefined,
    });

    const duration = Date.now() - start;
    logger.info('Email sent', {
      to,
      mailbox: mailbox.email,
      messageId: info.messageId,
      duration,
    });

    return {
      success: true,
      messageId: info.messageId,
      smtp_response: info.response,
      duration_ms: duration,
    };
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const e = err as Record<string, unknown>;
    const smtpCode = extractSmtpCode(e);

    logger.error('Send failed', {
      to,
      mailbox: mailbox.email,
      error: String(e.message ?? e),
      smtp_code: smtpCode,
      duration,
    });

    return {
      success: false,
      smtp_code: smtpCode ?? undefined,
      smtp_response: (e.response as string) ?? undefined,
      error: String(e.message ?? e),
      duration_ms: duration,
    };
  }
}

export function closeAllTransporters(): void {
  for (const [, t] of transporters) {
    t.close();
  }
  transporters.clear();
}

/* ── Helpers ───────────────────────────────────────────────── */

function extractSmtpCode(err: Record<string, unknown>): string | null {
  if (err.responseCode) return String(err.responseCode);
  const msg = String(err.message ?? '');
  const m = msg.match(/(\d{3})/);
  return m ? m[1] : null;
}
