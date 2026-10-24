// @vitest-environment node
/**
 * Gap 37 on Postgres: archiving a customer closes its unsent drafts and lists
 * what it left, and a request can no longer land on a customer archived a
 * moment earlier.
 *
 *   - the archive closes the customer's DRAFT requests (REJECTED, withdrawn,
 *     the decision fields naming the Steward, one UPDATE audit row each), leaves
 *     its NEEDS_CORRECTION ones as they are, and its SOFT_DELETE row lists both;
 *   - two connections, the submit first: a transaction holding the customer's
 *     lock (lockLiveCustomer, as every request insert takes it) writes a
 *     SUBMITTED request while the archive waits on the same lock; the archive
 *     then sees it and refuses (EDIT_OPEN);
 *   - the archive first: a request transaction started after it is refused
 *     (lockLiveCustomer reads the archived row), and nothing is written.
 *
 * Synthetic ZZ rows only, removed in the owner's maintenance window (requests
 * and audit rows are append-only). Aborts on the production endpoint.
 *
 *   RUN_ARCHIVE_REQUESTS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/archive-open-requests.test.ts
 *
 * Written with the audit-gaps branch; NOT run there (no database was used).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { src, withChangeContext } from '@/lib/change-context';
import { purgeAuditLog, purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ENABLED = process.env.RUN_ARCHIVE_REQUESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('gap 37: open requests when a customer is archived', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let customers: typeof import('@/services/customers');
  let locks: typeof import('@/lib/locks');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZAOR-${tag}`;
  const steward = `${P}-stew`;
  const salesman = `${P}-sm`;
  let regionId = '';
  let routeId = '';
  const editIds: string[] = [];

  const customer = async (suffix: string) => {
    const c = await prisma.customer.create({ data: { nmwcCode: `${P}-${suffix}`, legalName: `ZZ AOR ${suffix}`, temixSyncState: 'SYNCED' } });
    await prisma.branch.create({
      data: { customerId: c.id, branchCode: `${P}-${suffix}-01`, branchName: 'ZZ', address: `Way ${suffix}, ZZ`, regionId, routeId },
    });
    return c;
  };
  const request = async (customerId: string, state: 'DRAFT' | 'NEEDS_CORRECTION' | 'SUBMITTED') => {
    const e = await withChangeContext(prisma, { actorId: salesman, source: src.test('archive-open-requests') }, (tx) =>
      tx.customerEdit.create({
        data: {
          target: 'CUSTOMER',
          customerId,
          submittedById: salesman,
          state,
          submittedAt: state === 'DRAFT' ? null : new Date(),
          fieldChanges: [{ field: 'customer.contactPerson', before: null, after: 'ZZ' }],
          attachmentChanges: [],
        },
      })
    );
    editIds.push(e.id);
    return e;
  };
  const archive = (id: string) => {
    const fd = new FormData();
    fd.set('customerId', id);
    fd.set('reason', 'ZZ gap 37 archive test');
    return customers.archiveCustomerAction(fd);
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    customers = await import('@/services/customers');
    locks = await import('@/lib/locks');
    regionId = (await prisma.region.create({ data: { code: `${P}R`, name: `ZZ AOR ${tag}` } })).id;
    routeId = (await prisma.route.create({ data: { code: `${P}-RT`, name: `ZZ AOR ${tag}`, regionId } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ AOR Steward', role: 'STEWARD' } });
    await prisma.user.create({ data: { id: salesman, username: salesman, passwordHash: 'x', fullName: 'ZZ AOR Salesman', role: 'SALESMAN' } });
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: [steward, salesman] } }, { entityId: { in: [...ids, ...editIds] } }] } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: { in: [steward, salesman] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('closes the unsent drafts with a row each, leaves the sent-back ones, and lists both on the SOFT_DELETE row', async () => {
    const c = await customer('A');
    const draft = await request(c.id, 'DRAFT');
    const back = await request(c.id, 'NEEDS_CORRECTION');
    const res = await archive(c.id);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const d = await prisma.customerEdit.findUniqueOrThrow({ where: { id: draft.id } });
    expect(d).toMatchObject({ state: 'REJECTED', decisionCategory: 'withdrawn', reviewedById: steward, pendingRole: null });
    expect(d.decisionReason).toMatch(/archived/);
    expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: back.id } })).state).toBe('NEEDS_CORRECTION');

    const rows = await prisma.auditLog.findMany({ where: { actorId: steward, entityId: { in: [draft.id, back.id, c.id] } }, orderBy: { at: 'asc' } });
    expect(rows.map((r) => [r.action, r.entityId])).toEqual([
      ['UPDATE', draft.id],
      ['SOFT_DELETE', c.id],
    ]);
    expect(rows[0]!.after).toMatchObject({ state: 'REJECTED', from: 'DRAFT', closedBy: 'archive', customerId: c.id });
    expect((rows[1]!.after as { openRequests: unknown }).openRequests).toEqual({
      closedDrafts: [draft.id],
      closedDraftCount: 1,
      sentBack: [back.id],
      sentBackCount: 1,
    });
  });

  it('two connections, the submit first: the archive waits on the customer lock, then sees the request and refuses', async () => {
    const c = await customer('B');
    let archiving: ReturnType<typeof archive> | undefined;
    await withChangeContext(
      prisma,
      { actorId: salesman, source: src.test('archive-open-requests') },
      async (tx) => {
        await locks.lockLiveCustomer(tx, c.id);
        archiving = archive(c.id);
        archiving.catch(() => undefined);
        // Wait until the archive is blocked on the customer's row lock.
        let waiting = 0;
        for (let i = 0; i < 150 && waiting < 1; i++) {
          const [r] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query LIKE '%"Customer"%FOR UPDATE%'`;
          waiting = r?.n ?? 0;
          if (waiting < 1) await new Promise((res) => setTimeout(res, 100));
        }
        expect(waiting, 'the archive never waited on the customer lock').toBeGreaterThanOrEqual(1);
        const e = await tx.customerEdit.create({
          data: { target: 'CUSTOMER', customerId: c.id, submittedById: salesman, state: 'SUBMITTED', submittedAt: new Date(), fieldChanges: [], attachmentChanges: [] },
        });
        editIds.push(e.id);
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    const res = await archiving!;
    expect(res).toMatchObject({ ok: false, code: 'EDIT_OPEN' });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
  });

  it('the archive first: a request transaction after it is refused, and writes nothing', async () => {
    const c = await customer('C');
    expect((await archive(c.id)).ok).toBe(true);
    const before = await prisma.customerEdit.count({ where: { customerId: c.id } });
    await expect(
      withChangeContext(prisma, { actorId: salesman, source: src.test('archive-open-requests') }, async (tx) => {
        await locks.lockLiveCustomer(tx, c.id);
        await tx.customerEdit.create({
          data: { target: 'CUSTOMER', customerId: c.id, submittedById: salesman, state: 'SUBMITTED', submittedAt: new Date(), fieldChanges: [], attachmentChanges: [] },
        });
      })
    ).rejects.toThrow(locks.CUSTOMER_ARCHIVED_MESSAGE);
    expect(await prisma.customerEdit.count({ where: { customerId: c.id } })).toBe(before);
  });
});
