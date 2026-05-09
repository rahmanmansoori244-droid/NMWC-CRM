/**
 * In-memory rate-limiter tests. The Postgres path is exercised in production.
 * Here we set RATE_LIMIT_BACKEND=memory BEFORE importing the module so the
 * module-level constant captures it.
 */
process.env.RATE_LIMIT_BACKEND = 'memory';

import { describe, it, expect, beforeEach } from 'vitest';
import { checkLimit } from '@/lib/rate-limit';

describe('checkLimit — token bucket', () => {
  let key: string;
  beforeEach(() => {
    key = `test:${Math.random()}`;
  });

  it('grants up to capacity then refuses', async () => {
    const cfg = { capacity: 3, refillPerSec: 0.001 }; // refill is irrelevant in this test
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    const fourth = await checkLimit(key, cfg);
    expect(fourth.ok).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);
  });

  it('separate keys do not share buckets', async () => {
    const cfg = { capacity: 1, refillPerSec: 0.001 };
    expect((await checkLimit(`${key}:a`, cfg)).ok).toBe(true);
    expect((await checkLimit(`${key}:b`, cfg)).ok).toBe(true);
  });
});
