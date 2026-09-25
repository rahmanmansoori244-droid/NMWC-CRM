// @vitest-environment node
/**
 * The Data Steward's in-app fix of import rows, against real Postgres —
 * benchmark item 20, owner decisions of 2026-09-25:
 *
 *  - correct only the cells a row's problem names, then it loads;
 *  - release a row held back only for a shared phone, with a reason;
 *  - re-check a rejected customer (a payment-terms rejection comes back);
 *  - accept rows as excluded, and include them again;
 *  - fix only in the newest upload that carries the customer;
 *  - a customer linked to Temix: a FIXED row creates or updates its branch,
 *    and nothing else about the customer;
 *  - a customer with no Temix code: a partial file no longer closes it, a
 *    blank cell keeps the stored value, and a row with no branch_code is
 *    refused once the customer has branches.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-fixes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';
import { promoteFully } from '../support/promote';
import { OPEN_PROBLEM_ROW, WORK_BATCH_ROWS } from '@/lib/import-rows-view';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = [
  'cust_code',
  'cust_name',
  'branch_code',
  'branch_name',
  'sales_region',
  'route',
  'address',
  'phone',
  'cr_no',
  'payment_terms',
  'day_of_visit',
  'customer_status',
  'temix_code',
] as const;
type Row = Partial<Record<(typeof HEADERS)[number], string>>;

async function sheet(rows: Row[]): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow([...HEADERS]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out));
  return bytes;
}

describe.skipIf(!ENABLED)('fixing import rows in the app (item 20)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZIF-${tag}`;
  const REGION = `ZZIF${tag}R`;
  const ROUTE = `ZZIF${tag}-RT`;
  const ROUTE2 = `ZZIF${tag}-RT2`;
  const steward = `${P}-stew`;
  const manager = `${P}-mgr`;
  const batchIds: string[] = [];
  let regionId = '';
  let routeId = '';
  let route2Id = '';
  const base = parseInt(tag.slice(0, 6), 16) % 1_000_000;
  const phone = (n: number) => `9${String((base * 10 + n) % 10_000_000).padStart(7, '0')}`;

  const at = (r: Row): Row => ({ sales_region: REGION, route: ROUTE, ...r });
  const upload = async (rows: Row[]) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const fd = new FormData();
    fd.set('file', new File([await sheet(rows.map(at))], `${P}.xlsx`, { type: XLSX_MIME }));
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const id = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batchIds.push(id);
    return id;
  };
  const rowsOf = (batchId: string) =>
    prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const batchOf = (id: string) => prisma.importBatch.findUniqueOrThrow({ where: { id } });
  const onWork = async (batchId: string) =>
    (await prisma.importBatch.count({ where: { id: batchId, OR: WORK_BATCH_ROWS } })) === 1;

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    regionId = (await prisma.region.create({ data: { code: REGION, name: `ZZ IF ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: ROUTE, name: `ZZ IF ${tag}`, regionId } })).id;
    route2Id = (await prisma.route.create({ data: { code: ROUTE2, name: `ZZ IF2 ${tag}`, regionId } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ IF Steward', role: 'STEWARD' } });
    await prisma.user.create({ data: { id: manager, username: manager, passwordHash: 'x', fullName: 'ZZ IF Manager', role: 'MANAGER' } });
  });

  beforeEach(() => {
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: { in: [steward, manager] } } });
      await prisma.notification.deleteMany({ where: { userId: { in: [steward, manager] } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: { in: [routeId, route2Id] } } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: { in: [steward, manager] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('corrects only the named cell, keeps the row as uploaded, and the fixed row loads', async () => {
    const A = `${P}-A`;
    const b = await upload([
      { cust_code: A, cust_name: 'ZZ Alpha', branch_code: `${A}-01`, address: 'Way 1, Muscat', day_of_visit: 'XYZ' },
      { cust_code: `${P}-B`, cust_name: 'ZZ Bravo', branch_code: `${P}-B-01`, address: 'Way 2, Muscat' },
    ]);
    await promoteFully(imports, b);
    expect((await batchOf(b)).status).toBe('PROMOTED');
    const [a] = await rowsOf(b);
    expect(a.state).toBe('QUARANTINED');
    expect(await onWork(b)).toBe(true);

    // Refused: a cell the problem does not name, credit, a non-Steward.
    const wrongCell = await fixes.correctImportRowAction(fd({ rowId: a.id, cells: JSON.stringify({ cust_name: 'X' }) }));
    expect(wrongCell).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    const credit = await fixes.correctImportRowAction(fd({ rowId: a.id, cells: JSON.stringify({ payment_terms: 'CREDIT' }) }));
    expect(credit).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(credit)).toMatch(/cannot be changed in the app/);
    current = { id: manager, role: 'MANAGER', username: manager };
    expect(await fixes.correctImportRowAction(fd({ rowId: a.id, cells: JSON.stringify({ day_of_visit: 'SUN' }) }))).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    current = { id: steward, role: 'STEWARD', username: steward };

    const same = await fixes.correctImportRowAction(fd({ rowId: a.id, cells: JSON.stringify({ day_of_visit: 'XYZ' }) }));
    expect(same).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(same)).toMatch(/Nothing changed/);

    const ok = await fixes.correctImportRowAction(fd({ rowId: a.id, cells: JSON.stringify({ day_of_visit: 'sun' }) }));
    expect(ok).toEqual({ ok: true, data: { clean: 1, held: 0 } });
    const fixed = await prisma.importRow.findUniqueOrThrow({ where: { id: a.id } });
    expect(fixed.state).toBe('CLEAN');
    expect((fixed.raw as Record<string, unknown>).day_of_visit).toBe('XYZ'); // evidence untouched
    expect(fixed.corrections).toEqual({ cells: { day_of_visit: 'sun' } });
    expect((fixed.parsed as { dayOfVisit: string; fixedInApp: boolean }).dayOfVisit).toBe('SUN');
    expect(fixed.issues).toBeNull();
    expect((await batchOf(b)).status).toBe('READY');
    expect(await onWork(b)).toBe(true); // fixed, waiting to be promoted

    // The ledger names the column, never the value.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'ImportRow', entityId: a.id } });
    expect(audit.after).toEqual({ columns: ['day_of_visit'], clean: 1, held: 0 });
    expect(audit.actorId).toBe(steward);

    await promoteFully(imports, b);
    const alpha = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: A }, include: { branches: true } });
    expect(alpha.branches.map((x) => [x.branchCode, x.dayOfVisit])).toEqual([[`${A}-01`, 'SUN']]);
    expect(await onWork(b)).toBe(false);
  });

  it('releases a row held back only for a shared phone, with a reason; nothing else can be released', async () => {
    const H = `${P}-H`;
    await prisma.customer.create({
      data: { nmwcCode: H, legalName: 'ZZ Holder', paymentTerms: 'CASH', primaryPhone: phone(1), primaryPhoneNorm: `+968${phone(1)}` },
    });
    const b = await upload([
      { cust_code: `${P}-C`, cust_name: 'ZZ Charlie', branch_code: `${P}-C-01`, address: 'Way 3, Muscat', phone: phone(1) },
      { cust_code: `${P}-C2`, cust_name: 'ZZ Charlie Two', branch_code: `${P}-C2-01`, address: 'Way 4, Muscat', phone: '12' },
    ]);
    const [shared, bad] = await rowsOf(b);
    expect(shared.issues).toEqual([{ field: 'phone', message: `phone already exists in master on customer ${H}` }]);

    expect(await fixes.releaseImportRowPhoneAction(fd({ rowId: shared.id, reason: 'ok' }))).toMatchObject({ ok: false });
    expect(await fixes.releaseImportRowPhoneAction(fd({ rowId: bad.id, reason: 'same owner, two shops' }))).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    const res = await fixes.releaseImportRowPhoneAction(fd({ rowId: shared.id, reason: 'same owner, two shops' }));
    expect(res).toEqual({ ok: true, data: { clean: 1, held: 0 } });
    const override = await prisma.auditLog.findFirstOrThrow({ where: { entityId: shared.id, action: 'FORCE_OVERRIDE' } });
    expect(override.reason).toMatch(/same owner, two shops/);
    // A later re-check keeps the release: it is part of the row's corrections.
    const again = await fixes.recheckImportRowAction(fd({ rowId: bad.id }));
    expect(again).toMatchObject({ ok: true, data: { clean: 0, held: 1 } });

    await promoteFully(imports, b);
    const charlie = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: `${P}-C` } });
    expect(charlie.primaryPhoneNorm).toBe(`+968${phone(1)}`);
  });

  it('re-checks a rejected customer as a whole; a payment-terms rejection comes back rejected', async () => {
    const D = `${P}-D`;
    const b = await upload([
      { cust_code: D, cust_name: 'ZZ Delta', branch_code: `${D}-01`, address: 'Way 5, Muscat' },
      { cust_code: D, cust_name: 'ZZ Delta', branch_code: `${D}-01`, address: 'Way 6, Muscat' },
    ]);
    await promoteFully(imports, b);
    const [d1, d2] = await rowsOf(b);
    expect([d1.state, d2.state]).toEqual(['REJECTED', 'REJECTED']);
    expect(await onWork(b)).toBe(true); // rejections alone used to be invisible here

    const res = await fixes.correctImportRowAction(fd({ rowId: d2.id, cells: JSON.stringify({ branch_code: `${D}-02` }) }));
    expect(res).toEqual({ ok: true, data: { clean: 2, held: 0 } }); // the whole customer
    await promoteFully(imports, b);
    const delta = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: D }, include: { branches: true } });
    expect(delta.branches.map((x) => x.branchCode).sort()).toEqual([`${D}-01`, `${D}-02`]);

    // The credit guard is never bypassed by a re-check.
    const E = `${P}-E`;
    await prisma.customer.create({ data: { nmwcCode: E, legalName: 'ZZ Echo', paymentTerms: 'CREDIT', creditLimit: 100, paymentTermDays: 30 } });
    const b2 = await upload([{ cust_code: E, cust_name: 'ZZ Echo', branch_code: `${E}-01`, address: 'Way 7, Muscat', payment_terms: 'CASH' }]);
    await promoteFully(imports, b2);
    const [e1] = await rowsOf(b2);
    expect(e1.state).toBe('REJECTED');
    expect(await fixes.recheckImportRowAction(fd({ rowId: e1.id }))).toEqual({ ok: true, data: { clean: 1, held: 0 } });
    await promoteFully(imports, b2);
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: e1.id } })).state).toBe('REJECTED');
    expect((await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: E } })).paymentTerms).toBe('CREDIT');
  });

  it('accepts rows as excluded, lets one back in, and the batch leaves Work when nothing is open', async () => {
    const b = await upload([
      { cust_code: `${P}-F1`, cust_name: '', branch_code: `${P}-F1-01`, address: 'Way 8, Muscat' },
      { cust_code: `${P}-F2`, cust_name: '', branch_code: `${P}-F2-01`, address: 'Way 9, Muscat' },
    ]);
    const [f1, f2] = await rowsOf(b);
    expect(await fixes.excludeImportRowsAction(fd({ batchId: b, rowIds: JSON.stringify([f1.id]), reason: 'no' }))).toMatchObject({
      ok: false,
    });
    expect(await fixes.excludeImportRowsAction(fd({ batchId: b, rowIds: JSON.stringify([f1.id]), reason: 'duplicate of an existing shop' }))).toEqual({
      ok: true,
      data: { excluded: 1 },
    });
    expect(await fixes.recheckImportRowAction(fd({ rowId: f1.id }))).toMatchObject({ ok: false }); // include it first
    expect(await onWork(b)).toBe(true); // f2 still open
    expect(await fixes.excludeImportRowsAction(fd({ batchId: b, rowIds: 'all', reason: 'closed shops, not wanted' }))).toEqual({
      ok: true,
      data: { excluded: 1 },
    });
    expect(await prisma.importRow.count({ where: { batchId: b, ...OPEN_PROBLEM_ROW } })).toBe(0);
    expect(await onWork(b)).toBe(false);
    const f2x = await prisma.importRow.findUniqueOrThrow({ where: { id: f2.id } });
    expect([f2x.excludedById, f2x.excludedReason]).toEqual([steward, 'closed shops, not wanted']);

    expect(await fixes.includeImportRowAction(fd({ rowId: f2.id }))).toMatchObject({ ok: true });
    expect(await onWork(b)).toBe(true);
    expect(await fixes.includeImportRowAction(fd({ rowId: f2.id }))).toMatchObject({ ok: false }); // not excluded now
  });

  it('refuses a fix while the batch is being promoted, and in an upload older than one carrying the same customer', async () => {
    const G = `${P}-G`;
    const old = await upload([{ cust_code: G, cust_name: 'ZZ Golf', branch_code: `${G}-01`, address: 'Way 10, Muscat', day_of_visit: 'XX' }]);
    const [g] = await rowsOf(old);
    await prisma.importBatch.update({
      where: { id: old },
      data: { status: 'PROMOTING', promoteLeaseBy: 'someone', promoteLeaseUntil: new Date(Date.now() + 60_000) },
    });
    expect(await fixes.recheckImportRowAction(fd({ rowId: g.id }))).toMatchObject({ ok: false, code: 'BATCH_PROMOTING' });
    await prisma.importBatch.update({ where: { id: old }, data: { status: 'READY', promoteLeaseBy: null, promoteLeaseUntil: null } });

    await upload([{ cust_code: G, cust_name: 'ZZ Golf', branch_code: `${G}-01`, address: 'Way 10, Muscat', day_of_visit: 'SUN' }]);
    const stale = await fixes.correctImportRowAction(fd({ rowId: g.id, cells: JSON.stringify({ day_of_visit: 'MON' }) }));
    expect(stale).toMatchObject({ ok: false, code: 'NEWER_UPLOAD' });
    // The newer row is CLEAN: there is nothing to fix there, so it says exclude this one.
    expect(JSON.stringify(stale)).toMatch(/ready to load there\. This older row can no longer be fixed — exclude it/);
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: g.id } })).state).toBe('QUARANTINED');
  });

  it('Temix-linked customer: a FIXED row creates its branch or updates it from the cells it gave; nothing else changes', async () => {
    const T = `${P}-T`;
    const cust = await prisma.customer.create({
      data: { nmwcCode: T, legalName: 'ZZ Tango CRM Name', temixCode: T, paymentTerms: 'CASH', temixSyncState: 'SYNCED' },
    });
    await prisma.branch.create({
      data: { customerId: cust.id, branchCode: `${T}-01`, branchName: 'Main', address: 'Way 11, Muscat', regionId, routeId, dayOfVisit: 'SUN' },
    });
    const b = await upload([
      // Held back for its day; the branch exists: the fix updates day + address, and the blank route keeps its route.
      { cust_code: T, cust_name: 'ZZ Tango ERP Name', branch_code: `${T}-01`, address: 'Way 99, Muscat', route: '', sales_region: '', day_of_visit: 'XX', temix_code: T },
      // Held back for its day; the branch is missing: the fix creates it.
      { cust_code: T, cust_name: 'ZZ Tango ERP Name', branch_code: `${T}-02`, address: 'Way 12, Muscat', day_of_visit: 'XX', temix_code: T },
    ]);
    const [t1, t2] = await rowsOf(b);
    expect(await fixes.correctImportRowAction(fd({ rowId: t1.id, cells: JSON.stringify({ day_of_visit: 'MON' }) }))).toMatchObject({ ok: true });
    expect(await fixes.correctImportRowAction(fd({ rowId: t2.id, cells: JSON.stringify({ day_of_visit: 'TUE' }) }))).toMatchObject({ ok: true });
    await promoteFully(imports, b);

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id }, include: { branches: { orderBy: { branchCode: 'asc' } } } });
    expect(after.legalName).toBe('ZZ Tango CRM Name'); // customer fields: Temix-owned only
    expect(after.branches.map((x) => [x.branchCode, x.address, x.dayOfVisit, x.routeId])).toEqual([
      [`${T}-01`, 'Way 99, Muscat', 'MON', routeId],
      [`${T}-02`, 'Way 12, Muscat', 'TUE', routeId],
    ]);
    // Temix does not know these branch changes yet.
    expect(after.temixSyncState).toBe('PENDING_UPLOAD');
    expect((await rowsOf(b)).map((r) => [r.state, r.issues])).toEqual([
      ['PROMOTED', null],
      ['PROMOTED', null],
    ]);
  });

  it('Temix-linked customer: a fixed head-office row with no branch_code comes back REJECTED, offers branch_code, and the code creates the branch', async () => {
    // Every go-live head-office row has a blank branch_code, and only it carries
    // the phone — so it is the row held back for a shared phone. Its fix used to
    // be closed as PROMOTED with nothing written (pre-merge review).
    const U = `${P}-U`;
    await prisma.customer.create({
      data: { nmwcCode: `${P}-HOLD5`, legalName: 'ZZ Holder 5', paymentTerms: 'CASH', primaryPhone: phone(5), primaryPhoneNorm: `+968${phone(5)}` },
    });
    const cust = await prisma.customer.create({
      data: { nmwcCode: U, legalName: 'ZZ Uniform CRM', temixCode: U, paymentTerms: 'CASH', temixSyncState: 'SYNCED' },
    });
    await prisma.branch.create({
      data: { customerId: cust.id, branchCode: `${U}-02`, branchName: 'Souq', address: 'Way 13, Muscat', regionId, routeId },
    });
    const b = await upload([
      { cust_code: U, cust_name: 'ZZ Uniform', branch_code: '', branch_name: 'Main', address: 'Way 15, Muscat', phone: phone(5), temix_code: U },
    ]);
    const [u] = await rowsOf(b);
    expect(await fixes.releaseImportRowPhoneAction(fd({ rowId: u.id, reason: 'same owner, head office' }))).toMatchObject({ ok: true });
    await promoteFully(imports, b);
    let row = await prisma.importRow.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.state).toBe('REJECTED');
    expect((row.issues as { message: string }[])[0].message).toMatch(/a row fixed in the app has no branch_code/);
    expect(await prisma.branch.count({ where: { customerId: cust.id } })).toBe(1);

    // branch_code is now a cell the Steward may correct; the release is kept.
    expect(await fixes.correctImportRowAction(fd({ rowId: u.id, cells: JSON.stringify({ branch_code: 'HQ' }) }))).toEqual({
      ok: true,
      data: { clean: 1, held: 0 },
    });
    row = await prisma.importRow.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.corrections).toMatchObject({ phoneReleased: { reason: 'same owner, head office' }, cells: { branch_code: 'HQ' } });
    await promoteFully(imports, b);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id }, include: { branches: { orderBy: { branchCode: 'asc' } } } });
    expect(after.branches.map((x) => [x.branchCode, x.address])).toEqual([
      [`${U}-02`, 'Way 13, Muscat'],
      [`${U}-HQ`, 'Way 15, Muscat'],
    ]);
    expect(after.legalName).toBe('ZZ Uniform CRM'); // branch only
    expect(after.temixSyncState).toBe('PENDING_UPLOAD');
  });

  it('Temix-linked customer: a fixed row naming another customer\'s branch comes back REJECTED; nothing is moved', async () => {
    const U2 = `${P}-U2`;
    const other = await prisma.customer.create({ data: { nmwcCode: `${P}-OTHER`, legalName: 'ZZ Other', paymentTerms: 'CASH' } });
    await prisma.branch.create({
      data: { customerId: other.id, branchCode: `${U2}-09`, branchName: 'Theirs', address: 'Way 16, Muscat', regionId, routeId },
    });
    await prisma.customer.create({ data: { nmwcCode: U2, legalName: 'ZZ Uniform Two', temixCode: U2, paymentTerms: 'CASH' } });
    const b = await upload([
      { cust_code: U2, cust_name: 'ZZ Uniform Two', branch_code: `${U2}-09`, address: 'Way 14, Muscat', day_of_visit: 'XX', temix_code: U2 },
    ]);
    const [r] = await rowsOf(b);
    expect(await fixes.correctImportRowAction(fd({ rowId: r.id, cells: JSON.stringify({ day_of_visit: 'WED' }) }))).toMatchObject({ ok: true });
    await promoteFully(imports, b);
    const after = await prisma.importRow.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.state).toBe('REJECTED');
    expect((after.issues as { message: string }[])[0].message).toBe(`branch_code ${U2}-09 already belongs to ${P}-OTHER — steward review`);
    const theirs = await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${U2}-09` } });
    expect([theirs.customerId, theirs.address]).toEqual([other.id, 'Way 16, Muscat']);
  });

  it('Temix-linked customer: a FIXED row whose sheet left temix_code blank is still branch only', async () => {
    const W2 = `${P}-W2`;
    const cust = await prisma.customer.create({ data: { nmwcCode: W2, legalName: 'ZZ Whiskey CRM', temixCode: W2, paymentTerms: 'CASH' } });
    const b = await upload([
      { cust_code: W2, cust_name: 'ZZ Whiskey Old Sheet', branch_code: `${W2}-01`, address: 'Way 21, Muscat', day_of_visit: 'XX' },
    ]);
    const [r] = await rowsOf(b);
    expect(await fixes.correctImportRowAction(fd({ rowId: r.id, cells: JSON.stringify({ day_of_visit: 'THU' }) }))).toMatchObject({ ok: true });
    await promoteFully(imports, b);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id }, include: { branches: true } });
    expect(after.legalName).toBe('ZZ Whiskey CRM'); // not the old sheet's name
    expect(after.branches.map((x) => [x.branchCode, x.dayOfVisit])).toEqual([[`${W2}-01`, 'THU']]);
    expect(after.temixSyncState).toBe('PENDING_UPLOAD');
  });

  it('a fix is no Temix acknowledgement: an UPLOADED customer stays UPLOADED when the fix writes nothing', async () => {
    const X2 = `${P}-X2`;
    const cust = await prisma.customer.create({
      data: { nmwcCode: X2, legalName: 'ZZ Xray Two', temixCode: X2, paymentTerms: 'CASH', temixSyncState: 'UPLOADED' },
    });
    await prisma.branch.create({
      data: { customerId: cust.id, branchCode: `${X2}-01`, branchName: 'Main', address: 'Way 22, Muscat', regionId, routeId, dayOfVisit: 'SUN' },
    });
    const b = await upload([{ cust_code: X2, cust_name: 'ZZ Xray Two', branch_code: `${X2}-01`, day_of_visit: 'XX', temix_code: X2 }]);
    const [r] = await rowsOf(b);
    expect(await fixes.correctImportRowAction(fd({ rowId: r.id, cells: JSON.stringify({ day_of_visit: 'SUN' }) }))).toMatchObject({ ok: true });
    await promoteFully(imports, b);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).temixSyncState).toBe('UPLOADED');
  });

  it('a fix can be withdrawn back to exactly what the row was, and the row can then be excluded', async () => {
    const b = await upload([{ cust_code: '', cust_name: 'ZZ Nameless Code', branch_code: '', address: 'Way 23, Muscat' }]);
    const [r] = await rowsOf(b);
    const before = r.issues;
    // A typo'd code would merge this row into ANOTHER customer at promote.
    expect(await fixes.correctImportRowAction(fd({ rowId: r.id, cells: JSON.stringify({ cust_code: `${P}-TYPO` }) }))).toEqual({
      ok: true,
      data: { clean: 1, held: 0 },
    });
    expect(await fixes.withdrawImportRowFixAction(fd({ rowId: r.id }))).toMatchObject({ ok: true });
    const back = await prisma.importRow.findUniqueOrThrow({ where: { id: r.id } });
    expect([back.state, back.issues, back.corrections]).toEqual(['QUARANTINED', before, null]);
    expect((back.parsed as { custCode: string; fixedInApp?: boolean }).custCode).toBe('');
    expect((back.parsed as { fixedInApp?: boolean }).fixedInApp).toBeUndefined();
    expect(await fixes.withdrawImportRowFixAction(fd({ rowId: r.id }))).toMatchObject({ ok: false }); // nothing to withdraw
    expect(await fixes.excludeImportRowsAction(fd({ batchId: b, rowIds: JSON.stringify([r.id]), reason: 'no code known' }))).toEqual({
      ok: true,
      data: { excluded: 1 },
    });
  });

  it('a release survives the customer coming back REJECTED and a sibling being corrected', async () => {
    const S = `${P}-S`;
    await prisma.customer.create({
      data: { nmwcCode: `${P}-HOLD6`, legalName: 'ZZ Holder 6', paymentTerms: 'CASH', primaryPhone: phone(6), primaryPhoneNorm: `+968${phone(6)}` },
    });
    const b = await upload([
      { cust_code: S, cust_name: 'ZZ Sierra', branch_code: `${S}-01`, address: 'Way 24, Muscat', phone: phone(6) },
      { cust_code: S, cust_name: 'ZZ Sierra', branch_code: `${S}-01`, address: 'Way 25, Muscat' },
    ]);
    const [s1, s2] = await rowsOf(b);
    expect(await fixes.releaseImportRowPhoneAction(fd({ rowId: s1.id, reason: 'same owner, second shop' }))).toMatchObject({ ok: true });
    await promoteFully(imports, b); // both rows share a branch_code: the customer is rejected
    expect((await rowsOf(b)).map((r) => r.state)).toEqual(['REJECTED', 'REJECTED']);
    // Correcting the sibling re-checks the whole customer — with s1's release kept.
    expect(await fixes.correctImportRowAction(fd({ rowId: s2.id, cells: JSON.stringify({ branch_code: `${S}-02` }) }))).toEqual({
      ok: true,
      data: { clean: 2, held: 0 },
    });
    const kept = await prisma.importRow.findUniqueOrThrow({ where: { id: s1.id } });
    expect((kept.corrections as { phoneReleased?: { reason: string } }).phoneReleased?.reason).toBe('same owner, second shop');
    await promoteFully(imports, b);
    const sierra = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: S }, include: { branches: true } });
    expect(sierra.primaryPhoneNorm).toBe(`+968${phone(6)}`);
    expect(sierra.branches.map((x) => x.branchCode).sort()).toEqual([`${S}-01`, `${S}-02`]);
  });

  it('a row uploaded more than 90 days ago can no longer be fixed — the newer-upload check could not see far enough', async () => {
    const b = await upload([{ cust_code: `${P}-OLD`, cust_name: 'ZZ Old', branch_code: `${P}-OLD-01`, address: 'Way 26, Muscat', day_of_visit: 'XX' }]);
    const [r] = await rowsOf(b);
    await prisma.$executeRawUnsafe(`UPDATE "ImportRow" SET "createdAt" = now() - interval '91 days' WHERE "id" = $1`, r.id);
    const res = await fixes.recheckImportRowAction(fd({ rowId: r.id }));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res)).toMatch(/more than 90 days ago/);
    // Exclude still works.
    expect(await fixes.excludeImportRowsAction(fd({ batchId: b, rowIds: 'all', reason: 'too old to fix' }))).toMatchObject({ ok: true });
  });

    it('no Temix code: a file with one CLOSED branch no longer closes a customer whose other branch is ACTIVE', async () => {
    const V = `${P}-V`;
    const b1 = await upload([
      { cust_code: V, cust_name: 'ZZ Victor', branch_code: `${V}-01`, address: 'Way 16, Muscat', customer_status: 'ACTIVE' },
      { cust_code: V, cust_name: 'ZZ Victor', branch_code: `${V}-02`, address: 'Way 17, Muscat', customer_status: 'ACTIVE' },
    ]);
    await promoteFully(imports, b1);
    const b2 = await upload([{ cust_code: V, cust_name: 'ZZ Victor', branch_code: `${V}-02`, address: 'Way 17, Muscat', customer_status: 'CLOSED' }]);
    await promoteFully(imports, b2);
    const v = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: V }, include: { branches: { orderBy: { branchCode: 'asc' } } } });
    expect(v.branches.map((x) => x.status)).toEqual(['ACTIVE', 'CLOSED']);
    expect(v.status).toBe('ACTIVE');
    // Closing the last active one does close the customer.
    const b3 = await upload([{ cust_code: V, cust_name: 'ZZ Victor', branch_code: `${V}-01`, address: 'Way 16, Muscat', customer_status: 'CLOSED' }]);
    await promoteFully(imports, b3);
    expect((await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: V } })).status).toBe('CLOSED');
  });

  it('no Temix code: a blank cell keeps the stored branch value; a new branch still gets the placeholder', async () => {
    const W = `${P}-W`;
    const b1 = await upload([
      { cust_code: W, cust_name: 'ZZ Whiskey', branch_code: `${W}-01`, branch_name: 'Souq', address: 'Way 18, Muscat', route: ROUTE2 },
    ]);
    await promoteFully(imports, b1);
    const b2 = await upload([
      { cust_code: W, cust_name: 'ZZ Whiskey', branch_code: `${W}-01`, branch_name: '', address: '', route: '', sales_region: '' },
      { cust_code: W, cust_name: 'ZZ Whiskey', branch_code: `${W}-02`, branch_name: '', address: '', route: '', sales_region: '' },
    ]);
    await promoteFully(imports, b2);
    const [kept, fresh] = await prisma.branch.findMany({
      where: { branchCode: { in: [`${W}-01`, `${W}-02`] } },
      orderBy: { branchCode: 'asc' },
    });
    expect([kept.branchName, kept.address, kept.routeId]).toEqual(['Souq', 'Way 18, Muscat', route2Id]);
    expect(fresh.address).toBe('Address pending');
    expect(fresh.branchName).toBe('Main');
  });

  it('no Temix code: a row with no branch_code is refused once the customer has branches; a new customer still gets -01', async () => {
    const X = `${P}-X`;
    const b1 = await upload([{ cust_code: X, cust_name: 'ZZ Xray', branch_code: '', address: 'Way 19, Muscat' }]);
    await promoteFully(imports, b1);
    const x = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: X }, include: { branches: true } });
    expect(x.branches.map((br) => br.branchCode)).toEqual([`${X}-01`]);

    const b2 = await upload([{ cust_code: X, cust_name: 'ZZ Xray', branch_code: '', address: 'Way 20, Muscat' }]);
    await promoteFully(imports, b2);
    const [row] = await rowsOf(b2);
    expect(row.state).toBe('REJECTED');
    expect((row.issues as { message: string }[])[0].message).toMatch(/no branch_code, and this customer already has branches/);
    const still = await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${X}-01` } });
    expect(still.address).toBe('Way 19, Muscat');
  });
});
