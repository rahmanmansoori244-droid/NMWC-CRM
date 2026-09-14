// @vitest-environment node
/**
 * MANAGER-BRANCH-REGION-AUTHZ (final-hunt #17) — a Manager's customer-level edit
 * authorization is any-branch-overlap, so on a MULTI-region customer they could
 * direct-write a branch in a region they do NOT manage. The per-branch guard in
 * submitEditCore must reject that while allowing branches in a managed region.
 *
 *   RUN_MGR_AUTHZ=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/manager-branch-region-authz.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_MGR_AUTHZ === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('Manager can only edit branches in a region they manage (#17)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let edits: typeof import('@/services/edits');
  const tag = randomUUID().slice(0, 8);
  const ids = { regionA: '', regionB: '', routeA: '', routeB: '', mgr: `ZZMR-mgr-${tag}`, cust: '', branchA: '', branchB: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    const rA = await prisma.region.create({ data: { name: `ZZMR A ${tag}`, code: `ZZMRA-${tag}` } });
    const rB = await prisma.region.create({ data: { name: `ZZMR B ${tag}`, code: `ZZMRB-${tag}` } });
    ids.regionA = rA.id; ids.regionB = rB.id;
    const rtA = await prisma.route.create({ data: { name: `RtA ${tag}`, code: `ZZMR-RA-${tag}`, regionId: rA.id } });
    const rtB = await prisma.route.create({ data: { name: `RtB ${tag}`, code: `ZZMR-RB-${tag}`, regionId: rB.id } });
    ids.routeA = rtA.id; ids.routeB = rtB.id;
    // Manager manages ONLY region A.
    await prisma.user.create({ data: { id: ids.mgr, username: ids.mgr, passwordHash: 'x', fullName: 'ZZ Mgr', role: 'MANAGER', managedRegions: { connect: { id: rA.id } } } });
    // Multi-region customer: branch A (region A, managed) + branch B (region B, NOT managed).
    const cust = await prisma.customer.create({ data: { nmwcCode: `ZZMR-C-${tag}`, legalName: 'ZZ MultiRegion Co', paymentTerms: 'CASH', createdById: ids.mgr } });
    ids.cust = cust.id;
    const bA = await prisma.branch.create({ data: { customerId: cust.id, branchCode: `ZZMR-C-${tag}-01`, branchName: 'Branch A', address: 'ZZ Way A, Region A', routeId: rtA.id, regionId: rA.id, status: 'ACTIVE' } });
    const bB = await prisma.branch.create({ data: { customerId: cust.id, branchCode: `ZZMR-C-${tag}-02`, branchName: 'Branch B', address: 'ZZ Way B, Region B', routeId: rtB.id, regionId: rB.id, status: 'ACTIVE' } });
    ids.branchA = bA.id; ids.branchB = bB.id;
    current = { id: ids.mgr, role: 'MANAGER', username: ids.mgr };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.cust }, select: { id: true } });
      if (eds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: eds.map((e) => e.id) } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: eds.map((e) => e.id) } } });
      }
      await purgeAuditLog(prisma, { where: { actorId: ids.mgr } });
      await prisma.branch.deleteMany({ where: { customerId: ids.cust } });
      await prisma.customer.deleteMany({ where: { id: ids.cust } });
      await prisma.user.deleteMany({ where: { id: ids.mgr } });
      await prisma.route.deleteMany({ where: { id: { in: [ids.routeA, ids.routeB] } } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.regionA, ids.regionB] } } });
    } catch (e) { console.error('cleanup', e); }
    await prisma.$disconnect();
  });

  it('REJECTS a Manager editing a branch in a region they do NOT manage', async () => {
    const res = await edits.submitEditAction({
      customerId: ids.cust, isDraft: false, customer: {},
      branches: [{ branchId: ids.branchB, openingHours: '08:00-20:00' }],
    });
    expect(res.ok).toBe(false);
    // the fix throws ForbiddenError → runAction maps to a FORBIDDEN-ish message
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branchB }, select: { openingHours: true } });
    expect(branch.openingHours).toBeNull(); // never written
  });

  it('ALLOWS a Manager editing a branch in a region they manage', async () => {
    const res = await edits.submitEditAction({
      customerId: ids.cust, isDraft: false, customer: {},
      branches: [{ branchId: ids.branchA, openingHours: '09:00-21:00' }],
    });
    if (!res.ok) console.error('managed-region edit failed', JSON.stringify(res));
    expect(res.ok).toBe(true);
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branchA }, select: { openingHours: true } });
    expect(branch.openingHours).toBe('09:00-21:00'); // Manager direct-write applied
  });
});
