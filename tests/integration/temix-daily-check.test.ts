// @vitest-environment node
/**
 * The daily Temix import, stage 4, against real Postgres: the Check of a file
 * staged through the real upload (services/temix-daily.ts), made from the real
 * reads (lib/temix-daily-check-load.ts), and the route map through its real
 * actions (services/temix-daily-routes.ts). Every row and code is synthetic.
 *
 *  - The Check's figures for a synthetic CRM and file: a shop already on its
 *    route, a move by exact code, a move into another region with a credit
 *    limit that differs (not applied), a customer found by its Temix code only
 *    (shops not linked), an unknown customer, a route code not matched, a
 *    switched-off route, a customer named by no row, a test customer left out.
 *  - The route map: an entry C<x>MA -> a CRM route makes that row move through
 *    the map; a second entry for the code, an exact CRM code, a reason left
 *    blank and anyone but the Steward are refused; retiring it puts the row
 *    back to "not matched". Each write is one TemixRouteMap row and one AuditLog
 *    row under the temix-route-map source.
 *  - The pilot rule's reads find a new-customer request waiting at the Accountant.
 *  - NOTHING ELSE CHANGES: the Check and the route map write no Customer,
 *    Branch, history, ledger or notification row, and leave the staged rows and
 *    the file exactly as the upload left them.
 *
 *   RUN_TEMIX_DAILY_CHECK=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/temix-daily-check.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { contextClient, src } from '@/lib/change-context';
import { checkDailyFile, type RowPlan } from '@/lib/temix-daily-check';
import {
  loadCheckInput,
  loadLiveRouteMap,
  loadPilotWaiting,
  loadSwitchedOffRoutesHoldingShops,
  loadWaitingRouteCodes,
} from '@/lib/temix-daily-check-load';
import { withAuditMaintenance, purgeAuditLog } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_TEMIX_DAILY_CHECK === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEAD = ['cust_code', 'branch_code', 'cust_name', 'route', 'payment_terms', 'credit_limit', 'payment_term_days', 'status'];
const csv = (rows: string[][]) => new TextEncoder().encode([[...HEAD, 'created_date'], ...rows.map((r) => [...r, ''])].map((r) => r.join(',')).join('\r\n'));

describe.skipIf(!ENABLED)('the daily Temix Check and route map on Postgres', () => {
  let prisma: PrismaClient;
  let upload: typeof import('@/services/temix-daily');
  let routesSvc: typeof import('@/services/temix-daily-routes');
  let w: World;
  let S = '';
  let fileId = '';
  let ids: Record<string, string> = {};
  let before = '';
  let editId = '';

  const okData = <T,>(res: { ok: boolean }) => {
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return (res as unknown as { data: T }).data;
  };
  const refusal = (res: { ok: boolean }) => {
    expect(res.ok, JSON.stringify(res)).toBe(false);
    const r = res as unknown as { message: string; fields?: Record<string, string>; code?: string };
    return { text: r.fields ? Object.values(r.fields).join(' ') : r.message, code: r.code };
  };
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };
  const check = async () => {
    const { input, emptied } = await loadCheckInput(prisma, fileId);
    expect(emptied).toBe(0);
    const plan = checkDailyFile(input);
    return { plan, row: new Map<number, RowPlan>(plan.rows.map((p) => [p.rowNumber, p])) };
  };

  /** Everything the Check and the route map must never touch. */
  const untouched = async () => {
    const [r] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT (SELECT count(*) FROM "Customer") AS customer, (SELECT count(*) FROM "Branch") AS branch,
             (SELECT count(*) FROM "Route") AS route,
             (SELECT count(*) FROM "CustomerHistory") AS ch, (SELECT count(*) FROM "BranchHistory") AS bh,
             (SELECT count(*) FROM "RouteHistory") AS rh,
             (SELECT count(*) FROM "TemixChange") AS tc, (SELECT count(*) FROM "TemixNoticeSeen") AS tns,
             (SELECT count(*) FROM "TemixChangeReview") AS tcr, (SELECT count(*) FROM "Notification") AS n,
             (SELECT max("updatedAt") FROM "Customer") AS cu, (SELECT max("updatedAt") FROM "Branch") AS bu,
             (SELECT string_agg(b."id" || ':' || b."routeId" || ':' || b."regionId" || ':' || b."version", ',' ORDER BY b."id") FROM "Branch" b) AS shops,
             (SELECT md5(string_agg(r."id" || r."outcome" || array_to_string(r."holdReasons", '|') || coalesce(r."customerId", '') || coalesce(r."branchId", '') || coalesce(r."parsed"::text, ''), ',' ORDER BY r."id"))
                FROM "TemixDailyRow" r WHERE r."fileId" = ${fileId}) AS rows,
             (SELECT f."state"::text || f."heldRows" || f."appliedRows" FROM "TemixDailyFile" f WHERE f."id" = ${fileId}) AS file`;
    return JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  };

  beforeAll(async () => {
    assertNotProductionEnv();
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    upload = await import('@/services/temix-daily');
    routesSvc = await import('@/services/temix-daily-routes');
    w = await buildWorld(prisma, 'temixck');
    S = w.sfx.toUpperCase();
    const db = contextClient(prisma, { actorId: null, source: src.test('temix-daily-check') });
    // Routes: the world's route R (region A), R2 (region A), R3 (region B), RX (switched off).
    const route = async (code: string, regionId: string, isActive = true) => {
      const r = await db.route.create({ data: { code, name: `ZZ ${code}`, regionId, isActive } });
      w.routes.push(r.id);
      return r.id;
    };
    ids.R = w.route;
    ids.R2 = await route(`${S}R2`, w.regionA);
    ids.R3 = await route(`${S}R3`, w.regionB);
    ids.RX = await route(`${S}RX`, w.regionA, false);
    const customer = async (key: string, data: Record<string, unknown>) => {
      const c = await db.customer.create({ data: { nmwcCode: `${S}${key}`, legalName: `ZZ ${key}`, paymentTerms: 'CASH', ...data } });
      w.customers.push(c.id);
      ids[`c${key}`] = c.id;
      return c.id;
    };
    const shop = async (key: string, customerId: string, branchCode: string, routeId: string, regionId: string) => {
      const b = await db.branch.create({
        data: { customerId, branchCode, branchName: 'ZZ shop', routeId, regionId, address: 'ZZ Way 1, synthetic', status: 'ACTIVE' },
      });
      w.branches.push(b.id);
      ids[key] = b.id;
    };
    await customer('1', {});
    await shop('b11', ids.c1!, `${S}1-01`, ids.R, w.regionA);
    await shop('b12', ids.c1!, `${S}1-02`, ids.R2, w.regionA);
    await shop('b13', ids.c1!, `${S}1-03`, ids.R, w.regionA);
    await customer('2', { paymentTerms: 'CREDIT', creditLimit: 1500, paymentTermDays: 30, temixCode: `${S}2` });
    await shop('b21', ids.c2!, `${S}2-01`, ids.R, w.regionA);
    await customer('N', { temixCode: `${S}T` });
    await shop('bN1', ids.cN!, `${S}N-01`, ids.R, w.regionA);
    await customer('M', {}); // named by no row
    await customer('Z', {}); // a test customer, named by no row: flagged in the owner's window
    await withAuditMaintenance(prisma, (tx) => tx.customer.update({ where: { id: ids.cZ! }, data: { isTest: true } }));
    await shop('bZ1', ids.cZ!, `${S}Z-01`, ids.RX, w.regionA); // a switched-off route still holding a shop

    const res = await (async () => {
      current = { id: w.steward, role: 'STEWARD', username: `${w.sfx}.stw` };
      const fd = new FormData();
      const bytes = csv([
        [`${S}1`, '01', 'Customer 1', `${S}R`, 'CASH', '', '', 'A'], // 2: already on R
        [`${S}1`, '02', 'Customer 1', `${S}R`, 'CASH', '', '', 'A'], // 3: R2 -> R
        [`${S}2`, `${S}2-01`, 'Customer 2', `${S}R3`, 'CREDIT', '2000', '30', 'A'], // 4: R -> R3, another region; limit differs
        [`${S}T`, '01', 'Customer 3', `${S}R`, 'CASH', '', '', 'A'], // 5: found by its Temix code; shops not linked
        [`${S}NEW`, '01', 'Customer 4', `${S}R`, 'CASH', '', '', 'A'], // 6: unknown customer
        [`${S}1`, '03', 'Customer 1', `${S}R2MA`, 'CASH', '', '', 'I'], // 7: route code not matched
        [w.sfx.toUpperCase() + '-C', '01', 'Customer 5', `${S}RX`, 'CASH', '', '', 'A'], // 8: switched-off route
      ]);
      fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], `${S}-check.csv`, { type: 'text/csv' }));
      return upload.uploadTemixDailyFileAction(fd);
    })();
    fileId = okData<{ fileId: string }>(res).fileId;
    // The pilot rule: a new-customer request waiting at the Accountant.
    editId = (
      await contextClient(prisma, { actorId: w.salesman, source: src.test('temix-daily-check') }).customerEdit.create({
        data: {
          target: 'CUSTOMER',
          state: 'SUBMITTED',
          submittedById: w.salesman,
          submittedAt: new Date(),
          process: 'CREATE',
          pendingRole: 'ACCOUNTANT',
          fieldChanges: [] as never,
          attachmentChanges: [] as never,
        },
      })
    ).id;
    before = await untouched();
  });

  beforeEach(() => {
    current = { id: w.steward, role: 'STEWARD', username: `${w.sfx}.stw` };
  });

  afterAll(async () => {
    if (!prisma) return;
    if (w) {
      await withAuditMaintenance(prisma, async (tx) => {
        const mine = await tx.temixRouteMap.findMany({ where: { byId: w.steward }, select: { id: true } });
        await tx.temixRouteMap.deleteMany({ where: { id: { in: mine.map((m) => m.id) }, action: 'RETIRE' } });
        await tx.temixRouteMap.deleteMany({ where: { id: { in: mine.map((m) => m.id) } } });
        if (fileId) {
          await tx.temixDailyRow.deleteMany({ where: { fileId } });
          await tx.temixDailyFile.deleteMany({ where: { id: fileId } });
        }
      });
      await purgeAuditLog(prisma, { where: { actorId: w.steward } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
      await tearDownWorld(prisma, w, { editIds: editId ? [editId] : [] });
    }
    await prisma.$disconnect();
  });

  it('the Check of the staged file, row by row', async () => {
    const { row } = await check();
    expect(row.get(2)).toMatchObject({ verdict: 'NO_CHANGE', customerId: ids.c1, branchId: ids.b11, holds: [], routeHold: null, move: null });
    expect(row.get(3)).toMatchObject({
      verdict: 'WOULD_MOVE',
      move: { branchId: ids.b12, fromRouteId: ids.R2, toRouteId: ids.R, fromRegionId: w.regionA, toRegionId: w.regionA, via: 'EXACT' },
    });
    expect(row.get(4)).toMatchObject({
      verdict: 'WOULD_MOVE',
      matchedBy: 'BOTH',
      move: { branchId: ids.b21, fromRouteId: ids.R, toRouteId: ids.R3, fromRegionId: w.regionA, toRegionId: w.regionB, via: 'EXACT' },
      terms: [{ field: 'creditLimit', crm: '1500', file: '2000' }],
    });
    expect(row.get(5)).toMatchObject({ verdict: 'HELD', customerId: ids.cN, matchedBy: 'TEMIX_CODE', holds: ['SHOP_NOT_LINKED'] });
    expect(row.get(6)).toMatchObject({ verdict: 'HELD', customerId: null, holds: ['CUSTOMER_UNKNOWN'] });
    expect(row.get(7)).toMatchObject({ verdict: 'NO_CHANGE', branchId: ids.b13, routeHold: 'ROUTE_NOT_MATCHED', route: { kind: 'NOT_MATCHED', code: `${S}R2MA` } });
    expect(row.get(8)).toMatchObject({ verdict: 'NO_CHANGE', branchId: w.branch, routeHold: 'ROUTE_SWITCHED_OFF' });
  });

  it('the summary figures', async () => {
    const { plan } = await check();
    expect(plan.counts).toMatchObject({
      rows: 7,
      held: 2,
      wouldMove: 2,
      noChange: 3,
      customersMatched: 4,
      unknownCustomers: { codes: 1, rows: 1 },
      moves: { shops: 2, customers: 2, crossRegion: 1, viaMap: 0 },
      holds: { SHOP_NOT_LINKED: 1, CUSTOMER_UNKNOWN: 1 },
      routeHolds: { ROUTE_NOT_MATCHED: 1, ROUTE_SWITCHED_OFF: 1 },
      terms: { rows: 1, customers: 1, byField: { paymentTerms: 0, creditLimit: 1, paymentTermDays: 0 }, customersWithRowsDisagreeing: 0 },
    });
    expect(plan.counts.statusByCustomer).toEqual([
      { temix: 'A', crm: 'ACTIVE', rows: 5 },
      { temix: 'I', crm: 'ACTIVE', rows: 1 },
    ]);
    expect(plan.unmatchedRoutes).toEqual([{ code: `${S}R2MA`, rows: 1, shopFound: 1 }]);
    // Customers not in the file are counted over the whole CRM: this world's
    // customer named by no row is among them, its test customer is not, and
    // none the file names is.
    expect(plan.missingCustomerIds).toContain(ids.cM);
    expect(plan.missingCustomerIds).not.toContain(ids.cZ);
    for (const id of [ids.c1, ids.c2, ids.cN, w.customer]) expect(plan.missingCustomerIds).not.toContain(id);
  });

  it('the route-map page\'s reads: the code not matched among the waiting files, and the switched-off route holding a shop', async () => {
    const codes = await loadWaitingRouteCodes(prisma);
    expect(codes).toEqual(expect.arrayContaining([{ code: `${S}R2MA`, rows: 1 }, { code: `${S}R`, rows: 4 }]));
    const off = await loadSwitchedOffRoutesHoldingShops(prisma);
    expect(off).toEqual(expect.arrayContaining([{ id: ids.RX, code: `${S}RX`, shops: 1 }]));
  });

  it('the pilot rule\'s read finds the request waiting at the Accountant', async () => {
    const waiting = await loadPilotWaiting(prisma);
    expect(waiting.map((x) => x.id)).toContain(editId);
  });

  let entryId = '';
  it('a route-map entry makes the row move through the map, with one row and one audit row', async () => {
    expect(await loadLiveRouteMap(prisma)).not.toEqual(expect.arrayContaining([expect.objectContaining({ temixRouteCode: `${S}R2MA` })]));
    const out = okData<{ id: string; code: string }>(
      await routesSvc.addTemixRouteMapAction(form({ code: ` ${S.toLowerCase()}r2ma `, routeId: ids.R2!, reason: 'Synthetic route master, test' }))
    );
    entryId = out.id;
    expect(out.code).toBe(`${S}R2MA`);
    const entry = await prisma.temixRouteMap.findUniqueOrThrow({ where: { id: BigInt(entryId) } });
    expect(entry).toMatchObject({ temixRouteCode: `${S}R2MA`, action: 'ADD', routeId: ids.R2, byId: w.steward, source: `temix-route-map:add:${S}R2MA` });
    expect(entry.txId).not.toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { entityType: 'TemixRouteMap', entityId: entryId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'CREATE', actorId: w.steward, source: `temix-route-map:add:${S}R2MA` });
    expect(audit[0]!.txId).toEqual(entry.txId);

    const { plan, row } = await check();
    expect(row.get(7)).toMatchObject({
      verdict: 'WOULD_MOVE',
      route: { kind: 'MAP', routeId: ids.R2, code: `${S}R2MA`, entryId },
      move: { branchId: ids.b13, fromRouteId: ids.R, toRouteId: ids.R2, via: 'MAP' },
    });
    expect(plan.counts).toMatchObject({ wouldMove: 3, noChange: 2, moves: { shops: 3, viaMap: 1 } });
    expect(plan.unmatchedRoutes).toEqual([]);
  });

  it('refused: a second entry for the code, an exact CRM code, no reason, an unknown route, anyone but the Steward', async () => {
    const add = (o: Record<string, string>) => routesSvc.addTemixRouteMapAction(form({ reason: 'Synthetic route master, test', ...o }));
    expect(refusal(await add({ code: `${S}R2MA`, routeId: ids.R3! })).text).toMatch(/already has an entry\. Retire it first/);
    expect(refusal(await add({ code: `${S}R3`, routeId: ids.R! })).text).toMatch(/already a CRM route's code/);
    expect(refusal(await add({ code: `${S}Q`, routeId: ids.R!, reason: ' ' })).text).toMatch(/Give a reason/);
    expect(refusal(await add({ code: `${S}Q`, routeId: 'no-such-route' })).text).toMatch(/Pick the CRM route/);
    current = { id: w.manager, role: 'MANAGER', username: `${w.sfx}.m` };
    expect(refusal(await add({ code: `${S}Q`, routeId: ids.R! })).code).toBe('FORBIDDEN');
    expect(refusal(await routesSvc.retireTemixRouteMapAction(form({ id: entryId, reason: 'Synthetic, test' }))).code).toBe('FORBIDDEN');
    current = { id: w.steward, role: 'STEWARD', username: `${w.sfx}.stw` };
    const mine = await prisma.temixRouteMap.findMany({ where: { temixRouteCode: { startsWith: S } } });
    expect(mine.map((m) => m.temixRouteCode)).toEqual([`${S}R2MA`]);
  });

  it('two entries for one code at once: exactly one is written', async () => {
    const both = await Promise.all(
      [ids.R!, ids.R3!].map((routeId) => routesSvc.addTemixRouteMapAction(form({ code: `${S}DUO`, routeId, reason: 'Synthetic route master, test' })))
    );
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.temixRouteMap.count({ where: { temixRouteCode: `${S}DUO` } })).toBe(1);
  });

  it('retiring the entry puts the row back to "not matched"; it cannot be retired twice', async () => {
    okData(await routesSvc.retireTemixRouteMapAction(form({ id: entryId, reason: 'Synthetic, superseded' })));
    const retire = await prisma.temixRouteMap.findFirstOrThrow({ where: { retiresId: BigInt(entryId) } });
    expect(retire).toMatchObject({ action: 'RETIRE', temixRouteCode: `${S}R2MA`, routeId: null, source: `temix-route-map:retire:${S}R2MA` });
    expect(await prisma.auditLog.count({ where: { entityType: 'TemixRouteMap', entityId: retire.id.toString() } })).toBe(1);
    expect(refusal(await routesSvc.retireTemixRouteMapAction(form({ id: entryId, reason: 'Again' }))).text).toMatch(/already retired/);
    expect(refusal(await routesSvc.retireTemixRouteMapAction(form({ id: retire.id.toString(), reason: 'Again' }))).text).toMatch(/cannot be retired|not a route-map entry/);
    const { row } = await check();
    expect(row.get(7)).toMatchObject({ verdict: 'NO_CHANGE', routeHold: 'ROUTE_NOT_MATCHED' });
    // A new entry for the code may follow the retirement.
    okData(await routesSvc.addTemixRouteMapAction(form({ code: `${S}R2MA`, routeId: ids.R3!, reason: 'Synthetic route master, second' })));
    expect((await check()).row.get(7)).toMatchObject({ verdict: 'WOULD_MOVE', move: { toRouteId: ids.R3, fromRegionId: w.regionA, toRegionId: w.regionB } });
  });

  it('nothing else changed: no customer, shop, route, history, ledger or notification row; the staged file and rows as uploaded', async () => {
    expect(await untouched()).toBe(before);
  });
});
