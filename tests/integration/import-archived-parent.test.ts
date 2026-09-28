// @vitest-environment node
/**
 * N03 against real Postgres: an import never writes over an ARCHIVED customer,
 * and never creates a live branch under one.
 *
 * The archived-customer guard sat inside `if (lead.temixCode)`, so a row with a
 * blank temix_code took the full lane: the upsert found the archived customer
 * by its code (archiving keeps nmwcCode), rewrote its name and status, bumped
 * its version, and created the row's new branch_code LIVE under it — on a
 * salesman's Today list, while the customer page could not open it. The read
 * of the customer was also unlocked, so an archive committing after it was not
 * seen at all.
 *
 * Here: archived customers with a blank-temix row carrying a new branch_code,
 * one with no branch_code, one fixed in the app, and one with a populated
 * temix_code — every one REJECTED, the customer untouched, no live branch. Then
 * two connections: an archive holds the customer's row lock and commits while
 * the promote waits on it; the promote must see the archive and reject.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-archived-parent.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const HEADERS = [
  'cust_code',
  'cust_name',
  'branch_code',
  'branch_name',
  'sales_region',
  'route',
  'address',
  'contact_person',
  'payment_terms',
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

const ARCHIVED_MESSAGE =
  'customer is archived in the CRM, and an import does not bring an archived customer back — exclude the row; steward review';
const ARCHIVED_TEMIX_MESSAGE =
  'customer is archived in the CRM — resolve its Temix deactivation before refreshing';

describe.skipIf(!ENABLED)('N03: an import does not revive an archived customer', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZARC-${tag}`;
  const REGION = `ZZARC${tag}R`;
  const ROUTE = `ZZARC${tag}-RT`;
  const steward = `${P}-stew`;
  const batchIds: string[] = [];
  let regionId = '';
  let routeId = '';

  const at = (r: Row): Row => ({
    sales_region: REGION,
    route: ROUTE,
    payment_terms: 'CASH',
    customer_status: 'ACTIVE',
    contact_person: 'ZZ Sheet Contact',
    ...r,
  });
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
  const customer = async (code: string, archived: boolean, temixCode: string | null = null) => {
    const deletedAt = archived ? new Date('2026-09-01T08:00:00Z') : null;
    const c = await prisma.customer.create({
      data: {
        nmwcCode: code,
        legalName: `ZZ Stored ${code}`,
        contactPerson: 'ZZ Stored Contact',
        temixCode,
        version: 3,
        deletedAt,
        temixSyncState: 'SYNCED',
      },
    });
    await prisma.branch.create({
      data: {
        customerId: c.id,
        branchCode: `${code}-01`,
        branchName: 'Stored shop',
        address: 'Way 1, Stored',
        regionId,
        routeId,
        deletedAt,
      },
    });
    return c;
  };
  const snapshot = (id: string) =>
    prisma.customer.findUniqueOrThrow({
      where: { id },
      select: { legalName: true, contactPerson: true, version: true, status: true, deletedAt: true, temixSyncState: true },
    });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    regionId = (await prisma.region.create({ data: { code: REGION, name: `ZZ ARC ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: ROUTE, name: `ZZ ARC ${tag}`, regionId } })).id;
    await prisma.user.create({
      data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ ARC Steward', role: 'STEWARD' },
    });
  });

  beforeEach(() => {
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: steward } });
      await prisma.notification.deleteMany({ where: { userId: steward } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: steward } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('blank temix_code (new branch_code, no branch_code, fixed in the app) and a populated one: all REJECTED, nothing written', async () => {
    const A = await customer(`${P}-A`, true);
    const B = await customer(`${P}-B`, true);
    const C = await customer(`${P}-C`, true);
    const D = await customer(`${P}-D`, true, `${P}-D`);
    const before = await Promise.all([A, B, C, D].map((c) => snapshot(c.id)));

    const batchId = await upload([
      { cust_code: A.nmwcCode, cust_name: 'ZZ Sheet A', branch_code: `${A.nmwcCode}-02`, address: 'Way 2, Sheet' },
      { cust_code: B.nmwcCode, cust_name: 'ZZ Sheet B', address: 'Way 3, Sheet' },
      { cust_code: C.nmwcCode, cust_name: 'ZZ Sheet C', branch_code: `${C.nmwcCode}-02`, address: 'Way 4, Sheet' },
      {
        cust_code: D.nmwcCode,
        cust_name: 'ZZ Sheet D',
        branch_code: `${D.nmwcCode}-02`,
        address: 'Way 5, Sheet',
        temix_code: D.nmwcCode,
      },
    ]);
    const staged = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(staged.map((r) => r.state)).toEqual(['CLEAN', 'CLEAN', 'CLEAN', 'CLEAN']);
    // C: a row the Steward fixed in the app (services/import-fixes.ts marks it so).
    const cRow = staged[2];
    await prisma.importRow.update({
      where: { id: cRow.id },
      data: { parsed: { ...(cRow.parsed as object), fixedInApp: true } },
    });

    const totals = await promoteFully(imports, batchId);
    expect(totals).toMatchObject({ promoted: 0, failed: 4 });

    const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => r.state)).toEqual(['REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
    const messages = rows.map((r) => (r.issues as Array<{ message: string }>)[0].message);
    expect(messages).toEqual([ARCHIVED_MESSAGE, ARCHIVED_MESSAGE, ARCHIVED_MESSAGE, ARCHIVED_TEMIX_MESSAGE]);

    const after = await Promise.all([A, B, C, D].map((c) => snapshot(c.id)));
    expect(after).toEqual(before);
    const liveBranches = await prisma.branch.count({
      where: { customerId: { in: [A.id, B.id, C.id, D.id] }, deletedAt: null },
    });
    expect(liveBranches).toBe(0);
    expect(await prisma.branch.count({ where: { branchCode: { in: [`${A.nmwcCode}-02`, `${C.nmwcCode}-02`, `${D.nmwcCode}-02`] } } })).toBe(0);
  });

  it('two connections: an archive that commits while the promote waits on the lock is seen, and the row is rejected', async () => {
    const E = await customer(`${P}-E`, false);
    const batchId = await upload([
      { cust_code: E.nmwcCode, cust_name: 'ZZ Sheet E', branch_code: `${E.nmwcCode}-02`, address: 'Way 6, Sheet' },
    ]);

    let promoting: ReturnType<typeof promoteFully> | undefined;
    await prisma.$transaction(
      async (tx) => {
        // The archive's connection takes the customer's row lock first.
        await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${E.id} FOR UPDATE`;
        promoting = promoteFully(imports, batchId);
        promoting.catch(() => undefined);
        // Wait until the promote is actually blocked on that lock, by its code.
        let waiting = 0;
        for (let i = 0; i < 150 && waiting === 0; i++) {
          const [r] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%"nmwcCode"%FOR UPDATE%'`;
          waiting = r?.n ?? 0;
          if (waiting === 0) await new Promise((res) => setTimeout(res, 100));
        }
        expect(waiting, 'the promote never waited on the customer lock').toBeGreaterThan(0);
        const archivedAt = new Date();
        await tx.customer.update({
          where: { id: E.id },
          data: { deletedAt: archivedAt, version: { increment: 1 } },
        });
        await tx.branch.updateMany({
          where: { customerId: E.id, deletedAt: null },
          data: { deletedAt: archivedAt },
        });
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    const totals = await promoting!;
    expect(totals).toMatchObject({ promoted: 0, failed: 1 });

    const [row] = await prisma.importRow.findMany({ where: { batchId } });
    expect(row.state).toBe('REJECTED');
    expect((row.issues as Array<{ message: string }>)[0].message).toBe(ARCHIVED_MESSAGE);
    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: E.id } });
    expect(stored.legalName).toBe(`ZZ Stored ${E.nmwcCode}`);
    expect(stored.version).toBe(4); // the archive's bump only
    expect(await prisma.branch.count({ where: { customerId: E.id, deletedAt: null } })).toBe(0);
    expect(await prisma.branch.count({ where: { branchCode: `${E.nmwcCode}-02` } })).toBe(0);
  });
});
