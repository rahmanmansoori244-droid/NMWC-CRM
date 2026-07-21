// @vitest-environment node
/**
 * PROMOTE-RELEASE-ON-ABORT (final-hunt #23) — promoteCustomerBatchCore atomically
 * claims a batch READY→PROMOTING but had no compensating release, so any unexpected
 * throw after the claim stranded the batch in PROMOTING forever. The fix wraps the
 * post-claim body so an abort moves the batch to FAILED (terminal/visible) + rethrows.
 *
 * We trigger a deterministic post-claim throw: promote a batch whose kind is NOT
 * CUSTOMER — the claim succeeds, then the `kind !== 'CUSTOMER'` guard throws, which
 * (before the fix) left it PROMOTING.
 *
 *   RUN_PROMOTE_RELEASE=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/promote-release-on-abort.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_PROMOTE_RELEASE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('promote releases the batch on an unexpected abort (#23)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8);
  const stewardId = `ZZPR-stew-${tag}`;
  let batchId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await prisma.user.create({ data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' } });
    // A READY batch whose kind is NOT CUSTOMER → the post-claim kind guard throws.
    const b = await prisma.importBatch.create({ data: { filename: `zz-${tag}.xlsx`, kind: 'ACCOUNT', uploadedById: stewardId, status: 'READY', totalRows: 0 } });
    batchId = b.id;
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    if (batchId) {
      await prisma.importRow.deleteMany({ where: { batchId } });
      await prisma.importBatch.deleteMany({ where: { id: batchId } });
    }
    await prisma.auditLog.deleteMany({ where: { actorId: stewardId } });
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('an abort after the READY→PROMOTING claim leaves the batch FAILED, not stranded in PROMOTING', async () => {
    const fd = new FormData();
    fd.set('batchId', batchId);
    const res = await imports.promoteCustomerBatchAction(fd);
    expect(res.ok).toBe(false); // the kind guard rejected it
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId }, select: { status: true } });
    expect(batch.status).toBe('FAILED'); // released — NOT stuck in PROMOTING
    expect(batch.status).not.toBe('PROMOTING');
  });
});
