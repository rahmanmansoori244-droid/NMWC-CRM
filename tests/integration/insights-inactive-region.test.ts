/**
 * Launch fix (2026-10-07): the organisation's dashboard leaves out inactive
 * regions, on real Postgres (lib/insights/sql.ts).
 *
 * What was wrong: the ZZTEST test region, switched off and left in production
 * with its test request and archived customer, showed as a row of its own on
 * the Steward's and Viewer's dashboard. An organisation-wide view now counts
 * active regions only; a Manager's own regions are taken as his role gives
 * them (what a switched-off region means for him is an owner decision).
 *
 * Fixtures: an active and an inactive synthetic region, each with a route, a
 * live customer, an approved new-customer request and an approved update, all
 * dated in 2099. Every assertion reads this suite's own rows, except the region
 * rows of the organisation view, which are checked for the inactive region's
 * absence only.
 *
 *   RUN_INSIGHTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/insights-inactive-region.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_INSIGHTS === '1' && !!process.env.DATABASE_URL;
const sfx = `ina${Date.now().toString(36)}`;
const D = (iso: string) => new Date(`${iso}Z`);
const NOW = D('2099-07-01T08:00:00');

describe.skipIf(!ENABLED)('the organisation’s dashboard counts active regions only', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let Prisma: typeof import('@prisma/client').Prisma;
  let sql: typeof import('@/lib/insights/sql');
  let load: typeof import('@/lib/insights/load');
  let scopeLib: typeof import('@/lib/insights/scope');
  let periodLib: typeof import('@/lib/insights/period');

  const ids = { steward: '', salesman: '', regOn: '', regOff: '', rtOn: '', rtOff: '' };
  const cust: Record<'on' | 'off', { id: string; branchId: string }> = {
    on: { id: '', branchId: '' },
    off: { id: '', branchId: '' },
  };
  const edits: Record<string, string> = {};

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    ({ Prisma } = await import('@prisma/client'));
    sql = await import('@/lib/insights/sql');
    load = await import('@/lib/insights/load');
    scopeLib = await import('@/lib/insights/scope');
    periodLib = await import('@/lib/insights/period');

    // Switched-off accounts: other suites fan notifications out to every ACTIVE
    // Steward, and one left on this fixture would stop its delete below.
    ids.steward = (await prisma.user.create({ data: { username: `${sfx}.stw`, fullName: 'Inactive stw', role: 'STEWARD', passwordHash: 'x', isActive: false } })).id;
    ids.salesman = (await prisma.user.create({ data: { username: `${sfx}.sm`, fullName: 'Inactive sm', role: 'SALESMAN', passwordHash: 'x', isActive: false } })).id;
    ids.regOn = (await prisma.region.create({ data: { name: `Active ${sfx}`, code: `${sfx}-ON` } })).id;
    ids.regOff = (await prisma.region.create({ data: { name: `ZZTEST-like ${sfx}`, code: `${sfx}-OFF`, isActive: false } })).id;
    ids.rtOn = (await prisma.route.create({ data: { name: 'On', code: `${sfx}-RON`, regionId: ids.regOn } })).id;
    ids.rtOff = (await prisma.route.create({ data: { name: 'Off', code: `${sfx}-ROFF`, regionId: ids.regOff } })).id;

    for (const key of ['on', 'off'] as const) {
      const c = await prisma.customer.create({ data: { nmwcCode: `${sfx}-${key}`, legalName: `Inactive ${key}`, createdById: ids.steward } });
      const b = await prisma.branch.create({
        data: {
          customerId: c.id, branchCode: `${sfx}-${key}-0`, branchName: `Inactive ${key}`, address: 'Synthetic Way 1',
          regionId: key === 'on' ? ids.regOn : ids.regOff, routeId: key === 'on' ? ids.rtOn : ids.rtOff,
        },
      });
      cust[key] = { id: c.id, branchId: b.id };
    }
    const approved = { state: 'APPROVED', submittedAt: D('2099-06-10T04:00:00'), reviewedAt: D('2099-06-10T06:00:00'), reviewedById: ids.steward };
    const edit = async (key: string, data: Record<string, unknown>) => {
      edits[key] = (await prisma.customerEdit.create({
        data: { target: 'CUSTOMER', submittedById: ids.salesman, fieldChanges: [], attachmentChanges: [], ...approved, ...data } as never,
      })).id;
    };
    for (const key of ['on', 'off'] as const) {
      const [routeId, regionId] = key === 'on' ? [ids.rtOn, ids.regOn] : [ids.rtOff, ids.regOff];
      await edit(`create-${key}`, {
        process: 'CREATE', customerId: null, paymentTermsAtSubmit: 'CASH',
        branchDrafts: { create: [{ branchName: 'Synthetic draft', regionId, routeId, address: 'Synthetic Way 2' }] },
      });
      await edit(`update-${key}`, { customerId: cust[key].id });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    const editIds = Object.values(edits);
    if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    const custIds = Object.values(cust).map((c) => c.id).filter(Boolean);
    await prisma.branch.deleteMany({ where: { customerId: { in: custIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
    await prisma.route.deleteMany({ where: { id: { in: [ids.rtOn, ids.rtOff].filter(Boolean) } } });
    await prisma.region.deleteMany({ where: { id: { in: [ids.regOn, ids.regOff].filter(Boolean) } } });
    const people = [ids.steward, ids.salesman].filter(Boolean);
    await prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  const none = { regionIds: [] as string[], routeIds: [] as string[], rejected: false };
  const empty = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] as string[] };
  const active = (s: import('@/lib/insights/scope').InsightScope) => {
    if (s.kind === 'none') throw new Error('scope is none');
    return s;
  };

  it('branches, new-customer requests and requests of an inactive region are out of the organisation’s view', async () => {
    const org = active(scopeLib.resolveInsightScope('STEWARD', empty, none));
    const branches = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT b."id" FROM "Branch" b WHERE b."customerId" = ANY(${[cust.on.id, cust.off.id]}::text[]) AND ${sql.branchInScopeSql(org, 'b')}`);
    expect(branches.map((r) => r.id)).toEqual([cust.on.branchId]);

    const drafts = await prisma.$queryRaw<Array<{ editId: string }>>(Prisma.sql`
      SELECT d."editId" FROM "EditBranchDraft" d JOIN "Route" r ON r."id" = d."routeId"
       WHERE d."editId" = ANY(${[edits['create-on'], edits['create-off']]}::text[]) AND ${sql.draftInScopeSql(org, 'd', 'r')}`);
    expect(drafts.map((r) => r.editId)).toEqual([edits['create-on']]);

    const requests = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${Object.values(edits)}::text[]) AND ${sql.requestInScopeSql(org)}`);
    expect(requests.map((r) => r.id).sort()).toEqual([edits['create-on'], edits['update-on']].sort());
  });

  it('no row of the organisation’s figures is the inactive region’s', async () => {
    const org = active(scopeLib.resolveInsightScope('VIEWER', empty, none));
    const period = periodLib.parsePeriod({ period: 'custom', from: '2099-06-01', to: '2099-06-30' }, NOW);
    const data = await load.loadInsights(org, period);
    expect(data.state.ok && data.created.ok && data.updated.ok).toBe(true);
    if (!data.state.ok || !data.created.ok || !data.updated.ok) return;
    expect(data.state.data.regions.map((r) => r.region.id)).not.toContain(ids.regOff);
    expect(data.state.data.regions.map((r) => r.region.id)).toContain(ids.regOn);
    expect(data.created.data.regions.map((r) => r.region.id)).not.toContain(ids.regOff);
    expect(data.created.data.routes.map((r) => r.route.id)).not.toContain(ids.rtOff);
    expect(data.updated.data.regions.map((r) => r.region.id)).not.toContain(ids.regOff);
  });

  it('a Manager whose region is switched off still sees it: that rule is the owner’s to make', async () => {
    const mine = active(scopeLib.resolveInsightScope('MANAGER', { ...empty, managedRegionIds: [ids.regOff] }, none));
    const branches = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT b."id" FROM "Branch" b WHERE b."customerId" = ANY(${[cust.on.id, cust.off.id]}::text[]) AND ${sql.branchInScopeSql(mine, 'b')}`);
    expect(branches.map((r) => r.id)).toEqual([cust.off.branchId]);
  });
});
