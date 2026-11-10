/**
 * Token-bucket rate limiter.
 *
 * Two backends:
 *   - In-memory  (for unit tests + dev fast path)
 *   - PostgreSQL (durable across Vercel function instances)
 *
 * QA-006/QA-015: the in-memory implementation is per-Lambda and useless on
 * serverless. The Postgres implementation uses a single `INSERT ... ON CONFLICT
 * DO UPDATE ... RETURNING` so refill + decrement are atomic against concurrent
 * callers in any region.
 *
 * Public API stays the same: `await checkLimit(key, cfg)` returns `{ ok,
 * retryAfterSec }`. Existing call sites continue to work; behaviour upgrades
 * automatically when DATABASE_URL is set.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { logger } from './logger';

type Bucket = { tokens: number; lastRefill: number };

const memBuckets = new Map<string, Bucket>();

export type RateLimitConfig = {
  capacity: number;
  refillPerSec: number;
};

export async function checkLimit(
  key: string,
  cfg: RateLimitConfig
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const forceMemory = process.env.RATE_LIMIT_BACKEND === 'memory';
  if (forceMemory || !process.env.DATABASE_URL) {
    return checkLimitMemory(key, cfg);
  }
  try {
    return await checkLimitPg(key, cfg);
  } catch (err) {
    // GAP-12: when the durable backend is unreachable, the per-Lambda
    // in-memory limiter is effectively no protection (each cold start has a
    // fresh map). For SECURITY-CRITICAL keys (login, password reset) fail
    // CLOSED — a brief 503 is far better than uncapped brute-force. For
    // non-critical limits (form rate, photo serve) fall through to the
    // in-memory limiter so legitimate users keep working.
    const isSecurityCritical =
      key.startsWith('login:') ||
      key.startsWith('passwordreset:') ||
      key.startsWith(PASSWORD_CHANGE_KEY_PREFIX);
    if (isSecurityCritical) {
      return { ok: false, retryAfterSec: 30 };
    }
    void err;
    return checkLimitMemory(key, cfg);
  }
}

/**
 * PERF (audit #24): in-memory-only limiter for HIGH-FREQUENCY, non-security
 * paths (photo serving). The durable Postgres bucket costs a DB write per call —
 * a page with 6 photos paid 6 serialized bucket writes before a single byte
 * streamed. Per-lambda memory is plenty for DoS shaping here (a determined
 * abuser is still capped per warm instance, and photo access is behind auth +
 * scope anyway). NEVER use this for login/reset — those stay durable+fail-closed.
 */
export function checkLimitLocal(
  key: string,
  cfg: RateLimitConfig
): { ok: boolean; retryAfterSec: number } {
  return checkLimitMemory(key, cfg);
}

function checkLimitMemory(
  key: string,
  cfg: RateLimitConfig
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = memBuckets.get(key) ?? { tokens: cfg.capacity, lastRefill: now };
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec);
  b.lastRefill = now;
  if (b.tokens < 1) {
    memBuckets.set(key, b);
    const retry = Math.ceil((1 - b.tokens) / cfg.refillPerSec);
    return { ok: false, retryAfterSec: Math.max(1, retry) };
  }
  b.tokens -= 1;
  memBuckets.set(key, b);
  return { ok: true, retryAfterSec: 0 };
}

/**
 * Durable Postgres token bucket.
 *
 * Code review 2026-11-10, finding 10: a REFUSED request leaves the bucket
 * exactly as it was — no token taken, refill clock not restarted. It used to be
 * debited to a floor of -1 and re-stamped (one statement for grant and refusal
 * alike), so while a shared address kept retrying the bucket never refilled: a
 * room of people on one office Wi-Fi each told "try again in 24s" could lock
 * itself out indefinitely, and the wait a refused person was told was false
 * whenever anyone else was waiting too. Now the number of requests a bucket
 * grants in any window of T seconds is still at most capacity + T x refill —
 * the same ceiling as before, for any caller, however it paces itself — and the
 * wait it answers is the real time until the next token.
 *
 * Three statements at most, each atomic on the row:
 *   1. take a token from an existing bucket that holds a whole one (an UPDATE
 *      whose WHERE Postgres re-checks on the newest row version after waiting
 *      for a concurrent writer's lock, so two callers never share one token);
 *   2. no row: create a full bucket less this request's token (a concurrent
 *      creator wins the race and this caller goes round again);
 *   3. a row with no whole token: read how long until one, write nothing.
 * The SEC-C3 regression (a limiter that granted everything) cannot come back
 * through here: a grant is a row returned by a statement whose WHERE demands a
 * whole token, never a value derived from a floored count.
 */
