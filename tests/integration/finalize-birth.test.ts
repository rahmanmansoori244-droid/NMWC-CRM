// @vitest-environment node
/**
 * Gap 27 (data audit 2026-10-10, lossless paths) on Postgres: a new customer's
 * shops get a birth entry.
 *
 *   - at finalize each draft names the shop it became (EditBranchDraft.branchId),
 *     numbered in draft id order;
 *   - each shop has its own CREATE audit row (draft, route, region, visit day,
 *     GPS present, counts, the request it came from);
 *   - the dated history records each shop's CREATE under the request's source,
 *     with the approving Accountant as its actor;
 *   - the request keeps the customer it made as its original customer.
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/finalize-birth.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createFlowFixture } from '../support/create-flow-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const fx = createFlowFixture('zzfb', (u) => {
  current = u;
});

describe.skipIf(!ENABLED)("a new customer's shops are born on the record (gap 27)", () => {
  let prisma: import('@prisma/client').PrismaClient;
  let creates: typeof import('@/services/creates');

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    await fx.setup(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await fx.cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('two shops: each draft names its shop, each shop has its birth row and its history', async () => {
    fx.as(fx.ids.salesman, 'SALESMAN');
    const sent = await creates.submitCreateAction(await fx.cashBody(`ZZ Birth ${fx.tag}`, 31, { branches: 2 }));
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    const editId = sent.data.editId;

    fx.as(fx.ids.supervisor, 'SUPERVISOR');
    expect((await fx.decide('approve', editId)).ok).toBe(true);
    fx.as(fx.ids.accountant, 'ACCOUNTANT');
    const done = await fx.decide('approve', editId, { temixCode: `${fx.TAG}T`.slice(0, 30) });
    expect(done.ok, JSON.stringify(done)).toBe(true);

    const edit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect(edit.state).toBe('APPROVED');
    expect(edit.originalCustomerId).toBe(edit.customerId);

    const drafts = await prisma.editBranchDraft.findMany({ where: { editId }, orderBy: { id: 'asc' } });
    expect(drafts).toHaveLength(2);
    const shops = await prisma.branch.findMany({ where: { customerId: edit.customerId! }, orderBy: { branchCode: 'asc' } });
    // Numbered in draft id order: the first draft is -01.
    expect(drafts.map((d) => d.branchId)).toEqual(shops.map((b) => b.id));
    expect(shops.map((b) => b.branchCode.slice(-3))).toEqual(['-01', '-02']);

    for (const [i, shop] of shops.entries()) {
      const birth = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CREATE', entityType: 'Branch', entityId: shop.id } });
      expect(birth).toMatchObject({ actorId: fx.ids.accountant, source: `edit:${editId}` });
      expect(birth.after).toMatchObject({
        branchCode: shop.branchCode,
        draftId: drafts[i]!.id,
        routeId: fx.ids.route,
        regionId: fx.ids.region,
        dayOfVisit: 'THU',
        gpsPresent: true,
        coolersCount: i + 1,
        viaEditId: editId,
      });
      const history = await prisma.branchHistory.findFirstOrThrow({ where: { branchId: shop.id, changeKind: 'CREATE' } });
      expect(history).toMatchObject({ source: `edit:${editId}`, actorId: fx.ids.accountant, routeId: fx.ids.route });
    }
  });
});
