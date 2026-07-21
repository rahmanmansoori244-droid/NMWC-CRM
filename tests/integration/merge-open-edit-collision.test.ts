// @vitest-environment node
/**
 * MERGE-OPEN-EDIT-COLLISION (final-hunt #31) — merging two customers that BOTH have
 * an open (SUBMITTED) CustomerEdit used to abort with an opaque P2002: reparenting
 * the loser's SUBMITTED edit onto the winner violated CustomerEdit_open_per_customer
 * (customerId WHERE state='SUBMITTED'). The fix auto-rejects the loser's open edit
 * (its identity is merged away) before reparenting, so the merge completes.
 *
 *   RUN_MERGE_OPEN=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/merge-open-edit-collision.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_MERGE_OPEN === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('merge completes when BOTH customers have an open edit (#31)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let dupes: typeof import('@/services/duplicates');
  const tag = randomUUID().slice(0, 8);
  const ids = { region: '', route: '', steward: `ZZMO-stew-${tag}`, sales: `ZZMO-sales-${tag}`, winner: '', loser: '', winnerEdit: '', loserEdit: '' };

  async function mkOpenEdit(customerId: string, branchId: string) {
    const e = await prisma.customerEdit.create({
      data: {
        target: 'BRANCH', customerId, branchId, state: 'SUBMITTED', submittedById: ids.sales,
        submittedAt: new Date(), pendingRole: 'SUPERVISOR',
        fieldChanges: [{ field: `branch.${branchId}.openingHours`, before: null, after: '08:00-20:00' }] as never,
        attachmentChanges: [] as never,
      },
    });
    return e.id;
  }

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    dupes = await import('@/services/duplicates');
    const region = await prisma.region.create({ data: { name: `ZZMO R ${tag}`, code: `ZZMO-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZMO Rt ${tag}`, code: `ZZMO-RT-${tag}`, regionId: region.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.steward, username: ids.steward, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' } });
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: route.id } });
    const w = await prisma.customer.create({ data: { nmwcCode: `ZZMO-W-${tag}`, legalName: 'ZZ Winner', paymentTerms: 'CASH', createdById: ids.steward } });
    const l = await prisma.customer.create({ data: { nmwcCode: `ZZMO-L-${tag}`, legalName: 'ZZ Loser', paymentTerms: 'CASH', createdById: ids.steward } });
    ids.winner = w.id; ids.loser = l.id;
    const wb = await prisma.branch.create({ data: { customerId: w.id, branchCode: `ZZMO-W-${tag}-01`, branchName: 'W', address: 'ZZ Way 1', routeId: route.id, regionId: region.id, status: 'ACTIVE' } });
    const lb = await prisma.branch.create({ data: { customerId: l.id, branchCode: `ZZMO-L-${tag}-01`, branchName: 'L', address: 'ZZ Way 2', routeId: route.id, regionId: region.id, status: 'ACTIVE' } });
    // BOTH sides have an OPEN (SUBMITTED) edit — the collision trigger.
    ids.winnerEdit = await mkOpenEdit(w.id, wb.id);
    ids.loserEdit = await mkOpenEdit(l.id, lb.id);
    current = { id: ids.steward, role: 'STEWARD', username: ids.steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custIds = [ids.winner, ids.loser];
      await prisma.customerEdit.deleteMany({ where: { customerId: { in: custIds } } });
      await prisma.auditLog.deleteMany({ where: { actorId: ids.steward } });
      await prisma.branch.deleteMany({ where: { customerId: { in: custIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
      await prisma.user.deleteMany({ where: { id: { in: [ids.steward, ids.sales] } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) { console.error('cleanup', e); }
    await prisma.$disconnect();
  });

  it('merge succeeds; loser open edit auto-rejected + reparented; winner keeps its open edit', async () => {
    const fd = new FormData();
    fd.set('winnerId', ids.winner);
    fd.set('loserId', ids.loser);
    fd.set('reason', 'Same shop entered twice — merging.');
    const res = await dupes.mergeCustomersAction(fd);
    if (!res.ok) console.error('MERGE FAILED', JSON.stringify(res));
    expect(res.ok).toBe(true);

    // loser's edit: reparented onto the winner AND terminated (REJECTED)
    const loserEdit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: ids.loserEdit }, select: { customerId: true, state: true, pendingRole: true } });
    expect(loserEdit.customerId).toBe(ids.winner);
    expect(loserEdit.state).toBe('REJECTED');
    expect(loserEdit.pendingRole).toBeNull();

    // winner's own edit: still SUBMITTED on the winner
    const winnerEdit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: ids.winnerEdit }, select: { customerId: true, state: true } });
    expect(winnerEdit.customerId).toBe(ids.winner);
    expect(winnerEdit.state).toBe('SUBMITTED');

    // exactly ONE SUBMITTED edit on the winner (the index invariant holds)
    const openOnWinner = await prisma.customerEdit.count({ where: { customerId: ids.winner, state: 'SUBMITTED' } });
    expect(openOnWinner).toBe(1);

    // the loser is archived
    const loser = await prisma.customer.findUniqueOrThrow({ where: { id: ids.loser }, select: { deletedAt: true } });
    expect(loser.deletedAt).not.toBeNull();
  });
});
