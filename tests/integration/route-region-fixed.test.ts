// @vitest-environment node
/**
 * Gap 16, restated by the owner on 2026-10-11, on Postgres: a route NEVER moves
 * to another region.
 *
 *   - the database refuses any change of Route.regionId, through Prisma and in
 *     raw SQL, for the table owner too, and even inside the owner's maintenance
 *     window (there is no override);
 *   - a route's label and its on/off switch still change, and a route is still
 *     created in any region;
 *   - the account-master import holds back a Routes row that names another
 *     region, in the same words, writes no region, and still saves a new label.
 *
 *   RUN_ACCOUNTABILITY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/route-region-fixed.test.ts
 *
 * Synthetic rows only, removed again (history included).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { ROUTE_REGION_FIXED_MESSAGE } from '@/lib/route-region';
import { src, withChangeContext } from '@/lib/change-context';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_ACCOUNTABILITY === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('gap 16: a route never changes region', () => {
  let prisma: PrismaClient;
  let w: World;
  const batches: string[] = [];
  const routeNow = () => prisma.route.findUniqueOrThrow({ where: { id: w.route }, select: { name: true, regionId: true, isActive: true } });

  beforeAll(async () => {
    assertNotProductionEnv();
    ({ prisma } = await import('@/lib/db'));
    w = await buildWorld(prisma, 'routerule');
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.importRow.deleteMany({ where: { batchId: { in: batches } } });
    await prisma.importBatch.deleteMany({ where: { id: { in: batches } } });
    if (w) await tearDownWorld(prisma, w);
    await prisma.$disconnect();
  });

  it('refused through Prisma, in the owner’s words, and nothing moves', async () => {
    await expect(
      withChangeContext(prisma, { actorId: w.steward, source: src.test('route-region-fixed') }, (tx) =>
        tx.route.update({ where: { id: w.route }, data: { regionId: w.regionB } })
      )
    ).rejects.toThrow(ROUTE_REGION_FIXED_MESSAGE);
    expect((await routeNow()).regionId).toBe(w.regionA);
  });

  it('refused for the table owner in raw SQL, even inside the maintenance window', async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL!;
    const owner = new PrismaClient({ datasourceUrl: url });
    try {
      await expect(
        owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
          await tx.$executeRaw`UPDATE "Route" SET "regionId" = ${w.regionB} WHERE "id" = ${w.route}`;
        })
      ).rejects.toThrow(ROUTE_REGION_FIXED_MESSAGE);
    } finally {
      await owner.$disconnect();
    }
    expect((await routeNow()).regionId).toBe(w.regionA);
  });

  it('a route’s label and switch still change; a route is still created in the other region', async () => {
    await withChangeContext(prisma, { actorId: w.steward, source: src.test('route-region-fixed') }, async (tx) => {
      await tx.route.update({ where: { id: w.route }, data: { name: `Part C renamed ${w.sfx}`, isActive: false } });
      await tx.route.update({ where: { id: w.route }, data: { isActive: true } });
      // Writing the same region is no move.
      await tx.route.update({ where: { id: w.route }, data: { regionId: w.regionA } });
      const other = await tx.route.create({ data: { code: `${w.sfx.toUpperCase()}R2`, name: `Part C route 2 ${w.sfx}`, regionId: w.regionB } });
      w.routes.push(other.id);
    });
    expect(await routeNow()).toEqual({ name: `Part C renamed ${w.sfx}`, regionId: w.regionA, isActive: true });
  });

  it('the account import holds back a Routes row naming another region, saves its new label, writes no region', async () => {
    const imports = await import('@/services/imports');
    const route = await prisma.route.findUniqueOrThrow({ where: { id: w.route }, select: { code: true } });
    const regionB = await prisma.region.findUniqueOrThrow({ where: { id: w.regionB }, select: { code: true } });
    const regionA = await prisma.region.findUniqueOrThrow({ where: { id: w.regionA }, select: { code: true } });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Routes');
    ws.addRow(['code', 'name', 'region_code']);
    ws.addRow([route.code, `Part C import label ${w.sfx}`, regionB.code]);
    const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const bytes = new Uint8Array(out.byteLength);
    bytes.set(new Uint8Array(out));
    await prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
    current = { id: w.steward, role: 'STEWARD', username: w.steward };
    const fd = new FormData();
    fd.set('file', new File([bytes], `${w.sfx}-accounts.xlsx`, { type: XLSX_MIME }));
    const res = await imports.uploadAccountMasterAction(fd);
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { clean: 0, issues: 1 } });
    const batchId = (res as { ok: true; data: { batchId: string } }).data.batchId;
    batches.push(batchId);
    const rows = await prisma.importRow.findMany({ where: { batchId }, select: { issues: true } });
    const messages = rows.flatMap((r) => (r.issues as Array<{ message: string }>).map((i) => i.message));
    expect(messages).toEqual([
      `${ROUTE_REGION_FIXED_MESSAGE} Route ${route.code} is in region ${regionA.code}; this row says ${regionB.code}. Its new name was saved.`,
    ]);
    expect(await routeNow()).toEqual({ name: `Part C import label ${w.sfx}`, regionId: w.regionA, isActive: true });
    // The label change is in the dated history under the import row's cause; no region change is.
    const history = await prisma.routeHistory.findMany({ where: { routeId: w.route, source: { startsWith: `import:${batchId}` } } });
    expect(history.map((h) => [h.changedFields, h.regionId])).toEqual([[['name'], w.regionA]]);
  });
});
