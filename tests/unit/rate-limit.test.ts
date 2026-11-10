/**
 * In-memory rate-limiter tests. The Postgres path is exercised in production.
 * Here we set RATE_LIMIT_BACKEND=memory BEFORE importing the module so the
 * module-level constant captures it.
 */
process.env.RATE_LIMIT_BACKEND = 'memory';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** The durable backend, replaced: these tests never reach a database. */
  executeRaw: vi.fn(async (..._args: unknown[]): Promise<number> => 0),
}));
vi.mock('@/lib/db', () => ({ prisma: { $executeRaw: h.executeRaw } }));

import { checkLimit, rateLimitKeyKind, refundLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

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

describe('refundLimit — X-AUTH-2 gives back one charged token', () => {
  // The in-memory bucket reads Date.now(); a frozen clock makes its refill exact.
  const T0 = new Date(Date.UTC(2020, 0, 1));
  let key: string;
  beforeEach(() => {
    key = `test:refund:${Math.random()}`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const at = (sec: number) => vi.setSystemTime(new Date(T0.getTime() + sec * 1000));

  /** How many requests the bucket grants at this instant. Drains it, so call it last. */
  async function grantsNow(k: string, cfg: { capacity: number; refillPerSec: number }) {
    let n = 0;
    while ((await checkLimit(k, cfg)).ok) {
      n += 1;
      if (n > cfg.capacity) throw new Error('the bucket granted more than its capacity');
    }
    return n;
  }

  it('a charge and its refund leave the bucket where it was', async () => {
    const cfg = { capacity: 5, refillPerSec: 5 / 60 };
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    await refundLimit(key, cfg);
    expect(await grantsNow(key, cfg)).toBe(5);
  });

  it('is capped at capacity: refunds never add tokens nobody was charged', async () => {
    const cfg = { capacity: 3, refillPerSec: 0.001 };
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    await refundLimit(key, cfg);
    await refundLimit(key, cfg);
    await refundLimit(key, cfg);
    expect(await grantsNow(key, cfg)).toBe(3);
  });

  it('refills the elapsed time as checkLimit would, then adds the one token', async () => {
    const cfg = { capacity: 5, refillPerSec: 1 };
    expect(await grantsNow(key, cfg)).toBe(5); // empty at T0
    at(2);
    await refundLimit(key, cfg); // 0 + 2 s × 1/s + 1
    expect(await grantsNow(key, cfg)).toBe(3);
  });

  it('a refund after a long wait still stops at capacity', async () => {
    const cfg = { capacity: 5, refillPerSec: 1 };
    expect(await grantsNow(key, cfg)).toBe(5);
    at(10);
    await refundLimit(key, cfg); // min(5, 0 + 10 + 1)
    expect(await grantsNow(key, cfg)).toBe(5);
  });

  it('a key with no bucket: nothing to give back, nothing created, no throw', async () => {
    const cfg = { capacity: 4, refillPerSec: 0.001 };
    await expect(refundLimit(key, cfg)).resolves.toBeUndefined();
    expect(await grantsNow(key, cfg)).toBe(4);
  });
});

describe('refundLimit on the durable backend', () => {
  const SAVED = { backend: process.env.RATE_LIMIT_BACKEND, db: process.env.DATABASE_URL };
  beforeEach(() => {
    delete process.env.RATE_LIMIT_BACKEND;
    // Selects the Postgres path; prisma is replaced above, so nothing connects.
    process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:5432/unit';
    h.executeRaw.mockReset();
  });
  afterEach(() => {
    if (SAVED.backend === undefined) delete process.env.RATE_LIMIT_BACKEND;
    else process.env.RATE_LIMIT_BACKEND = SAVED.backend;
    if (SAVED.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = SAVED.db;
    vi.restoreAllMocks();
  });

  it('is one UPDATE of the existing row, never an INSERT that would create one', async () => {
    h.executeRaw.mockResolvedValue(0); // no such row: nothing updated, nothing thrown
    await expect(refundLimit('login:ip:10.0.0.9', { capacity: 5, refillPerSec: 5 / 60 })).resolves.toBeUndefined();
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = h.executeRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/^\s*UPDATE "RateLimit" SET/);
    expect(sql).not.toMatch(/\bINSERT\b/);
    expect(sql).toMatch(/WHERE "key" = \?/);
    expect(sql).toMatch(/LEAST\(\s*\?::float/);
    expect(values).toEqual([5, 5 / 60, 'login:ip:10.0.0.9']);
  });

  it('a backend failure is logged and swallowed, never thrown into the caller', async () => {
    h.executeRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(refundLimit('login:ip:10.0.0.9', { capacity: 5, refillPerSec: 5 / 60 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ key: 'login:ip:10.0.0.9' }), 'rate-limit.refund.failed');
  });
});

// Code review 2026-11-10, finding 22, second round: a fail-closed refusal says
// it is one (`unavailable`), so a caller need not call it "too many attempts",
// and it is logged at the level a failed refund is.
describe('checkLimit when the durable store cannot be reached', () => {
  const SAVED = { backend: process.env.RATE_LIMIT_BACKEND, db: process.env.DATABASE_URL };
  const cfg = { capacity: 5, refillPerSec: 5 / 60 };
  beforeEach(() => {
    delete process.env.RATE_LIMIT_BACKEND;
    process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:5432/unit';
  });
  afterEach(() => {
    if (SAVED.backend === undefined) delete process.env.RATE_LIMIT_BACKEND;
    else process.env.RATE_LIMIT_BACKEND = SAVED.backend;
    if (SAVED.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = SAVED.db;
    vi.restoreAllMocks();
  });

  it.each([
    ['pwchange:user:u1', 'pwchange:user'],
    ['login:user:c4', 'login:user'],
    ['login:ip:203.0.113.7', 'login:ip'],
    ['passwordreset:u1', 'passwordreset'],
  ])(
    '%s still fails closed, marked unavailable, with a warning that names the kind of key, never the key',
    async (key, kind) => {
      // The mocked client has no $queryRaw: the durable statement throws.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      expect(await checkLimit(key, cfg)).toEqual({ ok: false, retryAfterSec: 30, unavailable: true });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ keyKind: kind }), 'rate-limit.store.unavailable');
      // Third round: the typed username or the IP is not in the log line.
      const [fields] = warn.mock.calls.find((c) => c[1] === 'rate-limit.store.unavailable')! as [Record<string, unknown>];
      expect(fields).not.toHaveProperty('key');
      expect(JSON.stringify(fields)).not.toContain(key.split(':').at(-1));
    }
  );

  it('rateLimitKeyKind: the kind of every key, and "other" for the rest', () => {
    expect(rateLimitKeyKind('login:user:someone')).toBe('login:user');
    expect(rateLimitKeyKind('login:ip:198.51.100.1')).toBe('login:ip');
    expect(rateLimitKeyKind('passwordreset:x')).toBe('passwordreset');
    expect(rateLimitKeyKind('pwchange:user:u1')).toBe('pwchange:user');
    expect(rateLimitKeyKind('form:abc')).toBe('other');
  });

  it('a key that is not security-critical still falls back to memory, unmarked', async () => {
    const res = await checkLimit(`form:${Math.random()}`, cfg);
    expect(res).toEqual({ ok: true, retryAfterSec: 0 });
  });
});
