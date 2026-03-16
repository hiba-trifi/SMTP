import { MailboxConfig } from '../types';

const MAILBOX_COUNT = 10;

function loadMailboxes(): MailboxConfig[] {
  const result: MailboxConfig[] = [];

  for (let i = 1; i <= MAILBOX_COUNT; i++) {
    const user = process.env[`SMTP_MAILBOX_${i}_USER`];
    const pass = process.env[`SMTP_MAILBOX_${i}_PASS`];

    if (user && pass) {
      result.push({ email: user, credentials: { user, pass } });
    }
  }

  if (result.length === 0) {
    throw new Error(
      'No mailbox credentials configured. Set SMTP_MAILBOX_N_USER / SMTP_MAILBOX_N_PASS (N = 1..10) in .env',
    );
  }

  return result;
}

export const mailboxes = loadMailboxes();
