// @vitest-environment node
/**
 * Owner decision 7 (2026-10-07): a customer's status follows its shops, on every
 * path that changes a branch's status (lib/customer-status.ts), against real
 * Postgres:
 *
 *   - a salesman's close-shop request, approved, closes a one-shop customer, and
 *     the Manager's approval of his reactivation opens it again;
 *   - a reactivation of one shop opens a CLOSED customer whose other shop is
 *     still closed (it used to wait until every shop was active);
 *   - a Manager's direct write: closing one of two open shops leaves the customer
 *     ACTIVE, closing the second closes it, reopening one opens it;
 *   - an import: a row the Steward fixed in the app, on the branch-only lane of
 *     a customer linked to Temix, closing its only shop closes the customer;
 *   - every move is an audit row on the customer (CLOSE / REACTIVATE), and an
 *     archived customer is never touched.
 *
 * Fixer review (2026-10-07):
 *   - a customer with shops in two regions closes when its last open shop
 *     closes, whatever region the closed one is in;
 *   - closing a suspended shop while another stays suspended closes no open shop
 *     and moves nothing; closing the last one closes the customer;
 *   - the full import lane: the customer status the file states is audited with
 *     the rest, one CLOSE row from the status before the load;
 *   - a duplicate merge that moves an open shop onto a CLOSED winner reopens it.
 *
 * GATED: RUN_CUSTOMER_STATUS=1. Synthetic rows only (prefix ZZCSF-), deleted
 * after. Never production.
 *
 *   RUN_CUSTOMER_STATUS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/customer-status-follows.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { editPayload } from '../support/edit-payload';
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_CUSTOMER_STATUS === '1' && !!process.env.DATABASE_URL;
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
  'day_of_visit',
  'customer_status',
  'temix_code',
] as const;
type SheetRow = Partial<Record<(typeof HEADERS)[number], string>>;

async function sheet(rows: SheetRow[]): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow([...HEADERS]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out));
  return bytes;
}

describe.skipIf(!ENABLED)('owner decision 7: a customer’s status follows its shops', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let react: typeof import('@/services/reactivations');
  let edits: typeof import('@/services/edits');
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  let dupes: typeof import('@/services/duplicates');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZCSF-${tag}`;
  const REGION = `ZZCSF${tag}R`;
  const ROUTE = `ZZCSF${tag}-RT`;
  const REGION2 = `ZZCSF${tag}R2`;
  const ROUTE2 = `ZZCSF${tag}-RT2`;
  const ids = {
    region: '',
    route: '',
    region2: '',
    route2: '',
    sup: `${P}-sup`,
    mgr: `${P}-mgr`,
    sales: `${P}-sales`,
    stew: `${P}-stew`,
  };
  const USERS = [ids.sup, ids.mgr, ids.sales, ids.stew];
  const batchIds: string[] = [];
  const as = (id: string, role: string) => {
    current = { id, role, username: id };
  };

  beforeAll(async () => {
    for (const v of ['DATABASE_URL', 'DIRECT_URL']) {
      if ((process.env[v] ?? '').includes('ep-sweet-haze')) throw new Error(`ABORT: ${v} points at production`);
    }
    ({ prisma } = await import('@/lib/db'));
    react = await import('@/services/reactivations');
    edits = await import('@/services/edits');
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    dupes = await import('@/services/duplicates');
    ids.region = (await prisma.region.create({ data: { code: REGION, name: `ZZ CSF ${tag}` } })).id;
    ids.route = (await prisma.route.create({ data: { code: ROUTE, name: `ZZ CSF ${tag}`, regionId: ids.region } })).id;
    ids.region2 = (await prisma.region.create({ data: { code: REGION2, name: `ZZ CSF ${tag} 2` } })).id;
    ids.route2 = (await prisma.route.create({ data: { code: ROUTE2, name: `ZZ CSF ${tag} 2`, regionId: ids.region2 } })).id;
    const user = (id: string, role: string, extra: Record<string, unknown> = {}) =>
      prisma.user.create({ data: { id, username: id, passwordHash: 'x', fullName: `ZZ ${role}`, role: role as never, ...extra } });
    await user(ids.sup, 'SUPERVISOR');
    await user(ids.mgr, 'MANAGER', { managedRegions: { connect: { id: ids.region } } });
    await user(ids.sales, 'SALESMAN', { ownedRouteId: ids.route, supervisorId: ids.sup });
    await user(ids.stew, 'STEWARD');
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const custIds = custs.map((c) => c.id);
      const eds = await prisma.customerEdit.findMany({
        where: { OR: [{ customerId: { in: custIds } }, { submittedById: { in: USERS } }] },
        select: { id: true },
      });
      if (eds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: eds.map((e) => e.id) } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: eds.map((e) => e.id) } } });
      }
      await prisma.attachment.deleteMany({ where: { capturedById: { in: USERS } } });
      await purgeAuditLog(prisma, { where: { actorId: { in: USERS } } });
      await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: custIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: custIds } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { OR: USERS.map((u) => ({ key: { contains: u } })) } });
      await prisma.user.updateMany({ where: { id: { in: USERS } }, data: { supervisorId: null, ownedRouteId: null } });
      await prisma.user.deleteMany({ where: { id: { in: USERS } } });
      await prisma.route.deleteMany({ where: { id: { in: [ids.route, ids.route2] } } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.region, ids.region2] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  let seq = 0;
  async function customer(code: string, branches: Array<'ACTIVE' | 'CLOSED' | 'SUSPENDED'>, over: Record<string, unknown> = {}) {
    const anyActive = branches.includes('ACTIVE');
    const c = await prisma.customer.create({
      data: {
        nmwcCode: `${P}-${code}`,
        legalName: `ZZ ${code} Co`,
        paymentTerms: 'CASH',
        status: anyActive ? 'ACTIVE' : 'CLOSED',
        createdById: ids.mgr,
        ...over,
      },
    });
    const bs = [];
    for (const [i, status] of branches.entries()) {
      bs.push(
        await prisma.branch.create({
          data: {
            customerId: c.id,
            branchCode: `${P}-${code}-0${i + 1}`,
            branchName: `ZZ ${code} ${i + 1}`,
            address: `ZZ Way ${++seq}, Muscat`,
            routeId: ids.route,
            regionId: ids.region,
            status,
            lastStatusChangeAt: status === 'CLOSED' ? new Date(Date.now() - 3600_000) : null,
          },
        })
      );
    }
    return { id: c.id, branchIds: bs.map((b) => b.id) };
  }
  const statusOf = async (id: string) => (await prisma.customer.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const auditRows = (customerId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'Customer', entityId: customerId, action: { in: ['CLOSE', 'REACTIVATE'] } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      select: { action: true, actorId: true, before: true, after: true, reason: true },
    });
  const photo = (branchId: string | null) =>
    prisma.attachment.create({
      data: {
        kind: 'FREE',
        r2Key: `uat/csf-${tag}-${++seq}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById: ids.sales,
        // After the branch's last status change, as a photo taken at the shop is.
        capturedAt: new Date(Date.now() + 1000),
        ...(branchId ? { branchId, branchExtraId: branchId } : {}),
      },
    });
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  async function closeAndApprove(branchId: string) {
    as(ids.sales, 'SALESMAN');
    const att = await photo(branchId);
    const sub = await react.markBranchClosedAction(
      form({ branchId, reason: 'Shop shut permanently — seen today.', attachmentId: att.id })
    );
    expect(sub.ok, JSON.stringify(sub)).toBe(true);
    const editId = (sub as { ok: true; data: { editId: string } }).data.editId;
    as(ids.sup, 'SUPERVISOR');
    const app = await edits.approveEditAction(form({ editId, decisionToken: await freshDecisionToken(prisma, editId) }));
    expect(app.ok, JSON.stringify(app)).toBe(true);
    return editId;
  }

  async function reactivateAndApprove(branchId: string) {
    as(ids.sales, 'SALESMAN');
    const att = await photo(null);
    const sub = await react.requestReactivationAction(
      form({ branchId, reason: 'Reopened under the same owner.', attachmentId: att.id })
    );
    expect(sub.ok, JSON.stringify(sub)).toBe(true);
    const editId = (sub as { ok: true; data: { editId: string } }).data.editId;
    as(ids.mgr, 'MANAGER');
    const app = await react.approveReactivationAction(form({ editId }));
    expect(app.ok, JSON.stringify(app)).toBe(true);
    return editId;
  }

  it('an approved close of a one-shop customer closes it; the approved reactivation opens it again — both audited', async () => {
    const c = await customer('A', ['ACTIVE']);
    const closeId = await closeAndApprove(c.branchIds[0]!);
    expect(await statusOf(c.id)).toBe('CLOSED');
    const reactId = await reactivateAndApprove(c.branchIds[0]!);
    expect(await statusOf(c.id)).toBe('ACTIVE');
    expect(await auditRows(c.id)).toEqual([
      {
        action: 'CLOSE',
        actorId: ids.sup,
        before: { status: 'ACTIVE' },
        after: { status: 'CLOSED' },
        reason: `customer status follows its branches: approved request ${closeId}`,
      },
      {
        action: 'REACTIVATE',
        actorId: ids.mgr,
        before: { status: 'CLOSED' },
        after: { status: 'ACTIVE' },
        reason: `customer status follows its branches: reactivation ${reactId}`,
      },
    ]);
  });

  it('reopening one shop opens a CLOSED customer whose other shop stays closed (it used to wait for every shop)', async () => {
    const c = await customer('B', ['CLOSED', 'CLOSED']);
    await reactivateAndApprove(c.branchIds[0]!);
    const after = await prisma.customer.findUniqueOrThrow({
      where: { id: c.id },
      include: { branches: { orderBy: { branchCode: 'asc' } } },
    });
    expect(after.branches.map((b) => b.status)).toEqual(['ACTIVE', 'CLOSED']);
    expect(after.status).toBe('ACTIVE');
  });

  it('a Manager’s direct write: one of two shops closed keeps it ACTIVE, the last one closes it, one reopened opens it', async () => {
    const c = await customer('C', ['ACTIVE', 'ACTIVE']);
    as(ids.mgr, 'MANAGER');
    const write = async (branchId: string, status: 'ACTIVE' | 'CLOSED') => {
      await prisma.rateLimit.deleteMany({ where: { key: { contains: ids.mgr } } });
      const res = await edits.submitEditAction(
        await editPayload(prisma, { customerId: c.id, isDraft: false, customer: {}, branches: [{ branchId, status }] })
      );
      expect(res.ok, JSON.stringify(res)).toBe(true);
    };
    await write(c.branchIds[0]!, 'CLOSED');
    expect(await statusOf(c.id)).toBe('ACTIVE');
    expect(await auditRows(c.id)).toEqual([]);
    await write(c.branchIds[1]!, 'CLOSED');
    expect(await statusOf(c.id)).toBe('CLOSED');
    await write(c.branchIds[1]!, 'ACTIVE');
    expect(await statusOf(c.id)).toBe('ACTIVE');
    const rows = await auditRows(c.id);
    expect(rows.map((r) => [r.action, r.actorId, r.reason])).toEqual([
      ['CLOSE', ids.mgr, 'customer status follows its branches: direct write by MANAGER'],
      ['REACTIVATE', ids.mgr, 'customer status follows its branches: direct write by MANAGER'],
    ]);
  });

  it('an archived customer is never touched', async () => {
    const { followBranchStatus } = await import('@/lib/customer-status');
    const c = await customer('D', ['CLOSED'], { deletedAt: new Date() });
    await prisma.customer.update({ where: { id: c.id }, data: { status: 'ACTIVE' } });
    const moved = await prisma.$transaction((tx) =>
      followBranchStatus(tx, { actorId: ids.mgr, ip: null, userAgent: null }, c.id, { closed: true, closedOpen: true, reopened: false }, {
        actorId: ids.mgr,
        via: 'test',
      })
    );
    expect(moved).toBeNull();
    expect(await statusOf(c.id)).toBe('ACTIVE');
    expect(await auditRows(c.id)).toEqual([]);
  });

  it('an import: a fixed row closing the only shop of a customer linked to Temix closes the customer (branch-only lane)', async () => {
    const T = `${P}-T`;
    const cust = await prisma.customer.create({
      data: { nmwcCode: T, legalName: 'ZZ Tango', temixCode: T, paymentTerms: 'CASH', temixSyncState: 'SYNCED' },
    });
    await prisma.branch.create({
      data: { customerId: cust.id, branchCode: `${T}-01`, branchName: 'Main', address: 'Way 70, Muscat', regionId: ids.region, routeId: ids.route },
    });
    as(ids.stew, 'STEWARD');
    await prisma.rateLimit.deleteMany({ where: { key: { contains: ids.stew } } });
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        [
          await sheet([
            // Held back for its visit day, so the Steward fixes it in the app.
            { cust_code: T, cust_name: 'ZZ Tango', branch_code: `${T}-01`, sales_region: REGION, route: ROUTE, address: 'Way 70, Muscat', day_of_visit: 'XX', customer_status: 'CLOSED', temix_code: T },
          ]),
        ],
        `${P}.xlsx`,
        { type: XLSX_MIME }
      )
    );
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const batchId = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batchIds.push(batchId);
    const [row] = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(await fixes.correctImportRowAction(form({ rowId: row!.id, cells: JSON.stringify({ day_of_visit: 'MON' }) }))).toMatchObject({ ok: true });
    await promoteFully(imports, batchId);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id }, include: { branches: true } });
    expect(after.branches.map((b) => [b.status, b.dayOfVisit])).toEqual([['CLOSED', 'MON']]);
    expect(after.status).toBe('CLOSED');
    expect((await auditRows(cust.id)).map((r) => [r.action, r.actorId, r.reason])).toEqual([
      ['CLOSE', ids.stew, `customer status follows its branches: import ${batchId}`],
    ]);
  });

  it('shops in two regions: closing the last open one closes the customer, whatever region the closed one is in', async () => {
    const c = await customer('R', ['ACTIVE']);
    // Its other shop, in another region, closed earlier.
    await prisma.branch.create({
      data: {
        customerId: c.id,
        branchCode: `${P}-R-02`,
        branchName: 'ZZ R 2',
        address: `ZZ Way ${++seq}, Sohar`,
        routeId: ids.route2,
        regionId: ids.region2,
        status: 'CLOSED',
        lastStatusChangeAt: new Date(Date.now() - 3600_000),
      },
    });
    const closeId = await closeAndApprove(c.branchIds[0]!);
    expect(await statusOf(c.id)).toBe('CLOSED');
    expect((await auditRows(c.id)).map((r) => [r.action, r.before, r.after, r.reason])).toEqual([
      ['CLOSE', { status: 'ACTIVE' }, { status: 'CLOSED' }, `customer status follows its branches: approved request ${closeId}`],
    ]);
  });

  it('a suspended shop closed while another stays suspended moves nothing; the last one closed closes the customer', async () => {
    const c = await customer('S', ['SUSPENDED', 'SUSPENDED'], { status: 'SUSPENDED' });
    as(ids.mgr, 'MANAGER');
    const write = async (branchId: string) => {
      await prisma.rateLimit.deleteMany({ where: { key: { contains: ids.mgr } } });
      const res = await edits.submitEditAction(
        await editPayload(prisma, { customerId: c.id, isDraft: false, customer: {}, branches: [{ branchId, status: 'CLOSED' }] })
      );
      expect(res.ok, JSON.stringify(res)).toBe(true);
    };
    await write(c.branchIds[0]!);
    expect(await statusOf(c.id)).toBe('SUSPENDED');
    expect(await auditRows(c.id)).toEqual([]);
    await write(c.branchIds[1]!);
    expect(await statusOf(c.id)).toBe('CLOSED');
    expect((await auditRows(c.id)).map((r) => [r.action, r.before, r.after])).toEqual([
      ['CLOSE', { status: 'SUSPENDED' }, { status: 'CLOSED' }],
    ]);
  });

  it('the full import lane: the status the file states is audited with the rest — one CLOSE row from the status before the load', async () => {
    // Not linked to Temix: the plain row takes the full lane, whose item-20 block writes the stated status.
    const c = await customer('F', ['ACTIVE', 'ACTIVE']);
    as(ids.stew, 'STEWARD');
    await prisma.rateLimit.deleteMany({ where: { key: { contains: ids.stew } } });
    const row = (n: number) => ({
      cust_code: `${P}-F`,
      cust_name: 'ZZ F Co',
      branch_code: `${P}-F-0${n}`,
      branch_name: `ZZ F ${n}`,
      sales_region: REGION,
      route: ROUTE,
      address: `ZZ Way F${n}, Muscat`,
      day_of_visit: 'MON',
      customer_status: 'CLOSED',
    });
    const fd = new FormData();
    fd.set('file', new File([await sheet([row(1), row(2)])], `${P}-F.xlsx`, { type: XLSX_MIME }));
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const batchId = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batchIds.push(batchId);
    await promoteFully(imports, batchId);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id }, include: { branches: true } });
    expect(after.branches.map((b) => b.status)).toEqual(['CLOSED', 'CLOSED']);
    expect(after.status).toBe('CLOSED');
    expect((await auditRows(c.id)).map((r) => [r.action, r.actorId, r.before, r.after, r.reason])).toEqual([
      ['CLOSE', ids.stew, { status: 'ACTIVE' }, { status: 'CLOSED' }, `customer status follows its branches: import ${batchId}`],
    ]);
  });

  it('a duplicate merge that moves an open shop onto a CLOSED winner reopens it, audited', async () => {
    const winner = await customer('W', ['CLOSED']);
    const loser = await customer('L', ['ACTIVE']);
    expect(await statusOf(winner.id)).toBe('CLOSED');
    as(ids.stew, 'STEWARD');
    await prisma.rateLimit.deleteMany({ where: { key: { contains: ids.stew } } });
    const res = await dupes.mergeCustomersAction(form({ winnerId: winner.id, loserId: loser.id }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await statusOf(winner.id)).toBe('ACTIVE');
    expect((await auditRows(winner.id)).map((r) => [r.action, r.actorId, r.before, r.after, r.reason])).toEqual([
      ['REACTIVATE', ids.stew, { status: 'CLOSED' }, { status: 'ACTIVE' }, `customer status follows its branches: merge of ${P}-L`],
    ]);
    // A merge that moves only a closed shop leaves a CLOSED winner closed.
    const w2 = await customer('W2', ['CLOSED']);
    const l2 = await customer('L2', ['CLOSED']);
    expect((await dupes.mergeCustomersAction(form({ winnerId: w2.id, loserId: l2.id }))).ok).toBe(true);
    expect(await statusOf(w2.id)).toBe('CLOSED');
    expect(await auditRows(w2.id)).toEqual([]);
  });
});
