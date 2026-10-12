/**
 * Gap 23 (data audit 2026-10-10): the sign-in failures AuditLog cannot hold,
 * written to AuthEvent (lib/sign-in-events.ts says what is stored and why the
 * typed name never is). Called from lib/auth.ts authorize():
 *
 *   recordUnknownNameFailure  a name no account has (LOGIN_FAIL_UNKNOWN); reason
 *                             retired_username when an account used to have it
 *                             (UserHistory), else not_found / demo_disabled
 *   recordRateLimited         a refusal by a sign-in throttle (LOGIN_RATE_LIMITED),
 *                             at most one row per bucket per 5 minutes: in this
 *                             instance first, then under an advisory lock in the
 *                             database, so an attack writes a row per bucket and
 *                             window, not per attempt
 *   recordReusedNameFailure   a failure on an account whose name another account
 *                             held before it (LOGIN_FAIL_REUSED_NAME) — a leaver
 *                             typing his old route sign-in name shows up as his
 *                             successor's failures; this row says so
 *
 * Session cut-offs are not written here: the database records every one
 * (trigger user_session_revoke_capture) under the cause its writer named.
 *
 * Never throws: a sign-in must work whether or not its event could be recorded.
 */
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { src, withChangeContext } from '@/lib/change-context';
import {
  RATE_LIMITED_EVERY_MS,
  RETIRED_USERNAME_REASON,
  fingerprintKey,
  normaliseTypedName,
  usernameFingerprint,
} from '@/lib/sign-in-events';

/** Where the attempt came from, as AuditLog keeps it. */
export type SignInSeen = { ip: string | null; userAgent: string | null };

const UA_MAX = 500;

function fingerprint(typed: string): { usernameHmac: string | null; keyId: string | null } {
  const k = fingerprintKey();
  return k ? { usernameHmac: usernameFingerprint(typed, k), keyId: k.keyId } : { usernameHmac: null, keyId: null };
}

/** Did an account other than `holderId` ever hold this name? (UserHistory keeps every username.) */
async function heldByAnother(typed: string, holderId: string | null): Promise<boolean> {
  const row = await prisma.userHistory.findFirst({
    where: { username: normaliseTypedName(typed), ...(holderId ? { userId: { not: holderId } } : {}) },
    select: { id: true },
  });
  return row !== null;
}

/** A failed sign-in with a name no account has now. */
export async function recordUnknownNameFailure(
  typed: string,
  reason: 'not_found' | 'demo_disabled',
  seen: SignInSeen
): Promise<void> {
  try {
    const retired = await heldByAnother(typed, null);
    await prisma.authEvent.create({
      data: {
        kind: 'LOGIN_FAIL_UNKNOWN',
        ...fingerprint(typed),
        reason: retired ? RETIRED_USERNAME_REASON : reason,
        ip: seen.ip,
        userAgent: seen.userAgent?.slice(0, UA_MAX) ?? null,
        source: src.auth('login-fail'),
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message?.slice(0, 120), reason }, 'auth_event.unknown_failed');
  }
}

/** A failed sign-in on an account whose name another account held before it. */
export async function recordReusedNameFailure(
  user: { id: string; username: string },
  seen: SignInSeen
): Promise<void> {
  try {
    if (!(await heldByAnother(user.username, user.id))) return;
    await prisma.authEvent.create({
      data: {
        kind: 'LOGIN_FAIL_REUSED_NAME',
        userId: user.id,
        ...fingerprint(user.username),
        reason: RETIRED_USERNAME_REASON,
        ip: seen.ip,
        userAgent: seen.userAgent?.slice(0, UA_MAX) ?? null,
        source: src.auth('login-fail'),
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message?.slice(0, 120) }, 'auth_event.reused_failed');
  }
}

/** This instance's last row per bucket: most refusals never reach the database. */
const lastRateLimited = new Map<string, number>();
const LAST_MAX = 5_000;

/** A sign-in refused by a throttle: the per-network ('ip') or the per-name ('user') bucket. */
export async function recordRateLimited(
  bucket: 'ip' | 'user',
  typed: string,
  seen: SignInSeen,
  now: Date = new Date()
): Promise<void> {
  try {
    const fp = fingerprint(typed);
    const bucketKey = bucket === 'ip' ? `ip:${seen.ip ?? 'unknown'}` : `user:${fp.usernameHmac ?? normaliseTypedName(typed)}`;
    const last = lastRateLimited.get(bucketKey);
    if (last !== undefined && now.getTime() - last < RATE_LIMITED_EVERY_MS) return;
    if (lastRateLimited.size >= LAST_MAX) lastRateLimited.clear();
    lastRateLimited.set(bucketKey, now.getTime());
    await withChangeContext(prisma, { actorId: null, source: src.auth('rate-limited') }, async (tx) => {
      // One writer per bucket at a time, across instances: the check and the
      // insert below cannot interleave with another instance's.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nmwc:auth-rate:${bucketKey}`}, 42))`;
      const recent = await tx.authEvent.findFirst({
        where: {
          kind: 'LOGIN_RATE_LIMITED',
          reason: bucket,
          ...(bucket === 'ip' ? { ip: seen.ip } : { usernameHmac: fp.usernameHmac }),
          at: { gt: new Date(now.getTime() - RATE_LIMITED_EVERY_MS) },
        },
        select: { id: true },
      });
      if (recent) return;
      const holder =
        bucket === 'user'
          ? await tx.user.findUnique({ where: { username: normaliseTypedName(typed) }, select: { id: true } })
          : null;
      await tx.authEvent.create({
        data: {
          kind: 'LOGIN_RATE_LIMITED',
          userId: holder?.id ?? null,
          ...fp,
          reason: bucket,
          ip: seen.ip,
          userAgent: seen.userAgent?.slice(0, UA_MAX) ?? null,
        },
      });
    });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message?.slice(0, 120), bucket }, 'auth_event.rate_limited_failed');
  }
}

/** Test seam: forget this instance's per-bucket memory. */
export function __resetRateLimitedMemory(): void {
  lastRateLimited.clear();
}
