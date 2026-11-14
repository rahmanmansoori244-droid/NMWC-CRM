// @vitest-environment node
/**
 * The daily Temix import, stage 5, against real Postgres through the real
 * actions (services/temix-daily-apply.ts) and the one route writer
 * (lib/temix-daily-move.ts). Every code, row and id is synthetic.
 *
 * Two files: A, staged here for a load day three days ago (the upload always
 * stages today; the database accepts any day that is not in the future), and
 * B, uploaded today through the real upload. Shops were created ten days ago
 * (effectiveFrom), so a move's history row shows its own date, not a clamp.
 *
 *  - The order rule: B waits for A. The pilot rule and the figures the Steward
 *    confirms refuse the start, writing nothing.
 *  - A moves two shops (one into another region) and leaves the rest: an
 *    unknown route holds its row and the shop stays where it was; a switched-off
 *    route, an unknown customer are held. Each move: one BranchHistory UPDATE of
 *    routeId and regionId dated the START OF THE LOAD DAY, one AuditLog row with
 *    the file's lineage, one ledger row, joined by txId; the route intervals
 *    follow. The salesman's list, his Today list, the manager's list and the
 *    dashboard's scope read the shop on its new route at once.
 *  - B sets one of A's moves back: its start asks for the reversal tick. It is
 *    applied one customer per slice; the first slice is abandoned (its lease run
 *    out), the pilot rule stops the resume, two resumes at once take the lease
 *    once, and the load finishes without doing anything twice; the move is dated
 *    the start of today (the clamp against A's row is earlier).
 *  - The same rows again in another file change nothing: no history, ledger or
 *    shop audit row.
 *  - A file for a day before B's can never be applied; it is discarded with a
 *    reason. Anyone but the Data Steward is refused.
 *
 *   RUN_TEMIX_DAILY_APPLY=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/temix-daily-apply.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { contextClient, omanDayStart, src } from '@/lib/change-context';
import { reportDailyHeadings, sortedNotes, stageDailyRows } from '@/lib/temix-daily-file';
import { stalledDailyLoadWhere } from '@/lib/temix-daily-apply';
import { customerListBranchScope } from '@/lib/customer-filters';
import { parseInsightFilters, resolveInsightScope } from '@/lib/insights/scope';
import { branchInScopeSql } from '@/lib/insights/sql';
import { withAuditMaintenance, purgeAuditLog, purgeCustomerEdits } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_TEMIX_DAILY_APPLY === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEAD = ['cust_code', 'branch_code', 'cust_name', 'route', 'payment_terms', 'credit_limit', 'payment_term_days', 'status', 'created_date'];
const omanDay = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

describe.skipIf(!ENABLED)('the daily Temix apply on Postgres', () => {
  let prisma: PrismaClient;
  let apply: typeof import('@/services/temix-daily-apply');
  let upload: typeof import('@/services/temix-daily');
  let w: World;
  let S = '';
  const ids: Record<string, string> = {};
  const files: string[] = [];
  const edits: string[] = [];
  const today = omanDay(new Date());
  const D3 = omanDay(new Date(Date.now() - 3 * DAY));
  const D2 = omanDay(new Date(Date.now() - 2 * DAY));
  const D10 = omanDay(new Date(Date.now() - 10 * DAY));

  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };
  const fresh = async () => prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
  const ok = <T,>(res: { ok: boolean }) => {
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return (res as unknown as { data: T }).data;
  };
  const refusal = (res: { ok: boolean }) => {
    expect(res.ok, JSON.stringify(res)).toBe(false);
    const r = res as unknown as { message: string; fields?: Record<string, string>; code?: string };
    return { text: r.fields ? Object.values(r.fields).join(' ') : r.message, code: r.code };
  };
  type Slice = import('@/services/temix-daily-apply').TemixDailySliceResult;
  const start = async (fileId: string, seen: { moves: number; crossRegion: number; reversals: number }, ticks: Record<string, string> = { confirmFigures: '1' }) => {
    await fresh();
    return apply.startTemixDailyApplyAction(
      form({ fileId, seenMoves: String(seen.moves), seenCrossRegion: String(seen.crossRegion), seenReversals: String(seen.reversals), ...ticks })
    );
  };
  const slice = async (fileId: string, leaseToken?: string) => {
    await fresh();
    return apply.runTemixDailySliceAction(form({ fileId, ...(leaseToken ? { leaseToken } : {}) }));
  };
  /** Slices until done, as the page's form runs them. */
  const runToEnd = async (fileId: string, token?: string) => {
    let lease = token;
    for (let i = 0; i < 50; i++) {
      const r = ok<Slice>(await slice(fileId, lease));
      if (r.done || r.stopped) return r;
      lease = r.leaseToken;
    }
    throw new Error('the load never finished');
  };
  const shop = (id: string) => prisma.branch.findUniqueOrThrow({ where: { id }, select: { routeId: true, regionId: true, version: true, lastEditedById: true } });
  const history = (fileId: string) =>
    prisma.branchHistory.findMany({ where: { source: { startsWith: `temix-daily:${fileId}:` } }, orderBy: { id: 'asc' } });

  /** Stages a file the way the upload does, for a load day the upload cannot give (an earlier one). */
  const stageDirect = async (loadDay: string, rows: string[][], name: string) => {
    const sheet = rows.map((r) => Object.fromEntries(HEAD.map((h, i) => [h, r[i] ?? ''])));
    const staged = stageDailyRows({ rows: sheet, rowNumbers: sheet.map((_, i) => i + 2) }, reportDailyHeadings(HEAD));
    const id = randomUUID();
    const bytes = JSON.stringify(rows);
    await prisma.temixDailyFile.create({
      data: {
        id,
        filename: name,
        loadDay: new Date(`${loadDay}T00:00:00Z`),
        uploadedById: w.steward,
        uploadedAt: new Date(`${loadDay}T05:00:00Z`),
        fileSha256: createHash('sha256').update(bytes).digest('hex'),
        fileBytes: bytes.length,
        headings: { kind: 'csv', sheet: 'CSV', read: {}, notRead: [], otherSheets: [], notesAtUpload: { rows: 0, byNote: {} } },
        totalRows: staged.length,
      },
    });
    await prisma.temixDailyRow.createMany({
      data: staged.map((r) => ({
        fileId: id,
        rowNumber: r.rowNumber,
        raw: r.raw as Prisma.InputJsonValue,
        parsed: r.parsed as unknown as Prisma.InputJsonValue,
        custCodeKey: r.custCodeKey,
        branchCodeKey: r.branchCodeKey,
        holdReasons: sortedNotes(r.notes),
      })),
    });
    files.push(id);
    return id;
  };
  const uploadCsv = async (rows: string[][], name: string) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
    const bytes = new TextEncoder().encode([HEAD, ...rows].map((r) => r.join(',')).join('\r\n'));
    const fd = new FormData();
    fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'text/csv' }));
    const id = ok<{ fileId: string }>(await upload.uploadTemixDailyFileAction(fd)).fileId;
    files.push(id);
    return id;
  };
  const pilotRequest = async () => {
    const e = await contextClient(prisma, { actorId: w.salesman, source: src.test('temix-daily-apply') }).customerEdit.create({
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
    });
    edits.push(e.id);
    return e.id;
  };
  const salesmanSees = async () =>
    (
      await prisma.customer.findMany({
        where: { id: { in: [ids.c1!, ids.c2!, ids.c4!] }, branches: { some: customerListBranchScope('SALESMAN', { ownedRouteId: w.route, teamRouteIds: [], managedRegionIds: [] }).branchSome! } },
        select: { id: true },
      })
    ).map((c) => c.id);
  const managerSees = async () =>
    (
      await prisma.customer.findMany({
        where: { id: { in: [ids.c1!, ids.c2!, ids.c4!] }, branches: { some: customerListBranchScope('MANAGER', { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [w.regionA] }).branchSome! } },
        select: { id: true },
      })
    ).map((c) => c.id);
  /** The salesman's Today page's scope (app/(app)/today/page.tsx routeBranchWhere), any visit day. */
  const todayShops = async () =>
    (await prisma.branch.findMany({ where: { id: { in: [ids.b41!, ids.b11!, ids.b21!] }, routeId: w.route, deletedAt: null, customer: { deletedAt: null } }, select: { id: true } })).map((b) => b.id);
  const dashboardShops = async () => {
    const scope = resolveInsightScope('MANAGER', { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [w.regionA] }, parseInsightFilters({}));
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT b."id" FROM "Branch" b WHERE b."id" = ANY(${[ids.b41!, ids.b11!, ids.b21!]}::text[]) AND b."deletedAt" IS NULL AND ${branchInScopeSql(scope, 'b')}`);
    return rows.map((r) => r.id);
  };

  beforeAll(async () => {
    assertNotProductionEnv();
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    apply = await import('@/services/temix-daily-apply');
    upload = await import('@/services/temix-daily');
    w = await buildWorld(prisma, 'temixap');
    S = w.sfx.toUpperCase();
    // Everything this suite makes is dated ten days ago, so a move's dated row shows the load day.
    const db = contextClient(prisma, { actorId: null, source: src.test('temix-daily-apply'), effectiveFrom: D10 });
    const route = async (key: string, code: string, regionId: string, isActive = true) => {
      const r = await db.route.create({ data: { code, name: `ZZ ${code}`, regionId, isActive } });
      w.routes.push(r.id);
      ids[key] = r.id;
    };
    await route('R2', `${S}R2`, w.regionA);
    await route('R3', `${S}R3`, w.regionB);
    await route('RX', `${S}RX`, w.regionA, false);
    const customer = async (key: string) => {
      const c = await db.customer.create({ data: { nmwcCode: `${S}${key}`, legalName: `ZZ ${key}`, paymentTerms: 'CASH' } });
      w.customers.push(c.id);
      ids[`c${key}`] = c.id;
    };
    const branch = async (key: string, customerKey: string, code: string, routeId: string, regionId: string) => {
      const b = await db.branch.create({
        data: { customerId: ids[`c${customerKey}`]!, branchCode: code, branchName: 'ZZ shop', routeId, regionId, address: 'ZZ Way 1, synthetic', status: 'ACTIVE' },
      });
      w.branches.push(b.id);
      ids[key] = b.id;
    };
    await customer('1');
    await branch('b11', '1', `${S}1-01`, ids.R2!, w.regionA);
    await branch('b12', '1', `${S}1-02`, w.route, w.regionA);
    await branch('b13', '1', `${S}1-03`, w.route, w.regionA);
    await customer('2');
    await branch('b21', '2', `${S}2-01`, w.route, w.regionA);
    await customer('4');
    await branch('b41', '4', `${S}4-01`, ids.R3!, w.regionB);
  });

  beforeEach(() => {
    current = { id: w.steward, role: 'STEWARD', username: `${w.sfx}.stw` };
    delete process.env.TEMIX_DAILY_SLICE_MAX_GROUPS;
  });

  afterAll(async () => {
    delete process.env.TEMIX_DAILY_SLICE_MAX_GROUPS;
    if (!prisma) return;
    if (w) {
      await withAuditMaintenance(prisma, async (tx) => {
        await tx.temixChange.deleteMany({ where: { fileId: { in: files } } });
        await tx.temixDailyRow.deleteMany({ where: { fileId: { in: files } } });
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files }, sameBytesAsFileId: { not: null } } });
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files } } });
      });
      if (edits.length) await purgeCustomerEdits(prisma, { where: { id: { in: edits } } });
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: w.steward }, { entityId: { in: files } }] } });
      await tearDownWorld(prisma, w, { editIds: edits });
    }
    await prisma.$disconnect();
  });

  let A = '';
  let B = '';

  it('stages file A for a load day three days ago and file B today', async () => {
    A = await stageDirect(
      D3,
      [
        [`${S}4`, '01', 'Customer 4', `${S}R`, 'CASH', '', '', 'A', ''], // 2: R3 -> R, from region B into A
        [`${S}1`, '01', 'Customer 1', `${S}R`, 'CASH', '', '', 'A', ''], // 3: R2 -> R
        [`${S}1`, '02', 'Customer 1', `${S}R`, 'CASH', '', '', 'A', ''], // 4: already on R
        [`${S}1`, '03', 'Customer 1', `${S}ZZ9`, 'CASH', '', '', 'A', ''], // 5: an unknown route
        [`${S}2`, '01', 'Customer 2', `${S}RX`, 'CASH', '', '', 'A', ''], // 6: a switched-off route
        [`${S}NEW`, '01', 'Customer 9', `${S}R`, 'CASH', '', '', 'A', ''], // 7: unknown customer
      ],
      `${S}-A.csv`
    );
    B = await uploadCsv(
      [
        [`${S}1`, '01', 'Customer 1', `${S}R2`, 'CASH', '', '', 'A', ''], // 2: R -> R2, setting A's move back
        [`${S}1`, '02', 'Customer 1', `${S}R`, 'CASH', '', '', 'A', ''], // 3: already on R
        [`${S}2`, '01', 'Customer 2', `${S}R3`, 'CASH', '', '', 'A', ''], // 4: R -> R3, into region B
        [`${S}4`, '01', 'Customer 4', `${S}R`, 'CASH', '', '', 'A', ''], // 5: on R after A
      ],
      `${S}-B.csv`
    );
    expect((await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: B } })).loadDay.toISOString().slice(0, 10)).toBe(today);
  });

  it('refused, writing nothing: B before A (the order rule), the pilot rule, figures not confirmed or changed', async () => {
    expect(refusal(await start(B, { moves: 2, crossRegion: 1, reversals: 1 }, { confirmFigures: '1', confirmReversal: '1' })).text).toMatch(
      new RegExp(`The file of ${D3} \\("${S}-A\\.csv"\\) must be applied or discarded first`)
    );
    const edit = await pilotRequest();
    try {
      expect(refusal(await start(A, { moves: 2, crossRegion: 1, reversals: 0 })).text).toMatch(/The pilot rule: 1 new-customer request waits at the Accountant/);
    } finally {
      await purgeCustomerEdits(prisma, { where: { id: edit } });
    }
    expect(refusal(await start(A, { moves: 2, crossRegion: 1, reversals: 0 }, {})).text).toMatch(/Tick that you have checked the figures/);
    expect(refusal(await start(A, { moves: 3, crossRegion: 1, reversals: 0 })).text).toMatch(/has changed since the page was opened \(now 2 moves, 1 into another region/);
    expect(await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: A }, select: { state: true, applyLeaseBy: true } })).toEqual({ state: 'STAGED', applyLeaseBy: null });
    expect(await prisma.temixChange.count({ where: { fileId: { in: [A, B] } } })).toBe(0);
    // Before: the salesman (route R) and the manager (region A) do not have customer 4; its shop is on R3, region B.
    expect(await salesmanSees()).not.toContain(ids.c4);
    expect(await managerSees()).not.toContain(ids.c4);
    expect(await todayShops()).not.toContain(ids.b41);
    expect(await dashboardShops()).not.toContain(ids.b41);
  });

  it('anyone but the Data Steward is refused', async () => {
    current = { id: w.manager, role: 'MANAGER', username: `${w.sfx}.m` };
    expect(refusal(await start(A, { moves: 2, crossRegion: 1, reversals: 0 })).code).toBe('FORBIDDEN');
    expect(refusal(await slice(A)).code).toBe('FORBIDDEN');
    expect(refusal(await apply.discardTemixDailyFileAction(form({ fileId: A, reason: 'Not mine' }))).code).toBe('FORBIDDEN');
  });

  it('applies A: two shops move, dated the start of the load day, each with its audit and ledger row', async () => {
    const before41 = await shop(ids.b41!);
    const before13 = await shop(ids.b13!);
    const before21 = await shop(ids.b21!);
    const started = ok<{ leaseToken: string; figures: Record<string, number> }>(await start(A, { moves: 2, crossRegion: 1, reversals: 0 }));
    expect(started.figures).toMatchObject({ moves: 2, crossRegion: 1, reversals: 0, held: 1 });
    const end = await runToEnd(A, started.leaseToken);
    expect(end).toMatchObject({ done: true, state: 'LOADED', stopped: null });

    const f = await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: A } });
    expect(f).toMatchObject({ state: 'LOADED', appliedById: w.steward, appliedRows: 2, noChangeRows: 1, heldRows: 3, rejectedRows: 0, noticeRows: 0, applyLeaseBy: null, reversalAckById: null });
    expect(f.loadedAt).not.toBeNull();

    // The shops: moved with their region, version and editor; the others as they were.
    expect(await shop(ids.b41!)).toEqual({ routeId: w.route, regionId: w.regionA, version: before41.version + 1, lastEditedById: w.steward });
    expect((await shop(ids.b11!)).routeId).toBe(w.route);
    expect(await shop(ids.b13!)).toEqual(before13); // the unknown route: left where it was
    expect(await shop(ids.b21!)).toEqual(before21); // the switched-off route: left where it was

    const rows = await prisma.temixDailyRow.findMany({ where: { fileId: A }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => [r.rowNumber, r.outcome, r.holdReasons])).toEqual([
      [2, 'APPLIED', []],
      [3, 'APPLIED', []],
      [4, 'NO_CHANGE', []],
      [5, 'HELD', ['ROUTE_NOT_MATCHED']],
      [6, 'HELD', ['ROUTE_SWITCHED_OFF']],
      [7, 'HELD', ['CUSTOMER_UNKNOWN']],
    ]);
    expect(rows[0]).toMatchObject({ customerId: ids.c4, branchId: ids.b41 });
    expect(rows[3]).toMatchObject({ customerId: ids.c1, branchId: ids.b13 });

    // History: one UPDATE row per move, of routeId and regionId, dated the start of the load day.
    // The customers are taken in code order, so customer 1's move comes first.
    const h = await history(A);
    expect(h.map((r) => [r.branchId, r.changeKind, r.source])).toEqual([
      [ids.b11, 'UPDATE', `temix-daily:${A}:3`],
      [ids.b41, 'UPDATE', `temix-daily:${A}:2`],
    ]);
    const hOf = (b: string) => h.find((r) => r.branchId === b)!;
    expect(hOf(ids.b41!).changedFields).toEqual(expect.arrayContaining(['routeId', 'regionId']));
    expect(hOf(ids.b11!).changedFields).toContain('routeId');
    expect(hOf(ids.b11!).changedFields).not.toContain('regionId'); // R2 and R are both region A
    for (const r of h) for (const f of ['dayOfVisit', 'status', 'customerId', 'branchCode']) expect(r.changedFields).not.toContain(f);
    for (const r of h) {
      expect(r.validFrom.toISOString()).toBe(omanDayStart(D3)!.toISOString());
      expect(r.actorId).toBe(w.steward);
    }
    expect(hOf(ids.b41!)).toMatchObject({ routeId: w.route, regionId: w.regionA });

    // Audit and ledger: one each per move, joined to the history row by txId.
    const ledger = await prisma.temixChange.findMany({ where: { fileId: A }, orderBy: { id: 'asc' } });
    expect(ledger.map((l) => [l.kind, l.applied, l.branchId, l.field, l.fromValue, l.toValue, l.detailCode, l.source])).toEqual([
      ['ROUTE_MOVE', true, ids.b11, 'routeId', ids.R2, w.route, 'VIA_EXACT_CODE', `temix-daily:${A}:3`],
      ['ROUTE_MOVE', true, ids.b41, 'routeId', ids.R3, w.route, 'VIA_EXACT_CODE', `temix-daily:${A}:2`],
    ]);
    for (const l of ledger) {
      expect(l.loadDay.toISOString().slice(0, 10)).toBe(D3);
      expect(l.txId).toEqual(hOf(l.branchId!).txId);
    }
    const audit = await prisma.auditLog.findMany({ where: { entityType: 'Branch', entityId: { in: [ids.b41!, ids.b11!, ids.b13!, ids.b21!] }, actorId: w.steward } });
    expect(audit.map((a) => a.entityId).sort()).toEqual([ids.b11!, ids.b41!].sort());
    const a41 = audit.find((a) => a.entityId === ids.b41)!;
    expect(a41).toMatchObject({
      action: 'UPDATE',
      source: `temix-daily:${A}:2`,
      before: { routeId: ids.R3, regionId: w.regionB },
      after: { routeId: w.route, regionId: w.regionA, lineage: { fileId: A, rowId: rows[0]!.id, rowNumber: 2, loadDay: D3, via: 'EXACT' } },
      reason: `temix-daily ${A} row 2`,
    });
    for (const a of audit) expect(a.txId).toEqual(hOf(a.entityId).txId);
    expect(hOf(ids.b11!).txId).not.toEqual(hOf(ids.b41!).txId); // one transaction per customer
    // One audit row for the start and one for the end, on the file.
    const fileAudit = await prisma.auditLog.findMany({ where: { entityType: 'TemixDailyFile', entityId: A }, orderBy: { id: 'asc' } });
    expect(fileAudit.map((a) => (a.after as { kind: string }).kind)).toEqual(['TEMIX_DAILY_APPLY_START', 'TEMIX_DAILY_LOADED']);
    expect(fileAudit.map((a) => a.source)).toEqual([`temix-daily:${A}:apply`, `temix-daily:${A}:finalize`]);
  });

  it('the route intervals of the History page follow the move', async () => {
    const iv = await prisma.$queryRaw<Array<{ branch_id: string; route_id: string; valid_from: Date; valid_to: Date | null }>>`
      SELECT branch_id, route_id, valid_from, valid_to FROM nmwc_customer_route_intervals(${ids.c4!}) ORDER BY valid_from`;
    // On R3 from its creation to the start of the load day, then on R (whose
    // intervals are cut again where its salesman's ownership began).
    expect(iv[0]).toMatchObject({ route_id: ids.R3 });
    expect(iv[0]!.valid_from.toISOString()).toBe(omanDayStart(D10)!.toISOString());
    expect(iv[0]!.valid_to!.toISOString()).toBe(omanDayStart(D3)!.toISOString());
    expect(iv[1]).toMatchObject({ route_id: w.route });
    expect(iv[1]!.valid_from.toISOString()).toBe(omanDayStart(D3)!.toISOString());
    expect(iv.slice(1).every((r) => r.route_id === w.route)).toBe(true);
    expect(iv[iv.length - 1]!.valid_to).toBeNull();
  });

  it('the salesman, his Today list, the manager and the dashboard read the shop on its new route at once', async () => {
    expect(await salesmanSees()).toContain(ids.c4);
    expect(await todayShops()).toContain(ids.b41);
    expect(await managerSees()).toContain(ids.c4);
    expect(await dashboardShops()).toContain(ids.b41);
  });

  it('a slice on a loaded file writes nothing', async () => {
    const h = (await history(A)).length;
    expect(ok<Slice>(await slice(A))).toMatchObject({ done: true, state: 'LOADED', applied: 0 });
    expect((await history(A)).length).toBe(h);
    expect(await prisma.temixChange.count({ where: { fileId: A } })).toBe(2);
  });

  it('B sets back one of A\'s moves: the start asks for the reversal tick, and keeps it', async () => {
    expect(refusal(await start(B, { moves: 2, crossRegion: 1, reversals: 1 })).text).toMatch(/1 move would set shops back to the route the previous file moved them from/);
    expect(refusal(await start(B, { moves: 2, crossRegion: 1, reversals: 0 })).text).toMatch(/has changed since the page was opened/);
    const s = ok<{ leaseToken: string }>(await start(B, { moves: 2, crossRegion: 1, reversals: 1 }, { confirmFigures: '1', confirmReversal: '1' }));
    const f = await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: B } });
    expect(f).toMatchObject({ state: 'APPLYING', reversalAckById: w.steward, appliedById: w.steward, applyLeaseBy: s.leaseToken });
    // One customer per slice; the first slice is the only one this run makes.
    process.env.TEMIX_DAILY_SLICE_MAX_GROUPS = '1';
    const first = ok<Slice>(await slice(B, s.leaseToken));
    expect(first).toMatchObject({ done: false, applied: 1, noChange: 1, held: 0, remaining: 2 });
    expect((await shop(ids.b11!)).routeId).toBe(ids.R2);
    expect((await shop(ids.b21!)).routeId).toBe(w.route);
    // The run is abandoned (the tab closed): while its lease is live, nobody else may take the file.
    expect(refusal(await slice(B)).text).toMatch(/being applied right now/);
    await prisma.temixDailyFile.update({ where: { id: B }, data: { applyLeaseUntil: new Date(Date.now() - 1000) } });
    // Stalled: on the Work list and /status at once (the lease ran out an hour ago for /status, below).
    expect(await prisma.temixDailyFile.count({ where: { id: B, ...stalledDailyLoadWhere(new Date()) } })).toBe(1);
  });

  it('the pilot rule stops the resume; the load stays part-applied and listed as stalled', async () => {
    const edit = await pilotRequest();
    const res = await slice(B).finally(() => purgeCustomerEdits(prisma, { where: { id: edit } }));
    const r = ok<Slice>(res);
    expect(r).toMatchObject({ stopped: 'PILOT', applied: 0, remaining: 2 });
    expect(r.leaseToken).toBeUndefined();
    expect(await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: B }, select: { state: true, applyLeaseBy: true, applyLeaseUntil: true } })).toEqual({
      state: 'APPLYING',
      applyLeaseBy: null,
      applyLeaseUntil: null,
    });
    // A released lease counts at once on /status too (its cut-off is an hour back).
    expect(await prisma.temixDailyFile.count({ where: { id: B, ...stalledDailyLoadWhere(new Date(Date.now() - 3_600_000)) } })).toBe(1);
    expect((await shop(ids.b21!)).routeId).toBe(w.route);
  });

  it('two resumes at once take the load once; it finishes without doing anything twice', async () => {
    const both = await Promise.all([slice(B), slice(B)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(refusal(both.find((r) => !r.ok)!).text).toMatch(/being applied right now/);
    const winner = ok<Slice>(both.find((r) => r.ok)!);
    const end = winner.done ? winner : await runToEnd(B, winner.leaseToken);
    expect(end).toMatchObject({ done: true, state: 'LOADED' });

    expect(await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: B } })).toMatchObject({ state: 'LOADED', appliedRows: 2, noChangeRows: 2, heldRows: 0 });
    expect(await shop(ids.b21!)).toMatchObject({ routeId: ids.R3, regionId: w.regionB });
    expect((await shop(ids.b11!)).routeId).toBe(ids.R2);
    // Exactly one history row, audit row and ledger row per move: nothing twice.
    const h = await history(B);
    expect(h.map((r) => [r.branchId, r.source]).sort()).toEqual(
      [
        [ids.b11, `temix-daily:${B}:2`],
        [ids.b21, `temix-daily:${B}:4`],
      ].sort()
    );
    expect(await prisma.temixChange.count({ where: { fileId: B } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityType: 'Branch', source: { startsWith: `temix-daily:${B}:` } } })).toBe(2);
    // Dated the start of today: the clamp against A's row (the start of D3) is earlier.
    for (const r of h) expect(r.validFrom.toISOString()).toBe(omanDayStart(today)!.toISOString());
    const rows = await prisma.temixDailyRow.findMany({ where: { fileId: B }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => [r.rowNumber, r.outcome])).toEqual([
      [2, 'APPLIED'],
      [3, 'NO_CHANGE'],
      [4, 'APPLIED'],
      [5, 'NO_CHANGE'],
    ]);
    expect(await prisma.temixDailyFile.count({ where: { id: B, ...stalledDailyLoadWhere(new Date()) } })).toBe(0);
  });

  it('the same rows again, in another file, change nothing', async () => {
    const B2 = await uploadCsv(
      [
        [`${S}4`, '01', 'Customer 4', `${S}R`, 'CASH', '', '', 'A', ''],
        [`${S}2`, '01', 'Customer 2', `${S}R3`, 'CASH', '', '', 'A', ''],
        [`${S}1`, '02', 'Customer 1', `${S}R`, 'CASH', '', '', 'A', ''],
        [`${S}1`, '01', 'Customer 1', `${S}R2`, 'CASH', '', '', 'A', ''],
      ],
      `${S}-B2.csv`
    );
    const shopsBefore = await Promise.all([ids.b11!, ids.b12!, ids.b21!, ids.b41!].map(shop));
    const s = ok<{ leaseToken: string; figures: { moves: number } }>(await start(B2, { moves: 0, crossRegion: 0, reversals: 0 }));
    expect(s.figures.moves).toBe(0);
    expect(await runToEnd(B2, s.leaseToken)).toMatchObject({ done: true, applied: 0, noChange: 4 });
    expect(await Promise.all([ids.b11!, ids.b12!, ids.b21!, ids.b41!].map(shop))).toEqual(shopsBefore);
    expect(await history(B2)).toEqual([]);
    expect(await prisma.temixChange.count({ where: { fileId: B2 } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: 'Branch', source: { startsWith: `temix-daily:${B2}:` } } })).toBe(0);
    expect(await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: B2 } })).toMatchObject({ state: 'LOADED', appliedRows: 0, noChangeRows: 4 });
  });

  it('a file for a day before an applied one can never be applied: it is discarded, with its reason', async () => {
    const C = await stageDirect(D2, [[`${S}2`, '01', 'Customer 2', `${S}R`, 'CASH', '', '', 'A']], `${S}-C.csv`);
    expect(refusal(await start(C, { moves: 1, crossRegion: 1, reversals: 1 }, { confirmFigures: '1', confirmReversal: '1' })).text).toMatch(
      new RegExp(`can never be applied: the file of ${today} is already applied`)
    );
    expect(refusal(await apply.discardTemixDailyFileAction(form({ fileId: C, reason: ' ' }))).text).toMatch(/Give a reason/);
    await fresh();
    ok(await apply.discardTemixDailyFileAction(form({ fileId: C, reason: 'An old export, uploaded by mistake (test)' })));
    expect(await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: C } })).toMatchObject({
      state: 'DISCARDED',
      discardedById: w.steward,
      discardReason: 'An old export, uploaded by mistake (test)',
    });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'TemixDailyFile', entityId: C } });
    expect(a).toMatchObject({ action: 'UPDATE', source: `temix-daily:${C}:discard`, after: { kind: 'TEMIX_DAILY_DISCARD', state: 'DISCARDED' } });
    await fresh();
    expect(refusal(await apply.discardTemixDailyFileAction(form({ fileId: C, reason: 'Again' }))).text).toMatch(/already discarded/);
    await fresh();
    expect(refusal(await apply.discardTemixDailyFileAction(form({ fileId: B, reason: 'Too late' }))).text).toMatch(/Correct them in Temix/);
    expect((await shop(ids.b21!)).routeId).toBe(ids.R3);
  });
});
