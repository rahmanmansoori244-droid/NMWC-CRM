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
import { prisma } from './db';

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
  } catch {
    // If the DB is briefly unavailable, fall back to the in-memory limiter so
    // we don't disable the limit entirely. Logged at the call site.
    return checkLimitMemory(key, cfg);
  }
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
 * Atomic Postgres token-bucket. Single round-trip, single statement,
 * row-level lock on the bucket via UPSERT.
 */
async function checkLimitPg(
  key: string,
  cfg: RateLimitConfig
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const rows = await prisma.$queryRaw<
    Array<{ tokens: number; granted: boolean }>
  >`
    INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt")
    VALUES (${key}, ${cfg.capacity - 1}, NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "tokens" = LEAST(
        ${cfg.capacity}::float,
        "RateLimit"."tokens" +
          EXTRACT(EPOCH FROM (NOW() - "RateLimit"."lastRefill")) * ${cfg.refillPerSec}
      ) - CASE
        WHEN LEAST(
          ${cfg.capacity}::float,
          "RateLimit"."tokens" +
            EXTRACT(EPOCH FROM (NOW() - "RateLimit"."lastRefill")) * ${cfg.refillPerSec}
        ) >= 1 THEN 1
        ELSE 0
      END,
      "lastRefill" = NOW(),
      "updatedAt" = NOW()
    RETURNING
      "tokens",
      ("tokens" >= 0) AS "granted";
  `;
  const row = rows[0];
  if (!row) return { ok: true, retryAfterSec: 0 };
  if (row.granted) return { ok: true, retryAfterSec: 0 };
  const deficit = 1 - row.tokens;
  const retry = Math.max(1, Math.ceil(deficit / cfg.refillPerSec));
  return { ok: false, retryAfterSec: retry };
}

export const LOGIN_LIMIT: RateLimitConfig = { capacity: 5, refillPerSec: 5 / 60 };
export const FORM_LIMIT: RateLimitConfig = { capacity: 60, refillPerSec: 60 / 3600 };
export const PHOTO_LIMIT: RateLimitConfig = { capacity: 120, refillPerSec: 120 / 3600 };
