// @vitest-environment node
/**
 * PROMOTE-RELEASE-ON-ABORT (final-hunt #23, revised for RK-3) — promoteCustomerBatchCore
 * claims a batch before doing any work, so an unexpected throw after the claim must
 * never leave it holding a claim nobody owns.
 *
 * The invariant CHANGED with RK-3 (chunked/resumable promote). Promote now runs in
 * slices, so a batch that aborts part-way has real, committed work in it. Moving it to
 * FAILED (the old behaviour) would throw that half-finished master load away. Instead:
 *
 *   abort  →  the LEASE is released, status stays PROMOTING ("interrupted, resumable")
 *             and the very next call re-claims the batch and carries on.
 *
 * A stranded batch is still impossible: an unreleased lease expires by itself.
 *
 * We trigger a deterministic post-claim throw by making the first query inside the
 * claimed section fail.
 *
 *   RUN_PROMOTE_RELEASE=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/promote-release-on-abort.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_PROMOTE_RELEASE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

// Fail the FIRST query inside the claimed section exactly once, on demand.
// `vi.spyOn` cannot be used here: a Prisma model delegate does not expose its
// methods as own properties, so the spy restores as `undefined` and poisons the
// client for every later test. Wrapping the module keeps the real client intact.
let failRegionFindManyOnce = false;
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  const real = actual.prisma;
  const bind = (owner: object, value: unknown) =>
    typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(owner) : value;
  const prisma = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'region' || !value || typeof value !== 'object') return bind(target, value);
      return new Proxy(value as object, {
        get(delegate, key) {
          if (key === 'findMany' && failRegionFindManyOnce) {
            failRegionFindManyOnce = false;
            return async () => {
              throw new Error('simulated infrastructure failure');
            };
          }
          return bind(delegate, Reflect.get(delegate, key));
        },
      });
    },
  });
  return { ...actual, prisma };
});

describe.skipIf(!ENABLED)('promote releases its lease on an unexpected abort (#23 / RK-3)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8);
  const stewardId = `ZZPR-stew-${tag}`;
  let batchId = '';
  let accountBatchId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze'))
      throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await prisma.user.create({
      data: {
        id: stewardId,
        username: stewardId,
        passwordHash: 'x',
        fullName: 'ZZ Steward',
        role: 'STEWARD',
      },
    });
    const b = await prisma.importBatch.create({
      data: {
        filename: `zz-${tag}.xlsx`,
        kind: 'CUSTOMER',
        uploadedById: stewardId,
        status: 'READY',
        totalRows: 0,
      },
    });
    batchId = b.id;
    const ab = await prisma.importBatch.create({
      data: {
        filename: `zz-acct-${tag}.xlsx`,
        kind: 'ACCOUNT',
        uploadedById: stewardId,
        status: 'READY',
        totalRows: 0,
      },
    });
    accountBatchId = ab.id;
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = [batchId, accountBatchId].filter(Boolean);
    if (ids.length) {
      await prisma.importRow.deleteMany({ where: { batchId: { in: ids } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: ids } } });
    }
    await purgeAuditLog(prisma, { where: { actorId: stewardId } });
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('an abort after the claim releases the lease and leaves the batch resumable', async () => {
    // Deterministic post-claim failure: the reference-data read is the first query
    // inside the claimed section. runAction deliberately RETHROWS a non-AppError
    // (a genuine programmer/infrastructure fault) so Next.js and Sentry see it —
    // the compensating release must still have run on the way out.
    failRegionFindManyOnce = true;
    const fd = new FormData();
    fd.set('batchId', batchId);
    await expect(imports.promoteCustomerBatchAction(fd)).rejects.toThrow(/simulated/);

    const after = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { status: true, promoteLeaseBy: true, promoteLeaseUntil: true },
    });
    // The lease is GONE — nothing to wait out, the batch is immediately resumable.
    expect(after.promoteLeaseBy).toBeNull();
    expect(after.promoteLeaseUntil).toBeNull();
    // …and the batch kept its place rather than being written off as FAILED.
    expect(after.status).toBe('PROMOTING');
  });

  it('the interrupted batch can be resumed by the very next call', async () => {
    const fd = new FormData();
    fd.set('batchId', batchId);
    const res = await imports.promoteCustomerBatchAction(fd);
    expect(res.ok).toBe(true);
    // Nothing left to promote (the batch has no rows) → the resume slice finalises it.
    expect((res as { ok: true; data: { done: boolean } }).data.done).toBe(true);
    const after = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { status: true, promoteLeaseUntil: true },
    });
    expect(after.status).toBe('PROMOTED');
    expect(after.promoteLeaseUntil).toBeNull();
  });

  it('a non-CUSTOMER batch is rejected WITHOUT ever being claimed', async () => {
    const fd = new FormData();
    fd.set('batchId', accountBatchId);
    const res = await imports.promoteCustomerBatchAction(fd);
    expect(res.ok).toBe(false);
    // The kind guard runs before the claim, so an account batch is never dragged
    // into PROMOTING (a state only the customer resume path knows how to clear).
    const after = await prisma.importBatch.findUniqueOrThrow({
      where: { id: accountBatchId },
      select: { status: true, promoteLeaseUntil: true },
    });
    expect(after.status).toBe('READY');
    expect(after.promoteLeaseUntil).toBeNull();
  });
});
