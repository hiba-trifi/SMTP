/**
 * Staged retry delays (index = current retry_count before increment).
 *
 *   0 → 30 minutes
 *   1 → 2 hours
 *   2 → 12 hours
 *   3 → 24 hours
 *   4+ → no more retries
 */
const RETRY_DELAYS_MS: readonly number[] = [
  30 * 60 * 1000,       // 30 min
  2  * 60 * 60 * 1000,  // 2 h
  12 * 60 * 60 * 1000,  // 12 h
  24 * 60 * 60 * 1000,  // 24 h
];

export const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** Returns delay in ms for the given retry attempt index, or null if exhausted. */
export function getRetryDelay(retryCount: number): number | null {
  if (retryCount < 0 || retryCount >= RETRY_DELAYS_MS.length) return null;
  return RETRY_DELAYS_MS[retryCount];
}

/** Returns absolute Date for the next attempt, or null if no retries remain. */
export function getNextAttemptAt(retryCount: number): Date | null {
  const delay = getRetryDelay(retryCount);
  if (delay === null) return null;
  return new Date(Date.now() + delay);
}
