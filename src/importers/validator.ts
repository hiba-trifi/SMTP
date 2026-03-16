import { RecipientInput } from '../types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 320;
const MAX_SUBJECT_LEN = 998; // RFC 2822 max line length
const MAX_NAME_LEN = 255;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRecipient(input: RecipientInput): ValidationResult {
  const errors: string[] = [];

  if (!input.recipient_email) {
    errors.push('recipient_email is required');
  } else if (input.recipient_email.length > MAX_EMAIL_LEN) {
    errors.push(`recipient_email exceeds ${MAX_EMAIL_LEN} characters`);
  } else if (!EMAIL_RE.test(input.recipient_email)) {
    errors.push(`Invalid email format: ${input.recipient_email}`);
  }

  if (input.recipient_name && input.recipient_name.length > MAX_NAME_LEN) {
    errors.push(`recipient_name exceeds ${MAX_NAME_LEN} characters`);
  }

  if (input.subject && input.subject.length > MAX_SUBJECT_LEN) {
    errors.push(`subject exceeds ${MAX_SUBJECT_LEN} characters`);
  }

  if (!input.subject && !input.message) {
    errors.push('Either subject or message must be provided');
  }

  return { valid: errors.length === 0, errors };
}
