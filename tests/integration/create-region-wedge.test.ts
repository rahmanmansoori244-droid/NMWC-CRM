// @vitest-environment node
/**
 * CREATE-REGION-WEDGE (final-hunt #7/#15, RK-2) — a net-new CREATE request's approval
 * VISIBILITY must follow the draft's CURRENT route region, not the frozen
 * EditBranchDraft.regionId snapshot. If a route is re-regioned mid-chain, the request
 * must move to the NEW region's Accountant queue (who alone can approve) and leave the
 * OLD region's. This exercises the exact OR-clause the accountant queue page uses.
 *
 *   RUN_REGION_WEDGE=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/create-region-wedge.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_REGION_WEDGE === '1' && !!process.env.DATABASE_URL;

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('CREATE approval visibility follows the current route region (#7/#15)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const ids = { regionA: '', regionB: '', route: '', sales: `ZZRW-sales-${tag}`, edit: '' };

  // The exact accountant-queue OR-clause from app/(app)/work + approvals pages.
  const acctWhere = (managed: string[]) => ({
    state: 'SUBMITTED' as const,
    pendingRole: 'ACCOUNTANT' as const,
    OR: [
      { customer: { branches: { some: { regionId: { in: managed }, deletedAt: null } } } },
      { branchDrafts: { some: { route: { regionId: { in: managed } } } } },
    ],
  });
  const seesEdit = async (managed: string[]) =>
    (await prisma.customerEdit.count({ where: { id: ids.edit, ...acctWhere(managed) } })) === 1;

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    const rA = await prisma.region.create({ data: { name: `ZZRW A ${tag}`, code: `ZZRWA-${tag}` } });
    const rB = await prisma.region.create({ data: { name: `ZZRW B ${tag}`, code: `ZZRWB-${tag}` } });
    ids.regionA = rA.id; ids.regionB = rB.id;
    const route = await prisma.route.create({ data: { name: `ZZRW Rt ${tag}`, code: `ZZRW-RT-${tag}`, regionId: rA.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: route.id } });
    // A CREATE request sitting at the ACCOUNTANT step, with a branch draft on the
    // route (frozen regionId = A, matching route's region A at submit time).
    const edit = await prisma.customerEdit.create({
      data: {
        process: 'CREATE', customerId: null, target: 'CUSTOMER', state: 'SUBMITTED',
        submittedById: ids.sales, submittedAt: new Date(), pendingRole: 'ACCOUNTANT',
        fieldChanges: [] as never, attachmentChanges: [] as never,
        branchDrafts: { create: [{ branchName: 'ZZ RW Branch', regionId: rA.id, routeId: route.id, address: 'ZZ Way 1, Region A' }] },
      },
    });
    ids.edit = edit.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.editBranchDraft.deleteMany({ where: { editId: ids.edit } });
      await prisma.customerEdit.deleteMany({ where: { id: ids.edit } });
      await prisma.user.deleteMany({ where: { id: ids.sales } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.regionA, ids.regionB] } } });
    } catch (e) { console.error('cleanup', e); }
    await prisma.$disconnect();
  });

  it('before re-region: region-A accountant sees it, region-B does not', async () => {
    expect(await seesEdit([ids.regionA])).toBe(true);
    expect(await seesEdit([ids.regionB])).toBe(false);
  });

  it('after re-regioning the route to B: region-B accountant sees it, region-A does not', async () => {
    await prisma.route.update({ where: { id: ids.route }, data: { regionId: ids.regionB } });
    // The frozen draft column is UNCHANGED (still region A) — the fix must use the
    // route's current region, not this snapshot.
    const draft = await prisma.editBranchDraft.findFirstOrThrow({ where: { editId: ids.edit }, select: { regionId: true } });
    expect(draft.regionId).toBe(ids.regionA); // frozen snapshot, deliberately stale
    // Visibility now follows the CURRENT route region (B), so B sees it and A does not.
    expect(await seesEdit([ids.regionB])).toBe(true);
    expect(await seesEdit([ids.regionA])).toBe(false);
  });
});
