// @vitest-environment node
/**
 * Gaps 4 and 7 (data audit 2026-10-10, lossless paths) on Postgres, through
 * upload and promote: the customer-master import says which file and which row
 * set a value, what it changed, and leaves what it does not change alone.
 *
 *   - the batch keeps the uploaded file's SHA-256 and size;
 *   - a created customer names its sheet row (Customer.importRowId) and has a
 *     CREATE audit row with the lineage; its shop's dated history says
 *     import:<batch>:<row>:full;
 *   - re-importing the same row writes nothing: no new history row, no version,
 *     editor or updatedAt bump, no audit row;
 *   - a row that moves the shop to another route and visit day writes one
 *     history row naming both fields, under its own batch and row, and one
 *     UPDATE audit row with the before and after; the customer's own row is not
 *     written (its updatedAt moves, for the export's "updated since").
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/import-lineage.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog, purgeHistory } from '../support/audit';
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = ['cust_code', 'cust_name', 'branch_code', 'branch_name', 'region_code', 'route', 'address', 'day_of_visit', 'payment_terms', 'customer_status'] as const;

async function workbook(rows: Array<Record<string, string>>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow([...HEADERS]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!ENABLED)('the import says which file and row set a value (gaps 4 and 7)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = `ZZIL${randomUUID().slice(0, 6).toUpperCase()}`;
  const steward = `${tag}-st`;
  const ids = { region: '', route1: '', route2: '' };
  const code = `${tag}-C`;
  const branchCode = `${tag}-C-01`;
  const batches: string[] = [];
  const line = (over: Record<string, string> = {}) => ({
    cust_code: code,
    cust_name: `ZZ Lineage ${tag}`,
    branch_code: branchCode,
    branch_name: 'Main',
    region_code: `${tag}G`,
    route: `${tag}R1`,
    address: 'Way 9, Lineage',
    day_of_visit: 'MON',
    payment_terms: 'CASH',
    customer_status: 'ACTIVE',
    ...over,
  });

  async function load(rows: Array<Record<string, string>>, name: string) {
    const buf = await workbook(rows);
    const fd = new FormData();
    fd.set('file', new File([buf], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const batchId = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batches.push(batchId);
    const totals = await promoteFully(imports, batchId);
    expect(totals.failed).toBe(0);
    return { batchId, buf };
  }

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    const region = await prisma.region.create({ data: { code: `${tag}G`, name: `ZZ Lineage ${tag}` } });
    ids.region = region.id;
    ids.route1 = (await prisma.route.create({ data: { code: `${tag}R1`, name: 'ZZ Lineage R1', regionId: region.id } })).id;
    ids.route2 = (await prisma.route.create({ data: { code: `${tag}R2`, name: 'ZZ Lineage R2', regionId: region.id } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ Lineage Steward', role: 'STEWARD' } });
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const customer = await prisma.customer.findUnique({ where: { nmwcCode: code }, select: { id: true } });
      const branch = await prisma.branch.findUnique({ where: { branchCode }, select: { id: true } });
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: steward }, { entityId: { in: [customer?.id ?? '', branch?.id ?? '', ...batches] } }] } });
      await prisma.branch.deleteMany({ where: { branchCode } });
      await prisma.customer.deleteMany({ where: { nmwcCode: code } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batches } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batches } } });
      await prisma.rateLimit.deleteMany({ where: { key: `import:${steward}` } });
      await prisma.user.deleteMany({ where: { id: steward } });
      await prisma.route.deleteMany({ where: { id: { in: [ids.route1, ids.route2] } } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
      await purgeHistory(prisma, {
        customerIds: customer ? [customer.id] : [],
        branchIds: branch ? [branch.id] : [],
        userIds: [steward],
        routeIds: [ids.route1, ids.route2],
        regionIds: [ids.region],
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('a created customer names its file, its row and its lane', async () => {
    const { batchId, buf } = await load([line()], `${tag}-1.xlsx`);
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.fileSha256).toBe(createHash('sha256').update(buf).digest('hex'));
    expect(batch.fileBytes).toBe(buf.length);

    const row = await prisma.importRow.findFirstOrThrow({ where: { batchId } });
    const customer = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: code } });
    expect(customer.importRowId).toBe(row.id);
    const created = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CREATE', entityType: 'Customer', entityId: customer.id } });
    expect(created.reason).toBe(`import ${batchId} row ${row.rowNumber} (full)`);
    expect(created.after).toMatchObject({ nmwcCode: code, batchId, importRowId: row.id, rowNumber: row.rowNumber, lane: 'full' });

    const shop = await prisma.branch.findUniqueOrThrow({ where: { branchCode } });
    const born = await prisma.branchHistory.findFirstOrThrow({ where: { branchId: shop.id, changeKind: 'CREATE' } });
    expect(born).toMatchObject({ source: `import:${batchId}:${row.rowNumber}:full`, actorId: steward, routeId: ids.route1 });
  });

  it('the same row again writes nothing at all', async () => {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: code } });
    const shop = await prisma.branch.findUniqueOrThrow({ where: { branchCode } });
    const counts = async () => ({
      customerHistory: await prisma.customerHistory.count({ where: { customerId: customer.id } }),
      branchHistory: await prisma.branchHistory.count({ where: { branchId: shop.id } }),
      audit: await prisma.auditLog.count({ where: { entityId: { in: [customer.id, shop.id] } } }),
    });
    const before = await counts();
    await load([line()], `${tag}-2.xlsx`);
    expect(await counts()).toEqual(before);
    const c2 = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    const s2 = await prisma.branch.findUniqueOrThrow({ where: { id: shop.id } });
    expect({ version: c2.version, updatedAt: c2.updatedAt, lastEditedById: c2.lastEditedById }).toEqual({
      version: customer.version,
      updatedAt: customer.updatedAt,
      lastEditedById: customer.lastEditedById,
    });
    expect({ version: s2.version, updatedAt: s2.updatedAt }).toEqual({ version: shop.version, updatedAt: shop.updatedAt });
  });

  it('a row that moves the shop is said once, with its file row, and the customer is not written', async () => {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: code } });
    const { batchId } = await load([line({ route: `${tag}R2`, day_of_visit: 'TUE' })], `${tag}-3.xlsx`);
    const row = await prisma.importRow.findFirstOrThrow({ where: { batchId } });
    const shop = await prisma.branch.findUniqueOrThrow({ where: { branchCode } });
    expect(shop).toMatchObject({ routeId: ids.route2, dayOfVisit: 'TUE' });

    const moved = await prisma.branchHistory.findMany({ where: { branchId: shop.id, changeKind: 'UPDATE' } });
    expect(moved).toHaveLength(1);
    expect([...moved[0]!.changedFields].sort()).toEqual(['dayOfVisit', 'routeId']);
    expect(moved[0]).toMatchObject({ source: `import:${batchId}:${row.rowNumber}:full`, routeId: ids.route2 });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE', entityType: 'Branch', entityId: shop.id } });
    expect(audit.before).toEqual({ routeId: ids.route1, dayOfVisit: 'MON' });
    expect(audit.after).toMatchObject({ routeId: ids.route2, dayOfVisit: 'TUE', batchId, importRowId: row.id, lane: 'full' });

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.version).toBe(customer.version);
    expect(after.updatedAt.getTime()).toBeGreaterThan(customer.updatedAt.getTime());
    expect(await prisma.customerHistory.count({ where: { customerId: customer.id, changeKind: 'UPDATE' } })).toBe(0);
  });
});
