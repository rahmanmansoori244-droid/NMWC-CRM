// @vitest-environment node
/**
 * Code review 2026-11-10, finding 6, against real Postgres through the real
 * services: an old staged customer batch is not loaded over newer data.
 *
 *  - A batch whose customers a NEWER upload has already loaded is refused
 *    before anything is claimed; confirmed ("skipNewer"), those customers' rows
 *    are rejected with the reason and the rest loads.
 *  - A batch staged more than 7 days ago is refused, and so is a fix that would
 *    bring one of its rows back to load; a batch already loaded keeps the fix
 *    window for its held-back rows past 7 days.
 *  - The Data Steward discards a batch whose promote stopped part-way: audited,
 *    off the Work list, refused by promote and by every fix.
 *
 *   RUN_IMPORT_TESTS=1 vitest run tests/integration/import-batch-guard.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';
import { promoteFully } from '../support/promote';
import { WORK_BATCH_ROWS } from '@/lib/import-rows-view';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = ['cust_code', 'cust_name', 'branch_code', 'sales_region', 'route', 'address', 'payment_terms', 'temix_code', 'phone'] as const;
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

describe.skipIf(!ENABLED)('finding 6: an old staged customer batch is not loaded over newer data', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZBG-${tag}`;
  const REGION = `ZZBG${tag}R`;
  const ROUTE = `ZZBG${tag}-RT`;
  const steward = `${P}-stew`;
  const batchIds: string[] = [];
  let regionId = '';
  let routeId = '';
  const DAY = 24 * 60 * 60 * 1000;

  const at = (r: Row): Row => ({ sales_region: REGION, route: ROUTE, payment_terms: 'CASH', branch_code: '01', ...r });
  const upload = async (rows: Row[]) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const fd = new FormData();
    fd.set('file', new File([await sheet(rows.map(at))], `${P}-${batchIds.length}.xlsx`, { type: XLSX_MIME }));
    const res = await imports.uploadCustomerMasterAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const id = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batchIds.push(id);
    return id;
  };
  const promoteOnce = async (batchId: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set('batchId', batchId);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return imports.promoteCustomerBatchAction(fd);
  };
  const msg = (res: { ok: boolean }) => (res as { message?: string }).message ?? '';
  const batchOf = (id: string) => prisma.importBatch.findUniqueOrThrow({ where: { id } });
  const rowsOf = (batchId: string) => prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
  const nameOf = async (code: string) => (await prisma.customer.findUnique({ where: { nmwcCode: code } }))?.legalName ?? null;

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    regionId = (await prisma.region.create({ data: { code: REGION, name: `ZZ BG ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: ROUTE, name: `ZZ BG ${tag}`, regionId } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ BG Steward', role: 'STEWARD' } });
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
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: steward } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('a customer a newer upload loaded: refused until confirmed; then its row is rejected and the rest loads', async () => {
    const older = await upload([
      { cust_code: `${P}-1`, cust_name: 'ZZ Older One', address: 'Way 1, Older' },
      { cust_code: `${P}-2`, cust_name: 'ZZ Older Two', address: 'Way 2, Older' },
    ]);
    const newer = await upload([{ cust_code: `${P}-1`, cust_name: 'ZZ Newer One', address: 'Way 1, Newer' }]);
    await promoteFully(imports, newer);
    expect(await nameOf(`${P}-1`)).toBe('ZZ Newer One');

    // The review says so before the Steward presses anything.
    const review = await (await import('@/services/import-review')).summariseCustomerBatchAction(
      (() => {
        const f = new FormData();
        f.set('batchId', older);
        return f;
      })()
    );
    expect(review.ok && review.data.newer.customers).toBe(1);

    const refused = await promoteOnce(older);
    expect(refused.ok).toBe(false);
    expect(msg(refused)).toMatch(/^1 customer\(s\) in this batch \(for example .+-1\) were loaded since from a newer upload/);
    expect((await batchOf(older)).status).toBe('READY');
    expect((await rowsOf(older)).map((r) => r.state)).toEqual(['CLEAN', 'CLEAN']);

    // Confirmed.
    let token = '';
    for (let i = 0; i < 20; i++) {
      const res = await promoteOnce(older, { skipNewer: '1', ...(token ? { leaseToken: token } : {}) });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok || res.data.done) break;
      token = res.data.leaseToken ?? '';
    }
    const rows = await rowsOf(older);
    expect(rows.map((r) => r.state)).toEqual(['REJECTED', 'PROMOTED']);
    const newerName = (await batchOf(newer)).filename;
    expect((rows[0]!.issues as Array<{ field: string; message: string }>)[0]).toEqual({
      field: '_promote',
      message: `Customer ${P}-1 was loaded since from a newer upload, "${newerName}" (row 2), so this older row was not loaded over it. Exclude it.`,
    });
    expect(await nameOf(`${P}-1`)).toBe('ZZ Newer One');
    expect(await nameOf(`${P}-2`)).toBe('ZZ Older Two');
    expect(await batchOf(older)).toMatchObject({ status: 'PROMOTED', rejectedRows: 1 });
  });

  it('a batch staged more than 7 days ago is not promoted, and a fix cannot bring a row of it back', async () => {
    const id = await upload([
      { cust_code: `${P}-3`, cust_name: 'ZZ Three', address: 'Way 3, Old' },
      { cust_code: `${P}-4`, cust_name: 'ZZ Four', address: 'Way 4, Old', phone: 'not a phone' },
    ]);
    await prisma.importBatch.update({ where: { id }, data: { uploadedAt: new Date(Date.now() - 8 * DAY) } });
    const res = await promoteOnce(id);
    expect(res.ok).toBe(false);
    expect(msg(res)).toMatch(/^This batch was uploaded 8 days ago, and a staged batch older than 7 days can no longer be promoted/);
    expect((await batchOf(id)).status).toBe('READY');
    expect(await prisma.customer.count({ where: { nmwcCode: `${P}-3` } })).toBe(0);
    const held = (await rowsOf(id)).find((r) => r.state === 'QUARANTINED');
    expect(held, 'the bad phone is held back').toBeTruthy();
    const fd = new FormData();
    fd.set('rowId', held!.id);
    const fix = await fixes.recheckImportRowAction(fd);
    expect(fix.ok).toBe(false);
    expect(msg(fix)).toMatch(/can no longer be promoted/);
  });

  // Adversarial review of finding 6: the 7-day limit is on a STAGED batch. A
  // batch already loaded keeps the 90-day fix window for its held-back rows: the
  // fix is accepted past 7 days, the batch goes back to READY, and it finishes.
  it('a promoted batch older than 7 days: its held-back row is still fixed and loaded', async () => {
    const id = await upload([
      { cust_code: `${P}-7`, cust_name: 'ZZ Seven', address: 'Way 7, Loaded' },
      { cust_code: `${P}-8`, cust_name: 'ZZ Eight', address: 'Way 8, Loaded', phone: 'not a phone' },
    ]);
    await promoteFully(imports, id);
    expect((await batchOf(id)).status).toBe('PROMOTED');
    await prisma.importBatch.update({ where: { id }, data: { uploadedAt: new Date(Date.now() - 30 * DAY) } });
    const held = (await rowsOf(id)).find((r) => r.state === 'QUARANTINED')!;
    expect(held, 'the bad phone is held back').toBeTruthy();
    const phone = '+9689' + String(parseInt(tag.slice(0, 6), 16) % 10_000_000).padStart(7, '0');
    const fd = new FormData();
    fd.set('rowId', held.id);
    fd.set('cells', JSON.stringify({ phone }));
    const fix = await fixes.correctImportRowAction(fd);
    expect(fix, JSON.stringify(fix)).toEqual({ ok: true, data: { clean: 1, held: 0 } });
    expect((await batchOf(id)).status).toBe('READY');
    expect(((await prisma.importRow.findUniqueOrThrow({ where: { id: held.id } })).parsed as { fixedAfterLoad?: boolean }).fixedAfterLoad).toBe(true);
    await promoteFully(imports, id);
    expect(await batchOf(id)).toMatchObject({ status: 'PROMOTED' });
    expect(await nameOf(`${P}-8`)).toBe('ZZ Eight');
  });

  it('the Steward discards a batch whose promote stopped: audited, off the Work list, and nothing can load or fix it', async () => {
    const id = await upload([
      { cust_code: `${P}-5`, cust_name: 'ZZ Five', address: 'Way 5, Stopped' },
      { cust_code: `${P}-6`, cust_name: 'ZZ Six', address: 'Way 6, Stopped', phone: 'not a phone' },
    ]);
    await prisma.importBatch.update({
      where: { id },
      data: { status: 'PROMOTING', promoteLeaseBy: 'gone:tok', promoteLeaseUntil: new Date(Date.now() - 60_000) },
    });
    expect(await prisma.importBatch.count({ where: { id, OR: WORK_BATCH_ROWS } })).toBe(1);

    const f = new FormData();
    f.set('batchId', id);
    f.set('reason', 'x');
    expect((await fixes.discardImportBatchAction(f)).ok, 'a reason is needed').toBe(false);
    // Nobody but the Data Steward.
    current = { id: 'someone', role: 'MANAGER', username: 'someone' };
    f.set('reason', 'a corrected sheet replaced it');
    expect((await fixes.discardImportBatchAction(f)).ok).toBe(false);
    current = { id: steward, role: 'STEWARD', username: steward };
    const done = await fixes.discardImportBatchAction(f);
    expect(done.ok, JSON.stringify(done)).toBe(true);

    expect(await batchOf(id)).toMatchObject({ status: 'DISCARDED', promoteLeaseBy: null, promoteLeaseUntil: null });
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'ImportBatch', entityId: id, actorId: steward, action: 'UPDATE' } });
    expect(audit).toMatchObject({
      reason: 'Import batch discarded by the Data Steward: a corrected sheet replaced it',
      before: { status: 'PROMOTING' },
      after: { status: 'DISCARDED', rowsNotLoaded: 1, rowsLoadedBefore: 0 },
    });
    // Nothing deleted: its rows are as they were.
    expect((await rowsOf(id)).map((r) => r.state).sort()).toEqual(['CLEAN', 'QUARANTINED']);
    expect(await prisma.importBatch.count({ where: { id, OR: WORK_BATCH_ROWS } })).toBe(0);

    const res = await promoteOnce(id);
    expect(res.ok).toBe(false);
    expect(msg(res)).toMatch(/^This batch was discarded/);
    const held = (await rowsOf(id)).find((r) => r.state === 'QUARANTINED')!;
    const ex = new FormData();
    ex.set('batchId', id);
    ex.set('reason', 'stays out');
    ex.set('rowIds', JSON.stringify([held.id]));
    expect(msg(await fixes.excludeImportRowsAction(ex))).toMatch(/^This batch was discarded/);
    // Discarding twice says what it is.
    expect(msg(await fixes.discardImportBatchAction(f))).toMatch(/^This batch was discarded/);
  });
});