async function checkLimitPg(
  key: string,
  cfg: RateLimitConfig
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const refilled = Prisma.sql`LEAST(
    ${cfg.capacity}::float,
    "RateLimit"."tokens" +
      EXTRACT(EPOCH FROM (NOW() - "RateLimit"."lastRefill"))::float * ${cfg.refillPerSec}::float
  )`;
  for (let round = 0; round < 3; round += 1) {
    const taken = await prisma.$queryRaw<Array<{ tokens: number }>>`
      UPDATE "RateLimit" SET
        "tokens" = ${refilled} - 1,
        "lastRefill" = NOW(),
        "updatedAt" = NOW()
      WHERE "key" = ${key} AND ${refilled} >= 1
      RETURNING "tokens";
    `;
    if (taken.length > 0) return { ok: true, retryAfterSec: 0 };
    const created = await prisma.$queryRaw<Array<{ tokens: number }>>`
      INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt")
      VALUES (${key}, ${cfg.capacity - 1}, NOW(), NOW())
      ON CONFLICT ("key") DO NOTHING
      RETURNING "tokens";
    `;
    if (created.length > 0) return { ok: true, retryAfterSec: 0 };
    const rows = await prisma.$queryRaw<Array<{ refilled: number }>>`
      SELECT ${refilled} AS "refilled" FROM "RateLimit" WHERE "key" = ${key};
    `;
    const now = rows[0]?.refilled;
    // Gone again (a purge), or a token arrived since statement 1: go round.
    if (now === undefined || now === null || Number(now) >= 1) continue;
    const retry = Math.ceil((1 - Number(now)) / cfg.refillPerSec);
    return { ok: false, retryAfterSec: Math.max(1, retry) };
  }
  // Three rounds without an answer means the row is being fought over: refuse
  // for a second rather than grant on a guess.
  return { ok: false, retryAfterSec: 1 };
}

/**
 * X-AUTH-2: give back the one token checkLimit() charged a request that turned
 * out not to be what the bucket counts. authorize() (lib/auth.ts) refunds the
 * per-network login bucket when a sign-in SUCCEEDS, so that bucket in effect
 * counts failed sign-ins only.
 *
 * The bucket is refilled exactly as checkLimit would refill it at this instant,
 * then given one token, capped at capacity. A key with no bucket is a full
 * bucket: there is nothing to give back, and nothing is created.
 *
 * Never throws. A refund that could not be written leaves the token spent — what
 * every request cost before refunds existed — so the failure is logged and the
 * caller carries on; a sign-in that has already succeeded is not failed over it.
 */
export async function refundLimit(key: string, cfg: RateLimitConfig): Promise<void> {
  try {
    const forceMemory = process.env.RATE_LIMIT_BACKEND === 'memory';
    if (forceMemory || !process.env.DATABASE_URL) {
      refundLimitMemory(key, cfg);
      return;
    }
    await refundLimitPg(key, cfg);
  } catch (err) {
    // No in-memory fallback, unlike checkLimit: the token was taken from the
    // durable bucket, and a per-Lambda map has nothing to give back.
    logger.warn({ err: String(err), key }, 'rate-limit.refund.failed');
  }
}

function refundLimitMemory(key: string, cfg: RateLimitConfig): void {
  const b = memBuckets.get(key);
  if (!b) return;
  const now = Date.now();
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec + 1);
  b.lastRefill = now;
}

