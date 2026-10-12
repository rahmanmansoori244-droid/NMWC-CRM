/**
 * Gap 23 (data audit 2026-10-10): sign-in events AuditLog cannot hold, kept for
 * ever in AuthEvent (migration 20261015100000_authority_jobs_auth_events). The
 * writers are in lib/auth-events.ts (sign-in failures) and in the database
 * itself (trigger user_session_revoke_capture, every session cut-off).
 *
 * A typed sign-in name is never stored. AuditLog's LOGIN_FAIL rows point at a real
 * account; a name no account has used to reach only the 30-day logs, in plain
 * text — and what people type into the name field is sometimes their password.
 * AuthEvent keeps a keyed fingerprint instead:
 *
 *   usernameHmac = HMAC-SHA256(key, lower(trim(name)))
 *   key          = HKDF-SHA256(AUTH_SECRET, salt '', info 'nmwc-auth-event-v1', 32 bytes)
 *   keyId        = the first 8 hex digits of SHA-256(key)
 *
 * The same name always gives the same fingerprint under one key, so repeated
 * attempts on one name are counted and a name can be checked ("did anyone try
 * 'mct-01'?") by fingerprinting it again; nothing typed can be read back from the
 * table without AUTH_SECRET. When the owner rotates AUTH_SECRET the keyId
 * changes, and rows of the old key stay comparable only with the old secret.
 *
 * PURE: node:crypto only, so the e2e clean-up can fingerprint the world's names.
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto';

/** What AuthEvent.kind may hold (the database's AuthEvent_kind_check). */
export const AUTH_EVENT_KINDS = [
  'LOGIN_FAIL_UNKNOWN',
  'LOGIN_RATE_LIMITED',
  'LOGIN_FAIL_REUSED_NAME',
  'SESSION_REVOKE',
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

/** The reason a failure on a name that another account held before is given. */
export const RETIRED_USERNAME_REASON = 'retired_username';

/** At most one LOGIN_RATE_LIMITED row per bucket in this long. */
export const RATE_LIMITED_EVERY_MS = 5 * 60 * 1000;

/** The HKDF label: a new label is a new key, so change it only with a new version. */
export const FINGERPRINT_LABEL = 'nmwc-auth-event-v1';

export type FingerprintKey = { key: Buffer; keyId: string };

const cache = new Map<string, FingerprintKey>();

/** The fingerprint key derived from the app's signing secret; null when there is none. */
export function fingerprintKey(
  secret: string | undefined = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
): FingerprintKey | null {
  if (!secret) return null;
  const hit = cache.get(secret);
  if (hit) return hit;
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), FINGERPRINT_LABEL, 32));
  const out = { key, keyId: createHash('sha256').update(key).digest('hex').slice(0, 8) };
  if (cache.size > 4) cache.clear();
  cache.set(secret, out);
  return out;
}

/** The form trims and lower-cases a sign-in name (lib/auth.ts); the fingerprint does the same. */
export function normaliseTypedName(name: string): string {
  return name.trim().toLowerCase();
}

export function usernameFingerprint(name: string, k: FingerprintKey): string {
  return createHmac('sha256', k.key).update(normaliseTypedName(name), 'utf8').digest('hex');
}
