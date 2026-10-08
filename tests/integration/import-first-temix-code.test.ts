// @vitest-environment node
/**
 * Owner decision 2026-10-08, the backup match on the inbound Temix refresh
 * (services/imports.ts), against real Postgres.
 *
 * Since that decision the Accountant types a new customer's Temix code at its
 * last approval. A customer created in the app BEFORE it has none, and the
 * refresh rule — a row refreshes a customer only when the CRM already holds the
 * same Temix code — could never give it one: its row took the full lane, the
 * code was never recorded, and TEMIX_SYNC_ACKED was never sent.
 *
 * Here:
 *   - A, created by an approved new-customer request, no Temix code, UPLOADED:
 *     a row with its customer code and a temix_code records the code (and nothing
 *     else: its branch and its name stay as the CRM has them), moves it to
 *     SYNCED and tells the salesman who sent the request — once; the next
 *     refresh is the ordinary one.
 *   - S, a seeded customer (no such request): the go-live style row (temix_code
 *     == cust_code) keeps the full lane, and no code is recorded — the security
 *     rule is unchanged for everything else.
 *   - B, created in the app, offered S's customer code as its Temix code: refused
 *     on the row, naming S; nothing written.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-first-temix-code.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog, purgeCustomerEdits } from '../support/audit';
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

describe.skipIf(!ENABLED)('owner decision 2026-10-08: the first Temix code of a customer created in the app', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZFTC-${tag}`;
  const REGION = `ZZFTC${tag}R`;
  const ROUTE = `ZZFTC${tag}-RT`;
  const steward = `${P}-stew`;
  const salesman = `${P}-sales`;
  const TEMIX_A = `TXA${tag}`;
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
  /** A live customer with one branch; `fromRequest` = created by an approved new-customer request. */
  const customer = async (code: string, fromRequest: boolean) => {
    const c = await prisma.customer.create({
      data: {
        nmwcCode: code,
        legalName: `ZZ Stored ${code}`,
        contactPerson: 'ZZ Stored Contact',
        temixCode: null,
        temixSyncState: fromRequest ? 'UPLOADED' : 'SYNCED',
        createdById: fromRequest ? salesman : null,
        version: 3,
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
      },
    });
    if (fromRequest) {
      await prisma.customerEdit.create({
        data: {
          process: 'CREATE',
          target: 'CUSTOMER',
          state: 'APPROVED',
          customerId: c.id,
          submittedById: salesman,
          submittedAt: new Date('2026-10-01T06:00:00Z'),
          reviewedAt: new Date('2026-10-02T06:00:00Z'),
          fieldChanges: [] as never,
          attachmentChanges: [] as never,
        },
      });
    }
    return c;
  };
  const stored = (id: string) =>
    prisma.customer.findUniqueOrThrow({
      where: { id },
      select: {
        temixCode: true,
        temixSyncState: true,
        legalName: true,
        contactPerson: true,
        paymentTerms: true,
        branches: { select: { branchCode: true, address: true } },
      },
    });
  const acks = () => prisma.notification.findMany({ where: { userId: salesman, kind: 'TEMIX_SYNC_ACKED' } });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    regionId = (await prisma.region.create({ data: { code: REGION, name: `ZZ FTC ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: ROUTE, name: `ZZ FTC ${tag}`, regionId } })).id;
    await prisma.user.create({
      data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ FTC Steward', role: 'STEWARD' },
    });
    await prisma.user.create({
      data: { id: salesman, username: salesman, passwordHash: 'x', fullName: 'ZZ FTC Salesman', role: 'SALESMAN' },
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
      await purgeCustomerEdits(prisma, { where: { submittedById: salesman } });
      await purgeAuditLog(prisma, { where: { actorId: steward } });
      await prisma.notification.deleteMany({ where: { userId: { in: [steward, salesman] } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: { in: [steward, salesman] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('A records its code — nothing else — and the salesman is told; S keeps the full lane; B is refused naming S', async () => {
    const A = await customer(`${P}-A`, true);
    const S = await customer(`${P}-S`, false);
    const B = await customer(`${P}-B`, true);
    const beforeB = await stored(B.id);

    const batchId = await upload([
      {
        cust_code: A.nmwcCode,
        cust_name: 'ZZ Temix Name A',
        branch_code: `${A.nmwcCode}-01`,
        address: 'Way 9, Temix',
        temix_code: TEMIX_A,
      },
      // The go-live master's shape: temix_code is the customer code.
      {
        cust_code: S.nmwcCode,
        cust_name: 'ZZ Sheet S',
        branch_code: `${S.nmwcCode}-01`,
        address: 'Way 2, Sheet',
        temix_code: S.nmwcCode,
      },
      {
        cust_code: B.nmwcCode,
        cust_name: 'ZZ Temix Name B',
        branch_code: `${B.nmwcCode}-01`,
        address: 'Way 3, Temix',
        temix_code: S.nmwcCode,
      },
    ]);
    const staged = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(staged.map((r) => r.state)).toEqual(['CLEAN', 'CLEAN', 'CLEAN']);

    const totals = await promoteFully(imports, batchId);
    expect(totals).toMatchObject({ promoted: 2, failed: 1 });
    const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => r.state)).toEqual(['PROMOTED', 'PROMOTED', 'REJECTED']);

    // A: the code, SYNCED; its name and its branch as the CRM has them.
    expect(await stored(A.id)).toEqual({
      temixCode: TEMIX_A,
      temixSyncState: 'SYNCED',
      legalName: `ZZ Stored ${A.nmwcCode}`,
      contactPerson: 'ZZ Stored Contact',
      paymentTerms: 'CASH',
      branches: [{ branchCode: `${A.nmwcCode}-01`, address: 'Way 1, Stored' }],
    });
    // The row says its branch was left as it was.
    expect((rows[0]!.issues as Array<{ field: string; message: string }>).map((i) => i.field)).toEqual(['_lane']);
    const told = await acks();
    expect(told.map((n) => [n.title, n.body, n.customerId])).toEqual([
      ['Customer landed in Temix', `ZZ Stored ${A.nmwcCode} (${A.nmwcCode}) is now in Temix as ${TEMIX_A}.`, A.id],
    ]);

    // S: the full lane wrote the sheet, and still no Temix code is recorded.
    const s = await stored(S.id);
    expect(s.temixCode).toBeNull();
    expect(s.legalName).toBe('ZZ Sheet S');
    expect(s.branches).toEqual([{ branchCode: `${S.nmwcCode}-01`, address: 'Way 2, Sheet' }]);

    // B: refused, naming S; nothing written.
    expect((rows[2]!.issues as Array<{ message: string }>)[0]!.message).toBe(
      `temix_code is already the Temix code of live customer ${S.nmwcCode} — steward review`
    );
    expect(await stored(B.id)).toEqual(beforeB);
  });

  it('the next refresh of A is the ordinary one: no second acknowledgement', async () => {
    const A = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: `${P}-A` } });
    const batchId = await upload([
      {
        cust_code: A.nmwcCode,
        cust_name: 'ZZ Temix Name A',
        branch_code: `${A.nmwcCode}-01`,
        address: 'Way 9, Temix',
        temix_code: TEMIX_A,
      },
    ]);
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1, failed: 0 });
    expect((await stored(A.id)).temixCode).toBe(TEMIX_A);
    expect(await acks()).toHaveLength(1);
  });
});
