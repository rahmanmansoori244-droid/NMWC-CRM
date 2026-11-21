// @vitest-environment node
/**
 * The daily Temix import, stages 2 and 3, against real Postgres through the
 * real upload action (services/temix-daily.ts). Every file is synthetic, built
 * here from the agreed columns.
 *
 *  - An .xlsx and a .csv daily file are staged: the file (hash, size, Oman load
 *    day, headings), one row per data row with its normalised codes and notes,
 *    and one AuditLog row stamped with the upload's source. NOTHING ELSE
 *    CHANGES: no Customer, Branch, history, ledger, import or notification row.
 *  - Refused, writing nothing: the same bytes again on the same day; a
 *    customer master; a file missing a heading; a file that is not what its
 *    name says; anyone but the Data Steward.
 *  - The same bytes on a later day are staged with sameBytesAsFileId; a
 *    discarded file frees its day; a newer file waits for an older unfinished
 *    one; two uploads of the same bytes at once stage exactly one file.
 *  - Stage 2: the enum value exists and the inbox reads Notification as before.
 *
 *   RUN_TEMIX_DAILY_UPLOAD=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/temix-daily-upload.test.ts
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { src, withChangeContext } from '@/lib/change-context';
import { withAuditMaintenance, purgeAuditLog } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_TEMIX_DAILY_UPLOAD === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEAD = ['cust_code', 'branch_code', 'cust_name', 'route', 'payment_terms', 'credit_limit', 'payment_term_days', 'status', 'created_date', 'cr_no', 'phone', 'address'];
const omanDay = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function workbook(rows: unknown[][], head = HEAD): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Daily');
  ws.addRow(head);
  for (const r of rows) ws.addRow(r);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const csv = (rows: string[][], head = HEAD) =>
  new TextEncoder().encode([head, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'));

describe.skipIf(!ENABLED)('the daily Temix upload on Postgres', () => {
  let prisma: PrismaClient;
  let svc: typeof import('@/services/temix-daily');
  let w: World;
  const T = `ZZTD${Date.now().toString(36).toUpperCase()}`;
  const today = omanDay(new Date());
  const yesterday = omanDay(new Date(Date.now() - 86_400_000));
  const extraFiles: string[] = [];

  const upload = async (bytes: Uint8Array, name: string, type = XLSX) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
    const fd = new FormData();
    fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
    return svc.uploadTemixDailyFileAction(fd);
  };
  const okData = (res: Awaited<ReturnType<typeof upload>>) => {
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return (res as { ok: true; data: import('@/services/temix-daily').TemixDailyUploadResult }).data;
  };
  const refusedWith = (res: Awaited<ReturnType<typeof upload>>) => {
    expect(res.ok, JSON.stringify(res)).toBe(false);
    const r = res as { message: string; fields?: Record<string, string> };
    return r.fields ? Object.values(r.fields).join(' ') : r.message;
  };
  const mine = () => ({ OR: [{ uploadedById: w.steward }, { id: { in: extraFiles } }] });

  /** Rows of every table the upload must never touch. */
  const untouched = async () => {
    const [r] = await prisma.$queryRaw<Array<Record<string, bigint>>>`
      SELECT (SELECT count(*) FROM "Customer") AS customer, (SELECT count(*) FROM "Branch") AS branch,
             (SELECT count(*) FROM "CustomerHistory") AS ch, (SELECT count(*) FROM "BranchHistory") AS bh,
             (SELECT count(*) FROM "TemixChange") AS tc, (SELECT count(*) FROM "TemixNoticeSeen") AS tns,
             (SELECT count(*) FROM "TemixRouteMap") AS trm, (SELECT count(*) FROM "TemixChangeReview") AS tcr,
             (SELECT count(*) FROM "ImportBatch") AS ib, (SELECT count(*) FROM "ImportRow") AS ir,
             (SELECT count(*) FROM "Notification") AS n,
             (SELECT max("updatedAt") FROM "Customer") AS cu, (SELECT max("updatedAt") FROM "Branch") AS bu`;
    return JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  };
  let before = '';

  beforeAll(async () => {
    assertNotProductionEnv();
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    svc = await import('@/services/temix-daily');
    w = await buildWorld(prisma, 'temixup');
    before = await untouched();
  });

  beforeEach(() => {
    current = { id: w.steward, role: 'STEWARD', username: `${w.sfx}.stw` };
  });

  afterAll(async () => {
    if (!prisma) return;
    if (w) {
      const files = (await prisma.temixDailyFile.findMany({ where: mine(), select: { id: true } })).map((f) => f.id);
      await withAuditMaintenance(prisma, async (tx) => {
        await tx.temixDailyRow.deleteMany({ where: { fileId: { in: files } } });
        // A finished file never changes, even in the window, and its same-bytes
        // key is SET NULL on delete: the files that point at another go first.
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files }, sameBytesAsFileId: { not: null } } });
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files } } });
      });
      await purgeAuditLog(prisma, { where: { actorId: w.steward } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
      await tearDownWorld(prisma, w);
    }
    await prisma.$disconnect();
  });

  let firstId = '';
  let firstBytes: Uint8Array = new Uint8Array();

  it('stages an .xlsx daily file: the file, its rows, one audit row; codes in capitals, notes as codes', async () => {
    firstBytes = await workbook([
      [`${T.toLowerCase()}1`, `${T}1-01`, 'Customer 1', 'zr10', 'Cash', 0, 0, 'a', new Date(Date.UTC(2026, 0, 15)), '', '', ''],
      [`${T}1`, `${T}1-1`, 'Customer 1', 'ZR10', 'CASH', 0, 0, 'A', '2026-01-15', '', '', ''],
      [`${T}2`, '', 'Customer 2', 'ZR11MA', 'CREDIT', '1500', '30', 'I', '', '1234567', '90000000', 'Street 1'],
      [`${T}3`, `${T}3-01`, 'Customer 3', '', 'CREDIT', '1,500', '30.5', 'X', '03/04/2026', '', '', ''],
    ]);
    const res = okData(await upload(firstBytes, `${T}-daily.xlsx`));
    firstId = res.fileId;
    expect(res).toMatchObject({ loadDay: today, rows: 4, rowsWithNotes: 3, notRead: [], otherSheets: [], sameBytesAs: null });

    const f = await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: firstId } });
    expect(f).toMatchObject({ state: 'STAGED', fileSha256: sha(firstBytes), fileBytes: firstBytes.length, totalRows: 4, uploadedById: w.steward, filename: `${T}-daily.xlsx`, heldRows: 0, appliedRows: 0 });
    expect(f.loadDay.toISOString().slice(0, 10)).toBe(today);
    expect(f.headings).toMatchObject({ kind: 'xlsx', sheet: 'Daily', notRead: [] });
    // The notes are counted once here, so the file list never scans the rows.
    expect((f.headings as { notesAtUpload: unknown }).notesAtUpload).toEqual({
      rows: 3,
      byNote: { SHOP_CODE_LOOKALIKE: 2, ROUTE_MISSING: 1, STATUS_NOT_A_OR_I: 1, CREDIT_LIMIT_NOT_A_NUMBER: 1, CREDIT_DAYS_NOT_WHOLE_DAYS: 1, CREATED_DATE_UNREADABLE: 1 },
    });

    const rows = await prisma.temixDailyRow.findMany({ where: { fileId: firstId }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => [r.rowNumber, r.custCodeKey, r.branchCodeKey, r.outcome, r.holdReasons, r.isMainRow, r.customerId, r.branchId])).toEqual([
      [2, `${T}1`, `${T}1-01`, 'PENDING', ['SHOP_CODE_LOOKALIKE'], null, null, null],
      [3, `${T}1`, `${T}1-1`, 'PENDING', ['SHOP_CODE_LOOKALIKE'], null, null, null],
      [4, `${T}2`, null, 'PENDING', [], null, null, null],
      [5, `${T}3`, `${T}3-01`, 'PENDING', ['ROUTE_MISSING', 'STATUS_NOT_A_OR_I', 'CREDIT_LIMIT_NOT_A_NUMBER', 'CREDIT_DAYS_NOT_WHOLE_DAYS', 'CREATED_DATE_UNREADABLE'], null, null, null],
    ]);
    expect((rows[0]!.raw as Record<string, unknown>).cust_code).toBe(`${T.toLowerCase()}1`);
    expect(rows[0]!.parsed).toMatchObject({ route: 'ZR10', paymentTerms: 'CASH', status: 'A', createdDate: { day: '2026-01-15' } });
    expect(rows[2]!.parsed).toMatchObject({ route: 'ZR11MA', creditLimit: 1500, paymentTermDays: 30, status: 'I', crNo: '1234567', phone: '90000000', address: 'Street 1' });

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'TemixDailyFile', entityId: firstId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'IMPORT', actorId: w.steward, source: `temix-daily:${firstId}:upload` });
    expect(audit[0]!.txId).not.toBeNull();
    expect(audit[0]!.after).toMatchObject({ kind: 'TEMIX_DAILY_UPLOAD', rows: 4, rowsWithNotes: 3, fileSha256: sha(firstBytes), loadDay: today });
    // Counts and codes only: no value from a row is in the audit row, nor the
    // file's name (free text the uploader chose).
    expect(JSON.stringify(audit[0]!.after)).not.toMatch(/Customer \d|90000000|1234567|Street/);
    expect(audit[0]!.after).not.toHaveProperty('filename');
    expect(JSON.stringify(audit[0]!.after)).not.toContain('-daily.xlsx');
  });

  it('refuses the same bytes again on the same day, writing nothing', async () => {
    const n = await prisma.temixDailyFile.count({ where: mine() });
    const why = refusedWith(await upload(firstBytes, 'renamed.xlsx'));
    expect(why).toMatch(new RegExp(`already uploaded for ${today}.*once per day`));
    expect(await prisma.temixDailyFile.count({ where: mine() })).toBe(n);
  });

  it('stages a .csv daily file; it waits for the older unfinished file', async () => {
    const bytes = csv([[`${T}9`, '0012', 'Customer, Nine', 'zr10', 'CASH', '0', '0', 'A', '2026-02-01', '', '', '']]);
    const res = okData(await upload(bytes, `${T}-daily.csv`, 'text/csv'));
    expect(res.waitsFor).not.toBeNull();
    const [r] = await prisma.temixDailyRow.findMany({ where: { fileId: res.fileId } });
    // Kept as text: the leading zeros of a CSV code survive.
    expect(r).toMatchObject({ custCodeKey: `${T}9`, branchCodeKey: '0012', holdReasons: [] });
    expect((r!.parsed as { custName: string }).custName).toBe('Customer, Nine');
    expect((await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: res.fileId } })).headings).toMatchObject({ kind: 'csv' });
  });

  it('a column that is not agreed is not stored; a CSV row is numbered by the line it starts on', async () => {
    const head = [...HEAD, 'owner_mobile'];
    const bytes = csv(
      [
        [`${T}M`, '', 'Customer M', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', 'Line 1\nLine 2', '91234567'],
        [`${T}N`, '', 'Customer N', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', '', '#N/A'],
        [`${T}O`, '#N/A', 'Customer O', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', '', ''],
      ],
      head
    );
    const res = okData(await upload(bytes, `${T}-extra.csv`, 'text/csv'));
    expect(res.notRead).toEqual(['owner_mobile']);
    const rows = await prisma.temixDailyRow.findMany({ where: { fileId: res.fileId }, orderBy: { rowNumber: 'asc' } });
    // The first row spans lines 2 and 3 (a line break in its address).
    expect(rows.map((r) => [r.rowNumber, r.custCodeKey, r.holdReasons])).toEqual([
      [2, `${T}M`, []],
      [4, `${T}N`, []],
      [5, `${T}O`, ['CELL_ERROR']],
    ]);
    for (const r of rows) expect(Object.keys(r.raw as object)).not.toContain('owner_mobile');
    expect(JSON.stringify(rows.map((r) => r.raw))).not.toContain('91234567');
  });

  it('the upload time is taken after the lock, so files rank in the order they took it', async () => {
    const bytes = csv([[`${T}L`, '', 'Customer L', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', '']]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let releasedAt = new Date(0);
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    // Another upload holds the lock while this one's transaction has begun.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('nmwc:temix-daily:upload', 42))`;
        held();
        await gate;
        [{ at: releasedAt }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
      },
      { timeout: 30_000 }
    );
    await isHeld;
    const pending = upload(bytes, `${T}-locked.csv`, 'text/csv');
    await new Promise((r) => setTimeout(r, 1500));
    release();
    await holder;
    const res = okData(await pending);
    const f = await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: res.fileId } });
    // Behaviour, not the regression proof: Prisma's @default(now()) is also
    // filled after the lock, so this held before too. The proof that the time
    // is the database's one instant read with the day is structural
    // (tests/unit/temix-daily-upload-guard.test.ts).
    expect(f.uploadedAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
    expect(omanDay(f.uploadedAt)).toBe(res.loadDay);
  });

  it('refuses a customer master, a missing heading, a file that is not what it is named, writing nothing', async () => {
    const n = await prisma.temixDailyFile.count({ where: mine() });
    const master = await workbook([[`${T}5`, 'Customer 5', '01', 'R', 'ZR10', 'A', '9', 'C', '1', 'CASH', '0', '0', `${T}5`, 'RET', 'SUN', 'ACTIVE']], [
      'cust_code', 'cust_name', 'branch_code', 'sales_region', 'route', 'address', 'phone', 'contact_person', 'cr_no', 'payment_terms', 'credit_limit', 'payment_term_days', 'temix_code', 'channel', 'day_of_visit', 'customer_status',
    ]);
    expect(refusedWith(await upload(master, `${T}-master.xlsx`))).toMatch(/customer master.*Import screen/);
    const noStatus = await workbook([[`${T}6`, '', 'Customer 6', 'ZR10', 'CASH', 0, 0, '2026-01-01']], HEAD.filter((h) => !['status', 'cr_no', 'phone', 'address'].includes(h)));
    expect(refusedWith(await upload(noStatus, `${T}-nostatus.xlsx`))).toMatch(/has no status column/);
    expect(refusedWith(await upload(csv([[`${T}7`]]), `${T}-csv.xlsx`))).toMatch(/\.xlsx workbook or a \.csv file/);
    expect(refusedWith(await upload(new TextEncoder().encode('x'), `${T}.txt`, 'text/plain'))).toMatch(/\.xlsx workbook or a \.csv file/);
    expect(await prisma.temixDailyFile.count({ where: mine() })).toBe(n);
  });

  it('is the Data Steward\'s only', async () => {
    current = { id: w.salesman, role: 'SALESMAN', username: `${w.sfx}.s` };
    const res = await upload(csv([[`${T}8`, '', 'C', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', '']]), `${T}-s.csv`, 'text/csv');
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('the same bytes as an earlier day are staged with a warning; a discarded file frees its day', async () => {
    const bytes = csv([[`${T}Y`, '', 'Customer Y', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', '']]);
    // A file of yesterday with these very bytes, as yesterday's upload left it.
    const old = await withChangeContext(prisma, { actorId: w.steward, source: src.test('temix-daily-upload') }, (tx) =>
      tx.temixDailyFile.create({
        data: { filename: `${T}-yesterday.csv`, loadDay: new Date(`${yesterday}T00:00:00Z`), uploadedById: w.steward, fileSha256: sha(bytes), fileBytes: bytes.length, headings: {} },
      })
    );
    extraFiles.push(old.id);
    const res = okData(await upload(bytes, `${T}-today.csv`, 'text/csv'));
    expect(res.sameBytesAs).toEqual({ loadDay: yesterday, filename: `${T}-yesterday.csv` });
    expect(res.waitsFor).not.toBeNull();
    expect((await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: res.fileId } })).sameBytesAsFileId).toBe(old.id);

    // Discarded (as the later stages will), its day takes the same bytes again.
    await withChangeContext(prisma, { actorId: w.steward, source: src.test('temix-daily-upload') }, (tx) =>
      tx.temixDailyFile.update({ where: { id: res.fileId }, data: { state: 'DISCARDED', discardedAt: new Date(), discardedById: w.steward, discardReason: 'zz test' } })
    );
    const again = okData(await upload(bytes, `${T}-today-again.csv`, 'text/csv'));
    expect(again.fileId).not.toBe(res.fileId);
  });

  it('two uploads of the same new bytes at once stage exactly one file', async () => {
    const bytes = csv([[`${T}C`, '', 'Customer C', 'ZR10', 'CASH', '0', '0', 'A', '', '', '', '']]);
    await prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
    const send = () => {
      const fd = new FormData();
      fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], `${T}-race.csv`, { type: 'text/csv' }));
      return svc.uploadTemixDailyFileAction(fd);
    };
    const results = await Promise.all([send(), send()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { fields?: { file?: string } }).fields?.file)).toEqual([expect.stringMatching(/once per day/)]);
    expect(await prisma.temixDailyFile.count({ where: { fileSha256: sha(bytes), state: { not: 'DISCARDED' } } })).toBe(1);
  });

  it('nothing but the staged files, their rows and their audit rows changed', async () => {
    expect(await untouched()).toBe(before);
  });

  it('stage 2: the summary kind exists, none is written, and the inbox reads as before', async () => {
    const [{ kinds }] = await prisma.$queryRaw<Array<{ kinds: string[] }>>`SELECT enum_range(NULL::"NotificationKind")::text[] AS kinds`;
    expect(kinds).toContain('TEMIX_DAILY_SUMMARY');
    expect(await prisma.notification.count({ where: { kind: 'TEMIX_DAILY_SUMMARY' } })).toBe(0);
    await expect(prisma.notification.findMany({ take: 50, orderBy: { createdAt: 'desc' } })).resolves.toBeInstanceOf(Array);
  });
});
