/**
 * F2: the insights dashboard's SQL, run against a real Postgres.
 *
 * What only a database can prove:
 *   - the scope twins (lib/insights/sql.ts) select exactly what the access gates
 *     admit: the branches lib/access.ts filterBranchesByScope keeps and the
 *     customers canSeeCustomer admits, the new-customer requests /approvals/[id]
 *     lets a Manager open, and countedInRegionsSql itself for requests — with a
 *     customer whose branches sit in two regions among the fixtures;
 *   - the definitions: direct writes are their own series, close-shop requests
 *     and reactivations are never "updated", a moved route takes its new-customer
 *     requests with it, and a non-array fieldChanges does not break the query;
 *   - Oman days: a decision at 21:00 UTC lands on the next Oman day, and the week
 *     bucket Postgres computes is the one lib/insights/period.ts gap-fills;
 *   - a multi-region customer adds no heat cell and no route count from its other
 *     region's branch to a region Manager's view;
 *   - the route ranking credits a salesman's request to the route of the branch it
 *     changed (or his own route), never to another route of the same customer;
 *   - "the period before" is like for like: read at 08:00 Oman, a week with one
 *     event per business day compares equal with the week before (cut at 08:00),
 *     where full days would have shown a fall.
 *
 * Every fixture is synthetic and tagged with this run's suffix; every event is
 * dated in 2099 and every scope is limited to this suite's own regions, so rows
 * other suites write cannot change what it asserts. Everything is deleted after.
 *
 *   RUN_INSIGHTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/insights.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_INSIGHTS === '1' && !!process.env.DATABASE_URL;
const sfx = `ins${Date.now().toString(36)}`;
const D = (iso: string) => new Date(`${iso}Z`);
// The window: Oman days 1–30 June 2099; the previous window is 2–31 May 2099.
const NOW = D('2099-07-01T08:00:00');

describe.skipIf(!ENABLED)('F2: the insights dashboard queries', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let Prisma: typeof import('@prisma/client').Prisma;
  let load: typeof import('@/lib/insights/load');
  let sql: typeof import('@/lib/insights/sql');
  let scopeLib: typeof import('@/lib/insights/scope');
  let periodLib: typeof import('@/lib/insights/period');
  let access: typeof import('@/lib/access');

  const users = { salesman: '', steward: '', manager: '' };
  const reg = { in: '', out: '', flat: '' };
  const rt = { in1: '', in2: '', out: '', moved: '', flat: '' };
  const cust: Record<string, { id: string; branchIds: string[] }> = {};
  const edits: Record<string, string> = {};
  const editIds: string[] = [];

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    ({ Prisma } = await import('@prisma/client'));
    load = await import('@/lib/insights/load');
    sql = await import('@/lib/insights/sql');
    scopeLib = await import('@/lib/insights/scope');
    periodLib = await import('@/lib/insights/period');
    access = await import('@/lib/access');

    const user = async (key: keyof typeof users, role: Role) => {
      const u = await prisma.user.create({
        data: { username: `${sfx}.${key}`, fullName: `Insights ${key}`, role, passwordHash: 'x' },
      });
      users[key] = u.id;
    };
    await user('salesman', 'SALESMAN');
    await user('steward', 'STEWARD');
    await user('manager', 'MANAGER');

    reg.in = (await prisma.region.create({ data: { name: `Insights In ${sfx}`, code: `${sfx}-IN` } })).id;
    reg.out = (await prisma.region.create({ data: { name: `Insights Out ${sfx}`, code: `${sfx}-OUT` } })).id;
    const route = async (code: string, regionId: string) =>
      (await prisma.route.create({ data: { name: `Insights ${code}`, code: `${sfx}-${code}`, regionId } })).id;
    rt.in1 = await route('IN1', reg.in);
    rt.in2 = await route('IN2', reg.in);
    rt.out = await route('OUT', reg.out);
    rt.moved = await route('MOVED', reg.in);
    // A region of its own for the like-for-like comparison, so its events touch no other case.
    reg.flat = (await prisma.region.create({ data: { name: `Insights Flat ${sfx}`, code: `${sfx}-FLAT` } })).id;
    rt.flat = await route('FLAT', reg.flat);
    // The salesman owns IN1: a route with an owner, beside IN2 without one.
    await prisma.user.update({ where: { id: users.salesman }, data: { ownedRouteId: rt.in1 } });

    type B = {
      regionId: string;
      routeId: string;
      status?: 'ACTIVE' | 'CLOSED';
      gps?: [number, number];
      day?: 'SUN';
      deleted?: boolean;
      changedAt?: Date;
    };
    const customer = async (key: string, branches: B[], extra: Record<string, unknown> = {}) => {
      const c = await prisma.customer.create({
        data: { nmwcCode: `${sfx}-${key}`, legalName: `Insights ${key}`, createdById: users.steward, ...extra },
      });
      const ids: string[] = [];
      for (const [i, b] of branches.entries()) {
        const row = await prisma.branch.create({
          data: {
            customerId: c.id, branchCode: `${sfx}-${key}-${i}`, branchName: `Insights ${key} ${i}`, address: 'Synthetic Way 1',
            regionId: b.regionId, routeId: b.routeId, status: b.status ?? 'ACTIVE',
            gpsLat: b.gps?.[0] ?? null, gpsLng: b.gps?.[1] ?? null, dayOfVisit: b.day ?? null,
            lastStatusChangeAt: b.changedAt ?? null, deletedAt: b.deleted ? D('2099-06-02T00:00:00') : null,
          },
        });
        ids.push(row.id);
      }
      cust[key] = { id: c.id, branchIds: ids };
    };
    await customer('in', [{ regionId: reg.in, routeId: rt.in1, gps: [23.6, 58.4], day: 'SUN' }]);
    await customer('in2', [{ regionId: reg.in, routeId: rt.in2, status: 'CLOSED', changedAt: D('2099-06-15T06:00:00') }]);
    await customer('out', [{ regionId: reg.out, routeId: rt.out, gps: [17.0, 54.1] }]);
    // Branches in both regions: region "in" must see only its own branch of it.
    await customer('multi', [
      { regionId: reg.out, routeId: rt.out, gps: [17.02, 54.12] },
      { regionId: reg.in, routeId: rt.in1, gps: [23.62, 58.42] },
    ]);
    await customer('nogps', [{ regionId: reg.in, routeId: rt.in2 }]);
    // GPS outside the map box (a mistyped point): counted as located, not drawn.
    await customer('odd', [{ regionId: reg.in, routeId: rt.in1, gps: [30.0, 58.0] }]);
    // First created by an import inside the window.
    await customer('imported', [{ regionId: reg.in, routeId: rt.in2 }], {
      importBatchId: `${sfx}-batch`,
      createdAt: D('2099-06-10T06:00:00'),
    });
    // Not in view: a deleted branch, and an archived customer.
    await customer('delbranch', [{ regionId: reg.in, routeId: rt.in1, deleted: true }]);
    await customer('archived', [{ regionId: reg.in, routeId: rt.in1 }], { deletedAt: D('2099-06-03T00:00:00') });

    const edit = async (key: string, data: Record<string, unknown>) => {
      const e = await prisma.customerEdit.create({
        data: { target: 'CUSTOMER', submittedById: users.salesman, fieldChanges: [], attachmentChanges: [], ...data } as never,
      });
      edits[key] = e.id;
      editIds.push(e.id);
    };
    const approved = (at: string, reviewer = users.steward) => ({
      state: 'APPROVED', submittedAt: D(`${at.slice(0, 10)}T04:00:00`), reviewedAt: D(at), reviewedById: reviewer,
    });
    const create = (routeId: string, regionId: string, terms: 'CASH' | 'CREDIT') => ({
      process: 'CREATE', customerId: null, paymentTermsAtSubmit: terms,
      branchDrafts: { create: [{ branchName: 'Synthetic draft', regionId, routeId, address: 'Synthetic Way 2' }] },
    });

    // New customers. 21:00 UTC on 10 June is 01:00 on 11 June in Oman.
    await edit('createIn', { ...create(rt.in1, reg.in, 'CASH'), ...approved('2099-06-10T21:00:00') });
    await edit('createOut', { ...create(rt.out, reg.out, 'CREDIT'), ...approved('2099-06-12T06:00:00') });
    await edit('createMoved', { ...create(rt.moved, reg.in, 'CASH'), ...approved('2099-06-12T07:00:00') });
    // Finalized and linked to a customer whose branch is elsewhere: it counts where it was raised.
    await edit('createLinked', {
      ...create(rt.in2, reg.in, 'CREDIT'),
      ...approved('2099-06-13T06:00:00'),
      customerId: cust.out!.id,
    });
    await edit('createPrev', { ...create(rt.in1, reg.in, 'CASH'), ...approved('2099-05-20T06:00:00') });
    // The route is moved after the request: the request follows the route's current region.
    await prisma.route.update({ where: { id: rt.moved }, data: { regionId: reg.out } });

    // Customers updated.
    await edit('updIn', {
      customerId: cust.in!.id, ...approved('2099-06-14T06:00:00'),
      fieldChanges: [
        { field: `branch.${cust.in!.branchIds[0]}.gpsLat`, before: null, after: 23.6 },
        { field: `branch.${cust.in!.branchIds[0]}.gpsLng`, before: null, after: 58.4 },
        { field: 'customer.primaryPhone', before: null, after: '+96890000000' },
      ],
    });
    // A Manager's direct write: submitted and reviewed by the same person.
    await edit('directIn2', {
      customerId: cust.in2!.id, submittedById: users.manager, ...approved('2099-06-15T06:00:00', users.manager),
      fieldChanges: [
        // An unmoved coordinate changes nothing and is not a GPS capture.
        { field: `branch.${cust.in2!.branchIds[0]}.gpsLat`, before: 23.5, after: 23.5 },
      ],
    });
    // fieldChanges that is not an array (an object): the query must survive it.
    await edit('updMulti', {
      customerId: cust.multi!.id, ...approved('2099-06-16T06:00:00'), fieldChanges: { unexpected: true },
    });
    await edit('updPrev', { customerId: cust.in!.id, ...approved('2099-05-25T06:00:00') });
    // The salesman owns IN1, but this request changed OUT's branch of "out": the
    // route ranking credits OUT (the branch it changed), and never IN1.
    await edit('updOutNamed', {
      customerId: cust.out!.id, ...approved('2099-06-19T06:00:00'),
      fieldChanges: [{ field: `branch.${cust.out!.branchIds[0]}.dayOfVisit`, before: null, after: 'SUN' }],
    });

    // Like for like: one new customer per business day (Sun–Thu) at 10:00 Oman
    // (06:00 UTC), from Wednesday 17 June to Monday 29 June 2099. Read at 08:00 on
    // Tuesday 30 June, nothing of the 30th has happened yet.
    for (const day of ['17', '18', '21', '22', '23', '24', '25', '28', '29']) {
      await edit(`flat${day}`, { ...create(rt.flat, reg.flat, 'CASH'), ...approved(`2099-06-${day}T06:00:00`) });
    }

    // Not updates: a close-shop request and a reactivation, both approved.
    await edit('closeIn', {
      target: 'BRANCH', customerId: cust.in!.id, branchId: cust.in!.branchIds[0], ...approved('2099-06-17T06:00:00'),
      fieldChanges: [{ field: `branch.${cust.in!.branchIds[0]}.status`, before: 'ACTIVE', after: 'CLOSED' }],
    });
    await edit('reactIn2', {
      target: 'BRANCH', isReactivation: true, customerId: cust.in2!.id, branchId: cust.in2!.branchIds[0],
      ...approved('2099-06-18T06:00:00', users.manager),
      fieldChanges: [{ field: `branch.${cust.in2!.branchIds[0]}.status`, before: 'CLOSED', after: 'ACTIVE' }],
    });

    // Waiting now. One open request per customer (CustomerEdit_open_per_customer).
    await edit('waitUpdNogps', {
      customerId: cust.nogps!.id, state: 'SUBMITTED', pendingRole: 'SUPERVISOR', submittedAt: D('2099-06-20T06:00:00'),
    });
    await edit('waitCreateIn', {
      ...create(rt.in1, reg.in, 'CASH'), state: 'SUBMITTED', pendingRole: 'SUPERVISOR', submittedAt: D('2099-06-21T06:00:00'),
    });
    await edit('waitCreateAcc', {
      ...create(rt.in2, reg.in, 'CASH'), state: 'SUBMITTED', pendingRole: 'ACCOUNTANT', submittedAt: D('2099-06-22T06:00:00'),
    });
    // The multi-region customer's OUT branch: "out"'s reactivation, not "in"'s.
    await edit('waitReactMultiOut', {
      target: 'BRANCH', isReactivation: true, customerId: cust.multi!.id, branchId: cust.multi!.branchIds[0],
      state: 'SUBMITTED', pendingRole: 'MANAGER', submittedAt: D('2099-06-23T06:00:00'),
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    const ids = Object.values(cust).map((c) => c.id);
    if (ids.length) {
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    }
    if (users.salesman) await prisma.user.update({ where: { id: users.salesman }, data: { ownedRouteId: null } });
    await prisma.route.deleteMany({ where: { id: { in: Object.values(rt).filter(Boolean) } } });
    await prisma.region.deleteMany({ where: { id: { in: Object.values(reg).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
    await prisma.$disconnect();
  });

  const manager = (regions: string[]) => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: regions });
  const noFilter = { regionIds: [] as string[], routeIds: [] as string[], rejected: false };
  const period = () => periodLib.parsePeriod({ period: 'custom', from: '2099-06-01', to: '2099-06-30' }, NOW);
  const active = (s: import('@/lib/insights/scope').InsightScope) => {
    if (s.kind === 'none') throw new Error('scope is none');
    return s;
  };

  /** Every fixture branch, with its customer, as the access helpers read them. */
  const fixtureBranches = async () => {
    const rows = await prisma.branch.findMany({
      where: { customerId: { in: Object.values(cust).map((c) => c.id) } },
      select: { id: true, customerId: true, regionId: true, routeId: true, deletedAt: true, customer: { select: { deletedAt: true } } },
    });
    return rows;
  };

  it('the branch scope in SQL is filterBranchesByScope; its customers are canSeeCustomer’s', async () => {
    const rows = await fixtureBranches();
    const custIds = Object.values(cust).map((c) => c.id);
    const cases: Array<{ role: Role; regions: string[] }> = [
      { role: 'MANAGER', regions: [reg.in] },
      { role: 'MANAGER', regions: [reg.out] },
      { role: 'MANAGER', regions: [reg.in, reg.out] },
      // The organisation-wide roles, limited to this suite's regions by a filter.
      { role: 'STEWARD', regions: [] },
      { role: 'VIEWER', regions: [] },
    ];
    for (const c of cases) {
      const roleScope = manager(c.regions);
      const filters = c.role === 'MANAGER' ? noFilter : { ...noFilter, regionIds: [reg.in, reg.out] };
      const scope = scopeLib.resolveInsightScope(c.role, roleScope, filters);
      const bySql = await prisma.$queryRaw<{ id: string; customerId: string }[]>(Prisma.sql`
        SELECT b."id", b."customerId" FROM "Branch" b JOIN "Customer" c ON c."id" = b."customerId"
         WHERE b."customerId" = ANY(${custIds}::text[]) AND b."deletedAt" IS NULL AND c."deletedAt" IS NULL
           AND ${sql.branchInScopeSql(scope, 'b')}`);
      const user = { id: 'u', role: c.role, username: 'u' } as never;
      const live = rows.filter((r) => !r.customer.deletedAt);
      const byGate = new Set(
        live
          .flatMap((r) => access.filterBranchesByScope(user, [r], roleScope))
          .filter((b) => c.role === 'MANAGER' || [reg.in, reg.out].includes(b.regionId))
          .map((b) => b.id)
      );
      expect(new Set(bySql.map((r) => r.id)), `${c.role} ${c.regions.length}`).toEqual(byGate);

      // A customer is counted when it has a branch in view. Every one counted is a
      // customer canSeeCustomer admits; for a Manager the two sets are the same.
      // (For the organisation-wide roles canSeeCustomer admits a customer whose
      // only branch is deleted too; the dashboard counts customers by their live
      // branches, as /customers lists them.)
      const counted = new Set(bySql.map((r) => r.customerId));
      const withBranchInView = new Set([...byGate].map((id) => live.find((r) => r.id === id)!.customerId));
      expect(counted, `${c.role} customers`).toEqual(withBranchInView);
      const admitted = new Set(
        custIds.filter((id) => {
          const branches = live.filter((r) => r.customerId === id);
          return branches.length > 0 && access.canSeeCustomer(user, { branches }, roleScope);
        })
      );
      for (const id of counted) expect(admitted.has(id), `counted but not admitted: ${id}`).toBe(true);
      if (c.role === 'MANAGER') expect(counted, 'a Manager’s customers are canSeeCustomer’s').toEqual(admitted);
    }
    // The cases themselves: "in" sees its own branch of the two-region customer, never the other.
    const inScope = scopeLib.resolveInsightScope('MANAGER', manager([reg.in]), noFilter);
    const inRows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT b."id" FROM "Branch" b WHERE b."id" = ANY(${cust.multi!.branchIds}::text[]) AND ${sql.branchInScopeSql(inScope, 'b')}`);
    expect(inRows.map((r) => r.id)).toEqual([cust.multi!.branchIds[1]]);
    // A region-less Manager resolves to nothing at all.
    expect(scopeLib.resolveInsightScope('MANAGER', manager([]), noFilter).kind).toBe('none');
  });

  it('a route filter is applied on the same branch row as the region, and only narrows', async () => {
    const rows = await fixtureBranches();
    const live = rows.filter((r) => !r.deletedAt && !r.customer.deletedAt);
    const scope = scopeLib.resolveInsightScope('MANAGER', manager([reg.in]), { ...noFilter, routeIds: [rt.in2, rt.out] });
    const bySql = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT b."id" FROM "Branch" b WHERE b."id" = ANY(${live.map((r) => r.id)}::text[]) AND ${sql.branchInScopeSql(scope, 'b')}`);
    const byTwin = new Set(live.filter((b) => scopeLib.branchInView(scope, b)).map((b) => b.id));
    expect(new Set(bySql.map((r) => r.id))).toEqual(byTwin);
    // OUT's route is not "in"'s, though asked for: only IN2's branches remain.
    for (const id of bySql.map((r) => r.id)) expect(live.find((b) => b.id === id)!.routeId).toBe(rt.in2);
  });

  /** app/(app)/approvals/[id]/page.tsx's MANAGER gate, re-implemented over the same relations. */
  const pageLetsOpen = async (managed: string[]) => {
    const rows = await prisma.customerEdit.findMany({
      where: { id: { in: editIds } },
      select: {
        id: true, process: true,
        branchDrafts: { select: { route: { select: { regionId: true } } } },
        customer: { select: { branches: { select: { regionId: true, deletedAt: true } } } },
      },
    });
    return new Set(
      rows
        .filter((e) => {
          const regions =
            e.process === 'CREATE'
              ? e.branchDrafts.map((d) => d.route.regionId)
              : (e.customer?.branches ?? []).filter((b) => !b.deletedAt).map((b) => b.regionId);
          return regions.some((r) => managed.includes(r));
        })
        .map((e) => e.id)
    );
  };

  it('new-customer requests are counted exactly as /approvals/[id] lets a Manager open them', async () => {
    const creates = Object.entries(edits).filter(([k]) => k.startsWith('create') || k.startsWith('waitCreate')).map(([, id]) => id);
    for (const managed of [[reg.in], [reg.out], [reg.in, reg.out]]) {
      const scope = scopeLib.resolveInsightScope('MANAGER', manager(managed), noFilter);
      const bySql = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT DISTINCT e."id" FROM "CustomerEdit" e
          JOIN "EditBranchDraft" d ON d."editId" = e."id" JOIN "Route" r ON r."id" = d."routeId"
         WHERE e."id" = ANY(${creates}::text[]) AND ${sql.draftInScopeSql(scope, 'd', 'r')}`);
      const page = await pageLetsOpen(managed);
      expect(new Set(bySql.map((r) => r.id)), `regions ${managed.length}`).toEqual(
        new Set(creates.filter((id) => page.has(id)))
      );
    }
  });

  it('requests are counted by countedInRegionsSql itself; a route filter only removes', async () => {
    for (const managed of [[reg.in], [reg.out], [reg.in, reg.out]]) {
      const scope = scopeLib.resolveInsightScope('MANAGER', manager(managed), noFilter);
      const mine = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${editIds}::text[]) AND ${sql.requestInScopeSql(scope)}`);
      const gate = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${editIds}::text[]) AND ${sql.__gates.countedInRegionsSql(managed)}`);
      expect(new Set(mine.map((r) => r.id))).toEqual(new Set(gate.map((r) => r.id)));
      const page = await pageLetsOpen(managed);
      for (const r of mine) expect(page.has(r.id), `counted but not openable: ${r.id}`).toBe(true);

      const narrowed = scopeLib.resolveInsightScope('MANAGER', manager(managed), { ...noFilter, routeIds: [rt.in2] });
      const fewer = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${editIds}::text[]) AND ${sql.requestInScopeSql(narrowed)}`);
      const all = new Set(mine.map((r) => r.id));
      for (const r of fewer) expect(all.has(r.id)).toBe(true);
    }
    // "in" counts its own waiting requests, never "out"'s reactivation on the shared customer.
    const inScope = scopeLib.resolveInsightScope('MANAGER', manager([reg.in]), noFilter);
    const waiting = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${editIds}::text[]) AND e."state" = 'SUBMITTED' AND ${sql.requestInScopeSql(inScope)}`);
    expect(new Set(waiting.map((r) => r.id))).toEqual(new Set([edits.waitUpdNogps, edits.waitCreateIn, edits.waitCreateAcc]));
  });

  it('the whole loader, as a Manager of "in": the definitions hold', async () => {
    const p = period();
    const scope = active(scopeLib.resolveInsightScope('MANAGER', manager([reg.in]), noFilter));
    const data = await load.loadInsights(scope, p);
    for (const s of Object.values(data)) expect(s.ok).toBe(true);
    if (!data.state.ok || !data.created.ok || !data.updated.ok || !data.statusChanges.ok || !data.pipeline.ok || !data.heat.ok) return;

    // Branches in view now: in, in2 (closed), multi's IN branch, nogps, odd, imported.
    const s = data.state.data.total;
    expect(s.customers).toBe(6);
    expect(s.branches).toBe(6);
    expect(s.open).toBe(5);
    expect(s.closed).toBe(1);
    expect(s.closedInPeriod).toBe(1);
    expect(s.openWithGps).toBe(3); // in, multi's IN branch, odd
    expect(s.imported).toBe(1);
    expect(s.openNoDay).toBe(4);
    const in1 = data.state.data.routes.find((r) => r.route.id === rt.in1)!;
    const in2 = data.state.data.routes.find((r) => r.route.id === rt.in2)!;
    expect(in1.route.hasOwner).toBe(true);
    expect(in2.route.hasOwner).toBe(false);
    expect(data.state.data.routes.some((r) => r.route.id === rt.out)).toBe(false);

    // New customers: createIn and createLinked; createMoved went to "out" with its route.
    const c = data.created.data;
    expect(c.total).toBe(2);
    expect(c.prevTotal).toBe(1);
    expect([c.cash, c.credit]).toEqual([1, 1]);
    // 21:00 UTC on 10 June is 11 June in Oman.
    expect(c.series.find((b) => b.bucket === '2099-06-11')?.cash).toBe(1);
    expect(c.series.find((b) => b.bucket === '2099-06-10')?.cash).toBe(0);
    expect(c.series).toHaveLength(30);

    // Updated: in (request), in2 (direct write only), multi (request). Not the close, not the reactivation.
    const u = data.updated.data;
    expect(u.customers).toBe(3);
    expect(u.byRequest).toBe(2);
    expect(u.directOnly).toBe(1);
    expect(u.changes).toBe(3);
    expect(u.prevCustomers).toBe(1);
    expect(u.families.gps).toBe(1); // the unmoved coordinate is not a capture
    expect(u.families.phone).toBe(1);
    // By current route: multi counts on IN1 through its IN branch only.
    expect(u.routes.map((r) => r.route.id).sort()).toEqual([rt.in1, rt.in2].sort());
    // The route's own work: "in" (its IN1 branch changed) and multi (no branch
    // changed; the salesman owns IN1). IN2's only update is a direct write.
    const onIn1 = u.routes.find((r) => r.route.id === rt.in1)!;
    const onIn2 = u.routes.find((r) => r.route.id === rt.in2)!;
    expect([onIn1.customers, onIn1.byRequest, onIn1.byRequestOnRoute]).toEqual([2, 2, 2]);
    expect([onIn2.customers, onIn2.byRequest, onIn2.byRequestOnRoute]).toEqual([1, 0, 0]);

    // Closures and reactivations, on the branch's own region.
    const st = data.statusChanges.data;
    expect([st.closed, st.reactivated, st.reactWaiting]).toEqual([1, 1, 0]);

    // Waiting: the Supervisor step holds the update and the new-customer request (now included).
    const pipe = data.pipeline.data;
    expect(pipe.waitingFirstStep).toEqual({ create: 1, update: 1, close: 0, reactivation: 0 });
    expect(pipe.waitingAnyStep).toEqual({ create: 2, update: 1, close: 0, reactivation: 0 });
    expect(pipe.submitted.create.APPROVED).toBe(2);

    // The map: one region in view, so 0.01° cells; never the other region's branch.
    const h = data.heat.data;
    expect(h.cellDeg).toBe(0.01);
    expect(h.openBranches).toBe(5);
    expect(h.openWithGps).toBe(3);
    expect(h.located).toBe(2); // odd is outside the box
    for (const cell of h.cells) expect(cell.lat).toBeGreaterThan(20);
  });

  it('as a Manager of "out": the shared customer counts there too, from its own branch only', async () => {
    const scope = active(scopeLib.resolveInsightScope('MANAGER', manager([reg.out]), noFilter));
    const data = await load.loadInsights(scope, period());
    if (!data.created.ok || !data.updated.ok || !data.statusChanges.ok || !data.heat.ok || !data.state.ok) {
      throw new Error('a card failed');
    }
    expect(data.created.data.total).toBe(2); // createOut and createMoved
    expect(data.updated.data.customers).toBe(2); // multi, out
    expect(data.updated.data.routes.map((r) => r.route.id)).toEqual([rt.out]);
    // Both customers count on OUT, both by the IN1 salesman's requests; but only
    // the request that changed OUT's branch is OUT's work. multi's request changed
    // no branch, and its salesman's route is IN1: it is not credited to OUT.
    const onOut = data.updated.data.routes[0]!;
    expect([onOut.customers, onOut.byRequest, onOut.byRequestOnRoute]).toEqual([2, 2, 1]);
    expect(data.statusChanges.data.reactWaiting).toBe(1);
    expect(data.heat.data.cells.reduce((s, c) => s + c.n, 0)).toBe(2);
    for (const cell of data.heat.data.cells) expect(cell.lat).toBeLessThan(20);
    expect(data.state.data.routes.map((r) => r.route.id)).toEqual([rt.out]);
  });

  it('the organisation-wide view with both regions filtered is the two Managers’ views together', async () => {
    const scope = active(
      scopeLib.resolveInsightScope('VIEWER', manager([]), { ...noFilter, regionIds: [reg.in, reg.out] })
    );
    const data = await load.loadInsights(scope, period());
    if (!data.created.ok || !data.updated.ok || !data.state.ok || !data.heat.ok) throw new Error('a card failed');
    expect(data.created.data.total).toBe(4);
    expect(data.updated.data.customers).toBe(4); // in, in2, multi, out — multi once
    expect(data.state.data.total.customers).toBe(7); // in's six and out
    expect(data.heat.data.cellDeg).toBe(0.05);
  });

  it('the whole organisation, unfiltered and over a year, loads every card with consistent figures', async () => {
    // Whatever else the database holds: the statements must run at its real size.
    const scope = active(scopeLib.resolveInsightScope('STEWARD', manager([]), noFilter));
    // The real clock, read once: this case asserts no dated figure, only that the
    // year up to today loads and adds up.
    const p = periodLib.parsePeriod({ period: '12m' }, new Date());
    expect(p.grain).toBe('month');
    const started = Date.now();
    const data = await load.loadInsights(scope, p);
    const ms = Date.now() - started;
    for (const [card, s] of Object.entries(data)) expect(s.ok, card).toBe(true);
    if (!data.state.ok || !data.heat.ok || !data.updated.ok || !data.created.ok) return;
    const t = data.state.data.total;
    expect(t.openWithGps).toBeLessThanOrEqual(t.open);
    expect(t.open + t.closed).toBeLessThanOrEqual(t.branches);
    expect(data.heat.data.located).toBeLessThanOrEqual(data.heat.data.openWithGps);
    expect(data.heat.data.cells.length).toBeLessThanOrEqual(data.heat.data.totalCells);
    expect(data.updated.data.byRequest).toBeLessThanOrEqual(data.updated.data.customers);
    expect(data.created.data.series).toHaveLength(p.buckets.length);
    // A budget, not a benchmark: the page is a landing page.
    expect(ms).toBeLessThan(30_000);
  });

  it('the period before runs as long as this one has: one event per business day reads as no change at 08:00', async () => {
    const morning = D('2099-06-30T04:00:00'); // 08:00 on Tuesday 30 June in Oman
    const p = periodLib.parsePeriod({ period: 'custom', from: '2099-06-24', to: '2099-06-30' }, morning);
    expect(p.running).toBe(true);
    const scope = active(scopeLib.resolveInsightScope('MANAGER', manager([reg.flat]), noFilter));
    const data = await load.loadInsights(scope, p);
    if (!data.created.ok) throw new Error('a card failed');
    // This week so far: Wed 24, Thu 25, Sun 28, Mon 29. The week before, to 08:00 on
    // Tue 23: Wed 17, Thu 18, Sun 21, Mon 22 (Tue 23's came at 10:00).
    expect([data.created.data.total, data.created.data.prevTotal]).toEqual([4, 4]);
    // Full days would have compared with five, a false 20% fall.
    const [full] = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS "n" FROM "CustomerEdit" e
       WHERE e."id" = ANY(${editIds}::text[]) AND e."process" = 'CREATE'
         AND e."reviewedAt" >= ${p.prevFrom} AND e."reviewedAt" < ${p.from}
         AND EXISTS (SELECT 1 FROM "EditBranchDraft" d WHERE d."editId" = e."id" AND d."routeId" = ${rt.flat})`);
    expect(full!.n).toBe(5);
  });

  it('Postgres buckets weeks on the Monday period.ts gap-fills, in Oman days', async () => {
    const instants = [
      '2099-06-07 19:59:59', // Sunday 23:59:59 Oman
      '2099-06-07 20:00:00', // Monday 00:00 Oman: a new week
      '2099-06-01 03:00:00',
      '2099-12-31 20:30:00', // 1 January 2100 in Oman
    ];
    for (const grain of ['day', 'week', 'month'] as const) {
      for (const ts of instants) {
        const [row] = await prisma.$queryRaw<{ k: string }[]>(
          Prisma.sql`SELECT ${load.__sql.bucketSql(Prisma.sql`${ts}::timestamp`, grain)} AS "k"`
        );
        expect(row!.k, `${grain} ${ts}`).toBe(periodLib.bucketOf(new Date(`${ts.replace(' ', 'T')}Z`), grain));
      }
    }
  });
});
