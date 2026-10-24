// @vitest-environment node
/**
 * F11, the archive path, against real Postgres: archiving a customer whose
 * Temix identity another live customer still holds no longer queues that code's
 * deactivation.
 *
 * Before: the archive asked resolveArchiveTemixState alone, so the archived
 * customer went DEACTIVATE_PENDING while the other still held the code, and
 * Generate held it back on every run, for good. Now it is parked SYNCED with
 * temixDeactivation 'skipped-shared-code' in the SOFT_DELETE row, and the last
 * live holder archived is the one that deactivates the code.
 *
 * Owner decision 2026-10-25: two live customers can no longer share a Temix
 * code — the database refuses the second (migration
 * 20261025120000_temix_code_unique) — so the shared identity is now the one the
 * index does not cover: a customer with no Temix code, whose deactivation goes
 * out keyed on its customer code (lib/temix.ts deactivationCode), and a live
 * customer holding that code as its Temix code. The two-connection case that
 * archived two holders of one Temix code at once is replaced by the refusal
 * that makes it impossible.
 *
 * The queue is read with the batch's own predicate (TEMIX_QUEUE_WHERE),
 * restricted to this test's rows; generating a real batch would flip every
 * queued customer in the shared test database.
 *
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/archive-temix-shared-code.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_MERGE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('F11: archiving a customer whose Temix code another live customer holds', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let customers: typeof import('@/services/customers');
  let temix: typeof import('@/lib/temix');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZF11A-${tag}`;
  const steward = `${P}-stew`;
  let regionId = '';
  let routeId = '';

  const customer = async (suffix: string, temixCode: string | null) => {
    const c = await prisma.customer.create({
      data: { nmwcCode: `${P}-${suffix}`, legalName: `ZZ F11A ${suffix}`, temixCode, temixSyncState: 'SYNCED' },
    });
    await prisma.branch.create({
      data: {
        customerId: c.id,
        branchCode: `${P}-${suffix}-01`,
        branchName: `ZZ ${suffix}`,
        address: `Way ${suffix}, ZZ`,
        regionId,
        routeId,
      },
    });
    return c;
  };
  const archive = (id: string) => {
    const fd = new FormData();
    fd.set('customerId', id);
    fd.set('reason', 'ZZ F11 archive test');
    return customers.archiveCustomerAction(fd);
  };
  const deactivations = async (ids: string[]) =>
    prisma.customer.findMany({
      where: { AND: [temix.TEMIX_QUEUE_WHERE, { id: { in: ids } }, { deletedAt: { not: null } }] },
      select: { temixCode: true },
    });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    customers = await import('@/services/customers');
    temix = await import('@/lib/temix');
    regionId = (await prisma.region.create({ data: { code: `${P}R`, name: `ZZ F11A ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: `${P}-RT`, name: `ZZ F11A ${tag}`, regionId } })).id;
    await prisma.user.create({
      data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ F11A Steward', role: 'STEWARD' },
    });
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: steward } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: steward } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('the customer leaving first is parked and says why; the last holder archived deactivates the code', async () => {
    // A has no Temix code: its deactivation goes out keyed on its customer code,
    // which B holds as its Temix code.
    const A = await customer('A', null);
    const code = A.nmwcCode;
    const B = await customer('B', code);

    const first = await archive(A.id);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const a = await prisma.customer.findUniqueOrThrow({ where: { id: A.id } });
    expect(a.deletedAt).not.toBeNull();
    expect(a.temixSyncState).toBe('SYNCED');
    expect(a.temixSyncPendingSince).toBeNull();
    expect(await deactivations([A.id, B.id])).toEqual([]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: steward, action: 'SOFT_DELETE', entityId: A.id },
    });
    expect(audit.after).toEqual({
      temixSyncState: 'SYNCED',
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: [B.nmwcCode],
      // Gap 37: the open requests the archive closed or left (none here).
      openRequests: { closedDrafts: [], closedDraftCount: 0, sentBack: [], sentBackCount: 0 },
    });

    const last = await archive(B.id);
    expect(last.ok, JSON.stringify(last)).toBe(true);
    const b = await prisma.customer.findUniqueOrThrow({ where: { id: B.id } });
    expect(b.temixSyncState).toBe('DEACTIVATE_PENDING');
    expect(await deactivations([A.id, B.id])).toEqual([{ temixCode: code }]);
  });

  it('two live holders of one Temix code cannot exist: the database refuses the second, and the one holder deactivates the code once', async () => {
    const code = `${P}-T2`;
    const C = await customer('C', code);
    // Any spelling of it: upper case, the ends trimmed, as the index compares.
    for (const spelling of [code, code.toLowerCase(), ` ${code} `]) {
      await expect(
        prisma.customer.create({ data: { nmwcCode: `${P}-D`, legalName: 'ZZ F11A D', temixCode: spelling, temixSyncState: 'SYNCED' } })
      ).rejects.toMatchObject({ code: 'P2002' });
    }
    expect(await prisma.customer.count({ where: { nmwcCode: `${P}-D` } })).toBe(0);

    const res = await archive(C.id);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: C.id } });
    expect(c.temixSyncState).toBe('DEACTIVATE_PENDING');
    expect(await deactivations([C.id])).toEqual([{ temixCode: code }]);
  });
});
