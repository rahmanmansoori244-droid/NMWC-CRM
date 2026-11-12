// @vitest-environment node
/**
 * Owner's answer of 2026-11-11 ("A1 stop") — against Postgres, through the real
 * upload, the real fix flow, the real "Before you promote" check, the real
 * promote and the real acknowledgement: the customer import never changes the
 * route of a shop that already exists (lib/import-shop-route.ts).
 *
 * Proven here:
 *   - the FIXED lane (a held-back row of a customer linked to Temix, corrected on
 *     the batch page and then loaded): the shop keeps its route and region, the
 *     blank the row fills is written, the row's note names both routes with the
 *     owner-approved sentence, the summary and the end-of-load notice count it,
 *     the notice can be acknowledged, and neither the audit log nor BranchHistory
 *     records a route change; a NEW shop fixed the same way lands on the sheet's
 *     route;
 *   - a NEW customer's shops land on the routes the sheet names (the owner's file
 *     loaded onto an emptied database);
 *   - the REGION repair: a shop whose stored region is not its own route's is put
 *     back into its route's region, whether the row names that route or another
 *     one; the route never changes.
 * The full lane (no temix_code), with the overwrite option off and on, is proven
 * in tests/integration/import-crm-fill-only.test.ts.
 *
 *   RUN_IMPORT_TESTS=1 npx vitest run tests/integration/import-route-kept.test.ts
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
const SENTENCE = 'The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

type Cells = Record<string, string | number>;

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

describe.skipIf(!ENABLED)('A1: the import never moves a shop that exists to another route', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  let review: typeof import('@/services/import-review');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZRK-${tag}`;
  const REGION_A = `ZZRK${tag}A`;
  const REGION_B = `ZZRK${tag}B`;
  const ROUTE1 = `ZZRK${tag}-R1`; // region A
  const ROUTE2 = `ZZRK${tag}-R2`; // region A
  const ROUTE3 = `ZZRK${tag}-R3`; // region B
  const steward = `${P}-stew`;
  const batchIds: string[] = [];
  let regionA = '';
  let regionB = '';
  let route1 = '';
  let route2 = '';
  let route3 = '';
  const base = parseInt(tag.slice(0, 6), 16) % 1_000_000;
  const phone = (n: number) => `+9689${String((base * 10 + n) % 10_000_000).padStart(7, '0')}`;
  const startedAt = new Date();

  const K = `${P}-K`; // linked to Temix: the fixed lane
  const N = `${P}-N`; // a new customer
  const Q = `${P}-Q`; // no Temix code: the full lane, a stale region

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
  const rowsOf = (batchId: string) =>
    prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
  const issuesOf = (r: { issues: unknown }) => (r.issues as Array<{ field: string; message: string }> | null) ?? [];
  const shop = (branchCode: string) => prisma.branch.findUniqueOrThrow({ where: { branchCode } });
  const routeHistory = (branchId: string) =>
    prisma.branchHistory.findMany({
      where: { branchId, recordedAt: { gte: startedAt } },
      orderBy: { id: 'asc' },
      select: { changeKind: true, changedFields: true, routeId: true, regionId: true },
    });
  const branchAudit = async (entityId: string, batchId: string) =>
    (
      await prisma.auditLog.findMany({ where: { entityId, reason: { startsWith: `import ${batchId} ` } }, orderBy: { at: 'asc' } })
    ).map((a) => ({ action: a.action, before: (a.before ?? {}) as Record<string, unknown>, after: a.after as Record<string, unknown> }));

  const row = (over: Cells): Cells => ({
    cust_code: '',
    branch_code: '',
    branch_name: '',
    route: '',
    address: 'Way 30, Muscat',
    phone: '',
    payment_terms: 'CASH',
    temix_code: '',
    day_of_visit: '',
    ...over,
    cust_name: `ZZ Route Kept ${String(over.cust_code).slice(-1)}`,
  });

  beforeAll(async () => {
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    review = await import('@/services/import-review');
    regionA = (await prisma.region.create({ data: { code: REGION_A, name: `ZZ RK A ${tag}` } })).id;
    regionB = (await prisma.region.create({ data: { code: REGION_B, name: `ZZ RK B ${tag}` } })).id;
    route1 = (await prisma.route.create({ data: { code: ROUTE1, name: `ZZ RK1 ${tag}`, regionId: regionA } })).id;
    route2 = (await prisma.route.create({ data: { code: ROUTE2, name: `ZZ RK2 ${tag}`, regionId: regionA } })).id;
    route3 = (await prisma.route.create({ data: { code: ROUTE3, name: `ZZ RK3 ${tag}`, regionId: regionB } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ RK Steward', role: 'STEWARD' } });
    const k = await prisma.customer.create({
      data: { nmwcCode: K, legalName: 'ZZ Route Kept K', temixCode: K, paymentTerms: 'CASH', primaryPhone: phone(1), primaryPhoneNorm: phone(1), temixSyncState: 'SYNCED' },
    });
    await prisma.branch.create({
      data: { customerId: k.id, branchCode: `${K}-01`, branchName: 'Main', address: 'Way 30, Muscat', regionId: regionA, routeId: route1, dayOfVisit: null },
    });
    const q = await prisma.customer.create({
      data: { nmwcCode: Q, legalName: 'ZZ Route Kept Q', paymentTerms: 'CASH', primaryPhone: phone(3), primaryPhoneNorm: phone(3) },
    });
    // Two shops on route 3 (region B) that an earlier route move left in region A.
    // The database refuses that state today (B-19, route_region_fixed), so it is
    // made with the triggers off, as older data was.
    await prisma.$transaction(async (tx) => {
      await tx.branch.create({
        data: { customerId: q.id, branchCode: `${Q}-01`, branchName: 'Main', address: 'Way 30, Muscat', regionId: regionB, routeId: route3 },
      });
      await tx.branch.create({
        data: { customerId: q.id, branchCode: `${Q}-02`, branchName: 'Main', address: 'Way 30, Muscat', regionId: regionB, routeId: route3 },
      });
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE "Branch" SET "regionId" = ${regionA} WHERE "branchCode" IN (${`${Q}-01`}, ${`${Q}-02`})`;
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
      await purgeAuditLog(prisma, { where: { actorId: { in: [steward] } } });
      await prisma.notification.deleteMany({ where: { userId: steward } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: { in: [route1, route2, route3] } } });
      await prisma.region.deleteMany({ where: { id: { in: [regionA, regionB] } } });
      await prisma.user.deleteMany({ where: { id: steward } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('the fixed lane: a corrected held-back row loads, its shop keeps its route, and the Steward is told', async () => {
    const before = await shop(`${K}-01`);
    const batchId = await upload([
      // Held back for its visit day; names route 2 for a shop on route 1.
      row({ cust_code: K, branch_code: `${K}-01`, route: ROUTE2, phone: phone(1), temix_code: K, day_of_visit: 'XYZ' }),
      // Held back too; a shop the CRM does not have, on route 2.
      row({ cust_code: K, branch_code: `${K}-05`, route: ROUTE2, phone: phone(1), temix_code: K, day_of_visit: 'XYZ' }),
    ]);
    const held = await rowsOf(batchId);
    expect(held.map((r) => r.state)).toEqual(['QUARANTINED', 'QUARANTINED']);
    for (const r of held) {
      const res = await fixes.correctImportRowAction(fd({ rowId: r.id, cells: JSON.stringify({ day_of_visit: 'SUN' }) }));
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    expect((await rowsOf(batchId)).map((r) => [r.state, (r.parsed as { fixedInApp?: boolean }).fixedInApp])).toEqual([
      ['CLEAN', true],
      ['CLEAN', true],
    ]);

    // Before Promote: one row names a route that will not be applied; the new shop is created.
    const told = await check(batchId);
    expect(told.summary).toMatchObject({ routeNotApplied: 1, created: { shops: 1, shopsOnExisting: 1 } });
    expect(told.lines.find((l) => l.text.startsWith('Route NOT applied'))).toEqual({
      tone: 'warn',
      text: `Route NOT applied: 1 row(s) name a route other than the current route of their shop, which is already in the CRM. The rest of each row loads as the lines here say; the route does not. ${SENTENCE}`,
    });

    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });

    // The shop that exists: its route and region as they were; the blank visit day filled.
    const after = await shop(`${K}-01`);
    expect(after).toMatchObject({ routeId: route1, regionId: regionA, dayOfVisit: 'SUN' });
    expect(after.version).toBe(before.version + 1);
    // The new shop: on the route the sheet names.
    expect(await shop(`${K}-05`)).toMatchObject({ routeId: route2, regionId: regionA, dayOfVisit: 'SUN' });

    // The row's own note is the record.
    const [r1, r2] = await rowsOf(batchId);
    expect(r1!.state).toBe('PROMOTED');
    expect(issuesOf(r1!)).toContainEqual({
      field: '_route',
      message: `shop ${K}-01: the sheet names route ${ROUTE2}; the shop is on route ${ROUTE1}. ${SENTENCE}`,
    });
    expect(issuesOf(r2!).some((i) => i.field === '_route')).toBe(false);

    // No route change in the audit log or in BranchHistory.
    expect((await branchAudit(after.id, batchId)).map((a) => [a.action, Object.keys(a.before).sort()])).toEqual([
      ['UPDATE', ['dayOfVisit']],
    ]);
    const hist = await routeHistory(after.id);
    expect(hist.length).toBeGreaterThan(0);
    for (const h of hist) {
      expect(h.changedFields).not.toContain('routeId');
      expect(h.changedFields).not.toContain('regionId');
      expect(h.routeId).toBe(route1);
    }

    // The end-of-load notice counts the row, and is acknowledged as before.
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch).toMatchObject({ status: 'PROMOTED', shopNotChangedRows: 1, shopNotChangedAckRows: 0 });
    expect(await fixes.acknowledgeShopsNotChangedAction(fd({ batchId, rows: '1' }))).toEqual({
      ok: true,
      data: { acknowledged: 1, total: 1 },
    });
    expect(await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).toMatchObject({
      shopNotChangedAckRows: 1,
      shopNotChangedAckById: steward,
    });
  });

  it('a NEW customer’s shops land on the routes the sheet names', async () => {
    const batchId = await upload([
      row({ cust_code: N, branch_code: '01', route: ROUTE1, phone: phone(2) }),
      row({ cust_code: N, branch_code: '02', route: ROUTE3, phone: phone(2), address: 'Way 31, Muscat' }),
    ]);
    const told = await check(batchId);
    expect(told.summary).toMatchObject({ routeNotApplied: 0, created: { customers: 1, shops: 2 } });
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });
    expect(await shop(`${N}-01`)).toMatchObject({ routeId: route1, regionId: regionA });
    expect(await shop(`${N}-02`)).toMatchObject({ routeId: route3, regionId: regionB });
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.shopNotChangedRows).toBe(0);
  });

  it('the region repair still works, and never changes the route', async () => {
    const batchId = await upload([
      // Names the shop's own route: the region is repaired.
      row({ cust_code: Q, branch_code: `${Q}-01`, route: ROUTE3, phone: phone(3) }),
      // Names another route: the region of the shop's OWN route, and the route not applied.
      row({ cust_code: Q, branch_code: `${Q}-02`, route: ROUTE1, phone: phone(3) }),
    ]);
    const told = await check(batchId);
    expect(told.summary).toMatchObject({ routeNotApplied: 1 });
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });
    const q1 = await shop(`${Q}-01`);
    const q2 = await shop(`${Q}-02`);
    expect(q1).toMatchObject({ routeId: route3, regionId: regionB });
    expect(q2).toMatchObject({ routeId: route3, regionId: regionB });
    for (const s of [q1, q2]) {
      expect((await branchAudit(s.id, batchId)).map((a) => [a.action, Object.keys(a.before).sort()])).toEqual([
        ['UPDATE', ['regionId']],
      ]);
      for (const h of await routeHistory(s.id)) expect(h.changedFields).not.toContain('routeId');
    }
    const [, r2] = await rowsOf(batchId);
    expect(issuesOf(r2!)).toContainEqual({
      field: '_route',
      message: `shop ${Q}-02: the sheet names route ${ROUTE1}; the shop is on route ${ROUTE3}. ${SENTENCE}`,
    });
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).shopNotChangedRows).toBe(1);
  });
});
