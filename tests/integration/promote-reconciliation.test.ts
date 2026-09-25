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
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';
import ExcelJS from 'exceljs';
// RK-3: promote is sliced, so "load this batch" means driving it to completion.
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_PROMOTE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = [
  'cust_code', 'cust_name', 'branch_code', 'sales_region', 'route', 'address',
  'phone', 'contact_person', 'cr_no', 'payment_terms', 'credit_limit',
  'payment_term_days', 'temix_code', 'day_of_visit',
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
    await purgeAuditLog(prisma, { where: { actorId: ids.steward } });
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
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
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
    // non-refresh re-import target: an existing CREDIT customer with CRM-owned
    // phone/CR/contact and NO temix_code. A later NON-refresh re-import row that
    // omits payment_terms/phone/CR/contact must NOT flip it to CASH or null those
    // fields (final-hunt #4/#6/#19) — the destructive-upsert regression.
    await prisma.customer.create({ data: {
      nmwcCode: `${P}-REIMP`, legalName: 'ZZ Reimport Keep',
      paymentTerms: 'CREDIT', creditLimit: 750, paymentTermDays: 45,
      primaryPhone: '+96890999001', primaryPhoneNorm: '+96890999001',
      crNumber: '7770001', crNumberNorm: '7770001', contactPerson: 'ZZ Keep Contact',
    } });
    current = { id: ids.steward, role: 'STEWARD', username: ids.steward };
  });

  // The upload action is rate-limited per Steward (3 uploads, then one token
  // every 20 s — services/imports.ts). This suite uploads four times; over a
  // WAN each upload takes seconds so the bucket refilled, but on a local
  // Postgres in CI the four land inside a second and the fourth is refused.
  // Reset the bucket before every test so the suite exercises the promote
  // layer, not the limiter (which has its own suite: rate-limit-pg.test.ts).
  beforeEach(async () => {
    await prisma.rateLimit.deleteMany({ where: { key: `import:${ids.steward}` } });
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

    promoteRes1 = await promoteFully(imports, batch1);
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

  it('non-refresh re-import preserves CREDIT terms + phone/CR/contact when columns are absent/blank (final-hunt #4/#6/#14)', async () => {
    const before = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: `${P}-REIMP` } });
    // Re-import row with NO temix_code (=> non-refresh lane), NO payment_terms,
    // NO phone / cr_no / contact_person. Before the fix this force-overwrote:
    // paymentTerms→CASH (absent col defaults CASH) and nulled phone/CR/contact.
    const fd = new FormData();
    fd.set('file', new File([await sheetBuf([
      { cust_code: `${P}-REIMP`, cust_name: 'ZZ Reimport Keep', branch_code: `${P}-REIMP-01`, sales_region: 'ZZMCT', route: 'ZZMCT-R01', address: 'Way 11, Muscat' },
    ])], 'reimport.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const up = await imports.uploadCustomerMasterAction(fd);
    if (!up.ok) console.error('REIMPORT UPLOAD FAILED:', JSON.stringify(up));
    expect(up.ok).toBe(true);
    await promoteFully(imports, (up as { ok: true; data: { batchId: string } }).data.batchId);

    const after = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: `${P}-REIMP` } });
    expect(after.paymentTerms).toBe('CREDIT');            // NOT flipped to CASH
    expect(Number(after.creditLimit)).toBe(750);          // credit figures untouched
    expect(after.paymentTermDays).toBe(45);
    expect(after.primaryPhone).toBe('+96890999001');      // NOT nulled
    expect(after.crNumber).toBe('7770001');               // NOT nulled
    expect(after.contactPerson).toBe('ZZ Keep Contact');  // NOT nulled
    expect(after.version).toBeGreaterThan(before.version); // B-05 optimistic bump (#14)
  });

  // ---- SEC-03/09 (2): credit standing is approval-gated or ERP-authoritative ----
  //
  // Before these guards an ordinary spreadsheet could mint a live CREDIT
  // customer with any credit limit, or flip an existing customer's terms, with
  // no approver and nothing in the trail. The three cases below are the hole,
  // the other direction of the hole, and the proof that the go-live master load
  // still works — which is the one that decides whether this change is safe to
  // ship before launch.

  it('SEC-03/09: a non-refresh sheet cannot flip an existing customer to CASH', async () => {
    const before = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: `${P}-REIMP` } });
    expect(before.paymentTerms).toBe('CREDIT');
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: `${P}-REIMP`,
              cust_name: 'ZZ Reimport Keep',
              branch_code: `${P}-REIMP-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 11, Muscat',
              payment_terms: 'CASH', // the flip, with no temix_code to authorise it
            },
          ]),
        ],
        'flip.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    await promoteFully(imports, (up as { ok: true; data: { batchId: string } }).data.batchId);

    // The customer is untouched, and the row says why rather than failing silently.
    const after = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: `${P}-REIMP` } });
    expect(after.paymentTerms).toBe('CREDIT');
    expect(Number(after.creditLimit)).toBe(750);
    const rows = await prisma.importRow.findMany({
      where: { batchId: (up as { ok: true; data: { batchId: string } }).data.batchId },
    });
    const row = rows.find((r) => (r.parsed as { custCode?: string })?.custCode === `${P}-REIMP`);
    expect(row?.state).toBe('REJECTED');
    const issues = (row?.issues as { field: string; message: string }[]) ?? [];
    expect(issues.some((i) => /payment_terms disagrees/i.test(i.message))).toBe(true);
    // The message must not carry the customer's data into the row.
    expect(JSON.stringify(issues)).not.toContain('96890999001');
  });

  it('SEC-03/09: a NEW customer cannot be created as CREDIT without ERP authority', async () => {
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: `${P}-NOAUTH`,
              cust_name: 'ZZ Credit No Authority',
              branch_code: `${P}-NOAUTH-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 12, Muscat',
              payment_terms: 'CREDIT',
              credit_limit: '99000',
              // no temix_code: nothing says the ERP agreed, and no approver saw it
            },
          ]),
        ],
        'noauth.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    await promoteFully(imports, (up as { ok: true; data: { batchId: string } }).data.batchId);

    // No customer at all — held, not downgraded to CASH behind the operator's back.
    expect(await prisma.customer.findUnique({ where: { nmwcCode: `${P}-NOAUTH` } })).toBeNull();
    const rows = await prisma.importRow.findMany({
      where: { batchId: (up as { ok: true; data: { batchId: string } }).data.batchId },
    });
    const row = rows.find((r) => (r.parsed as { custCode?: string })?.custCode === `${P}-NOAUTH`);
    expect(row?.state).toBe('REJECTED');
    const issues = (row?.issues as { field: string; message: string }[]) ?? [];
    expect(issues.some((i) => /CREDIT but the row carries no temix_code/i.test(i.message))).toBe(true);
  });

  it('SEC-03/09: the go-live master still loads — CREDIT with a temix_code promotes intact', async () => {
    // Every row scripts/golive/build-masters.ts emits carries temix_code, so this
    // is the shape the launch load actually has. If this test fails, the guards
    // above would block go-live.
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: `${P}-ERPOK`,
              cust_name: 'ZZ Credit From ERP',
              branch_code: `${P}-ERPOK-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 13, Muscat',
              payment_terms: 'CREDIT',
              credit_limit: '1250',
              payment_term_days: '30',
              temix_code: `${P}-ERPOK`,
            },
          ]),
        ],
        'erpok.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    await promoteFully(imports, (up as { ok: true; data: { batchId: string } }).data.batchId);

    const made = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-ERPOK` } });
    expect(made).toBeTruthy();
    expect(made!.paymentTerms).toBe('CREDIT');
    expect(Number(made!.creditLimit)).toBe(1250);
    expect(made!.paymentTermDays).toBe(30);
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
    // The warning says where the branch went. It used to end "; assigned to
    // UNASSIGNED" — false here, because the route resolved (item 20).
    expect(urRow?.issues).toEqual([
      { field: '_resolve', message: 'region "ZZNOWHERE" not found — used the region of route "ZZMCT-R01"' },
    ]);
  });

  it('F-17: unknown ROUTE falls back to the UNASSIGNED pair (trigger-consistent), row PROMOTED with warning', async () => {
    const cust = await prisma.customer.findUnique({ where: { nmwcCode: `${P}-XR` }, include: { branches: true } });
    expect(cust).toBeTruthy();
    expect(cust!.branches.length).toBe(1);
    const unRoute = await prisma.route.findUnique({ where: { code: 'UNASSIGNED' } });
    expect(unRoute).toBeTruthy();
    expect(cust!.branches[0].routeId).toBe(unRoute!.id);
    expect(cust!.branches[0].regionId).toBe(unRoute!.regionId); // region+route consistent
    const rows = await prisma.importRow.findMany({ where: { batchId: batch1 } });
    const xrRow = rows.find((r) => (r.parsed as { custCode?: string })?.custCode === `${P}-XR`);
    expect(xrRow?.state).toBe('PROMOTED');
    expect(xrRow?.issues).toEqual([
      { field: '_resolve', message: 'route "ZZNO-R99" not found — a new branch is parked in UNASSIGNED, an existing one keeps its route' },
    ]);
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
    await promoteFully(imports, batch2); // action completes; the GROUP fails
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
    await promoteFully(imports, b);
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

  // ---- The lane the go-live load takes for a customer that already exists ----
  //
  // build-masters.ts puts a temix_code on EVERY row (it is the same string as
  // cust_code), and production already holds ~3,300 seeded customers keyed on the
  // same RoutePro alternate code. The lane used to be chosen from the presence of
  // that cell alone, so on the FIRST load those rows took the narrow ERP refresh
  // lane: credit fields only, and the whole branch loop skipped. Region, route,
  // address and day of visit never landed, the rows were still counted as
  // PROMOTED, and the reconciliation came out clean.
  //
  // The first of these two would have failed before that fix; the second proves
  // the fix did not break a genuine Temix refresh, which is the whole reason the
  // narrow lane exists.

  it('GOLIVE: a seeded customer with no Temix code takes the FULL lane, branches included', async () => {
    const code = `${P}-SEEDED`;
    await prisma.customer.create({
      data: {
        nmwcCode: code,
        legalName: 'ZZ Seeded Old Name',
        paymentTerms: 'CASH',
        primaryPhone: '+96890999777',
        primaryPhoneNorm: '+96890999777',
        // No temixCode: exactly the shape the May seed left behind.
      },
    });

    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: code,
              cust_name: 'ZZ Seeded New Name',
              branch_code: `${code}-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 21, Muscat',
              temix_code: code, // every builder row carries one
            },
          ]),
        ],
        'golive.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    await promoteFully(imports, (up as { ok: true; data: { batchId: string } }).data.batchId);

    const after = await prisma.customer.findUniqueOrThrow({
      where: { nmwcCode: code },
      include: { branches: true },
    });
    // Identity applied — the refresh lane would have left the May name.
    expect(after.legalName).toBe('ZZ Seeded New Name');
    // And the branch exists, which is the half that silently did not happen: a
    // salesman with no branch has nothing on Today.
    expect(after.branches.length).toBeGreaterThan(0);
    expect(after.branches[0]!.branchCode).toBe(`${code}-01`);
  });

  it('GOLIVE: a customer that already carries a Temix code still takes the narrow refresh lane', async () => {
    const code = `${P}-XWALK`;
    await prisma.customer.create({
      data: {
        nmwcCode: code,
        legalName: 'ZZ CRM Owned Name',
        temixCode: code,
        paymentTerms: 'CASH',
        primaryPhone: '+96890999778',
        primaryPhoneNorm: '+96890999778',
      },
    });

    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: code,
              cust_name: 'ZZ ERP Wants To Rename',
              branch_code: `${code}-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 22, Muscat',
              temix_code: code,
            },
          ]),
        ],
        'refresh.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    await promoteFully(imports, (up as { ok: true; data: { batchId: string } }).data.batchId);

    const after = await prisma.customer.findUniqueOrThrow({
      where: { nmwcCode: code },
      include: { branches: true },
    });
    // CRM-owned identity is NOT clobbered by an inbound ERP refresh. That is the
    // field-ownership rule the narrow lane exists to enforce, and narrowing the
    // lane test must not have weakened it.
    expect(after.legalName).toBe('ZZ CRM Owned Name');
    // Nor does a plain file row add the branch it describes (item 20): only a
    // row the Steward fixed in the app does (import-fixes.test.ts). The row now
    // SAYS so, instead of reading PROMOTED as if the branch had landed.
    expect(after.branches).toEqual([]);
    const [row] = await prisma.importRow.findMany({
      where: { batchId: (up as { ok: true; data: { batchId: string } }).data.batchId },
    });
    expect(row.state).toBe('PROMOTED');
    expect(row.issues).toEqual([
      {
        field: '_lane',
        message: `branch ${code}-01 is not in the master and was not added — a re-import does not add branches to a customer linked to Temix; fix the held-back row on its batch page instead`,
      },
    ]);
  });

  it('item 20: a refresh row names the branch values it did not apply; a row that matches, or leaves a cell blank, says nothing', async () => {
    const code = `${P}-XW2`;
    const cust = await prisma.customer.create({
      data: { nmwcCode: code, legalName: 'ZZ Refresh Two', temixCode: code, paymentTerms: 'CASH' },
    });
    for (const [n, day] of [['01', 'SUN'], ['02', 'TUE']] as const) {
      await prisma.branch.create({
        data: {
          customerId: cust.id,
          branchCode: `${code}-${n}`,
          branchName: `Branch ${n}`,
          address: `Way 3${n}, Muscat`,
          regionId: ids.region,
          routeId: ids.route,
          dayOfVisit: day,
        },
      });
    }
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: code,
              cust_name: 'ZZ Refresh Two',
              branch_code: `${code}-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 99, Muscat', // differs
              day_of_visit: 'MON', // differs
              temix_code: code,
            },
            {
              cust_code: code,
              cust_name: 'ZZ Refresh Two',
              branch_code: `${code}-02`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 302, Muscat', // the same
              // day_of_visit left blank: a blank asks for nothing, so it is no difference
              temix_code: code,
            },
          ]),
        ],
        'refresh2.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    const batchId = (up as { ok: true; data: { batchId: string } }).data.batchId;
    await promoteFully(imports, batchId);

    const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => r.state)).toEqual(['PROMOTED', 'PROMOTED']);
    expect(rows[0].issues).toEqual([
      {
        field: '_lane',
        message: `branch ${code}-01: address, visit day in this row differ from the master and were not applied — a re-import does not change an existing branch of a customer linked to Temix; change it on the customer page`,
      },
    ]);
    expect(rows[1].issues).toBeNull();
    // The lane's contract is unchanged: nothing on the branch moved.
    const b1 = await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${code}-01` } });
    expect([b1.address, b1.dayOfVisit]).toEqual(['Way 301, Muscat', 'SUN']);
  });

  it('item 20: a go-live row rejected for payment terms names the real reason', async () => {
    // Every go-live row carries temix_code; the customer it meets may not. The
    // rejection used to say "the row carries no temix_code" — untrue for all
    // 1,833 rows rejected this way on 2026-09-23.
    const code = `${P}-GLPT`;
    await prisma.customer.create({
      data: { nmwcCode: code, legalName: 'ZZ Go-live Terms', paymentTerms: 'CREDIT', creditLimit: 100, paymentTermDays: 30 },
    });
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheetBuf([
            {
              cust_code: code,
              cust_name: 'ZZ Go-live Terms',
              branch_code: `${code}-01`,
              sales_region: 'ZZMCT',
              route: 'ZZMCT-R01',
              address: 'Way 40, Muscat',
              payment_terms: 'CASH',
              temix_code: code,
            },
          ]),
        ],
        'glpt.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok).toBe(true);
    const batchId = (up as { ok: true; data: { batchId: string } }).data.batchId;
    await promoteFully(imports, batchId);
    const [row] = await prisma.importRow.findMany({ where: { batchId } });
    expect(row.state).toBe('REJECTED');
    const message = (row.issues as { message: string }[])[0].message;
    expect(message).toMatch(/the customer has no Temix code on record/);
    expect(message).not.toMatch(/row carries no temix_code/);
    const after = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: code } });
    expect(after.paymentTerms).toBe('CREDIT');
  });

});
