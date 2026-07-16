/**
 * Shared cron bearer auth (B-16): constant-time comparison so timing on the
 * prefix of CRON_SECRET cannot be probed. timingSafeEqual throws on length
 * mismatch, so we length-check first and only compare equal-length buffers.
 *
 * Extracted from app/api/cron/photo-gc (it was already copy-pasted into
 * keep-warm; a third copy is where drift starts).
 */
import { timingSafeEqual } from 'crypto';

export function bearerMatches(headerValue: string | null, expected: string): boolean {
  if (!headerValue) return false;
  const presented = `Bearer ${expected}`;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when the request carries a valid CRON_SECRET bearer. */
export function cronAuthorized(authorizationHeader: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return bearerMatches(authorizationHeader, expected);
}
