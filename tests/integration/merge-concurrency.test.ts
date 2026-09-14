// @vitest-environment node
/**
 * PROD-DUP-01 regression — concurrent reversed-pair customer merge.
 *
 * Bug: merge claims the LOSER atomically but never locks/re-validates the WINNER,
 * so merge(A,B) racing merge(B,A) each claim a different loser row and BOTH
 * customers get soft-deleted, stranding live branches under deleted parents.
 * Fix: sorted FOR UPDATE lock on both rows + in-tx liveness re-check.
 *
 * GATED; isolated QA branch only; ZZMERGE- synthetic rows cleaned in afterAll.
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/merge-concurrency.test.ts
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_MERGE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const P = 'ZZMERGE';
const ids = {
  steward: `${P}-steward`, region: `${P}-region`, route: `${P}-route`,
  custA: `${P}-A`, custB: `${P}-B`, brA: `${P}-brA`, brB: `${P}-brB`,
};

describe.skipIf(!ENABLED)('PROD-DUP-01: concurrent reversed-pair merge', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let dups: typeof import('@/services/duplicates');

  async function cleanup() {
    await purgeAuditLog(prisma, { where: { actorId: ids.steward } });
    await prisma.branch.deleteMany({ where: { id: { in: [ids.brA, ids.brB] } } });
    await prisma.customer.deleteMany({ where: { id: { in: [ids.custA, ids.custB] } } });
    await prisma.route.deleteMany({ where: { id: ids.route } });
    await prisma.region.deleteMany({ where: { id: ids.region } });
    await prisma.user.deleteMany({ where: { id: ids.steward } });
  }

  beforeEach(async () => {
    if (!ENABLED) return;
    if (!prisma) {
      ({ prisma } = await import('@/lib/db'));
      dups = await import('@/services/duplicates');
    }
    await cleanup();
    await prisma.user.create({ data: { id: ids.steward, username: ids.steward, passwordHash: 'x', fullName: 'ZZ Merge Steward', role: 'STEWARD' } });
    await prisma.region.create({ data: { id: ids.region, code: `${P}-${randomUUID().slice(0, 6)}`, name: 'ZZ Merge Region' } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}RT-${randomUUID().slice(0, 6)}`, name: 'ZZ Merge Route', regionId: ids.region } });
    await prisma.customer.create({ data: { id: ids.custA, nmwcCode: `${P}-A-${randomUUID().slice(0, 6)}`, legalName: 'ZZ Cust A' } });
    await prisma.customer.create({ data: { id: ids.custB, nmwcCode: `${P}-B-${randomUUID().slice(0, 6)}`, legalName: 'ZZ Cust B' } });
    // both branches in the SAME region → no cross-region confirmation gate
    await prisma.branch.create({ data: { id: ids.brA, customerId: ids.custA, branchCode: `${P}-A-01`, branchName: 'A main', regionId: ids.region, routeId: ids.route, address: 'ZZ addr A' } });
    await prisma.branch.create({ data: { id: ids.brB, customerId: ids.custB, branchCode: `${P}-B-01`, branchName: 'B main', regionId: ids.region, routeId: ids.route, address: 'ZZ addr B' } });
    current = { id: ids.steward, role: 'STEWARD', username: ids.steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  });

  it('merge(A,B) racing merge(B,A) leaves EXACTLY ONE live customer, no stranded branches', async () => {
    const fd = (winnerId: string, loserId: string) => {
      const f = new FormData(); f.set('winnerId', winnerId); f.set('loserId', loserId); return f;
    };
    const [r1, r2] = await Promise.all([
      dups.mergeCustomersAction(fd(ids.custA, ids.custB)),
      dups.mergeCustomersAction(fd(ids.custB, ids.custA)),
    ]);
    const oks = [r1, r2].filter((r) => r.ok).length;
    // exactly one merge may win; the other must abort cleanly
    expect(oks).toBe(1);

    // exactly one of the pair remains live
    const live = await prisma.customer.findMany({
      where: { id: { in: [ids.custA, ids.custB] }, deletedAt: null }, select: { id: true },
    });
    expect(live.length).toBe(1);

    // both branches survive and point at the SURVIVING (non-deleted) customer —
    // no branch stranded under a deleted parent
    const branches = await prisma.branch.findMany({
      where: { id: { in: [ids.brA, ids.brB] }, deletedAt: null },
      include: { customer: { select: { deletedAt: true } } },
    });
    expect(branches.length).toBe(2);
    for (const b of branches) {
      expect(b.customerId).toBe(live[0].id);
      expect(b.customer.deletedAt).toBeNull();
    }
  });

  it('cross-region merge: refused without confirm, succeeds WITH confirmCrossRegion+reason (SR-UI-01 server side)', async () => {
    // put B's branch in a DIFFERENT region so the merge is cross-region
    const region2 = `${P}-region2`;
    const route2 = `${P}-route2`;
    await prisma.region.create({ data: { id: region2, code: `${P}2-${randomUUID().slice(0, 6)}`, name: 'ZZ Region 2' } });
    await prisma.route.create({ data: { id: route2, code: `${P}2RT-${randomUUID().slice(0, 6)}`, name: 'ZZ Route 2', regionId: region2 } });
    await prisma.branch.update({ where: { id: ids.brB }, data: { regionId: region2, routeId: route2 } });

    const bare = new FormData(); bare.set('winnerId', ids.custA); bare.set('loserId', ids.custB);
    const refused = await dups.mergeCustomersAction(bare);
    expect(refused.ok).toBe(false); // needs confirmation

    const ok = new FormData();
    ok.set('winnerId', ids.custA); ok.set('loserId', ids.custB);
    ok.set('confirmCrossRegion', 'yes'); ok.set('reason', 'same legal entity, verified');
    const done = await dups.mergeCustomersAction(ok);
    expect(done.ok).toBe(true);
    const b = await prisma.customer.findUnique({ where: { id: ids.custB } });
    expect(b?.deletedAt).not.toBeNull(); // loser archived
    // cleanup the extra region/route (branches now under custA)
    await prisma.branch.updateMany({ where: { routeId: route2 }, data: { routeId: ids.route, regionId: ids.region } });
    await prisma.route.deleteMany({ where: { id: route2 } });
    await prisma.region.deleteMany({ where: { id: region2 } });
  });

  it('sequential double-merge of the same pair: the second is refused', async () => {
    const f1 = new FormData(); f1.set('winnerId', ids.custA); f1.set('loserId', ids.custB);
    const r1 = await dups.mergeCustomersAction(f1);
    expect(r1.ok).toBe(true);
    const f2 = new FormData(); f2.set('winnerId', ids.custA); f2.set('loserId', ids.custB);
    const r2 = await dups.mergeCustomersAction(f2);
    expect(r2.ok).toBe(false); // loser already archived
  });
});
