// @vitest-environment node
/**
 * F11, the archive path, against real Postgres: archiving one of two live
 * customers that share a Temix code no longer queues that code's deactivation.
 *
 * Before: the archive asked resolveArchiveTemixState alone, so the archived
 * customer went DEACTIVATE_PENDING while the other still held the code, and
 * Generate held it back on every run, for good. Now it is parked SYNCED with
 * temixDeactivation 'skipped-shared-code' in the SOFT_DELETE row, and the last
 * live holder archived is the one that deactivates the code. Archive locks the
 * code's live holders first (lib/locks.ts), so two holders archived at once
 * still deactivate the code exactly once: the two-connection case below holds
 * both rows locked until both archives are waiting on that lock.
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

  it('the first holder archived leaves the queue and says why; the last one archived deactivates the code', async () => {
    const code = `${P}-T1`;
    const A = await customer('A', code);
    const B = await customer('B', code);

    const first = await archive(B.id);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const b = await prisma.customer.findUniqueOrThrow({ where: { id: B.id } });
    expect(b.deletedAt).not.toBeNull();
    expect(b.temixSyncState).toBe('SYNCED');
    expect(b.temixSyncPendingSince).toBeNull();
    expect(await deactivations([A.id, B.id])).toEqual([]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: steward, action: 'SOFT_DELETE', entityId: B.id },
    });
    expect(audit.after).toEqual({
      temixSyncState: 'SYNCED',
      temixDeactivation: 'skipped-shared-code',
      temixCodeHeldBy: [A.nmwcCode],
    });

    const last = await archive(A.id);
    expect(last.ok, JSON.stringify(last)).toBe(true);
    const a = await prisma.customer.findUniqueOrThrow({ where: { id: A.id } });
    expect(a.temixSyncState).toBe('DEACTIVATE_PENDING');
    expect(await deactivations([A.id, B.id])).toEqual([{ temixCode: code }]);
  });

  it('two connections: both holders archived at once deactivate the code exactly once', async () => {
    const code = `${P}-T2`;
    const C = await customer('C', code);
    const D = await customer('D', code);

    let archiving: Promise<Array<Awaited<ReturnType<typeof archive>>>> | undefined;
    await prisma.$transaction(
      async (tx) => {
        // A third connection holds both rows, so each archive has read the other
        // as live before either can decide.
        await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" IN (${C.id}, ${D.id}) FOR UPDATE`;
        archiving = Promise.all([archive(C.id), archive(D.id)]);
        archiving.catch(() => undefined);
        // Wait until both archives are blocked on the holders lock, by its code.
        let waiting = 0;
        for (let i = 0; i < 150 && waiting < 2; i++) {
          const [r] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%"temixCode"%FOR UPDATE%'`;
          waiting = r?.n ?? 0;
          if (waiting < 2) await new Promise((res) => setTimeout(res, 100));
        }
        expect(waiting, 'the archives never waited on the Temix-code holders lock').toBe(2);
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    const results = await archiving!;
    expect(results.map((r) => r.ok), JSON.stringify(results)).toEqual([true, true]);

    const both = await prisma.customer.findMany({ where: { id: { in: [C.id, D.id] } } });
    expect(both.every((c) => c.deletedAt !== null)).toBe(true);
    expect(both.map((c) => c.temixSyncState).sort()).toEqual(['DEACTIVATE_PENDING', 'SYNCED']);
    expect(await deactivations([C.id, D.id])).toEqual([{ temixCode: code }]);
  });
});
