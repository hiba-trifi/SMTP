import { BounceClassification } from '../types';

/* ── SMTP code sets ─────────────────────────────────────── */

const HARD_CODES = new Set(['550', '551', '552', '553', '554']);
const SOFT_CODES = new Set(['421', '450', '451', '452']);

/* ── Pattern lists (first match wins within each tier) ──── */

const BLOCKED_PATTERNS: RegExp[] = [
  /\bblocked\b/i,
  /\bblacklist(?:ed)?\b/i,
  /\bspamhaus\b/i,
  /\breputation\b/i,
  /\bpolicy\s*reject(?:ion|ed)?\b/i,
  /\bdnsbl\b/i,
  /\brbl\b/i,
  /\bbarracuda\b/i,
  /\baccess\s*denied\b/i,
  /\bbanned\b/i,
  /\bnot\s*allowed\b/i,
];

const HARD_BOUNCE_PATTERNS: RegExp[] = [
  /\buser\s*unknown\b/i,
  /\bmailbox\s*unavailable\b/i,
  /\brecipient\s*rejected\b/i,
  /\bdoes\s*not\s*exist\b/i,
  /\bno\s*such\s*user\b/i,
  /\binvalid\s*(?:recipient|address)\b/i,
  /\baddress\s*rejected\b/i,
  /\bunknown\s*user\b/i,
  /\baccount\s*(?:disabled|has been disabled)\b/i,
  /\bmailbox\s*not\s*found\b/i,
  /\b(?:recipient|user)\s*not\s*found\b/i,
  /\bno\s*mailbox\s*here\b/i,
];

const SOFT_BOUNCE_PATTERNS: RegExp[] = [
  /\btemporarily\s*unavailable\b/i,
  /\bmailbox\s*full\b/i,
  /\btry\s*again\s*later\b/i,
  /\brate\s*limit/i,
  /\btoo\s*many\s*connections\b/i,
  /\bservice\s*unavailable\b/i,
  /\binsufficient\s*storage\b/i,
  /\bover\s*quota\b/i,
  /\btemporarily\s*deferred\b/i,
  /\btemporary\s*failure\b/i,
  /\bconnection\s*timed?\s*out\b/i,
];

/* ── Classifier ─────────────────────────────────────────── */

export function classifyBounce(
  smtpCode: string | null | undefined,
  errorMessage: string | null | undefined,
): BounceClassification {
  const code = (smtpCode ?? '').trim();
  const msg = (errorMessage ?? '').trim();
  const combined = `${code} ${msg}`;

  // 1. Blocked — highest priority (protects sending reputation)
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(combined)) {
      return { type: 'blocked', smtp_code: code || null, reason: `Blocked: matched ${pat.source}` };
    }
  }

  // 2. Hard bounce by message pattern
  for (const pat of HARD_BOUNCE_PATTERNS) {
    if (pat.test(msg)) {
      return { type: 'hard_bounce', smtp_code: code || null, reason: `Hard bounce: matched ${pat.source}` };
    }
  }

  // 3. Hard bounce by SMTP code
  if (HARD_CODES.has(code)) {
    return { type: 'hard_bounce', smtp_code: code, reason: `Hard bounce: SMTP ${code}` };
  }

  // 4. Soft bounce by message pattern
  for (const pat of SOFT_BOUNCE_PATTERNS) {
    if (pat.test(msg)) {
      return { type: 'soft_bounce', smtp_code: code || null, reason: `Soft bounce: matched ${pat.source}` };
    }
  }

  // 5. Soft bounce by SMTP code
  if (SOFT_CODES.has(code)) {
    return { type: 'soft_bounce', smtp_code: code, reason: `Soft bounce: SMTP ${code}` };
  }

  // 6. Unknown failure
  return {
    type: 'failed',
    smtp_code: code || null,
    reason: `Unknown failure: ${msg.substring(0, 200)}`,
  };
}
