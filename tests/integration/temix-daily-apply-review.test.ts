// @vitest-environment node
/**
 * The daily Temix import, stage 5, review 2026-11-15: the fixes, against real
 * Postgres through the real actions (services/temix-daily-apply.ts). Every
 * code, row and id is synthetic.
 *
 * One file, uploaded today, three customers' rows, each on route R2 in the
 * file while its shop is on R:
 *  - X1: customer CX has NMWC code X1 exactly (shop X1-01); customer CXA has
 *    NMWC code "X" + an Arabic digit one. The Check folds both to X1: two live
 *    customers, DUPLICATE_SUSPECT, held in the preview. Finding 1: the apply
 *    found customers with upper(btrim()), saw CX only, and moved X1-01. Now it
 *    stays HELD DUPLICATE_SUSPECT and the shop stays where it was.
 *  - Y1: customer CY's NMWC code is "Y1" with an invisible U+200B (shop
 *    Y1-01). The preview matches it and plans the move; the apply, which saw
 *    nobody (CUSTOMER_UNKNOWN), now moves it as the preview said.
 *  - Z1: customer CZ, whose transaction fails every time (a synthetic error in
 *    the mover). Before: its rows stayed PENDING for ever and the file never
 *    loaded. Now: the failure is recorded once per slice, and at the third its
 *    row is HELD APPLY_FAILED in a transaction of its own; the file loads.
 *  - Between the slices, the pilot rule stops the load (finding 3): /status
 *    counts it as held by the pilot rule, not stuck, until the request is
 *    decided.
 *  - Finding 2: the held figure the Steward confirms is the load's HELD count.
 *
 *   RUN_TEMIX_DAILY_APPLY=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/temix-daily-apply-review.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { contextClient, src } from '@/lib/change-context';
import { stalledDailyLoadWhere } from '@/lib/temix-daily-apply';
import { withAuditMaintenance, purgeAuditLog, purgeCustomerEdits } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_TEMIX_DAILY_APPLY === '1' && !!process.env.DATABASE_URL;

const h = vi.hoisted(() => ({ failing: new Set<string>() }));
type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
// The one route writer, failing on the shops named in h.failing (a fault that is not a conflict).
vi.mock('@/lib/temix-daily-move', async (orig) => {
  const real = await orig<typeof import('@/lib/temix-daily-move')>();
  return {
    ...real,
    moveShopToRoute: async (...args: Parameters<typeof real.moveShopToRoute>) => {
      if (h.failing.has(args[2].id)) throw new Error('synthetic failure (test)');
      return real.moveShopToRoute(...args);
    },
  };
});

const HEAD = ['cust_code', 'branch_code', 'cust_name', 'route', 'payment_terms', 'credit_limit', 'payment_term_days', 'status', 'created_date'];
const ARABIC_ONE = String.fromCharCode(0x0661);
const ZWSP = String.fromCharCode(0x200b);

describe.skipIf(!ENABLED)('the daily Temix apply on Postgres: review 2026-11-15', () => {
  let prisma: PrismaClient;
  let apply: typeof import('@/services/temix-daily-apply');
  let upload: typeof import('@/services/temix-daily');
  let status: typeof import('@/lib/service-status');
  let check: { load: typeof import('@/lib/temix-daily-check-load'); run: typeof import('@/lib/temix-daily-check') };
  let w: World;
  let S = '';
  const ids: Record<string, string> = {};
  const files: string[] = [];
  const edits: string[] = [];

  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };
  const fresh = async () => prisma.rateLimit.deleteMany({ where: { key: { contains: w.steward } } });
  const ok = <T,>(res: { ok: boolean }) => {
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return (res as unknown as { data: T }).data;
  };
  type Slice = import('@/services/temix-daily-apply').TemixDailySliceResult;
  const slice = async (fileId: string, leaseToken?: string) => {
    await fresh();
    return ok<Slice>(await apply.runTemixDailySliceAction(form({ fileId, ...(leaseToken ? { leaseToken } : {}) })));
  };
  const shopRoute = async (id: string) => (await prisma.branch.findUniqueOrThrow({ where: { id }, select: { routeId: true } })).routeId;
  const failures = (fileId: string) =>
    prisma.auditLog.count({ where: { entityType: 'TemixDailyFile', entityId: fileId, after: { path: ['kind'], equals: 'TEMIX_DAILY_GROUP_FAILED' } } });

  beforeAll(async () => {
    assertNotProductionEnv();
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    apply = await import('@/services/temix-daily-apply');
    upload = await import('@/services/temix-daily');
    status = await import('@/lib/service-status');
    check = { load: await import('@/lib/temix-daily-check-load'), run: await import('@/lib/temix-daily-check') };
    w = await buildWorld(prisma, 'temixrv');
    S = w.sfx.toUpperCase();
    const db = contextClient(prisma, { actorId: null, source: src.test('temix-daily-apply-review') });
    const r2 = await db.route.create({ data: { code: `${S}R2`, name: 'ZZ R2', regionId: w.regionA } });
    w.routes.push(r2.id);
    ids.R2 = r2.id;
    const customer = async (key: string, nmwcCode: string) => {
      const c = await db.customer.create({ data: { nmwcCode, legalName: `ZZ ${key}`, paymentTerms: 'CASH' } });
      w.customers.push(c.id);
      ids[key] = c.id;
    };
    const shop = async (key: string, customerKey: string, code: string) => {
      const b = await db.branch.create({
        data: { customerId: ids[customerKey]!, branchCode: code, branchName: 'ZZ shop', routeId: w.route, regionId: w.regionA, address: 'ZZ Way 1, synthetic', status: 'ACTIVE' },
      });
      w.branches.push(b.id);
      ids[key] = b.id;
    };
    await customer('CX', `${S}X1`);
    await shop('bX', 'CX', `${S}X1-01`);
    await customer('CXA', `${S}X${ARABIC_ONE}`);
    await customer('CY', `${S}Y1${ZWSP}`);
    await shop('bY', 'CY', `${S}Y1-01`);
    await customer('CZ', `${S}Z1`);
    await shop('bZ', 'CZ', `${S}Z1-01`);
    h.failing.add(ids.bZ!);
  });

  beforeEach(() => {
    current = { id: w.steward, role: 'STEWARD', username: `${w.sfx}.stw` };
  });

  afterAll(async () => {
    h.failing.clear();
    if (!prisma) return;
    if (w) {
      await withAuditMaintenance(prisma, async (tx) => {
        await tx.temixNoticeSeen.deleteMany({ where: { firstFileId: { in: files } } });
        await tx.temixChange.deleteMany({ where: { fileId: { in: files } } });
        await tx.temixDailyRow.deleteMany({ where: { fileId: { in: files } } });
        await tx.temixDailyFile.deleteMany({ where: { id: { in: files } } });
      });
      if (edits.length) await purgeCustomerEdits(prisma, { where: { id: { in: edits } } });
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: w.steward }, { entityId: { in: files } }] } });
      await tearDownWorld(prisma, w, { editIds: edits });
    }
    await prisma.$disconnect();
  });

  let F = '';
  let token: string | undefined;

  it('the preview holds X1 as a duplicate suspect and plans the moves of Y1 and Z1', async () => {
    await fresh();
    const bytes = new TextEncoder().encode(
      [
        HEAD,
        [`${S}X1`, '01', 'Customer X', `${S}R2`, 'CASH', '', '', 'A', ''],
        [`${S}Y1`, '01', 'Customer Y', `${S}R2`, 'CASH', '', '', 'A', ''],
        [`${S}Z1`, '01', 'Customer Z', `${S}R2`, 'CASH', '', '', 'A', ''],
      ]
        .map((r) => r.join(','))
        .join('\r\n')
    );
    const fd = new FormData();
    fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], `${S}-review.csv`, { type: 'text/csv' }));
    F = ok<{ fileId: string }>(await upload.uploadTemixDailyFileAction(fd)).fileId;
    files.push(F);
    const { input } = await check.load.loadCheckInput(prisma, F);
    const plan = check.run.checkDailyFile(input);
    expect(plan.rows.map((p) => [p.custCodeKey?.slice(S.length), p.verdict, p.holds])).toEqual([
      ['X1', 'HELD', ['DUPLICATE_SUSPECT']],
      ['Y1', 'WOULD_MOVE', []],
      ['Z1', 'WOULD_MOVE', []],
    ]);
  });

  it('the first slice: X1 stays held, Y1 moves, Z1 fails once and waits', async () => {
    await fresh();
    const started = ok<{ leaseToken: string; figures: { held: number; moves: number } }>(
      await apply.startTemixDailyApplyAction(form({ fileId: F, seenMoves: '2', seenCrossRegion: '0', seenReversals: '0', confirmFigures: '1' }))
    );
    expect(started.figures).toMatchObject({ moves: 2, held: 1 });
    const r = await slice(F, started.leaseToken);
    expect(r).toMatchObject({ applied: 1, held: 1, failed: 1, heldAfterFailures: 0, remaining: 1, done: false });
    token = r.leaseToken;
    const rows = await prisma.temixDailyRow.findMany({ where: { fileId: F }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((x) => [x.outcome, x.holdReasons])).toEqual([
      ['HELD', ['DUPLICATE_SUSPECT']],
      ['APPLIED', []],
      ['PENDING', []],
    ]);
    expect(rows[1]).toMatchObject({ customerId: ids.CY, branchId: ids.bY });
    expect(await shopRoute(ids.bX!)).toBe(w.route); // the duplicate suspect's shop did not move
    expect(await shopRoute(ids.bY!)).toBe(ids.R2);
    expect(await shopRoute(ids.bZ!)).toBe(w.route);
    expect(await prisma.temixChange.findMany({ where: { fileId: F }, select: { branchId: true } })).toEqual([{ branchId: ids.bY }]);
    expect(await failures(F)).toBe(1);
  });

  it('stopped by the pilot rule, the load is held by it on /status, not stuck; stuck again once the request is decided', async () => {
    const e = await contextClient(prisma, { actorId: w.salesman, source: src.test('temix-daily-apply-review') }).customerEdit.create({
      data: {
        target: 'CUSTOMER',
        state: 'SUBMITTED',
        submittedById: w.salesman,
        submittedAt: new Date(),
        process: 'CREATE',
        pendingRole: 'ACCOUNTANT',
        fieldChanges: [] as never,
        attachmentChanges: [] as never,
      },
    });
    edits.push(e.id);
    expect(await slice(F, token)).toMatchObject({ stopped: 'PILOT', remaining: 1 });
    expect(await prisma.temixDailyFile.count({ where: { id: F, ...stalledDailyLoadWhere(new Date()) } })).toBe(1);
    const held = (await status.loadServiceStatus('company')).imports;
    expect(held.stuckDailyLoads).toBe(0);
    expect(held.dailyLoadsHeldByPilot).toBeGreaterThanOrEqual(1);
    await purgeCustomerEdits(prisma, { where: { id: e.id } });
    const after = (await status.loadServiceStatus('company')).imports;
    expect(after.dailyLoadsHeldByPilot).toBe(0);
    expect(after.stuckDailyLoads).toBeGreaterThanOrEqual(1);
    expect(after.status).toBe('breached');
  });

  it('Z1 fails twice more: at the third its row is HELD APPLY_FAILED and the file loads', async () => {
    const second = await slice(F);
    expect(second).toMatchObject({ applied: 0, failed: 1, heldAfterFailures: 0, remaining: 1, done: false });
    expect(await failures(F)).toBe(2);
    const third = await slice(F, second.leaseToken);
    expect(third).toMatchObject({ failed: 1, heldAfterFailures: 1, held: 1, done: true, state: 'LOADED' });
    expect(await failures(F)).toBe(3);
    const z = await prisma.temixDailyRow.findFirstOrThrow({ where: { fileId: F, rowNumber: 4 } });
    expect(z).toMatchObject({ outcome: 'HELD', holdReasons: ['APPLY_FAILED'] });
    expect(z.doneAt).not.toBeNull();
    expect(await shopRoute(ids.bZ!)).toBe(w.route);
    // The figures the Steward confirmed (held 1) plus the one customer that kept failing.
    expect(await prisma.temixDailyFile.findUniqueOrThrow({ where: { id: F } })).toMatchObject({
      state: 'LOADED',
      appliedRows: 1,
      noChangeRows: 0,
      heldRows: 2,
      applyLeaseBy: null,
    });
    // The failure audit rows name the group and the error's class, never its message.
    const a = await prisma.auditLog.findMany({ where: { entityType: 'TemixDailyFile', entityId: F, after: { path: ['kind'], equals: 'TEMIX_DAILY_GROUP_FAILED' } } });
    expect(a.map((x) => x.after)).toEqual(Array(3).fill({ kind: 'TEMIX_DAILY_GROUP_FAILED', group: `${S}Z1`, error: 'Error' }));
    expect(a.every((x) => x.source === `temix-daily:${F}:${S}Z1`)).toBe(true);
    // A later file is no longer stopped behind it.
    expect(await prisma.temixDailyFile.count({ where: { id: F, ...stalledDailyLoadWhere(new Date()) } })).toBe(0);
  });
});
