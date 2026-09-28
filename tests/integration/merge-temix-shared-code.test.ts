// @vitest-environment node
/**
 * F11 against real Postgres: merging two customers that carry the SAME Temix
 * code no longer queues the surviving identity for deactivation.
 *
 * Before: the loser went DEACTIVATE_PENDING (resolveArchiveTemixState saw a
 * code) while the winner was re-queued PENDING_UPLOAD, so the next batch held
 * `UPSERT T` and `DEACTIVATE T` — and whichever Temix applied last won.
 *
 * The queue is read here with the batch's own predicate (TEMIX_QUEUE_WHERE) and
 * shaped with the batch's own buildTemixRows, restricted to this test's rows.
 * Generating a real batch would flip every queued customer in the shared test
 * database; the generate path's hold-back is covered in
 * tests/unit/temix-service.test.ts.
 *
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/merge-temix-shared-code.test.ts
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

describe.skipIf(!ENABLED)('F11: a same-code merge keeps the surviving Temix identity', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let dups: typeof import('@/services/duplicates');
  let temix: typeof import('@/lib/temix');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZF11-${tag}`;
  const steward = `${P}-stew`;
  let regionId = '';
  let routeId = '';

  const customer = async (suffix: string, temixCode: string | null) => {
    const c = await prisma.customer.create({
      data: { nmwcCode: `${P}-${suffix}`, legalName: `ZZ F11 ${suffix}`, temixCode, temixSyncState: 'SYNCED' },
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
  const merge = (winnerId: string, loserId: string) => {
    const fd = new FormData();
    fd.set('winnerId', winnerId);
    fd.set('loserId', loserId);
    return dups.mergeCustomersAction(fd);
  };
  const queueRows = async (ids: string[]) => {
    const queued = await prisma.customer.findMany({
      where: { AND: [temix.TEMIX_QUEUE_WHERE, { id: { in: ids } }] },
      select: {
        id: true, nmwcCode: true, temixCode: true, legalName: true, paymentTerms: true, creditLimit: true,
        paymentTermDays: true, crNumber: true, primaryPhone: true, altPhone: true, contactPerson: true,
        deletedAt: true, channel: { select: { label: true } }, subChannel: { select: { label: true } },
        branches: {
          select: {
            branchCode: true, branchName: true, address: true, dayOfVisit: true, gpsLat: true, gpsLng: true,
            deletedAt: true, region: { select: { name: true, code: true } }, route: { select: { code: true } },
          },
        },
      },
      orderBy: { nmwcCode: 'asc' },
    });
    return temix.buildTemixRows(queued.map((c) => ({ ...c, guaranteeDocs: 0 })), 'check');
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    dups = await import('@/services/duplicates');
    temix = await import('@/lib/temix');
    regionId = (await prisma.region.create({ data: { code: `${P}R`, name: `ZZ F11 ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: `${P}-RT`, name: `ZZ F11 ${tag}`, regionId } })).id;
    await prisma.user.create({
      data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ F11 Steward', role: 'STEWARD' },
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

  it('same code: the loser leaves the queue, the winner is the one UPSERT, and the MERGE row says why', async () => {
    const code = `${P}-T1`;
    const W = await customer('W', code);
    const L = await customer('L', code);
    const res = await merge(W.id, L.id);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const loser = await prisma.customer.findUniqueOrThrow({ where: { id: L.id } });
    expect(loser.deletedAt).not.toBeNull();
    expect(loser.temixSyncState).toBe('SYNCED');
    expect(loser.temixSyncPendingSince).toBeNull();
    const winner = await prisma.customer.findUniqueOrThrow({ where: { id: W.id } });
    expect(winner.temixSyncState).toBe('PENDING_UPLOAD');

    const rows = await queueRows([W.id, L.id]);
    expect(rows.filter((r) => r.sync_action === 'DEACTIVATE')).toEqual([]);
    expect(new Set(rows.map((r) => `${r.sync_action}:${r.temix_code}`))).toEqual(new Set([`UPSERT:${code}`]));

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: steward, action: 'MERGE', entityId: W.id },
      orderBy: { at: 'desc' },
    });
    expect(audit.after).toEqual({ temixDeactivation: 'skipped-shared-code', temixCodeHeldBy: [W.nmwcCode] });
  });

  it("crossed identities (the loser's Temix code is the winner's customer code): refused, nothing moved", async () => {
    const X = await customer('X', null);
    const Y = await customer('Y', `${P}-X`);
    const res = await merge(X.id, Y.id);
    expect(res.ok).toBe(false);
    const both = await prisma.customer.findMany({ where: { id: { in: [X.id, Y.id] } } });
    expect(both.every((c) => c.deletedAt === null)).toBe(true);
    expect(await prisma.branch.count({ where: { customerId: Y.id, deletedAt: null } })).toBe(1);
  });

  it('different codes: the loser is still queued for deactivation', async () => {
    const A = await customer('A', `${P}-TA`);
    const B = await customer('B', `${P}-TB`);
    const res = await merge(A.id, B.id);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const loser = await prisma.customer.findUniqueOrThrow({ where: { id: B.id } });
    expect(loser.temixSyncState).toBe('DEACTIVATE_PENDING');
  });
});
