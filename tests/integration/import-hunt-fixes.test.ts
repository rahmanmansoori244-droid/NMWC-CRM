// @vitest-environment node
/**
 * The customer-import fixes from the bug hunts before the real load, against
 * Postgres, through the real upload, the real "Before you promote" check, the
 * real fix flow and the real promote:
 *   - round 2, F1: a row with an Excel error cell (#N/A) is held back at upload
 *     on that column, is counted before Promote, is never created, and holds no
 *     other row back; the rest of the file loads; corrected, it loads.
 *   - round 1, finding 6: a NEW customer created from [CLOSED, blank status]
 *     rows ends ACTIVE, and its own audit trail and history now say how.
 *   - round 1, finding 1: a blank branch_code numbered by its place (-01) that
 *     is the code another row of the customer gives: the reasons say so and
 *     name both rows; and correcting the held-back coded row after the blank
 *     row loaded never changes the blank row's shop in place of creating its own.
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

    // Review of the hunt fixes: once the Steward excludes the #N/A row, it is no
    // longer "held back" for an Excel error, and the line goes away.
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const out = await fixes.excludeImportRowsAction(
      fd({ batchId, reason: 'a failed lookup, not a customer', rowIds: JSON.stringify([staged[1]!.id]) })
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const after = await check(batchId);
    expect(after.summary).toMatchObject({ excelErrorRows: 0 });
    expect(after.lines.some((l) => l.text.startsWith('Excel errors'))).toBe(false);
  });
  it('round 1, finding 6: a new customer from [CLOSED, blank] rows ends ACTIVE, and its trail says how', async () => {
    const G = `${P}-G`;
    const batchId = await upload([
      row({ cust_code: G, branch_code: '01', phone: phone(5), customer_status: 'CLOSED' }),
      row({ cust_code: G, branch_code: '02', phone: phone(5), customer_status: '' }),
    ]);
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });
    const g = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: G }, include: { branches: { orderBy: { branchCode: 'asc' } } } });
    expect(g.branches.map((x) => x.status)).toEqual(['CLOSED', 'ACTIVE']);
    expect(g.status).toBe('ACTIVE');
    // The customer's own audit rows, oldest first: created CLOSED (the file's
    // status), then reopened by its open shop. Only the CREATE was written before.
    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'Customer', entityId: g.id },
      orderBy: { at: 'asc' },
      select: { action: true, before: true, after: true, reason: true, source: true },
    });
    expect(audit.map((a) => a.action)).toEqual(['CREATE', 'REACTIVATE']);
    expect((audit[0]!.after as { status: string }).status).toBe('CLOSED');
    expect(audit[1]).toMatchObject({
      before: { status: 'CLOSED' },
      after: { status: 'ACTIVE' },
      reason: `customer status follows its branches: import ${batchId}`,
    });
    // Named as the customer's other writes are: its lead row.
    expect(audit[1]!.source).toBe(audit[0]!.source);
    // The dated history holds both states too.
    const history = await prisma.customerHistory.findMany({ where: { customerId: g.id }, orderBy: { id: 'asc' }, select: { status: true } });
    expect(history.map((h) => h.status)).toEqual(['CLOSED', 'ACTIVE']);

    // [CLOSED, CLOSED] stays CLOSED and writes no second row.
    const H = `${P}-H`;
    const b2 = await upload([
      row({ cust_code: H, branch_code: '01', phone: phone(6), customer_status: 'CLOSED' }),
      row({ cust_code: H, branch_code: '02', phone: phone(6), customer_status: 'CLOSED' }),
    ]);
    await promoteFully(imports, b2);
    const h = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: H } });
    expect(h.status).toBe('CLOSED');
    expect((await prisma.auditLog.findMany({ where: { entityType: 'Customer', entityId: h.id } })).map((a) => a.action)).toEqual(['CREATE']);
  });
  it('round 1, finding 1: a blank row numbered -01 beside a row coded 01 — the reasons say what happened', async () => {
    const X = `${P}-X`;
    const batchId = await upload([
      row({ cust_code: X, branch_code: '', phone: phone(7), address: 'Head office, Way 1' }),
      row({ cust_code: X, branch_code: '01', phone: phone(7), address: 'Shop one, Way 2' }),
    ]);
    expect((await rowsOf(batchId)).map((r) => r.state)).toEqual(['CLEAN', 'CLEAN']);
    const told = await check(batchId);
    expect(told.summary.expectRejected.reasons).toEqual([
      { reason: "a blank branch_code whose number by place is the code another row of the customer gives", customers: 1 },
    ]);
    expect(told.summary.numberedClash).toEqual({ customers: 1, examples: [{ blankRow: 2, codedRow: 3 }] });
    expect(told.lines.some((l) => l.text.includes('row 2 (blank) and row 3'))).toBe(true);
    expect(told.lines.some((l) => l.text.includes('a branch_code repeated in the file'))).toBe(false);

    await promoteFully(imports, batchId);
    const after = await rowsOf(batchId);
    expect(after.map((r) => r.state)).toEqual(['REJECTED', 'REJECTED']);
    const reason = `The branch_code on row 2 is blank, so it is numbered "${X}-01" by its place among this customer's rows, and that is the code row 3 gives ("01"). No code is repeated in the file: the two rows would be loaded as one shop. Give row 2 a branch_code.`;
    for (const r of after) expect(issuesOf(r)).toEqual([{ field: '_promote', message: reason }]);
    expect(await prisma.customer.count({ where: { nmwcCode: X } })).toBe(0);
  });

  it('round 1, finding 1: correcting the held-back 01 row never changes the shop the blank row loaded as -01', async () => {
    const Y = `${P}-Y`;
    const batchId = await upload([
      row({ cust_code: Y, branch_code: '', phone: phone(8), address: 'Head office, Way 1' }),
      // Held back for its phone: the head office alone loads, numbered -01 by its place.
      row({ cust_code: Y, branch_code: '01', phone: '12', address: 'Shop one, Way 2' }),
    ]);
    const staged = await rowsOf(batchId);
    expect(staged.map((r) => r.state)).toEqual(['CLEAN', 'QUARANTINED']);
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1 });
    expect(await shopsOf(Y)).toEqual([`${Y}-01`]);
    const headOffice = await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${Y}-01` } });

    // The Steward corrects the phone. Before, the row came back CLEAN and the
    // load then changed the head office (Y-01) instead of creating shop 01.
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const fixed = await fixes.correctImportRowAction(fd({ rowId: staged[1]!.id, cells: JSON.stringify({ phone: phone(8) }) }));
    expect(fixed.ok, JSON.stringify(fixed)).toBe(true);
    const held = await prisma.importRow.findUniqueOrThrow({ where: { id: staged[1]!.id } });
    expect(held.state).toBe('QUARANTINED');
    expect(issuesOf(held)).toEqual([
      {
        field: 'branch_code',
        message: `Shop code "01" is "${Y}-01", the code row 2 was given by its place when it loaded (its branch_code was blank). This is another row of the same file, so loading it would change row 2's shop instead of creating its own. Give this row a branch_code this customer does not have yet, or exclude the row.`,
      },
    ]);
    // Nothing of the batch is left to load; the head office is as it was.
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe('PROMOTED');
    const still = await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${Y}-01` } });
    expect({ address: still.address, version: still.version }).toEqual({ address: headOffice.address, version: headOffice.version });

    // Given a code the customer does not have, it loads as its own shop.
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const recoded = await fixes.correctImportRowAction(fd({ rowId: staged[1]!.id, cells: JSON.stringify({ branch_code: '02' }) }));
    expect(recoded.ok, JSON.stringify(recoded)).toBe(true);
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: staged[1]!.id } })).state).toBe('CLEAN');
    await promoteFully(imports, batchId);
    expect(await shopsOf(Y)).toEqual([`${Y}-01`, `${Y}-02`]);
    expect((await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${Y}-01` } })).address).toBe(headOffice.address);
  });
});
