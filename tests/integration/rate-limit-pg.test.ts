/**
 * SEC-C3 regression test — the DURABLE (Postgres) rate-limit path.
 *
 * The bug this guards: `checkLimitPg` derived `granted` from a token count that
 * was floored at >= 0, so it was ALWAYS true — the production limiter never
 * denied. The unit test (`tests/unit/rate-limit.test.ts`) only exercises the
 * in-memory path and could not catch it.
 *
 * This test drives the real Postgres SQL. It is GATED so the normal test run
 * (which has no Postgres) skips it cleanly:
 *
 *   RUN_PG_RATE_LIMIT_TEST=1 \
 *   DATABASE_URL="postgres://…"   \   # a throwaway Postgres with the RateLimit table
 *   npx vitest run tests/integration/rate-limit-pg.test.ts
 *
 * In CI, run it against a `postgres:` service container after
 * `prisma migrate deploy`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const ENABLED = process.env.RUN_PG_RATE_LIMIT_TEST === '1' && !!process.env.DATABASE_URL;

// Force the Postgres backend regardless of what another test file set on the
// shared process.env (the unit test sets RATE_LIMIT_BACKEND='memory').
let savedBackend: string | undefined;

describe.skipIf(!ENABLED)('checkLimitPg — durable Postgres token bucket', () => {
  // Imported lazily so this file never touches the DB when the suite is skipped.
  let checkLimit: typeof import('@/lib/rate-limit').checkLimit;
  let refundLimit: typeof import('@/lib/rate-limit').refundLimit;
  let prisma: typeof import('@/lib/db').prisma;
  let key: string;

  beforeAll(async () => {
    // This suite writes to the database it is pointed at: never production.
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    savedBackend = process.env.RATE_LIMIT_BACKEND;
    delete process.env.RATE_LIMIT_BACKEND; // ensure the PG path is taken
    ({ checkLimit, refundLimit } = await import('@/lib/rate-limit'));
    ({ prisma } = await import('@/lib/db'));
  });

  afterAll(async () => {
    if (savedBackend === undefined) delete process.env.RATE_LIMIT_BACKEND;
    else process.env.RATE_LIMIT_BACKEND = savedBackend;
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    key = `test:pg:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    await prisma.rateLimit.deleteMany({ where: { key } });
  });

  it('grants exactly `capacity` requests then DENIES the next', async () => {
    const cfg = { capacity: 3, refillPerSec: 0.0001 }; // negligible refill within the test
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    const denied = await checkLimit(key, cfg);
    expect(denied.ok).toBe(false); // <-- would have been `true` before the fix
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it('refills over time and grants again once a token is available', async () => {
    const cfg = { capacity: 1, refillPerSec: 1000 }; // refills ~instantly
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    // Backdate lastRefill so a full token has "elapsed".
    await prisma.rateLimit.update({
      where: { key },
      data: { lastRefill: new Date(Date.now() - 5_000) },
    });
    expect((await checkLimit(key, cfg)).ok).toBe(true);
  });

  it('two concurrent callers on a 1-token bucket: exactly one is granted', async () => {
    const cfg = { capacity: 1, refillPerSec: 0.0001 };
    const [a, b] = await Promise.all([checkLimit(key, cfg), checkLimit(key, cfg)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
  });

  it('the penalty is bounded — repeated denials never spiral the wait', async () => {
    const cfg = { capacity: 1, refillPerSec: 5 / 60 }; // login-like refill
    await checkLimit(key, cfg); // consume the token
    const first = await checkLimit(key, cfg);
    for (let i = 0; i < 5; i++) await checkLimit(key, cfg); // hammer while denied
    const later = await checkLimit(key, cfg);
    expect(first.ok).toBe(false);
    expect(later.ok).toBe(false);
    // Finding 10: a refusal costs nothing, so the wait never grows past one refill.
    expect(later.retryAfterSec).toBeLessThanOrEqual(first.retryAfterSec);
    expect(later.retryAfterSec).toBeLessThanOrEqual(Math.ceil(1 / cfg.refillPerSec));
  });

  // Code review 2026-11-10, finding 10: a refused request used to be debited to
  // -1 and re-stamp lastRefill, so while anyone behind one address kept trying,
  // the bucket never refilled and nobody got in.
  it('a refused request leaves the row exactly as it was: no token taken, the refill clock not restarted', async () => {
    const cfg = { capacity: 5, refillPerSec: 5 / 60 };
    await prisma.$executeRaw`
      INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt")
      VALUES (${key}, 0.25, NOW() - INTERVAL '3 seconds', NOW() - INTERVAL '3 seconds')`;
    const before = await prisma.rateLimit.findUnique({ where: { key } });
    for (let i = 0; i < 10; i++) expect((await checkLimit(key, cfg)).ok).toBe(false);
    const after = await prisma.rateLimit.findUnique({ where: { key } });
    expect(after!.tokens).toBe(before!.tokens);
    expect(after!.lastRefill.getTime()).toBe(before!.lastRefill.getTime());
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it('the wait a refusal answers is the real one: waiting exactly that long is granted, however many were refused meanwhile', async () => {
    const cfg = { capacity: 5, refillPerSec: 5 / 60 }; // one token every 12 s
    await prisma.$executeRaw`
      INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt") VALUES (${key}, 0, NOW(), NOW())`;
    const told = await checkLimit(key, cfg);
    expect(told.ok).toBe(false);
    expect(told.retryAfterSec).toBeGreaterThanOrEqual(11);
    expect(told.retryAfterSec).toBeLessThanOrEqual(12);
    // Others behind the same address keep trying while he waits.
    for (let i = 0; i < 20; i++) expect((await checkLimit(key, cfg)).ok).toBe(false);
    // His wait passes, on the database's clock.
    await prisma.$executeRaw`
      UPDATE "RateLimit" SET "lastRefill" = "lastRefill" - make_interval(secs => ${told.retryAfterSec}::float8)
      WHERE "key" = ${key}`;
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    expect((await checkLimit(key, cfg)).ok, 'one token, one grant').toBe(false);
  });

  it('many concurrent callers on a fresh key: exactly `capacity` are granted', async () => {
    const cfg = { capacity: 3, refillPerSec: 0.0001 };
    const results = await Promise.all(Array.from({ length: 10 }, () => checkLimit(key, cfg)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it('a bucket never grants more than capacity + elapsed x refill, refused requests or not (the guard is as strong as before)', async () => {
    const cfg = { capacity: 5, refillPerSec: 5 / 60 };
    let granted = 0;
    // Ten simulated minutes of one guess a second, the clock moved on the database.
    for (let sec = 0; sec < 600; sec++) {
      if ((await checkLimit(key, cfg)).ok) granted++;
      await prisma.$executeRaw`
        UPDATE "RateLimit" SET "lastRefill" = "lastRefill" - INTERVAL '1 second' WHERE "key" = ${key}`;
    }
    expect(granted).toBeLessThanOrEqual(5 + Math.ceil(600 * cfg.refillPerSec));
    expect(granted).toBeGreaterThanOrEqual(50); // and the steady rate is reached, not a permanent lock
  });

  // Launch browser suite: PhotoCaptureSlot waits out a presign 429 of up to
  // RATE_LIMIT_MAX_WAIT_S, counting down, then tries again by itself.
  // Finding 10: an empty photo bucket now asks for exactly one refill (30 s),
  // the real wait, and the try after it is granted.
  it('an empty photo bucket asks for the real wait, which the photo slot waits out, and the try after it is granted', async () => {
    const { PHOTO_LIMIT } = await import('@/lib/rate-limit');
    const { RATE_LIMIT_MAX_WAIT_S } = await import('@/components/nmwc/PhotoCaptureSlot');
    // As the launch suite's drainLimit leaves it: no token, refilled just now
    // (by the database's clock).
    await prisma.$executeRaw`
      INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt") VALUES (${key}, 0, NOW(), NOW())`;
    const refused = await checkLimit(key, PHOTO_LIMIT);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(refused.retryAfterSec).toBeLessThanOrEqual(Math.ceil(1 / PHOTO_LIMIT.refillPerSec));
    expect(refused.retryAfterSec).toBeLessThanOrEqual(RATE_LIMIT_MAX_WAIT_S);
    const waited = async (s: number) =>
      prisma.$executeRaw`
        UPDATE "RateLimit" SET "lastRefill" = "lastRefill" - make_interval(secs => ${s}::float8)
        WHERE "key" = ${key}`;
    await waited(Math.floor(refused.retryAfterSec / 2));
    expect((await checkLimit(key, PHOTO_LIMIT)).ok, 'half the wait is not enough').toBe(false);
    await waited(refused.retryAfterSec);
    expect((await checkLimit(key, PHOTO_LIMIT)).ok).toBe(true);
  });

  // X-AUTH-2: refundLimit, which authorize() calls on the per-network login
  // bucket when a sign-in succeeds.
  it('a refund gives back exactly one token', async () => {
    const cfg = { capacity: 3, refillPerSec: 0.0001 };
    for (let i = 0; i < 3; i++) expect((await checkLimit(key, cfg)).ok).toBe(true);
    await refundLimit(key, cfg);
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    expect((await checkLimit(key, cfg)).ok).toBe(false);
  });

  it('refunds never lift a bucket above capacity', async () => {
    const cfg = { capacity: 2, refillPerSec: 0.0001 };
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    for (let i = 0; i < 3; i++) await refundLimit(key, cfg);
    const row = await prisma.rateLimit.findUnique({ where: { key } });
    expect(row?.tokens).toBe(2);
  });

  it('a refund on a key with no row creates nothing and does not throw', async () => {
    await expect(refundLimit(key, { capacity: 5, refillPerSec: 1 })).resolves.toBeUndefined();
    expect(await prisma.rateLimit.findUnique({ where: { key } })).toBeNull();
  });

  it('a refund first refills the elapsed time, as checkLimitPg does', async () => {
    const cfg = { capacity: 5, refillPerSec: 1 };
    expect((await checkLimit(key, cfg)).ok).toBe(true);
    // Empty, last refilled two seconds ago by the DATABASE's clock, so the
    // client's clock (and any skew) plays no part.
    await prisma.$executeRaw`
      UPDATE "RateLimit" SET "tokens" = 0, "lastRefill" = NOW() - INTERVAL '2 seconds'
      WHERE "key" = ${key}`;
    await refundLimit(key, cfg);
    const row = await prisma.rateLimit.findUnique({ where: { key } });
    // 0 + ~2 s × 1/s + 1, plus however long the round trip between took — up
    // to the capacity on a slow link (local database timings are WAN-bound).
    expect(row!.tokens).toBeGreaterThanOrEqual(3);
    expect(row!.tokens).toBeLessThanOrEqual(5);
  });
});
