// @vitest-environment node
/**
 * PROMOTE-CHUNKED-RESUME (RK-3) — a real NMWC customer master is ~3,300 rows, which
 * is roughly a thousand per-customer transactions. Over a networked Postgres that is
 * minutes of work, while the serverless function is capped at 60s (vercel.json
 * maxDuration). A single-pass promote therefore could never load the real master: it
 * would be killed part-way, every time.
 *
 * Promote now runs in TIME-BOXED SLICES and the batch is resumed until no CLEAN rows
 * remain. This test pins the contract that makes that safe:
 *
 *   1. a slice stops at its budget and reports {done:false, remaining:n};
 *   2. resuming continues where it stopped — no row is promoted twice, none skipped;
 *   3. the final slice finalises the batch (PROMOTED) with accumulated counters;
 *   4. a live lease blocks a second, concurrent promote of the same batch;
 *   5. an EXPIRED lease does not — a killed worker can never strand a batch.
 *
 * The slice budget is forced to 1ms so every slice promotes exactly one customer,
 * making the multi-slice path deterministic instead of timing-dependent.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/promote-chunked-resume.test.ts
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

const HEADERS = [
  'cust_code',
  'cust_name',
  'branch_code',
  'branch_name',
  'sales_region',
  'route',
  'address',
  'phone',
  'contact_person',
  'cr_no',
  'payment_terms',
] as const;

type SliceResult = {
  promoted: number;
  failed: number;
  remaining: number;
  done: boolean;
  leaseToken?: string;
};

describe.skipIf(!ENABLED)('RK-3: promote is chunked and resumable', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const stewardId = `ZZCH-stew-${tag}`;
  const regionCode = `ZZCHR${tag}`;
  const routeCode = `ZZCHT${tag}`;
  // 5 single-branch customers + 1 two-branch customer = 6 groups over 7 rows.
  const custCodes = [1, 2, 3, 4, 5, 6].map((n) => `ZZCH-${tag}-${n}`);
  const MULTI = custCodes[5]!; // the 2-branch customer
  let regionId = '';
  let routeId = '';
  let batchId = '';
  let leaseBatchId = '';
  const prevBudget = process.env.PROMOTE_SLICE_BUDGET_MS;

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
        fullName: 'ZZ Chunk Steward',
        role: 'STEWARD',
      },
    });
    const region = await prisma.region.create({
      data: { code: regionCode, name: `ZZ Chunk ${tag}` },
    });
    regionId = region.id;
    const route = await prisma.route.create({
      data: { code: routeCode, name: `ZZ Chunk Route ${tag}`, regionId },
    });
    routeId = route.id;
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    if (prevBudget === undefined) delete process.env.PROMOTE_SLICE_BUDGET_MS;
    else process.env.PROMOTE_SLICE_BUDGET_MS = prevBudget;
    // Branches reference Customer/Region/Route; Customer references the batch.
    await prisma.branch.deleteMany({ where: { customer: { nmwcCode: { in: custCodes } } } });
    await prisma.customer.deleteMany({ where: { nmwcCode: { in: custCodes } } });
    const ids = [batchId, leaseBatchId].filter(Boolean);
    if (ids.length) {
      await prisma.importRow.deleteMany({ where: { batchId: { in: ids } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: ids } } });
    }
    if (routeId) await prisma.route.deleteMany({ where: { id: routeId } });
    if (regionId) await prisma.region.deleteMany({ where: { id: regionId } });
    await prisma.auditLog.deleteMany({ where: { actorId: stewardId } });
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  async function upload() {
    const rows: Array<Record<string, string>> = [];
    for (const [i, code] of custCodes.entries()) {
      rows.push({
        cust_code: code,
        cust_name: `ZZ Chunk Co ${i + 1}`,
        branch_code: `${code}-01`,
        branch_name: 'Main',
        sales_region: regionCode,
        route: routeCode,
        address: `Way ${i + 1}, Muscat`,
        phone: `+9689${String(1000000 + i).slice(0, 7)}`,
        contact_person: 'ZZ Contact',
        cr_no: `${8_100_000 + i}`,
        payment_terms: 'CASH',
      });
    }
    // Second branch for the last customer — its two rows must be promoted together
    // in ONE slice, never split across a slice boundary.
    rows.push({
      ...rows[rows.length - 1]!,
      branch_code: `${MULTI}-02`,
      branch_name: 'Second',
      address: 'Way 99, Muscat',
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(HEADERS as unknown as string[]);
    for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const fd = new FormData();
    fd.set(
      'file',
      new File([buf], 'chunk-master.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error('UPLOAD FAILED:', JSON.stringify(res));
    expect(res.ok).toBe(true);
    return (res as { ok: true; data: { batchId: string } }).data.batchId;
  }

  async function promoteOnce(id: string, token = '') {
    const fd = new FormData();
    fd.set('batchId', id);
    if (token) fd.set('leaseToken', token);
    return imports.promoteCustomerBatchAction(fd);
  }

  it('promotes the whole batch across several slices, losing and repeating nothing', async () => {
    batchId = await upload();
    const cleanBefore = await prisma.importRow.count({
      where: { batchId, state: 'CLEAN' },
    });
    expect(cleanBefore).toBe(7); // all 7 rows staged clean

    // One customer per slice.
    process.env.PROMOTE_SLICE_BUDGET_MS = '1';

    let slices = 0;
    let promotedTotal = 0;
    let last: SliceResult | null = null;
    let token = '';
    for (let i = 0; i < 20; i++) {
      const res = await promoteOnce(batchId, token);
      if (!res.ok) throw new Error(`slice ${i} failed: ${JSON.stringify(res)}`);
      last = res.data as SliceResult;
      slices++;
      promotedTotal += last.promoted;
      // Every intermediate slice must hand the batch back cleanly for the next one.
      if (!last.done) {
        const mid = await prisma.importBatch.findUniqueOrThrow({
          where: { id: batchId },
          select: { status: true, promoteLeaseUntil: true, promoteLeaseBy: true },
        });
        expect(mid.status).toBe('PROMOTING');
        // Between slices the run KEEPS a short grace lease (so the batch reads as
        // "in progress", not "interrupted") and hands back the matching token.
        expect(mid.promoteLeaseUntil).not.toBeNull();
        expect(last.leaseToken).toBeTruthy();
        expect(mid.promoteLeaseBy).toBe(last.leaseToken);
        token = last.leaseToken!;
      }
      if (last.done) break;
    }

    expect(last?.done).toBe(true);
    // The point of the whole exercise: this needed MORE THAN ONE pass.
    expect(slices).toBeGreaterThan(1);
    expect(slices).toBe(6); // 6 customer groups, one per slice
    expect(promotedTotal).toBe(7); // all 7 ROWS promoted, none twice
    expect(last?.remaining).toBe(0);

    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { status: true, promotedRows: true, rejectedRows: true, promoteLeaseUntil: true },
    });
    expect(batch.status).toBe('PROMOTED');
    expect(batch.promotedRows).toBe(7); // counters ACCUMULATED across slices
    expect(batch.rejectedRows).toBe(0);
    expect(batch.promoteLeaseUntil).toBeNull();

    // Every customer landed exactly once, with its branches.
    const customers = await prisma.customer.findMany({
      where: { nmwcCode: { in: custCodes } },
      include: { branches: true },
    });
    expect(customers.length).toBe(6);
    for (const c of customers) {
      // Reference data resolved through the per-slice region/route maps, not a
      // query per row — the branch must still land in the REAL region/route.
      for (const b of c.branches) {
        expect(b.regionId).toBe(regionId);
        expect(b.routeId).toBe(routeId);
      }
    }
    // The multi-branch customer's two rows were promoted together, not split.
    const multi = customers.find((c) => c.nmwcCode === MULTI)!;
    expect(multi.branches.length).toBe(2);
    // No CLEAN rows left, and no row was rejected.
    expect(await prisma.importRow.count({ where: { batchId, state: 'CLEAN' } })).toBe(0);
    expect(await prisma.importRow.count({ where: { batchId, state: 'PROMOTED' } })).toBe(7);
  });

  it('a completed batch cannot be promoted again', async () => {
    const res = await promoteOnce(batchId);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/PROMOTED/);
  });

  it('a LIVE lease blocks a concurrent promote; an EXPIRED one does not', async () => {
    const b = await prisma.importBatch.create({
      data: {
        filename: `zz-lease-${tag}.xlsx`,
        kind: 'CUSTOMER',
        uploadedById: stewardId,
        status: 'PROMOTING',
        totalRows: 0,
        promoteLeaseBy: stewardId,
        promoteLeaseUntil: new Date(Date.now() + 60_000), // held, not expired
      },
    });
    leaseBatchId = b.id;

    const blocked = await promoteOnce(leaseBatchId);
    expect(blocked.ok).toBe(false);
    expect(JSON.stringify(blocked)).toMatch(/being promoted right now/);

    // A STALE token must not open the door either — otherwise a worker whose lease
    // was taken over could barge back in and break mutual exclusion.
    const stale = await promoteOnce(leaseBatchId, `${stewardId}:stale-token`);
    expect(stale.ok).toBe(false);
    // …and the rightful holder's lease is untouched by the rejected attempt.
    const held = await prisma.importBatch.findUniqueOrThrow({
      where: { id: leaseBatchId },
      select: { promoteLeaseBy: true },
    });
    expect(held.promoteLeaseBy).toBe(stewardId);

    // Simulate the holder being killed mid-slice: its lease simply ages out.
    await prisma.importBatch.update({
      where: { id: leaseBatchId },
      data: { promoteLeaseUntil: new Date(Date.now() - 1_000) },
    });
    const resumed = await promoteOnce(leaseBatchId);
    expect(resumed.ok).toBe(true);
    expect((resumed as { ok: true; data: SliceResult }).data.done).toBe(true);
  });
});
