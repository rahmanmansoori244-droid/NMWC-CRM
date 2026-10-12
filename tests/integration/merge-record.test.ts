// @vitest-environment node
/**
 * Gap 8 (data audit 2026-10-10, lossless paths) on Postgres: a merge says what
 * moved, and where the loser went, without rewriting what its requests were about.
 *
 *   - the loser points at the winner (Customer.mergedIntoId), recorded in its
 *     dated history under the merge's source;
 *   - its shops move with a version bump, and their history says merge:<w>:<l>;
 *   - the MERGE row lists the moved shops, documents and requests, the requests
 *     it closed, and the loser's non-personal standing; the typed reason is kept;
 *   - each request it closed has its own REJECT row;
 *   - a repointed request keeps its originalCustomerId;
 *   - the loser's old page and code lead to the winner (lib/merged-customers.ts).
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/merge-record.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { src, withChangeContext } from '@/lib/change-context';
import { purgeAuditLog, purgeCustomerEdits, purgeHistory } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzmr${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('a merge says what moved (gap 8)', () => {
  let db: PrismaClient;
  const ids = {
    region: `${sfx}-g`,
    route: `${sfx}-r`,
    steward: `${sfx}-st`,
    salesman: `${sfx}-sm`,
    winner: `${sfx}-w`,
    loser: `${sfx}-l`,
    wb: `${sfx}-wb`,
    lb: `${sfx}-lb`,
    doc: `${sfx}-doc`,
    oldEdit: `${sfx}-e-old`,
    openEdit: `${sfx}-e-open`,
  };
  const write = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withChangeContext(db, { actorId: ids.steward, source: src.test('merge-record') }, fn);

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD)) throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
    await write(async (tx) => {
      await tx.region.create({ data: { id: ids.region, code: `G${SFX}`, name: `Merge G ${sfx}` } });
      await tx.route.create({ data: { id: ids.route, code: `R${SFX}`, name: `Merge R ${sfx}`, regionId: ids.region } });
      await tx.user.create({
        data: { id: ids.steward, username: `st.${sfx}`, fullName: `Merge Steward ${sfx}`, role: 'STEWARD', passwordHash: 'x' },
      });
      await tx.user.create({
        data: { id: ids.salesman, username: `sm.${sfx}`, fullName: `Merge Salesman ${sfx}`, role: 'SALESMAN', passwordHash: 'x' },
      });
      await tx.customer.createMany({
        data: [
          { id: ids.winner, nmwcCode: `W${SFX}`, legalName: `Merge winner ${sfx}` },
          { id: ids.loser, nmwcCode: `L${SFX}`, legalName: `Merge loser ${sfx}`, paymentTerms: 'CASH' },
        ],
      });
      await tx.branch.createMany({
        data: [
          [ids.wb, ids.winner, `W${SFX}-01`],
          [ids.lb, ids.loser, `L${SFX}-01`],
        ].map(([id, customerId, code]) => ({
          id: id!,
          customerId: customerId!,
          branchCode: code!,
          branchName: 'Main',
          regionId: ids.region,
          routeId: ids.route,
          address: 'Merge probe address',
        })),
      });
      await tx.attachment.create({
        data: {
          id: ids.doc,
          kind: 'GUARANTEE',
          customerId: ids.loser,
          r2Key: `photos/zz/${ids.doc}.jpg`,
          mimeType: 'image/jpeg',
          bytes: 1,
          capturedById: ids.salesman,
          capturedAt: new Date(),
          hash: 'c'.repeat(64),
        },
      });
    });
    await db.customerEdit.create({
      data: {
        id: ids.oldEdit,
        target: 'CUSTOMER',
        customerId: ids.loser,
        state: 'APPROVED',
        submittedById: ids.salesman,
        submittedAt: new Date(),
        fieldChanges: [],
        attachmentChanges: [],
      },
    });
    await db.customerEdit.create({
      data: {
        id: ids.openEdit,
        target: 'CUSTOMER',
        customerId: ids.loser,
        state: 'SUBMITTED',
        submittedById: ids.salesman,
        submittedAt: new Date(),
        pendingRole: 'SUPERVISOR',
        fieldChanges: [{ field: 'customer.notes', before: null, after: 'x' }],
        attachmentChanges: [],
      },
    });
    current = { id: ids.steward, role: 'STEWARD', username: `st.${sfx}` };
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await purgeCustomerEdits(db, { where: { id: { in: [ids.oldEdit, ids.openEdit] } } });
      await purgeAuditLog(db, { where: { actorId: ids.steward } });
      await db.notification.deleteMany({ where: { userId: { in: [ids.salesman, ids.steward] } } });
      await write(async (tx) => {
        await tx.attachment.deleteMany({ where: { id: ids.doc } });
        await tx.branch.deleteMany({ where: { id: { in: [ids.wb, ids.lb] } } });
        await tx.customer.deleteMany({ where: { id: { in: [ids.winner, ids.loser] } } });
        await tx.user.deleteMany({ where: { id: { in: [ids.steward, ids.salesman] } } });
        await tx.route.deleteMany({ where: { id: ids.route } });
        await tx.region.deleteMany({ where: { id: ids.region } });
      });
      await purgeHistory(db, {
        attachmentIds: [ids.doc],
        customerIds: [ids.winner, ids.loser],
        branchIds: [ids.wb, ids.lb],
        userIds: [ids.steward, ids.salesman],
        routeIds: [ids.route],
        regionIds: [ids.region],
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('the merge records everything it moved, and where the loser went', async () => {
    const before = await db.branch.findUniqueOrThrow({ where: { id: ids.lb } });
    const dups = await import('@/services/duplicates');
    const fd = new FormData();
    fd.set('winnerId', ids.winner);
    fd.set('loserId', ids.loser);
    fd.set('reason', 'Same shop registered twice');
    const res = await dups.mergeCustomersAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const loser = await db.customer.findUniqueOrThrow({ where: { id: ids.loser } });
    expect(loser.mergedIntoId).toBe(ids.winner);
    expect(loser.deletedAt).not.toBeNull();
    const merged = await db.customerHistory.findFirstOrThrow({
      where: { customerId: ids.loser, changedFields: { has: 'mergedIntoId' } },
    });
    expect(merged).toMatchObject({ mergedIntoId: ids.winner, source: `merge:${ids.winner}:${ids.loser}`, actorId: ids.steward });

    const moved = await db.branch.findUniqueOrThrow({ where: { id: ids.lb } });
    expect(moved).toMatchObject({ customerId: ids.winner, version: before.version + 1 });

    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'MERGE', entityId: ids.winner } });
    expect(row.reason).toBe(`Merged L${SFX} into W${SFX}. Same shop registered twice`);
    expect(row.after).toMatchObject({
      movedBranchIds: [ids.lb],
      movedAttachmentIds: [ids.doc],
      repointedEditIds: [ids.oldEdit, ids.openEdit].sort(),
      autoClosedEditIds: [ids.openEdit],
      loserSnapshot: { nmwcCode: `L${SFX}`, paymentTerms: 'CASH' },
    });
    expect(JSON.stringify(row.after)).not.toContain(`Merge loser ${sfx}`);

    const reject = await db.auditLog.findFirstOrThrow({ where: { action: 'REJECT', entityType: 'CustomerEdit', entityId: ids.openEdit } });
    expect(reject.after).toMatchObject({ closedBy: 'merge', loserId: ids.loser, winnerId: ids.winner });

    // The requests now sit on the winner, and still say what they were about.
    for (const id of [ids.oldEdit, ids.openEdit]) {
      expect(await db.customerEdit.findUniqueOrThrow({ where: { id } })).toMatchObject({
        customerId: ids.winner,
        originalCustomerId: ids.loser,
      });
    }
  });

  it("the loser's code and page lead to the winner", async () => {
    const { mergedCodeMatches, survivorOf } = await import('@/lib/merged-customers');
    expect(await survivorOf(db, ids.loser)).toMatchObject({ id: ids.winner, nmwcCode: `W${SFX}` });
    expect(await mergedCodeMatches(db, `l${SFX}`.toLowerCase())).toEqual([
      expect.objectContaining({ id: ids.loser, survivor: expect.objectContaining({ id: ids.winner }) }),
    ]);
  });
});