/**
 * One UPDATE, so it is atomic against a concurrent checkLimitPg on the same row
 * (both take the row lock). Not an UPSERT: a missing row is a full bucket and
 * must stay missing. The refill expression is checkLimitPg's.
 */
async function refundLimitPg(key: string, cfg: RateLimitConfig): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "RateLimit" SET
      "tokens" = LEAST(
        ${cfg.capacity}::float,
        "RateLimit"."tokens" +
          EXTRACT(EPOCH FROM (NOW() - "RateLimit"."lastRefill")) * ${cfg.refillPerSec} + 1
      ),
      "lastRefill" = NOW(),
      "updatedAt" = NOW()
    WHERE "key" = ${key};
  `;
}

/**
 * The sign-in buckets (lib/auth.ts authorize()). Every number is named here so
 * the owner can see and change them in one place (code review 2026-11-10,
 * finding 10).
 *
 * Per ACCOUNT (`login:user:<name>`): the brute-force control. Every attempt
 * costs a token, success or not, from whatever address. Unchanged by finding
 * 10: at most LOGIN_USER_CAPACITY + LOGIN_USER_REFILL_PER_MIN password checks
 * per minute of any window, for any attacker, however he paces himself.
 */
export const LOGIN_USER_CAPACITY = 5;
export const LOGIN_USER_REFILL_PER_MIN = 5;
/**
 * Per NETWORK ADDRESS (`login:ip:<ip>`): counts FAILED sign-ins only (a success,
 * or an attempt the per-account bucket refused, gives its token back). Much
 * larger than the per-account bucket, because a whole office or depot can sit
 * behind one address: a hand-out morning of 60 people typing new passwords on
 * phones makes a few dozen typos in a few minutes. Its refill rate is the old
 * one, so an address spraying guesses across many accounts is held to the same
 * long-run rate as before; only the burst it may start with is larger.
 */
export const LOGIN_NETWORK_CAPACITY = 30;
export const LOGIN_NETWORK_REFILL_PER_MIN = 5;

/**
 * The change-password form's guesses at the CURRENT password (services/password.ts,
 * code review 2026-11-10, finding 22). Charged on every attempt and given back
 * when the change goes through, so it counts failed attempts only: at most
 * PASSWORD_CHANGE_CAPACITY + PASSWORD_CHANGE_REFILL_PER_MIN a minute, per account.
 * Before it the form had no limit at all; it needs one now because a refused
 * attempt also compares the NEW password with the stored one (a reply lost after
 * the change was saved), so each attempt can test two candidates. Fails closed.
 */
export const PASSWORD_CHANGE_CAPACITY = 5;
export const PASSWORD_CHANGE_REFILL_PER_MIN = 5;
export const PASSWORD_CHANGE_KEY_PREFIX = 'pwchange:user:';
export const PASSWORD_CHANGE_LIMIT: RateLimitConfig = {
  capacity: PASSWORD_CHANGE_CAPACITY,
  refillPerSec: PASSWORD_CHANGE_REFILL_PER_MIN / 60,
};

/** The per-account sign-in bucket. */
export const LOGIN_LIMIT: RateLimitConfig = {
  capacity: LOGIN_USER_CAPACITY,
  refillPerSec: LOGIN_USER_REFILL_PER_MIN / 60,
};
/** The per-network-address sign-in bucket (failures only). */
export const LOGIN_NETWORK_LIMIT: RateLimitConfig = {
  capacity: LOGIN_NETWORK_CAPACITY,
  refillPerSec: LOGIN_NETWORK_REFILL_PER_MIN / 60,
};
export const FORM_LIMIT: RateLimitConfig = { capacity: 60, refillPerSec: 60 / 3600 };
export const PHOTO_LIMIT: RateLimitConfig = { capacity: 120, refillPerSec: 120 / 3600 };
/**
 * Owner decisions 2026-10-11 (part C): recording a print (services/prints.ts).
 * Light — a print is a read with an audit row — and its own bucket, so a Manager
 * printing a morning's applications never spends the decisions' FORM_LIMIT.
 */
export const PRINT_LIMIT: RateLimitConfig = { capacity: 120, refillPerSec: 120 / 3600 };
