// @vitest-environment node
/**
 * PROMOTE-RECON — promote-layer reconciliation (the checks the UPLOAD layer is
 * silent on by design, promised in qa/reports/PRODUCTION-READINESS-VERDICT.md §3):
 *
 *   1. Temix crosswalk conflict MUST be enforced at promote.
 *   2. Unknown region/route MUST fall back (UNASSIGNED + warning), not poison
 *      the whole customer group (F-17 contract).
 *   3. Identity model: branch = custcode-branchcode, GLOBALLY unique. A sheet
 *      carrying bare suffixes ('01') must not cross-collide between customers,
 *      and a composed code belonging to ANOTHER customer must never be silently
 *      re-parented (branch steal).
 *   4. Temix refresh semantics: absent payment_terms preserved, credit figures
 *      updated, CRM-owned fields untouched, UPLOADED→SYNCED.
 *   5. Quarantined rows excluded; double-promote refused (atomic batch claim).
 *
 * GATED like the sibling suites; isolated QA branch only; ZZPRO- synthetic rows
 * cleaned in afterAll (and pre-cleaned in beforeAll for crash-idempotency).
 *
 *   RUN_PROMOTE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/promote-reconciliation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_PROMOTE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = [
  'cust_code', 'cust_name', 'branch_code', 'sales_region', 'route', 'address',
  'phone', 'contact_person', 'cr_no', 'payment_terms', 'credit_limit',
  'payment_term_days', 'temix_code',
] as const;
type Row = Partial<Record<(typeof HEADERS)[number], string | number>>;

async function sheetBuf(rows: Row[]): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(HEADERS as unknown as string[]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  // fresh copy → Uint8Array<ArrayBuffer>, which satisfies File's BlobPart
  return new Uint8Array((await wb.xlsx.writeBuffer()) as unknown as Uint8Array);
}

const P = 'ZZPRO';
const ids = { steward: `${P}-steward`, region: `${P}-region`, route: `${P}-route` };

describe.skipIf(!ENABLED)('promote-layer reconciliation (crosswalk / fallback / identity / refresh)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let batch1 = '';
  let batch2 = '';
  let promoteRes1: { promoted: number; failed: number } | null = null;

  async function cleanupAll() {
    const customers = await prisma.customer.findMany({
      where: { nmwcCode: { startsWith: `${P}-` } }, select: { id: true },
    });
    const custIds = customers.map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: ids.steward } });
    await prisma.auditLog.deleteMany({ where: { actorId: ids.steward } });
    await prisma.branch.deleteMany({
      where: { OR: [{ customerId: { in: custIds } }, { branchCode: { in: ['01', `${P}-C1-01`, `${P}-C1-02`] } }] },
    });
    await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
    const batches = await prisma.importBatch.findMany({
      where: { uploadedById: ids.steward }, select: { id: true },
    });
    await prisma.importRow.deleteMany({ where: { batchId: { in: batches.map((b) => b.id) } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: batches.map((b) => b.id) } } });
    await prisma.rateLimit?.deleteMany({ where: { key: `import:${ids.steward}` } }).catch(() => {});
    await prisma.route.deleteMany({ where: { id: ids.route } });
    await prisma.region.deleteMany({ where: { id: ids.region } });
    await prisma.user.deleteMany({ where: { id: ids.steward } });
  }

  beforeAll(async () => {
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await cleanupAll().catch(() => {}); // crash-idempotency from a previous run
    await prisma.user.create({ data: { id: ids.steward, username: ids.steward, passwordHash: 'x', fullName: 'ZZ Promote Steward', role: 'STEWARD' } });
    await prisma.region.create({ data: { id: ids.region, code: 'ZZMCT', name: 'ZZ Muscat' } });
    await prisma.route.create({ data: { id: ids.route, code: 'ZZMCT-R01', name: 'ZZ Route 1', regionId: ids.region } });
    // crosswalk owner: a live customer already holding the shared temix code
    await prisma.customer.create({ data: { nmwcCode: `${P}-OWN`, legalName: 'ZZ Crosswalk Owner', temixCode: 'ZZTMX-SHARED' } });
    // refresh target: CREDIT customer awaiting inbound ack
    await prisma.customer.create({ data: {
      nmwcCode: `${P}-CR`, legalName: 'ZZ Original Name', temixCode: 'ZZTMX-CR',
      paymentTerms: 'CREDIT', creditLimit: 500, paymentTermDays: 30, temixSyncState: 'UPLOADED',
    } });
    current = { id: ids.steward, role: 'STEWARD', username: ids.steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanupAll().catch((e) => console.error('cleanup failed:', (e as Error).message));
    await prisma.$disconnect();
  });

  it('batch 1: uploads, stages, and promotes end-to-end', async () => {
    const rows: Row[] = [
      // clean customer, 2 branches with COMPOSED codes, known region+route
      { cust_code: `${P}-C1`, cust_name: 'ZZ Clean One', branch_code: `${P}-C1-01`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 1, Muscat', phone: '+96890555011' },
      { cust_code: `${P}-C1`, cust_name: 'ZZ Clean One', branch_code: `${P}-C1-02`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 2, Muscat', phone: '+96890555012' },
      // bare-suffix branch codes on two DIFFERENT customers (identity-model case)
      { cust_code: `${P}-BA`, cust_name: 'ZZ Bare A', branch_code: '01', sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 3, Muscat', phone: '+96890555013' },
      { cust_code: `${P}-BB`, cust_name: 'ZZ Bare B', branch_code: '01', sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 4, Muscat', phone: '+96890555014' },
      // unknown REGION, known route (F-17 fallback)
      { cust_code: `${P}-UR`, cust_name: 'ZZ Unknown Region', branch_code: `${P}-UR-01`, sales_region: 'ZZNOWHERE', route: 'ZZMCT-R01', address: 'Way 5, Muscat', phone: '+96890555015' },
      // unknown ROUTE (F-17 fallback → UNASSIGNED pair)
      { cust_code: `${P}-XR`, cust_name: 'ZZ Unknown Route', branch_code: `${P}-XR-01`, sales_region: 'ZZMCT', route: 'ZZNO-R99', address: 'Way 6, Muscat', phone: '+96890555016' },
      // temix crosswalk conflict: code owned by ZZPRO-OWN
      { cust_code: `${P}-XW`, cust_name: 'ZZ Conflict', branch_code: `${P}-XW-01`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 7, Muscat', phone: '+96890555017', temix_code: 'ZZTMX-SHARED' },
      // temix REFRESH row: absent payment_terms, new credit figures, changed name (must NOT clobber)
      { cust_code: `${P}-CR`, cust_name: 'ZZ CHANGED NAME', branch_code: `${P}-CR-01`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 8, Muscat', phone: '+96890555018', temix_code: 'ZZTMX-CR', credit_limit: 900, payment_term_days: 60 },
      // quarantine bait: missing cust_name — must never promote
      { cust_code: `${P}-QQ`, branch_code: `${P}-QQ-01`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 9, Muscat', phone: '+96890555019' },
    ];
    const fd = new FormData();
    fd.set('file', new File([await sheetBuf(rows)], 'promote-recon.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const up = await imports.uploadCustomerMasterAction(fd);
    if (!up.ok) console.error('UPLOAD1 FAILED:', JSON.stringify(up));
    expect(up.ok).toBe(true);
    const upData = (up as { ok: true; data: { batchId: string; clean: number; quarantined: number } }).data;
    batch1 = upData.batchId;
    expect(upData.quarantined).toBe(1); // only the missing-name row
    expect(upData.clean).toBe(rows.length - 1);

    const pfd = new FormData();
    pfd.set('batchId', batch1);
    const pr = await imports.promoteCustomerBatchAction(pfd);
    if (!pr.ok) console.error('PROMOTE1 FAILED:', JSON.stringify(pr));
    expect(pr.ok).toBe(true);
    promoteRes1 = (pr as { ok: true; data: { promoted: number; failed: number } }).data;
    console.log('PROMOTE1 result:', JSON.stringify(promoteRes1));
  });

  it('clean customer promotes with composed branch codes, correct region/route', async () => {
    const cust = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-C1` }, include: { branches: true } });
    expect(cust).toBeTruthy();
    expect(cust!.branches.map((b) => b.branchCode).sort()).toEqual([`${P}-C1-01`, `${P}-C1-02`]);
    // completenessScore is computed on promote (was left at 0, hiding imports)
    expect(cust!.completenessScore).toBeGreaterThan(0);
    for (const b of cust!.branches) {
      expect(b.regionId).toBe(ids.region);
      expect(b.routeId).toBe(ids.route);
    }
  });

  it('crosswalk conflict is REJECTED at promote (no silent overwrite, no new customer)', async () => {
    const stolen = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-XW` } });
    expect(stolen).toBeNull(); // conflict group must not create the customer
    const row = await prisma.importRow.findFirst({
      where: { batchId: batch1, state: 'REJECTED' },
      orderBy: { rowNumber: 'asc' },
    });
    const rejected = await prisma.importRow.findMany({ where: { batchId: batch1, state: 'REJECTED' } });
    const xwRow = rejected.find((r) => (r.parsed as { custCode?: string })?.custCode === `${P}-XW`);
    expect(xwRow).toBeTruthy();
    const issues = (xwRow!.issues as { field: string; message: string }[]) ?? [];
    expect(issues.some((i) => i.message.includes(`${P}-OWN`))).toBe(true); // names the owner, PII-free
    // and the owner keeps its code untouched
    const owner = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-OWN` } });
    expect(owner?.temixCode).toBe('ZZTMX-SHARED');
    void row;
  });

  it('temix refresh: absent payment_terms preserved, credit updated, CRM name untouched, UPLOADED→SYNCED', async () => {
    const cr = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-CR` } });
    expect(cr?.legalName).toBe('ZZ Original Name'); // CRM-owned, not clobbered
    expect(cr?.paymentTerms).toBe('CREDIT'); // absent column keeps terms
    expect(Number(cr?.creditLimit)).toBe(900); // Temix-owned, updated
    expect(cr?.paymentTermDays).toBe(60);
    expect(cr?.temixSyncState).toBe('SYNCED'); // UPLOADED → SYNCED on ack
  });

  it('F-17: unknown REGION falls back (row PROMOTED with warning), does not poison the group', async () => {
    const cust = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-UR` }, include: { branches: true } });
    expect(cust).toBeTruthy(); // group must promote, not reject
    expect(cust!.branches.length).toBe(1);
    // known route wins: branch lands on the route's real region (trigger-consistent)
    expect(cust!.branches[0].routeId).toBe(ids.route);
    expect(cust!.branches[0].regionId).toBe(ids.region);
    const rows = await prisma.importRow.findMany({ where: { batchId: batch1 } });
    const urRow = rows.find((r) => (r.parsed as { custCode?: string })?.custCode === `${P}-UR`);
    expect(urRow?.state).toBe('PROMOTED');
    const issues = (urRow?.issues as { field: string; message: string }[]) ?? [];
    expect(issues.some((i) => i.field === '_resolve')).toBe(true); // warning surfaced
  });

  it('F-17: unknown ROUTE falls back to the UNASSIGNED pair (trigger-consistent), row PROMOTED with warning', async () => {
    const cust = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-XR` }, include: { branches: true } });
    expect(cust).toBeTruthy();
    expect(cust!.branches.length).toBe(1);
    const unRoute = await prisma.route.findUnique({ where: { code: 'UNASSIGNED' } });
    expect(unRoute).toBeTruthy();
    expect(cust!.branches[0].routeId).toBe(unRoute!.id);
    expect(cust!.branches[0].regionId).toBe(unRoute!.regionId); // region+route consistent
  });

  it('identity model: bare-suffix branch codes are composed custcode-branchcode (no cross-customer collision)', async () => {
    const ba = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-BA` }, include: { branches: true } });
    const bb = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-BB` }, include: { branches: true } });
    expect(ba?.branches.map((b) => b.branchCode)).toEqual([`${P}-BA-01`]);
    expect(bb?.branches.map((b) => b.branchCode)).toEqual([`${P}-BB-01`]);
    // the raw bare code must NOT exist as a global branch
    const bare = await prisma.branch.findUnique({ where: { branchCode: '01' } });
    expect(bare).toBeNull();
  });

  it('quarantined rows are excluded from promote', async () => {
    const qq = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-QQ` } });
    expect(qq).toBeNull();
    const rows = await prisma.importRow.findMany({ where: { batchId: batch1, state: 'QUARANTINED' } });
    expect(rows.length).toBe(1);
  });

  it('double promote is refused by the atomic batch claim', async () => {
    const pfd = new FormData();
    pfd.set('batchId', batch1);
    const again = await imports.promoteCustomerBatchAction(pfd);
    expect(again.ok).toBe(false);
  });

  it('batch 2: a composed code owned by ANOTHER customer is refused — no silent branch steal', async () => {
    const fd = new FormData();
    fd.set('file', new File([await sheetBuf([
      // claims clean-customer C1's existing branch code
      { cust_code: `${P}-BC`, cust_name: 'ZZ Branch Thief', branch_code: `${P}-C1-01`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 10, Muscat', phone: '+96890555020' },
    ])], 'promote-steal.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    batch2 = (up as { ok: true; data: { batchId: string } }).data.batchId;
    const pfd = new FormData();
    pfd.set('batchId', batch2);
    const pr = await imports.promoteCustomerBatchAction(pfd);
    expect(pr.ok).toBe(true); // action completes; the GROUP fails
    // the branch must still belong to C1
    const branch = await prisma.branch.findUnique({ where: { branchCode: `${P}-C1-01` }, include: { customer: true } });
    expect(branch?.customer.nmwcCode).toBe(`${P}-C1`);
    const rows = await prisma.importRow.findMany({ where: { batchId: batch2 } });
    expect(rows[0]?.state).toBe('REJECTED');
  });

  it('QA P-03: two rows in ONE customer that resolve to the same branchCode reject the group (no silent branch loss)', async () => {
    // Row1 bare '02' -> ZZPRO-DUP-02 ; Row2 blank -> positional ZZPRO-DUP-01 ;
    // Row3 blank at ordinal 2 -> positional ZZPRO-DUP-02  ⇒ Row1 and Row3 collide.
    const fd = new FormData();
    fd.set('file', new File([await sheetBuf([
      { cust_code: `${P}-DUP`, cust_name: 'ZZ Dup Branch', branch_code: '02', sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 11', phone: '+96890555021' },
      { cust_code: `${P}-DUP`, cust_name: 'ZZ Dup Branch', branch_code: '', sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 12', phone: '+96890555022' },
      { cust_code: `${P}-DUP`, cust_name: 'ZZ Dup Branch', branch_code: '', sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 13', phone: '+96890555023' },
    ])], 'promote-dup.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    const b = (up as { ok: true; data: { batchId: string } }).data.batchId;
    const pfd = new FormData(); pfd.set('batchId', b);
    const pr = await imports.promoteCustomerBatchAction(pfd);
    expect(pr.ok).toBe(true);
    // the whole group is rejected — the customer is NOT created (no silent overwrite)
    const cust = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-DUP` } });
    expect(cust).toBeNull();
    const rows = await prisma.importRow.findMany({ where: { batchId: b } });
    expect(rows.every((r) => r.state === 'REJECTED')).toBe(true);
    expect((rows[0].issues as { message: string }[])[0].message).toMatch(/duplicate branch_code/i);
    // cleanup this ad-hoc batch
    await prisma.importRow.deleteMany({ where: { batchId: b } });
    await prisma.importBatch.deleteMany({ where: { id: b } });
  });
});
