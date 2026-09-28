// @vitest-environment node
/**
 * Generate's queue lock (lib/locks.ts lockTemixQueue) against real Postgres: the
 * SQL the unit fakes stand in for. It must select exactly the Temix queue (live
 * PENDING_UPLOAD rows, and DEACTIVATE_PENDING rows), lock it, and take the locks in
 * byte id order, the order archive and merge lock a customer and the live holders
 * of its code in (lockCustomersAndTemixCodeHolders). Taken in any other order, the
 * two could each hold one of a pair and wait for the other (review of 023173c).
 * The ids here sort one way under a linguistic collation and another under "C",
 * so a lost COLLATE "C" shows.
 *
 * Generating a real batch would flip every queued customer in the shared test
 * database, so only the lock runs, in a transaction that writes nothing.
 *
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/temix-queue-lock.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_MERGE_TESTS === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('lockTemixQueue: the Temix queue, locked in byte id order', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let lockTemixQueue: typeof import('@/lib/locks').lockTemixQueue;
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const P = `zzq-${tag}`;
  const at = new Date();
  // In byte order an uppercase letter sorts before every lowercase one.
  const rows = [
    { id: `${P}-b`, temixSyncState: 'PENDING_UPLOAD', deletedAt: null },
    { id: `${P}-B`, temixSyncState: 'DEACTIVATE_PENDING', deletedAt: at },
    { id: `${P}-a`, temixSyncState: 'PENDING_UPLOAD', deletedAt: null },
    // Not queued: an archived row still marked PENDING_UPLOAD, a synced one, an uploaded one.
    { id: `${P}-c`, temixSyncState: 'PENDING_UPLOAD', deletedAt: at },
    { id: `${P}-d`, temixSyncState: 'SYNCED', deletedAt: null },
    { id: `${P}-e`, temixSyncState: 'UPLOADED', deletedAt: null },
  ] as const;
  const ids = rows.map((r) => r.id);

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze'))
      throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze'))
      throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    ({ lockTemixQueue } = await import('@/lib/locks'));
    for (const [i, r] of rows.entries()) {
      await prisma.customer.create({
        data: {
          id: r.id,
          nmwcCode: `ZZQ-${tag}-${i}`,
          legalName: `ZZ queue lock ${i}`,
          temixSyncState: r.temixSyncState,
          deletedAt: r.deletedAt,
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('locks exactly the queue, returns it in byte id order, and holds it to the end of the transaction', async () => {
    const mine = new Set<string>(ids);
    await prisma.$transaction(
      async (tx) => {
        const locked = await lockTemixQueue(tx);
        expect(locked).toEqual([...locked].sort());
        expect(locked.filter((id) => mine.has(id))).toEqual([`${P}-B`, `${P}-a`, `${P}-b`]);
        // Another connection cannot take a queued row now, and can take one outside the queue.
        const queued = `${P}-a`;
        const outside = `${P}-d`;
        await expect(
          prisma.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${queued} FOR UPDATE NOWAIT`
        ).rejects.toThrow(/55P03|could not obtain lock/);
        await expect(
          prisma.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${outside} FOR UPDATE NOWAIT`
        ).resolves.toHaveLength(1);
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
  });
});
