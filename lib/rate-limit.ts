/**
 * In-memory token-bucket rate limiter.
 * For v1 with one Vercel region, the in-process map works. For multi-region or
 * heavy traffic, swap with Upstash Redis later.
 */

type Bucket = { tokens: number; lastRefill: number };

const buckets = new Map<string, Bucket>();

export type RateLimitConfig = {
  capacity: number;
  refillPerSec: number;
};

export function checkLimit(key: string, cfg: RateLimitConfig): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: cfg.capacity, lastRefill: now };
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec);
  b.lastRefill = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    const retry = Math.ceil((1 - b.tokens) / cfg.refillPerSec);
    return { ok: false, retryAfterSec: Math.max(1, retry) };
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return { ok: true, retryAfterSec: 0 };
}

export const LOGIN_LIMIT: RateLimitConfig = { capacity: 5, refillPerSec: 5 / 60 }; // 5 per minute
export const FORM_LIMIT: RateLimitConfig = { capacity: 60, refillPerSec: 60 / 3600 }; // 60 per hour
export const PHOTO_LIMIT: RateLimitConfig = { capacity: 120, refillPerSec: 120 / 3600 }; // 120 per hour
