/* ────────────────────────────────────────────────────────────
 *  Shared type definitions
 * ──────────────────────────────────────────────────────────── */

export type EmailJobStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'soft_bounce'
  | 'hard_bounce'
  | 'blocked'
  | 'failed'
  | 'suppressed';

export type MailboxStatus = 'active' | 'paused' | 'warming' | 'blocked';

export type BounceType = 'hard_bounce' | 'soft_bounce' | 'blocked' | 'failed';

/* ── Database row shapes ─────────────────────────────────── */

export interface EmailJob {
  id: number;
  recipient_email: string;
  recipient_name: string | null;
  sender_mailbox: string | null;
  subject: string;
  body: string;
  ticket_id: string | null;
  import_batch_id: string | null;
  status: EmailJobStatus;
  retry_count: number;
  max_retries: number;
  smtp_code: string | null;
  error_message: string | null;
  next_attempt_at: Date;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  sent_at: Date | null;
  updated_at: Date;
}

export interface MailboxState {
  id: number;
  email: string;
  display_name: string | null;
  status: MailboxStatus;
  last_sent_at: Date | null;
  total_sent: number;
  total_bounced: number;
  total_blocked: number;
  consecutive_failures: number;
  failure_threshold: number;
  created_at: Date;
  updated_at: Date;
}

/* ── Config / credential shapes ──────────────────────────── */

export interface MailboxCredentials {
  user: string;
  pass: string;
}

export interface MailboxConfig {
  email: string;
  credentials: MailboxCredentials;
}

/* ── Input / output shapes ───────────────────────────────── */

export interface RecipientInput {
  recipient_email: string;
  recipient_name?: string;
  subject?: string;
  message?: string;
  sender_mailbox?: string;
  ticket_id?: string;
}

export interface BounceClassification {
  type: BounceType;
  smtp_code: string | null;
  reason: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  smtp_code?: string;
  smtp_response?: string;
  error?: string;
  duration_ms: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  suppressed: number;
  errors: string[];
}

export interface ImportOptions {
  templatePath?: string;
  defaultSubject?: string;
  batchId?: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}
