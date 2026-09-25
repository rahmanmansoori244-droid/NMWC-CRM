// @vitest-environment node
/**
 * Import problem rows against real Postgres (benchmark item 20).
 *
 *  - The batch page's views page through EVERY row of a view: the page used to
 *    stop at 200 problem rows, and one go-live load had 1,833.
 *  - "Loaded with a warning" (a PROMOTED row that carries issues) is a JSON
 *    null test, which only a real database can prove.
 *  - A row held back because its phone or CR is already in the master names the
 *    customer that holds it. It used to say "review in /duplicates", a screen
 *    that cannot show a held-back row and ignores shared phones by design.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-problem-rows.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { purgeAuditLog } from '../support/audit';
import { ROWS_PAGE_SIZE, rowViewWhere } from '@/lib/import-rows-view';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = ['cust_code', 'cust_name', 'branch_code', 'sales_region', 'route', 'address', 'phone', 'cr_no'] as const;
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

describe.skipIf(!ENABLED)('import problem rows (item 20)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8);
  const P = `ZZIPR-${tag}`.toUpperCase();
  const stewardId = `${P}-stew`;
  const batchIds: string[] = [];
  const holder = `${P}-HOLD`;
  // Eight digits unique to this run; CR carries the tag.
  const phone = `9${String(parseInt(tag.slice(0, 7), 16) % 10_000_000).padStart(7, '0')}`;
  const cr = `${P}-CR`;

  const upload = async (rows: Row[]) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
    const fd = new FormData();
    fd.set('file', new File([await sheet(rows)], 'problems.xlsx', { type: XLSX_MIME }));
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const id = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batchIds.push(id);
    return id;
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await prisma.user.create({
      data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' },
    });
    await prisma.customer.create({
      data: {
        nmwcCode: holder,
        legalName: 'ZZ Holder',
        paymentTerms: 'CASH',
        primaryPhone: phone,
        primaryPhoneNorm: `+968${phone}`,
        crNumber: cr,
        crNumberNorm: cr,
      },
    });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await purgeAuditLog(prisma, { where: { actorId: stewardId } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: stewardId } } });
      await prisma.customer.deleteMany({ where: { nmwcCode: holder } });
      await prisma.user.deleteMany({ where: { id: stewardId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('a row whose phone and CR are already in the master names the customer that holds them', async () => {
    const batchId = await upload([
      { cust_code: `${P}-NEW`, cust_name: 'ZZ Newcomer', address: 'Way 1, Muscat', phone, cr_no: cr },
    ]);
    const [row] = await prisma.importRow.findMany({ where: { batchId } });
    expect(row.state).toBe('QUARANTINED');
    const messages = (row.issues as { field: string; message: string }[]).map((i) => `${i.field}: ${i.message}`);
    expect(messages).toEqual([
      `phone: phone already exists in master on customer ${holder}`,
      `cr_no: CR already exists in master on customer ${holder}`,
    ]);
  });

  it('every row of a 230-row view is reachable page by page, each exactly once', async () => {
    const rows: Row[] = Array.from({ length: 230 }, (_, i) => ({
      cust_code: `${P}-M${String(i).padStart(3, '0')}`,
      cust_name: '', // required: every row is held back
      address: 'Way 2, Muscat',
    }));
    const batchId = await upload(rows);
    const where = rowViewWhere(batchId, 'problems');
    expect(await prisma.importRow.count({ where })).toBe(230);
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const got = await prisma.importRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (page - 1) * ROWS_PAGE_SIZE,
        take: ROWS_PAGE_SIZE,
        select: { id: true },
      });
      expect(got.length).toBe(page < 3 ? 100 : 30);
      for (const r of got) seen.add(r.id);
    }
    expect(seen.size).toBe(230);

    // "Loaded with a warning" is a PROMOTED row carrying issues — not one without.
    const [a, b, c] = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' }, take: 3 });
    await prisma.importRow.update({
      where: { id: a.id },
      data: { state: 'PROMOTED', issues: [{ field: '_resolve', message: 'x' }] as Prisma.InputJsonValue },
    });
    await prisma.importRow.update({
      where: { id: b.id },
      data: { state: 'PROMOTED', issues: [{ field: '_lane', message: 'y' }] as Prisma.InputJsonValue },
    });
    await prisma.importRow.update({ where: { id: c.id }, data: { state: 'PROMOTED', issues: Prisma.DbNull } });
    const warned = await prisma.importRow.findMany({ where: rowViewWhere(batchId, 'warnings'), select: { id: true } });
    expect(warned.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await prisma.importRow.count({ where: rowViewWhere(batchId, 'problems') })).toBe(227);
  });
});
