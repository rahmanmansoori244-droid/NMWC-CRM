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
    // tokens floored at -1 => deficit <= 2 => retry <= ceil(2 / refill).
    expect(later.retryAfterSec).toBeLessThanOrEqual(Math.ceil(2 / cfg.refillPerSec));
  });

  // Launch browser suite: PhotoCaptureSlot waits out a presign 429 of up to
  // RATE_LIMIT_MAX_WAIT_S, counting down, then tries again by itself. That
  // was 30 s, under every wait an empty photo bucket asks for, so the
  // countdown never ran.
  it('an empty photo bucket asks for 31–60 s, which the photo slot waits out, and the try after it is granted', async () => {
    const { PHOTO_LIMIT } = await import('@/lib/rate-limit');
    const { RATE_LIMIT_MAX_WAIT_S } = await import('@/components/nmwc/PhotoCaptureSlot');
    // As the launch suite's drainLimit leaves it: no token, refilled just now
    // (by the database's clock).
    await prisma.$executeRaw`
      INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt") VALUES (${key}, 0, NOW(), NOW())`;
    const refused = await checkLimit(key, PHOTO_LIMIT);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThan(30);
    expect(refused.retryAfterSec).toBeLessThanOrEqual(RATE_LIMIT_MAX_WAIT_S);
    // The slot's wait, on the database's clock: what was asked, not one refill.
    const waited = async (s: number) =>
      prisma.$executeRaw`
        UPDATE "RateLimit" SET "lastRefill" = "lastRefill" - make_interval(secs => ${s}::float8)
        WHERE "key" = ${key}`;
    await waited(30);
    expect((await checkLimit(key, PHOTO_LIMIT)).ok, 'a try after one refill is refused again').toBe(false);
    const again = await checkLimit(key, PHOTO_LIMIT);
    await waited(again.retryAfterSec);
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
