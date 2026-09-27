/**
 * Item 9: the Service status page's SQL, run against a real Postgres.
 *
 * The verdicts are unit-tested (tests/unit/service-levels.test.ts); what only a
 * database can prove is the SQL — date_bin's slot grid lining up with the one
 * slotStarts() walks, bool_or collapsing two schedulers into one slot,
 * percentile_cont over the snapshot minutes, the enum casts, the whole loader
 * running end to end, and the region test that decides which approvals a Manager's
 * figures are made of: exactly the requests /approvals/[id] lets that Manager open.
 *
 * Every row this suite writes is dated in 2099 and every query reads from 2099
 * on, so rows other suites write in parallel cannot change what it asserts.
 *
 *   RUN_SERVICE_LEVELS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/service-levels.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_SERVICE_LEVELS === '1' && !!process.env.DATABASE_URL;
const sfx = `slo${Date.now().toString(36)}`;
const T = (iso: string) => new Date(`2099-06-01T${iso}Z`);
const FROM = new Date('2099-06-01T00:00:00Z');
// The region fixtures are dated a month earlier, so the company-wide assertions
// read from FROM see none of them.
const R = (iso: string) => new Date(`2099-05-10T${iso}Z`);
const REGION_FROM = new Date('2099-05-01T00:00:00Z');

describe.skipIf(!ENABLED)('item 9: the service-level queries', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let svc: typeof import('@/lib/service-status');
  let userId = '';
  let managerId = '';
  const editIds: string[] = [];
  // A Manager of region "in"; region "out" is someone else's.
  const reg = { in: '', out: '', routeIn: '', routeOut: '', routeMoved: '' };
  const cust: string[] = [];
  const e = {} as Record<
    | 'in' | 'out' | 'early' | 'deleted' | 'multi' | 'createIn' | 'createMoved' | 'createLinked'
    | 'reactIn' | 'reactOut' | 'reactMultiOut' | 'waitingIn' | 'waitingOut' | 'waitingReactMultiOut',
    string
  >;

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    svc = await import('@/lib/service-status');

    const u = await prisma.user.create({
      data: { username: `${sfx}.op`, fullName: 'SLO Operator', role: 'STEWARD', passwordHash: 'x' },
    });
    userId = u.id;
    const m = await prisma.user.create({
      data: { username: `${sfx}.mgr`, fullName: 'SLO Manager', role: 'MANAGER', passwordHash: 'x' },
    });
    managerId = m.id;
    // One request waiting at the Supervisor step, for the open-queue test.
    const waiting = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'SUBMITTED', pendingRole: 'SUPERVISOR',
        submittedAt: T('04:00:00'), stageEnteredAt: T('04:00:00'), slaDueAt: T('12:00:00'),
        fieldChanges: [], attachmentChanges: [],
      },
    });
    editIds.push(waiting.id);

    // Keep-warm: two schedulers in the 03:00 slot (one failed), one failed run in
    // 03:04, nothing in 03:08, one success in 03:12.
    const kw = (id: string, at: Date, ok: boolean, dbMs: number | null, source: string) =>
      prisma.cronRun.create({ data: { id: `${sfx}-${id}`, key: 'keep-warm', at, ok, durationMs: 100, dbMs, source } });
    await kw('a', T('03:00:05'), true, 10, 'vercel');
    // A failed probe that still timed a slow round trip: it must not enter the p95.
    await kw('b', T('03:00:40'), false, 5000, 'cron-job.org');
    await kw('c', T('03:04:10'), false, null, 'vercel');
    await kw('d', T('03:12:30'), true, 30, 'cron-job.org');

    // Approval decisions: three tracked SUPERVISOR steps (two on time), one
    // untracked (made before the snapshot existed).
    const edit = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'APPROVED',
        fieldChanges: [], attachmentChanges: [],
      },
    });
    editIds.push(edit.id);
    const step = (i: number, at: Date, due: Date | null, minutes: number | null) =>
      prisma.editApproval.create({
        data: {
          editId: edit.id, cycle: 1, stepIndex: i, role: 'SUPERVISOR', decision: 'APPROVED', actorId: userId,
          at, stageEnteredAt: due ? T('04:00:00') : null, slaDueAt: due, workingMinutes: minutes,
        },
      });
    await step(0, T('05:00:00'), T('12:00:00'), 60);
    await step(1, T('06:00:00'), T('12:00:00'), 120);
    await step(2, T('13:00:00'), T('12:00:00'), 600);
    await step(3, T('07:00:00'), null, null);

    // A reactivation decided on time: the MANAGER tier.
    const re = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'APPROVED', isReactivation: true,
        fieldChanges: [], attachmentChanges: [],
        submittedAt: T('04:00:00'), stageEnteredAt: T('04:00:00'), slaDueAt: T('12:00:00'), reviewedAt: T('06:00:00'),
        // Who decided it: the tier's "people" count, which decides whether a
        // Manager may see the tier on its own.
        reviewedById: userId,
      },
    });
    editIds.push(re.id);

    // ── Regions: which requests a Manager of region "in" can open ────────────
    const rIn = await prisma.region.create({ data: { name: `SLO In ${sfx}`, code: `${sfx}-IN` } });
    const rOut = await prisma.region.create({ data: { name: `SLO Out ${sfx}`, code: `${sfx}-OUT` } });
    reg.in = rIn.id;
    reg.out = rOut.id;
    const route = (code: string, regionId: string) =>
      prisma.route.create({ data: { name: `SLO ${code}`, code: `${sfx}-${code}`, regionId } });
    reg.routeIn = (await route('RIN', rIn.id)).id;
    reg.routeOut = (await route('ROUT', rOut.id)).id;
    // Drafted in region "in", then the route is moved to "out" (below): the request
    // page follows the route's CURRENT region, so the Manager of "in" can no longer open it.
    reg.routeMoved = (await route('RMOVED', rIn.id)).id;

    const customer = async (key: string, branches: { regionId: string; routeId: string; deleted?: boolean }[]) => {
      const c = await prisma.customer.create({
        data: { nmwcCode: `${sfx}-${key}`, legalName: `SLO ${key}`, createdById: userId },
      });
      cust.push(c.id);
      const ids: string[] = [];
      for (const [i, b] of branches.entries()) {
        const row = await prisma.branch.create({
          data: {
            customerId: c.id, branchCode: `${sfx}-${key}-${i}`, branchName: `SLO ${key} ${i}`, address: 'SLO Way 1',
            routeId: b.routeId, regionId: b.regionId, status: 'ACTIVE', deletedAt: b.deleted ? R('00:00:00') : null,
          },
        });
        ids.push(row.id);
      }
      return { id: c.id, branchIds: ids };
    };
    const cIn = await customer('CIN', [{ regionId: rIn.id, routeId: reg.routeIn }]);
    const cOut = await customer('COUT', [{ regionId: rOut.id, routeId: reg.routeOut }]);
    const cDeleted = await customer('CDEL', [{ regionId: rIn.id, routeId: reg.routeIn, deleted: true }]);
    const cMulti = await customer('CMULTI', [
      { regionId: rOut.id, routeId: reg.routeOut },
      { regionId: rIn.id, routeId: reg.routeIn },
    ]);

    // One decided request per case, each with one tracked decision.
    const decided = async (
      key: keyof typeof e,
      data: Record<string, unknown>,
      role: 'SUPERVISOR' | 'ACCOUNTANT' | 'FINANCE_MANAGER' | 'GM',
      onTime: boolean,
      minutes: number,
      day = R
    ) => {
      const edit = await prisma.customerEdit.create({
        data: {
          target: 'CUSTOMER', submittedById: userId, state: 'APPROVED', fieldChanges: [], attachmentChanges: [],
          ...data,
        } as never,
      });
      editIds.push(edit.id);
      e[key] = edit.id;
      await prisma.editApproval.create({
        data: {
          editId: edit.id, cycle: 1, stepIndex: 0, role, decision: 'APPROVED', actorId: userId,
          at: day(onTime ? '06:00:00' : '14:00:00'), stageEnteredAt: day('04:00:00'), slaDueAt: day('12:00:00'),
          workingMinutes: minutes,
        },
      });
    };
    await decided('in', { customerId: cIn.id }, 'SUPERVISOR', true, 60);
    await decided('out', { customerId: cOut.id }, 'GM', false, 900);
    // The earliest tracked decision of all, the day before and in the other
    // region: a Manager of "in" must not be shown its minute as "Measuring since".
    await decided('early', { customerId: cOut.id }, 'SUPERVISOR', true, 120, (iso) => new Date(`2099-05-09T${iso}Z`));
    await decided('deleted', { customerId: cDeleted.id }, 'FINANCE_MANAGER', true, 30);
    await decided('multi', { customerId: cMulti.id }, 'ACCOUNTANT', false, 700);
    const draft = (routeId: string) => ({
      process: 'CREATE', customerId: null,
      branchDrafts: { create: [{ branchName: 'SLO draft', regionId: rIn.id, routeId, address: 'SLO Way 2' }] },
    });
    await decided('createIn', draft(reg.routeIn), 'SUPERVISOR', true, 90);
    await decided('createMoved', draft(reg.routeMoved), 'GM', true, 45);
    await prisma.route.update({ where: { id: reg.routeMoved }, data: { regionId: rOut.id } });
    // A finalized CREATE is linked to its customer (lib/create-finalize.ts). Its
    // draft route is in "in", the customer's live branch in "out": the request
    // page follows the draft, so "in" may open it and "out" may not.
    await decided('createLinked', { ...draft(reg.routeIn), customerId: cOut.id }, 'ACCOUNTANT', true, 30);

    const reactivation = async (
      key: 'reactIn' | 'reactOut' | 'reactMultiOut',
      c: { id: string; branchIds: string[] },
      branch = 0
    ) => {
      const edit = await prisma.customerEdit.create({
        data: {
          target: 'CUSTOMER', submittedById: userId, state: 'APPROVED', isReactivation: true,
          customerId: c.id, branchId: c.branchIds[branch]!, fieldChanges: [], attachmentChanges: [],
          submittedAt: R('04:00:00'), stageEnteredAt: R('04:00:00'), slaDueAt: R('12:00:00'), reviewedAt: R('05:00:00'),
          reviewedById: managerId,
        },
      });
      editIds.push(edit.id);
      e[key] = edit.id;
    };
    await reactivation('reactIn', cIn);
    await reactivation('reactOut', cOut);
    // The multi-region customer's branch in "out": decided by "out"'s Managers
    // (/reactivations, approveReactivation). "in" may open the request, but it is
    // not "in"'s reactivation to be counted on.
    await reactivation('reactMultiOut', cMulti, 0);
    const waitingReact = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'SUBMITTED', pendingRole: 'MANAGER', isReactivation: true,
        customerId: cMulti.id, branchId: cMulti.branchIds[0]!, fieldChanges: [], attachmentChanges: [],
        submittedAt: R('04:00:00'), stageEnteredAt: R('04:00:00'), slaDueAt: R('12:00:00'),
      },
    });
    editIds.push(waitingReact.id);
    e.waitingReactMultiOut = waitingReact.id;

    const waiting2 = async (key: 'waitingIn' | 'waitingOut', customerId: string, pendingRole: 'ACCOUNTANT' | 'GM') => {
      const edit = await prisma.customerEdit.create({
        data: {
          target: 'CUSTOMER', submittedById: userId, state: 'SUBMITTED', pendingRole, customerId,
          submittedAt: R('04:00:00'), stageEnteredAt: R('04:00:00'), slaDueAt: R('12:00:00'),
          fieldChanges: [], attachmentChanges: [],
        },
      });
      editIds.push(edit.id);
      e[key] = edit.id;
    };
    await waiting2('waitingIn', cIn.id, 'ACCOUNTANT');
    await waiting2('waitingOut', cOut.id, 'GM');
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.cronRun.deleteMany({ where: { id: { startsWith: sfx } } });
    // The step ledger is append-only: its rows go with their edit, in a maintenance window.
    if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    if (cust.length) {
      await prisma.branch.deleteMany({ where: { customerId: { in: cust } } });
      await prisma.customer.deleteMany({ where: { id: { in: cust } } });
    }
    await prisma.route.deleteMany({ where: { id: { in: [reg.routeIn, reg.routeOut, reg.routeMoved].filter(Boolean) } } });
    await prisma.region.deleteMany({ where: { id: { in: [reg.in, reg.out].filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, managerId].filter(Boolean) } } });
    await prisma.$disconnect();
  });

  it('keep-warm collapses to one row per 4-minute slot on the hour grid; a slot is ok if any run in it was', async () => {
    const slots = await svc.__internal.keepWarmSlots(FROM);
    const mine = slots
      .filter((s) => s.at.getUTCFullYear() === 2099)
      .map((s) => [s.at.toISOString().slice(11, 19), s.ok])
      .sort();
    expect(mine).toEqual([
      ['03:00:00', true],
      ['03:04:00', false],
      ['03:12:00', true],
    ]);
  });

  it('the database round trip is read from successful probes only', async () => {
    // [10, 30] → p95 = 10 + 0.95 × 20 = 29
    expect(await svc.__internal.p95DbMs(FROM)).toBe(29);
  });

  it('approval tiers: tracked vs untracked, on time, and percentiles of the snapshot minutes', async () => {
    const { tiers } = await svc.__internal.approvalTiers(FROM, 'company');
    const sup = tiers.find((t) => t.role === 'SUPERVISOR');
    expect(sup).toEqual({ role: 'SUPERVISOR', decided: 4, tracked: 3, within: 2, p50Minutes: 120, p90Minutes: 504 });
    const mgr = tiers.find((t) => t.role === 'MANAGER');
    expect(mgr).toEqual({ role: 'MANAGER', decided: 1, tracked: 1, within: 1, p50Minutes: 120, p90Minutes: 120 });
  });

  it('the last successful run from Vercel’s own cron, per job — the check before retiring cron-job.org', async () => {
    const last = await svc.__internal.lastVercelRuns(new Date('2099-06-02T00:00:00Z'));
    // 03:04:10 was Vercel's too, but it failed; 03:12:30 succeeded, from cron-job.org.
    expect(last.get('keep-warm')).toEqual(T('03:00:05'));
  });

  // ── A Manager's figures: only requests that Manager can already open ──────

  /**
   * Which of our requests app/(app)/approvals/[id]/page.tsx lets a Manager of
   * `managed` open: its MANAGER gate, re-implemented over the same relations.
   */
  const pageLetsOpen = async (managed: string[]) => {
    const edits = await prisma.customerEdit.findMany({
      where: { id: { in: Object.values(e) } },
      select: {
        id: true,
        process: true,
        branchDrafts: { select: { route: { select: { regionId: true } } } },
        customer: { select: { branches: { select: { regionId: true, deletedAt: true } } } },
      },
    });
    const open = new Set<string>();
    for (const edit of edits) {
      const regionIds =
        edit.process === 'CREATE'
          ? edit.branchDrafts.map((b) => b.route.regionId)
          : (edit.customer?.branches ?? []).filter((b) => !b.deletedAt).map((b) => b.regionId);
      if (regionIds.some((r) => managed.includes(r))) open.add(edit.id);
    }
    return open;
  };

  it('the region test is the request page’s, in Prisma and in SQL alike', async () => {
    const all = Object.values(e);
    for (const managed of [[reg.in], [reg.out], [reg.in, reg.out], [] as string[]]) {
      const byPage = await pageLetsOpen(managed);
      const byPrisma = await prisma.customerEdit.findMany({
        where: { id: { in: all }, ...svc.openableInRegions(managed) },
        select: { id: true },
      });
      const { Prisma } = await import('@prisma/client');
      const bySql = await prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${all}::text[]) AND ${svc.__internal.openableInRegionsSql(managed)}`
      );
      expect(new Set(byPrisma.map((r) => r.id)), `Prisma, regions ${managed.length}`).toEqual(byPage);
      expect(new Set(bySql.map((r) => r.id)), `SQL, regions ${managed.length}`).toEqual(byPage);

      // What a Manager's figures count: the same in Prisma and SQL, and never a
      // request the page would not open.
      const countedPrisma = await prisma.customerEdit.findMany({
        where: { id: { in: all }, ...svc.countedInRegions(managed) },
        select: { id: true },
      });
      const countedSql = await prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT e."id" FROM "CustomerEdit" e WHERE e."id" = ANY(${all}::text[]) AND ${svc.__internal.countedInRegionsSql(managed)}`
      );
      const counted = new Set(countedPrisma.map((r) => r.id));
      expect(new Set(countedSql.map((r) => r.id)), `counted SQL, regions ${managed.length}`).toEqual(counted);
      for (const id of counted) expect(byPage.has(id), `counted but not openable: ${id}`).toBe(true);
    }
    // The cases themselves: live branch in the region, a multi-region customer,
    // a draft on a route there now, a finalized CREATE whose draft route is here
    // though its customer's branch is not — yes; the other region, a deleted
    // branch, a draft whose route has since moved away — no.
    expect(await pageLetsOpen([reg.in])).toEqual(
      new Set([e.in, e.multi, e.createIn, e.createLinked, e.reactIn, e.reactMultiOut, e.waitingIn, e.waitingReactMultiOut])
    );
    expect((await pageLetsOpen([reg.out])).has(e.createLinked)).toBe(false);
    // Counted for "in": all of that but the other region's branch's reactivations.
    const countedIn = await prisma.customerEdit.findMany({
      where: { id: { in: all }, ...svc.countedInRegions([reg.in]) },
      select: { id: true },
    });
    expect(new Set(countedIn.map((r) => r.id))).toEqual(
      new Set([e.in, e.multi, e.createIn, e.createLinked, e.reactIn, e.waitingIn])
    );
  });

  it('a Manager’s approval tiers: the Supervisor step in their regions; the company’s count every step', async () => {
    const tiers = async (regionIds: string[]) => svc.__internal.approvalTiers(REGION_FROM, { regionIds });
    const mine = await tiers([reg.in]);
    // No Accountant row though "in" has Accountant decisions, and no reactivations
    // row though "in" has a decided reactivation: no Manager screen shows their due times.
    expect(mine.tiers).toEqual([{ role: 'SUPERVISOR', decided: 2, tracked: 2, within: 2, p50Minutes: 75, p90Minutes: 87 }]);
    // "Measuring since" is the earliest decision these figures count — "in"'s
    // Supervisor decisions at 06:00 — not the company's first, out of region, the day before.
    expect(mine.firstCounted).toEqual(R('06:00:00'));
    const theirs = await tiers([reg.out]);
    expect(theirs.tiers).toEqual([{ role: 'SUPERVISOR', decided: 1, tracked: 1, within: 1, p50Minutes: 120, p90Minutes: 120 }]);
    expect(theirs.firstCounted).toEqual(new Date('2099-05-09T06:00:00Z'));
    // No regions counts nothing, and measures from nothing.
    expect(await tiers([])).toEqual({ tiers: [], firstCounted: null });
    // The company's has every step, reactivations included.
    const company = await svc.__internal.approvalTiers(REGION_FROM, 'company');
    expect(company.tiers.find((t) => t.role === 'GM')?.decided).toBe(2);
    expect(company.tiers.find((t) => t.role === 'FINANCE_MANAGER')?.decided).toBe(1);
    expect(company.tiers.find((t) => t.role === 'ACCOUNTANT')?.decided).toBe(2);
    // Three region reactivations on 10 May, and the suite's first one on 1 June.
    expect(company.tiers.find((t) => t.role === 'MANAGER')?.decided).toBe(4);
    expect(company.firstCounted!.getTime()).toBeLessThanOrEqual(new Date('2099-05-09T06:00:00Z').getTime());
  });

  it('a Manager’s waiting queue: the Supervisor step in their regions', async () => {
    const now = new Date('2099-06-02T00:00:00Z');
    const view = (tiers: { role: string; open: number }[]) => tiers.map((t) => [t.role, t.open]);
    // "in" has a request waiting at the Accountant step and "out" a reactivation:
    // neither is on a Manager's page. The request with no customer at all waits
    // at the Supervisor step: nobody's region.
    for (const regionIds of [[reg.in], [reg.out], [] as string[]]) {
      expect(view(await svc.__internal.openApprovals(now, { regionIds }))).toEqual([['SUPERVISOR', 0]]);
    }
    const company = await svc.__internal.openApprovals(now, 'company');
    const open = (role: string) => company.find((t) => t.role === role)?.open ?? 0;
    for (const role of ['SUPERVISOR', 'ACCOUNTANT', 'GM', 'MANAGER']) expect(open(role), role).toBeGreaterThanOrEqual(1);
  });

  it('the whole loader runs against real Postgres and returns verdicts', async () => {
    const s = await svc.loadServiceStatus('company', new Date('2099-06-02T00:00:00Z'));
    const statuses = ['met', 'at-risk', 'breached', 'no-data'];
    for (const v of [s.availability, s.slaSweep, s.backup, s.approvals]) expect(statuses).toContain(v.status);
    expect(statuses).toContain(s.temix.status);
    expect(statuses).toContain(s.imports.status);
    for (const t of s.openApprovals) expect(t.open).toBeGreaterThanOrEqual(t.pastDue);
    expect(s.jobs.length).toBeGreaterThan(0);
    for (const j of s.jobs) expect(j).not.toHaveProperty('lastError');
    // Our SUPERVISOR decisions are inside its 30-day window.
    expect(s.approvals.tiers.some((t) => t.role === 'SUPERVISOR' && t.decided >= 4)).toBe(true);
  });
});
