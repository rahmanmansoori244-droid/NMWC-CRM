// @vitest-environment node
/**
 * The daily Temix import, stage 6, against real Postgres through the real
 * actions: finalize's notices (lib/temix-daily-notices.ts, called by
 * services/temix-daily-apply.ts) and the drill-down's Reviewed marks
 * (services/temix-daily-review.ts). Every code, name and id is synthetic.
 *
 * Three files, applied in order: A (three days ago), B (two days ago, the same
 * rows), C (today, through the real upload).
 *  - A half-loaded A (one customer per slice, the first slice only) lists no one.
 *  - A loaded: one spell opened for each suite customer no row names
 *    (MISSING_FROM_FILE), one for the Accountant's code not in the file
 *    (ACCOUNTANT_CODE_NOT_SEEN), one for the switched-off route still holding a
 *    shop (ROUTE_INACTIVE), one name difference (keyed hash, no name stored);
 *    a name that differs only in capitals and spaces is not listed. The file
 *    counts its notices; its LOADED audit row counts them by kind. No customer,
 *    shop or history row is written by finalize, no queue state flips, no
 *    alert is sent (the switch is off).
 *  - B, the same rows: finalize writes nothing new about the suite's customers.
 *  - C: the missing customers and the Accountant's code are back (closed,
 *    pointing at their row), the shop leaves the switched-off route (cleared),
 *    another name is listed, and a customer now absent opens its own spell.
 *  - The writer refuses a file that is not FINALIZING; the ledger stays INSERT-only.
 *  - Reviewed: one line, then all the day's others; a second press marks
 *    nothing; anyone but the Steward is refused.
 *
 *   RUN_TEMIX_DAILY_FINALIZE=1 AUTH_SECRET=… DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/temix-daily-finalize.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { contextClient, src, withChangeContext } from '@/lib/change-context';
import { reportDailyHeadings, sortedNotes, stageDailyRows } from '@/lib/temix-daily-file';
import { SPELL_CLOSED_CLEARED, SPELL_CLOSED_SEEN, SPELL_OPENED, foldName, nameHash, nameKey, summaryCountsOf } from '@/lib/temix-daily-finalize';
import { loadDaySummaryInput } from '@/lib/temix-daily-day-load';
import { writeFinalizeNotices } from '@/lib/temix-daily-notices';
import { withAuditMaintenance, purgeAuditLog } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_TEMIX_DAILY_FINALIZE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEAD = ['cust_code', 'branch_code', 'cust_name', 'route', 'payment_terms', 'credit_limit', 'payment_term_days', 'status', 'created_date'];
const omanDay = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

describe.skipIf(!ENABLED)('the daily Temix finalize and drill-down on Postgres', () => {
  let prisma: PrismaClient;
  let apply: typeof import('@/services/temix-daily-apply');
  let upload: typeof import('@/services/temix-daily');
  let review: typeof import('@/services/temix-daily-review');
  let w: World;
  let S = '';
  let APP = '';
  const ids: Record<string, string> = {};
  const files: string[] = [];
  const D3 = omanDay(new Date(Date.now() - 3 * DAY));
  const D2 = omanDay(new Date(Date.now() - 2 * DAY));
  const D10 = omanDay(new Date(Date.now() - 10 * DAY));
  const today = omanDay(new Date());

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
  type Slice = import('@/services/temix-daily-apply').TemixDailySliceResult;
  const start = async (fileId: string) => {
    await fresh();
    const pre = await apply.startTemixDailyApplyAction(form({ fileId, confirmFigures: '1', seenMoves: '0', seenCrossRegion: '0', seenReversals: '0' }));
    if (pre.ok) return (pre as unknown as { data: { leaseToken: string } }).data.leaseToken;
    // The figures the page would show: read them back from the refusal and confirm them.
    const text = JSON.stringify(pre);
    const m = /now (\d+) moves?, (\d+) into another region(?:, (\d+))?/.exec(text);
    expect(m, text).not.toBeNull();
    await fresh();
    const again = await apply.startTemixDailyApplyAction(
      form({ fileId, confirmFigures: '1', confirmReversal: '1', confirmSameBytes: '1', seenMoves: m![1]!, seenCrossRegion: m![2]!, seenReversals: m![3] ?? '0' })
    );
    return ok<{ leaseToken: string }>(again).leaseToken;
  };
  const slice = async (fileId: string, leaseToken?: string) => {
    await fresh();
    return ok<Slice>(await apply.runTemixDailySliceAction(form({ fileId, ...(leaseToken ? { leaseToken } : {}) })));
  };
  const runToEnd = async (fileId: string, token?: string) => {
    let lease = token;
    for (let i = 0; i < 50; i++) {
      const r = await slice(fileId, lease);
      if (r.done || r.stopped) return r;
      lease = r.leaseToken;
    }
    throw new Error('the load never finished');
  };
  const mine = () => [ids.c1!, ids.c2!, ids.c3!, ids.c4!, ids.cN!, w.customer];
  /** The suite's notices of a file, as [kind, customer key, detail, row number]. */
  const notices = async (fileId: string) => {
    const key = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
    key.set(w.customer, 'cW');
    const rows = await prisma.temixChange.findMany({
      where: { fileId, applied: false, OR: [{ customerId: { in: mine() } }, { kind: 'ROUTE_INACTIVE', toValue: ids.RX }] },
      orderBy: { id: 'asc' },
      include: { row: { select: { rowNumber: true } } },
    });
    return rows
      .map((r) => [r.kind, r.customerId ? key.get(r.customerId) : key.get(r.toValue ?? ''), r.detailCode, r.row?.rowNumber ?? null, r.toValue && r.kind !== 'ROUTE_INACTIVE' ? r.toValue : null])
      .sort(byText);
  };

  const stageDirect = async (loadDay: string, rows: string[][], name: string) => {
    const sheet = rows.map((r) => Object.fromEntries(HEAD.map((h, i) => [h, r[i] ?? ''])));
    const staged = stageDailyRows({ rows: sheet, rowNumbers: sheet.map((_, i) => i + 2) }, reportDailyHeadings(HEAD));
    const id = randomUUID();
    const bytes = JSON.stringify([name, rows]);
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
    await fresh();
    const bytes = new TextEncoder().encode([HEAD, ...rows].map((r) => r.join(',')).join('\r\n'));
    const fd = new FormData();
    fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'text/csv' }));
    const id = ok<{ fileId: string }>(await upload.uploadTemixDailyFileAction(fd)).fileId;
    files.push(id);
    return id;
  };

  beforeAll(async () => {
    assertNotProductionEnv();
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    if (!nameKey()) throw new Error('This suite needs AUTH_SECRET (a throw-away value) to hash names.');
    ({ prisma } = await import('@/lib/db'));
    apply = await import('@/services/temix-daily-apply');
    upload = await import('@/services/temix-daily');
    review = await import('@/services/temix-daily-review');
    w = await buildWorld(prisma, 'temixfn');
    S = w.sfx.toUpperCase();
    APP = `NMWC-2099-${String(Date.now() % 1_000_000).padStart(6, '0')}`;
    const db = contextClient(prisma, { actorId: null, source: src.test('temix-daily-finalize'), effectiveFrom: D10 });
    const rx = await db.route.create({ data: { code: `${S}RX`, name: `ZZ ${S}RX`, regionId: w.regionA, isActive: true } });
    w.routes.push(rx.id);
    ids.RX = rx.id;
    const customer = async (key: string, data: { nmwcCode: string; legalName: string; temixCode?: string; temixSyncState?: 'UPLOADED' }) => {
      const c = await db.customer.create({ data: { paymentTerms: 'CASH', ...data } });
      w.customers.push(c.id);
      ids[key] = c.id;
    };
    const branch = async (key: string, customerKey: string, code: string, routeId: string) => {
      const b = await db.branch.create({
        data: { customerId: ids[customerKey]!, branchCode: code, branchName: 'ZZ shop', routeId, regionId: w.regionA, address: 'ZZ Way 1, synthetic', status: 'ACTIVE' },
      });
      w.branches.push(b.id);
      ids[key] = b.id;
    };
    await customer('c1', { nmwcCode: `${S}1`, legalName: 'ZZ Customer One' });
    await branch('b11', 'c1', `${S}1-01`, w.route);
    await customer('c2', { nmwcCode: `${S}2`, legalName: 'ZZ Customer Two' });
    await branch('b21', 'c2', `${S}2-01`, rx.id);
    await customer('c3', { nmwcCode: `${S}3`, legalName: 'ZZ Customer Three' });
    await branch('b31', 'c3', `${S}3-01`, w.route);
    await customer('c4', { nmwcCode: `${S}4`, legalName: 'ZZ Customer Four' });
    await branch('b41', 'c4', `${S}4-01`, w.route);
    // Made in the CRM: the Accountant typed its Temix code at the final approval.
    await customer('cN', { nmwcCode: APP, legalName: 'ZZ Customer New', temixCode: `${S}TX`, temixSyncState: 'UPLOADED' });
    await branch('bN1', 'cN', `${APP}-01`, w.route);
    // The route is switched off after the shop was put on it.
    await db.route.update({ where: { id: rx.id }, data: { isActive: false } });
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
        await tx.temixChangeReview.deleteMany({ where: { change: { fileId: { in: files } } } });
        await tx.temixNoticeSeen.deleteMany({ where: { firstFileId: { in: files } } });
        await tx.temixChange.deleteMany({ where: { fileId: { in: files } } });
        await tx.temixDailyRow.deleteMany({ where: { fileId: { in: files } } });
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files }, sameBytesAsFileId: { not: null } } });
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files } } });
      });
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: w.steward }, { entityId: { in: files } }] } });
      await tearDownWorld(prisma, w, {});
    }
    await prisma.$disconnect();
  });

  let A = '';
  let B = '';
  let C = '';
  const rowsAB = () => [
    [`${S}1`, '01', 'Customer 1 Trading', `${S}R`, 'CASH', '', '', 'A', ''], // 2: a name the CRM does not have
    [`${S}2`, '01', '  zz   customer two ', `${S}RX`, 'CASH', '', '', 'A', ''], // 3: the same name, other capitals and spaces
    [`${S}4`, '01', 'ZZ Customer Four', `${S}R`, 'CASH', '', '', 'A', ''], // 4
    // c3, cN (by either code) and the world's customer are not in the file.
  ];

  it('a half-loaded file lists no one', async () => {
    A = await stageDirect(D3, rowsAB(), `${S}-A.csv`);
    const token = await start(A);
    process.env.TEMIX_DAILY_SLICE_MAX_GROUPS = '1';
    const first = await slice(A, token);
    expect(first).toMatchObject({ done: false, state: 'APPLYING' });
    expect(first.remaining).toBeGreaterThan(0);
    expect(await prisma.temixChange.count({ where: { fileId: A, applied: false } })).toBe(0);
    expect(await prisma.temixNoticeSeen.count({ where: { firstFileId: A } })).toBe(0);
    // The writer itself refuses a file that is not finalizing.
    await expect(
      withChangeContext(prisma, { actorId: w.steward, source: src.temixDailyStep(A, 'finalize') }, (tx) => writeFinalizeNotices(tx, { id: A, loadDay: D3 }))
    ).rejects.toThrow(/not finalizing/);
    delete process.env.TEMIX_DAILY_SLICE_MAX_GROUPS;
    expect(await runToEnd(A, first.leaseToken)).toMatchObject({ done: true, state: 'LOADED' });
  });

  it('A loaded: each absence once, the Accountant code, the switched-off route, one name; nothing else written', async () => {
    expect(await notices(A)).toEqual([
      ['MISSING_FROM_FILE', 'c3', SPELL_OPENED, null, null],
      ['MISSING_FROM_FILE', 'cN', SPELL_OPENED, null, null],
      ['MISSING_FROM_FILE', 'cW', SPELL_OPENED, null, null],
      ['ACCOUNTANT_CODE_NOT_SEEN', 'cN', SPELL_OPENED, null, `${S}TX`],
      ['ROUTE_INACTIVE', 'RX', SPELL_OPENED, null, null],
      ['NAME_DIFFERS', 'c1', null, 2, null],
    ].sort(byText));
    // Codes and ids only: no name in the ledger; the mark is a keyed hash.
    const ledger = await prisma.temixChange.findMany({ where: { fileId: A } });
    expect(JSON.stringify(ledger, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/Customer 1|Trading|ZZ Customer/i);
    for (const l of ledger) {
      expect(l.loadDay.toISOString().slice(0, 10)).toBe(D3);
      expect(l.txId).not.toBeNull();
      if (!l.applied) expect(l.source).toBe(`temix-daily:${A}:finalize`);
    }
    const marks = await prisma.temixNoticeSeen.findMany({ where: { firstFileId: A, customerId: { in: mine() } } });
    expect(marks.map((m) => [m.customerId, m.kind, m.valueHash])).toEqual([[ids.c1, 'NAME_DIFFERS', nameHash(nameKey()!, foldName('Customer 1 Trading'))]]);

    // The file counts its notices, and its LOADED audit row counts them by kind.
    const f = await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: A } });
    expect(f.noticeRows).toBe(await prisma.temixChange.count({ where: { fileId: A, applied: false } }));
    const loaded = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'TemixDailyFile', entityId: A, after: { path: ['kind'], equals: 'TEMIX_DAILY_LOADED' } } });
    expect(loaded.after).toMatchObject({ namesChecked: true, listed: { NAME_DIFFERS: 1, ROUTE_INACTIVE: expect.any(Number), MISSING_FROM_FILE: expect.any(Number), ACCOUNTANT_CODE_NOT_SEEN: expect.any(Number) } });

    // Finalize changed no customer, shop or history: the queue state stands, the shop stays on the switched-off route.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.cN! } })).temixSyncState).toBe('UPLOADED');
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b21! } })).routeId).toBe(ids.RX);
    expect(await prisma.customerHistory.count({ where: { source: { startsWith: `temix-daily:${A}:` } } })).toBe(0);
    expect(await prisma.branchHistory.count({ where: { source: `temix-daily:${A}:finalize` } })).toBe(0);
    // The alert is switched off: none was written.
    expect(await prisma.notification.count({ where: { kind: 'TEMIX_DAILY_SUMMARY', userId: w.steward } })).toBe(0);
    // The ledger stays INSERT-only.
    await expect(prisma.temixChange.updateMany({ where: { fileId: A }, data: { detailCode: 'SPELL_CLOSED_SEEN' } })).rejects.toThrow(/forbidden/i);
  });

  it("the day's summary is counted from the ledger and the loaded files", async () => {
    const day = await loadDaySummaryInput(prisma, D3);
    const counts = summaryCountsOf(day.changes, day.heldRows);
    expect(counts.NAME_DIFFERS).toBe(await prisma.temixChange.count({ where: { loadDay: new Date(`${D3}T00:00:00Z`), kind: 'NAME_DIFFERS' } }));
    expect(counts.MISSING_FROM_FILE).toBe(await prisma.temixChange.count({ where: { loadDay: new Date(`${D3}T00:00:00Z`), kind: 'MISSING_FROM_FILE', detailCode: SPELL_OPENED } }));
    expect(counts.ACCOUNTANT_CODE_NOT_SEEN).toBeGreaterThanOrEqual(1);
    expect(counts.ROUTE_INACTIVE).toBeGreaterThanOrEqual(1);
  });

  it('B, the same rows the next day: nothing new about the suite', async () => {
    B = await stageDirect(D2, rowsAB(), `${S}-B.csv`);
    expect(await runToEnd(B, await start(B))).toMatchObject({ done: true, state: 'LOADED' });
    expect(await notices(B)).toEqual([]);
    expect(await prisma.temixNoticeSeen.count({ where: { firstFileId: B, customerId: { in: mine() } } })).toBe(0);
  });

  it('C: the absences end, pointing at their rows; the route is cleared; another name; a new absence', async () => {
    C = await uploadCsv(
      [
        [`${S}1`, '01', 'Customer 1 Renamed', `${S}R`, 'CASH', '', '', 'A', ''], // 2: another Temix name: listed
        [`${S}2`, '01', 'ZZ Customer Two', `${S}R`, 'CASH', '', '', 'A', ''], // 3: leaves the switched-off route
        [`${S}3`, '01', 'ZZ Customer Three', `${S}R`, 'CASH', '', '', 'A', ''], // 4: back in the file
        [`${S}TX`, '01', 'ZZ Customer New', `${S}R`, 'CASH', '', '', 'A', ''], // 5: the Accountant's code (shop not linked)
        [w.sfx.toUpperCase() + '-C', '01', `ZZ Part C ${w.sfx}`, `${S}R`, 'CASH', '', '', 'A', ''], // 6: the world's customer
        // c4 is not in the file now.
      ],
      `${S}-C.csv`
    );
    expect(await runToEnd(C, await start(C))).toMatchObject({ done: true, state: 'LOADED' });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b21! } })).routeId).toBe(w.route);
    expect(await notices(C)).toEqual([
      ['MISSING_FROM_FILE', 'c4', SPELL_OPENED, null, null],
      ['MISSING_FROM_FILE', 'c3', SPELL_CLOSED_SEEN, 4, null],
      ['MISSING_FROM_FILE', 'cN', SPELL_CLOSED_SEEN, 5, null],
      ['MISSING_FROM_FILE', 'cW', SPELL_CLOSED_SEEN, 6, null],
      ['ACCOUNTANT_CODE_NOT_SEEN', 'cN', SPELL_CLOSED_SEEN, 5, `${S}TX`],
      ['ROUTE_INACTIVE', 'RX', SPELL_CLOSED_CLEARED, null, null],
      ['NAME_DIFFERS', 'c1', null, 2, null],
    ].sort(byText));
    // Still nothing flips the Accountant customer's queue state.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.cN! } })).temixSyncState).toBe('UPLOADED');
  });

  it('Reviewed: one line, then the rest of the day; a second press marks nothing; the Steward only', async () => {
    const line = await prisma.temixChange.findFirstOrThrow({ where: { fileId: A, kind: 'NAME_DIFFERS', customerId: ids.c1 } });
    await fresh();
    expect(ok<{ reviewed: number }>(await review.reviewTemixChangesAction(form({ loadDay: D3, changeId: line.id.toString() })))).toEqual({ reviewed: 1 });
    const mark = await prisma.temixChangeReview.findFirstOrThrow({ where: { changeId: line.id } });
    expect(mark).toMatchObject({ reviewedById: w.steward, note: 'REVIEWED', source: `temix-daily:${A}:review` });
    expect(mark.txId).not.toBeNull();
    await fresh();
    expect(ok<{ reviewed: number }>(await review.reviewTemixChangesAction(form({ loadDay: D3, changeId: line.id.toString() })))).toEqual({ reviewed: 0 });

    const dayLines = await prisma.temixChange.count({ where: { loadDay: new Date(`${D3}T00:00:00Z`) } });
    await fresh();
    expect(ok<{ reviewed: number }>(await review.reviewTemixChangesAction(form({ loadDay: D3 })))).toEqual({ reviewed: dayLines - 1 });
    expect(await prisma.temixChange.count({ where: { loadDay: new Date(`${D3}T00:00:00Z`), reviews: { none: {} } } })).toBe(0);
    await fresh();
    expect(ok<{ reviewed: number }>(await review.reviewTemixChangesAction(form({ loadDay: D3 })))).toEqual({ reviewed: 0 });
    // One audit row per press that marked something (A's lines are of one file).
    expect(await prisma.auditLog.count({ where: { entityType: 'TemixDailyFile', entityId: A, after: { path: ['kind'], equals: 'TEMIX_DAILY_REVIEWED' } } })).toBe(2);
    // A review is a mark beside the ledger: the spells stay as they were.
    expect(await notices(A)).toHaveLength(6);

    current = { id: w.manager, role: 'MANAGER', username: `${w.sfx}.m` };
    const refused = await review.reviewTemixChangesAction(form({ loadDay: today }));
    expect(refused.ok).toBe(false);
    expect((refused as unknown as { code: string }).code).toBe('FORBIDDEN');
  });
});

/** A stable order for comparing lists of notices. */
function byText(a: unknown[], b: unknown[]): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}
