// @vitest-environment node
/**
 * F17 against real Postgres: the filtered export shows a branch the filter
 * matches.
 *
 * A customer with an older branch on route A and a newer one on route B,
 * exported by a Manager filtering to route B, came out with route A's Region,
 * Route, Address, GPS and Day of visit: the customer was matched on route B, but
 * the branch shown was chosen by the role scope alone, oldest first. The
 * /customers card had the same pattern; it and the export now take the branch
 * from lib/customer-filters.ts customerBranchPredicate (structural guard in
 * tests/unit/customer-export-branch.test.ts).
 *
 *   RUN_EXPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/customer-export-branch-filter.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_EXPORT_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('F17: the filtered export shows the branch the filter matched', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let exportsSvc: typeof import('@/services/customer-export');
  let excel: typeof import('@/lib/excel');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZF17-${tag}`;
  const manager = `${P}-mgr`;
  let regionId = '';
  let routeA = { id: '', code: `${P}-RA` };
  let routeB = { id: '', code: `${P}-RB` };

  const exportWith = async (params: Record<string, string>) => {
    const fd = new FormData();
    fd.set('urlParams', new URLSearchParams(params).toString());
    const res = await exportsSvc.exportFilteredCustomersAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const { base64 } = (res as { ok: true; data: { base64: string } }).data;
    const [sheet] = await excel.parseWorkbook(Buffer.from(base64, 'base64'));
    return sheet.rows;
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    exportsSvc = await import('@/services/customer-export');
    excel = await import('@/lib/excel');
    regionId = (await prisma.region.create({ data: { code: `${P}R`, name: `ZZ F17 ${tag}` } })).id;
    routeA = { ...routeA, id: (await prisma.route.create({ data: { code: routeA.code, name: 'ZZ F17 A', regionId } })).id };
    routeB = { ...routeB, id: (await prisma.route.create({ data: { code: routeB.code, name: 'ZZ F17 B', regionId } })).id };
    await prisma.user.create({
      data: {
        id: manager,
        username: manager,
        passwordHash: 'x',
        fullName: 'ZZ F17 Manager',
        role: 'MANAGER',
        managedRegions: { connect: { id: regionId } },
      },
    });
    const two = await prisma.customer.create({ data: { nmwcCode: `${P}-TWO`, legalName: `${P} Two Branches` } });
    await prisma.branch.create({
      data: {
        customerId: two.id, branchCode: `${P}-TWO-01`, branchName: 'Old A', address: 'Way A, older',
        regionId, routeId: routeA.id, dayOfVisit: 'SUN', createdAt: new Date('2026-01-01T06:00:00Z'),
      },
    });
    await prisma.branch.create({
      data: {
        customerId: two.id, branchCode: `${P}-TWO-02`, branchName: 'New B', address: 'Way B, newer',
        regionId, routeId: routeB.id, dayOfVisit: 'TUE', createdAt: new Date('2026-02-01T06:00:00Z'),
      },
    });
    const onlyA = await prisma.customer.create({ data: { nmwcCode: `${P}-ONLYA`, legalName: `${P} Only A` } });
    await prisma.branch.create({
      data: {
        customerId: onlyA.id, branchCode: `${P}-ONLYA-01`, branchName: 'Only A', address: 'Way A, only',
        regionId, routeId: routeA.id,
      },
    });
    current = { id: manager, role: 'MANAGER', username: manager };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: manager } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: manager } });
      await prisma.route.deleteMany({ where: { id: { in: [routeA.id, routeB.id] } } });
      await prisma.region.deleteMany({ where: { id: regionId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('filtered to route B: the two-branch customer exports its route-B branch', async () => {
    const rows = await exportWith({ q: P, route: routeB.id });
    expect(rows.map((r) => r['NMWC code'])).toEqual([`${P}-TWO`]);
    expect(rows[0]).toMatchObject({ Route: routeB.code, Address: 'Way B, newer', 'Day of visit': 'TUE' });
  });

  it('filtered to route A: the same customer exports its route-A branch', async () => {
    const rows = await exportWith({ q: P, route: routeA.id });
    const two = rows.find((r) => r['NMWC code'] === `${P}-TWO`);
    expect(two).toMatchObject({ Route: routeA.code, Address: 'Way A, older', 'Day of visit': 'SUN' });
  });

  it('matched by name only: still a branch — the oldest in scope', async () => {
    const rows = await exportWith({ q: `${P} Two` });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Route: routeA.code, Address: 'Way A, older' });
  });
});
