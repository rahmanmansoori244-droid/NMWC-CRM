// @vitest-environment node
/**
 * PROMOTE-TRANSIENT-DEFER (RK-3, raised by the completeness critic) — the per-group
 * catch used to treat EVERY throw the same way: a CROSSWALK conflict, a P2002
 * duplicate and a P2028 transaction timeout all ended as `state: REJECTED`.
 *
 * That is only safe if failures are about the DATA. Under RK-3 promote is minutes of
 * work across dozens of requests — exactly the window in which a pool timeout, a Neon
 * compute resume or a dropped connection happens — and a REJECTED row leaves CLEAN,
 * so no later slice retries it and no screen requeues it. A database hiccup would
 * therefore have permanently deleted good customers from the load, while the batch
 * still finished PROMOTED and looked healthy.
 *
 * Contract pinned here: an INFRASTRUCTURE failure leaves the group CLEAN (retried by
 * the next slice), never REJECTED; a DATA failure still rejects.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/promote-transient-defer.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

// Fail the next per-customer transaction exactly once, the way a real pool/engine
// fault does. Wrapping the module (rather than vi.spyOn) keeps the client usable —
// a Prisma delegate does not expose its methods as own properties.
let failTransactionOnce = false;
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  const real = actual.prisma;
  const prisma = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === '$transaction' && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (failTransactionOnce) {
            failTransactionOnce = false;
            const err = new Error('Transaction API error: Transaction already closed');
            (err as { code?: string }).code = 'P2028';
            return Promise.reject(err);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...actual, prisma };
});

const HEADERS = [
  'cust_code',
  'cust_name',
  'branch_code',
  'sales_region',
  'route',
  'address',
  'phone',
  'payment_terms',
] as const;

describe.skipIf(!ENABLED)('RK-3: a database hiccup defers a customer, it never rejects it', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const stewardId = `ZZTD-stew-${tag}`;
  const regionCode = `ZZTDR${tag}`;
  const routeCode = `ZZTDT${tag}`;
  const custCodes = [`ZZTD-${tag}-1`, `ZZTD-${tag}-2`];
  let regionId = '';
  let routeId = '';
  let batchId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze'))
      throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await prisma.user.create({
      data: {
        id: stewardId,
        username: stewardId,
        passwordHash: 'x',
        fullName: 'ZZ Transient Steward',
        role: 'STEWARD',
      },
    });
    const region = await prisma.region.create({
      data: { code: regionCode, name: `ZZ Transient ${tag}` },
    });
    regionId = region.id;
    const route = await prisma.route.create({
      data: { code: routeCode, name: `ZZ Transient Route ${tag}`, regionId },
    });
    routeId = route.id;
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.branch.deleteMany({ where: { customer: { nmwcCode: { in: custCodes } } } });
    await prisma.customer.deleteMany({ where: { nmwcCode: { in: custCodes } } });
    if (batchId) {
      await prisma.importRow.deleteMany({ where: { batchId } });
      await prisma.importBatch.deleteMany({ where: { id: batchId } });
    }
    if (routeId) await prisma.route.deleteMany({ where: { id: routeId } });
    if (regionId) await prisma.region.deleteMany({ where: { id: regionId } });
    await prisma.auditLog.deleteMany({ where: { actorId: stewardId } });
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('leaves a transaction-timeout group CLEAN and promotes it on the next slice', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(HEADERS as unknown as string[]);
    for (const [i, code] of custCodes.entries()) {
      ws.addRow([
        code,
        `ZZ Transient Co ${i + 1}`,
        `${code}-01`,
        regionCode,
        routeCode,
        `Way ${i + 1}, Muscat`,
        `+9689${String(2000000 + i).slice(0, 7)}`,
        'CASH',
      ]);
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const fd = new FormData();
    fd.set(
      'file',
      new File([buf], 'transient.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    if (!up.ok) console.error('UPLOAD FAILED:', JSON.stringify(up));
    expect(up.ok).toBe(true);
    batchId = (up as { ok: true; data: { batchId: string } }).data.batchId;
    expect(await prisma.importRow.count({ where: { batchId, state: 'CLEAN' } })).toBe(2);

    // The FIRST customer's transaction fails the way a stalled pool does.
    failTransactionOnce = true;
    const pfd = new FormData();
    pfd.set('batchId', batchId);
    const first = await imports.promoteCustomerBatchAction(pfd);
    if (!first.ok) throw new Error(`slice 1 failed: ${JSON.stringify(first)}`);
    const s1 = first.data as {
      promoted: number;
      failed: number;
      deferred: number;
      remaining: number;
      done: boolean;
      leaseToken?: string;
    };

    // The hiccup is reported as DEFERRED, not failed...
    expect(s1.deferred).toBeGreaterThan(0);
    expect(s1.failed).toBe(0);
    // ...the batch is not finished, because the deferred rows are still to do...
    expect(s1.done).toBe(false);
    expect(s1.remaining).toBeGreaterThan(0);
    // ...and CRITICALLY the group was NOT written off. Nothing is REJECTED.
    expect(await prisma.importRow.count({ where: { batchId, state: 'REJECTED' } })).toBe(0);
    expect(await prisma.importRow.count({ where: { batchId, state: 'CLEAN' } })).toBe(1);

    // The next slice retries it — the customer that hit the hiccup still lands.
    const rfd = new FormData();
    rfd.set('batchId', batchId);
    if (s1.leaseToken) rfd.set('leaseToken', s1.leaseToken);
    const second = await imports.promoteCustomerBatchAction(rfd);
    if (!second.ok) throw new Error(`slice 2 failed: ${JSON.stringify(second)}`);
    expect((second.data as { done: boolean }).done).toBe(true);

    const landed = await prisma.customer.findMany({
      where: { nmwcCode: { in: custCodes } },
      select: { nmwcCode: true },
    });
    // BOTH customers are in the master — the hiccup cost nothing.
    expect(landed.length).toBe(2);
    expect(await prisma.importRow.count({ where: { batchId, state: 'PROMOTED' } })).toBe(2);
    expect(await prisma.importRow.count({ where: { batchId, state: 'REJECTED' } })).toBe(0);

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('PROMOTED');
    expect(batch.promotedRows).toBe(2);
    expect(batch.rejectedRows).toBe(0);
  });
});
