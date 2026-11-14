// @vitest-environment node
/**
 * The customer-import fixes from the bug hunts before the real load, against
 * Postgres, through the real upload, the real "Before you promote" check, the
 * real fix flow and the real promote:
 *   - round 2, F1: a row with an Excel error cell (#N/A) is held back at upload
 *     on that column, is counted before Promote, is never created, and holds no
 *     other row back; the rest of the file loads; corrected, it loads.
 *
 *   RUN_IMPORT_TESTS=1 npx vitest run tests/integration/import-hunt-fixes.test.ts
 */
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

type Cell = string | number | { error: string };
type Cells = Record<string, Cell>;

async function workbook(rows: Cells[]): Promise<Uint8Array<ArrayBuffer>> {
  const headings = Object.keys(rows[0]!);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(headings);
  for (const r of rows) ws.addRow(headings.map((h) => r[h] ?? ''));
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out));
  return bytes;
}

describe.skipIf(!ENABLED)('bug hunt fixes on the customer import', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  let review: typeof import('@/services/import-review');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZHF-${tag}`;
  const REGION = `ZZHF${tag}A`;
  const ROUTE1 = `ZZHF${tag}-R1`;
  const steward = `${P}-stew`;
  const batchIds: string[] = [];
  let regionA = '';
  let route1 = '';
  const base = parseInt(tag.slice(0, 6), 16) % 1_000_000;
  const phone = (n: number) => `+9689${String((base * 10 + n) % 10_000_000).padStart(7, '0')}`;

  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const upload = async (rows: Cells[]) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const f = new FormData();
    f.set('file', new File([await workbook(rows)], `${P}.xlsx`, { type: XLSX_MIME }));
    const res = await imports.uploadCustomerMasterAction(f);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = (res as { ok: true; data: { batchId: string } }).data;
    batchIds.push(data.batchId);
    return data.batchId;
  };
  const check = async (batchId: string) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const res = await review.summariseCustomerBatchAction(fd({ batchId }));
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.data;
  };
  const rowsOf = (batchId: string) => prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
  const issuesOf = (r: { issues: unknown }) => (r.issues as Array<{ field: string; message: string }> | null) ?? [];
  const shopsOf = async (code: string) =>
    (
      await prisma.branch.findMany({ where: { customer: { nmwcCode: code } }, select: { branchCode: true }, orderBy: { branchCode: 'asc' } })
    ).map((b) => b.branchCode);

  const row = (over: Cells): Cells => ({
    cust_code: '',
    cust_name: 'ZZ Hunt Fix',
    branch_code: '',
    route: ROUTE1,
    address: 'Way 31, Muscat',
    phone: '',
    payment_terms: 'CASH',
    customer_status: '',
    ...over,
  });

  beforeAll(async () => {
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    review = await import('@/services/import-review');
    regionA = (await prisma.region.create({ data: { code: REGION, name: `ZZ HF A ${tag}` } })).id;
    route1 = (await prisma.route.create({ data: { code: ROUTE1, name: `ZZ HF1 ${tag}`, regionId: regionA } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ HF Steward', role: 'STEWARD' } });
  });

  beforeEach(() => {
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({
        where: { nmwcCode: { startsWith: P, mode: 'insensitive' } },
        select: { id: true },
      });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: { in: [steward] } } });
      await prisma.notification.deleteMany({ where: { userId: steward } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: route1 } });
      await prisma.region.deleteMany({ where: { id: regionA } });
      await prisma.user.deleteMany({ where: { id: steward } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('round 2, F1: an Excel error cell holds its row back; the rest of the file loads', async () => {
    const A = `${P}-A`;
    const B = `${P}-B`;
    const batchId = await upload([
      row({ cust_code: A, branch_code: '01', phone: phone(1) }),
      // A failed lookup in cust_code, with A's phone: it used to load as a customer '#ERROR:#N/A'.
      row({ cust_code: { error: '#N/A' }, branch_code: '02', phone: phone(1) }),
      row({ cust_code: B, cust_name: { error: '#REF!' }, branch_code: '01', phone: phone(2) }),
    ]);
    const staged = await rowsOf(batchId);
    expect(staged.map((r) => r.state)).toEqual(['CLEAN', 'QUARANTINED', 'QUARANTINED']);
    // Held back on the cell (and, itself, for sharing row 2's phone); row 2 is not held back by it.
    expect(issuesOf(staged[1]!)).toContainEqual({
      field: 'cust_code',
      message: 'the cell holds the Excel error #N/A, not a value. This row is not loaded until the cell holds a real value',
    });
    expect(issuesOf(staged[2]!)).toEqual([
      { field: 'cust_name', message: 'the cell holds the Excel error #REF!, not a value. This row is not loaded until the cell holds a real value' },
    ]);

    const told = await check(batchId);
    expect(told.summary).toMatchObject({ excelErrorRows: 2, created: { customers: 1, shops: 1 } });
    expect(told.lines.some((l) => l.text.startsWith('Excel errors: 2 row(s) are held back'))).toBe(true);

    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1, failed: 0 });
    expect(await prisma.customer.count({ where: { nmwcCode: { startsWith: '#ERROR' } } })).toBe(0);
    expect(await prisma.customer.count({ where: { nmwcCode: B } })).toBe(0);
    expect(await shopsOf(A)).toEqual([`${A}-01`]);

    // The Steward puts the real name in the cell: the row is re-checked and loads.
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const fixed = await fixes.correctImportRowAction(fd({ rowId: staged[2]!.id, cells: JSON.stringify({ cust_name: 'ZZ Hunt Fix B' }) }));
    expect(fixed.ok, JSON.stringify(fixed)).toBe(true);
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: staged[2]!.id } })).state).toBe('CLEAN');
    // The #N/A row, still held back, is left out of the fixed row's in-file checks.
    expect((await check(batchId)).summary).toMatchObject({ excelErrorRows: 1 });
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1, failed: 0 });
    expect(await shopsOf(B)).toEqual([`${B}-01`]);
  });
});
