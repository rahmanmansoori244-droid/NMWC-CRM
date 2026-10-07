// @vitest-environment node
/**
 * F10, X-STATUS-1 and F13 (reactivation reject) against a real Postgres, through
 * the real services: what only SQL can prove.
 *
 *  F10  A close or reactivation request is approved on the photo it was sent
 *       with. The salesman who took it can remove it after sending (Remove on
 *       the photo); the approval must then be refused, the branch left as it
 *       was, and the request still rejectable. A photo taken three days before
 *       the approval still approves: the 24-hour rule is a submit-time rule.
 *       And the check is race-free: a removal that commits while the approval
 *       waits on the customer's row lock is seen by it.
 *  X-STATUS-1  A reactivation whose branch was removed, reopened, or whose
 *       customer was archived while it waited is refused, and writes nothing.
 *  F13  A reactivation rejection whose audit row cannot be written leaves the
 *       request pending: the decision and its audit row are one commit.
 *
 * GATED: writes only rows it creates (prefix ZZSE-) and deletes them after.
 * Never production.
 *
 *   RUN_STATUS_EVIDENCE=1 DATABASE_URL=… DIRECT_URL=… \
 *     npx vitest run tests/integration/status-evidence.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const ENABLED = process.env.RUN_STATUS_EVIDENCE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const tag = randomUUID().slice(0, 8);
const P = `ZZSE-${tag}`;
const ids = {
  region: `${P}-region`,
  route: `${P}-route`,
  sup: `${P}-sup`,
  sales: `${P}-sales`,
  other: `${P}-other`,
  mgr: `${P}-mgr`,
  customer: `${P}-cust`,
  b1: `${P}-b1`,
  b2: `${P}-b2`,
};

const as = (id: string, role: string) => {
  current = { id, role, username: id };
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
type Result = { ok: boolean; code?: string; message?: string; data?: { editId: string } };

describe.skipIf(!ENABLED)('status evidence at decision time (F10, X-STATUS-1, F13)', () => {
  let prisma: PrismaClient;
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');
  let photos: typeof import('@/services/photos');

  beforeAll(async () => {
    for (const url of [process.env.DATABASE_URL, process.env.DIRECT_URL]) {
      if ((url ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    }
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    reacts = await import('@/services/reactivations');
    photos = await import('@/services/photos');

    await prisma.region.create({ data: { id: ids.region, code: `${P}-R`, name: `${P} Region` } });
    await prisma.route.create({ data: { id: ids.route, code: `${P}-RT`, name: `${P} Route`, regionId: ids.region } });
    await prisma.user.create({ data: { id: ids.sup, username: ids.sup, passwordHash: 'x', fullName: 'ZZ Sup', role: 'SUPERVISOR' } });
    await prisma.user.create({
      data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Sales', role: 'SALESMAN', ownedRouteId: ids.route, supervisorId: ids.sup },
    });
    await prisma.user.create({ data: { id: ids.other, username: ids.other, passwordHash: 'x', fullName: 'ZZ Other', role: 'SALESMAN', supervisorId: ids.sup } });
    await prisma.user.create({
      data: { id: ids.mgr, username: ids.mgr, passwordHash: 'x', fullName: 'ZZ Mgr', role: 'MANAGER', managedRegions: { connect: { id: ids.region } } },
    });
    await prisma.customer.create({ data: { id: ids.customer, nmwcCode: `${P}-C`, legalName: 'ZZ Evidence Co', paymentTerms: 'CASH' } });
    for (const [id, n] of [[ids.b1, '01'], [ids.b2, '02']] as const) {
      await prisma.branch.create({
        data: { id, customerId: ids.customer, branchCode: `${P}-B-${n}`, branchName: `ZZ Branch ${n}`, regionId: ids.region, routeId: ids.route, address: 'ZZ Way 1, Muscat' },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const users = [ids.sup, ids.sales, ids.other, ids.mgr];
      const eds = await prisma.customerEdit.findMany({ where: { customerId: ids.customer }, select: { id: true } });
      const editIds = eds.map((e) => e.id);
      await prisma.notification.deleteMany({ where: { OR: [{ editId: { in: editIds } }, { userId: { in: users } }] } });
      if (editIds.length) {
        await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
        await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      }
      await purgeAuditLog(prisma, { where: { actorId: { in: users } } });
      await prisma.attachment.deleteMany({ where: { capturedById: { in: users } } });
      await prisma.branch.deleteMany({ where: { customerId: ids.customer } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  /** One open request per customer: clear the last test's before the next. */
  async function clearEdits() {
    const rows = await prisma.customerEdit.findMany({ where: { customerId: ids.customer }, select: { id: true } });
    const editIds = rows.map((r) => r.id);
    if (!editIds.length) return;
    await prisma.notification.deleteMany({ where: { editId: { in: editIds } } });
    await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
    await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
  }

  beforeEach(async () => {
    await clearEdits();
    await prisma.customer.update({ where: { id: ids.customer }, data: { deletedAt: null, status: 'ACTIVE' } });
    await prisma.branch.updateMany({
      where: { customerId: ids.customer },
      data: { deletedAt: null, status: 'ACTIVE', lastStatusChangeAt: new Date(Date.now() - 2 * DAY) },
    });
  });

  /** A photo as the FREE slot leaves it: on the branch as an extra, captured now. */
  async function photo(over: { capturedById?: string; branchId?: string } = {}) {
    const branchId = over.branchId ?? ids.b1;
    return prisma.attachment.create({
      data: {
        kind: 'FREE',
        r2Key: `zz/${P}/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById: over.capturedById ?? ids.sales,
        capturedAt: new Date(),
        branchId,
        branchExtraId: branchId,
      },
    });
  }

  async function sendClose(attachmentId: string): Promise<string> {
    as(ids.sales, 'SALESMAN');
    const res = (await reacts.markBranchClosedAction(
      form({ branchId: ids.b1, reason: 'Shop shut permanently — seen today.', attachmentId })
    )) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId;
  }

  async function sendReactivation(attachmentId: string): Promise<string> {
    await prisma.branch.update({ where: { id: ids.b1 }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 2 * DAY) } });
    as(ids.sales, 'SALESMAN');
    const res = (await reacts.requestReactivationAction(
      form({ branchId: ids.b1, reason: 'Open again under the same owner.', attachmentId })
    )) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res.data!.editId;
  }

  async function removeAsSalesman(attachmentId: string) {
    as(ids.sales, 'SALESMAN');
    const res = (await photos.detachPhotoAction({ attachmentId })) as Result;
    expect(res.ok, JSON.stringify(res)).toBe(true);
  }

  /** From a freshly loaded review page: every approval sends its decision token (N01). */
  const approveClose = async (editId: string) => {
    as(ids.sup, 'SUPERVISOR');
    const decisionToken = await freshDecisionToken(prisma, editId);
    return (await edits.approveEditAction(form({ editId, decisionToken }))) as Result;
  };
  const approveReactivation = (editId: string) => {
    as(ids.mgr, 'MANAGER');
    return reacts.approveReactivationAction(form({ editId })) as Promise<Result>;
  };
  const b1 = () => prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } });
  const editState = async (id: string) => (await prisma.customerEdit.findUniqueOrThrow({ where: { id } })).state;

  describe('a close request', () => {
    it('whose photo the salesman removed is refused; nothing is applied; it can still be rejected', async () => {
      const p = await photo();
      const editId = await sendClose(p.id);
      await removeAsSalesman(p.id);

      const res = await approveClose(editId);
      expect(res).toMatchObject({ ok: false, code: 'EVIDENCE_GONE' });
      expect((await b1()).status).toBe('ACTIVE');
      expect(await editState(editId)).toBe('SUBMITTED');
      expect(await prisma.editApproval.count({ where: { editId } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'APPROVE', entityId: editId } })).toBe(0);

      as(ids.sup, 'SUPERVISOR');
      const rejected = (await edits.rejectEditAction(
        form({
          editId,
          reason: 'Photo removed — send it again.',
          category: 'other',
          decisionToken: await freshDecisionToken(prisma, editId),
        })
      )) as Result;
      expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
      // A refused close and a "Keep closed" are final since 2026-10-07 (REJECTED).
      expect(await editState(editId)).toBe('REJECTED');
    });

    it('whose photo was taken three days before the approval still closes the branch', async () => {
      const p = await photo();
      const editId = await sendClose(p.id);
      await prisma.attachment.update({ where: { id: p.id }, data: { capturedAt: new Date(Date.now() - 3 * DAY) } });
      const res = await approveClose(editId);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect((await b1()).status).toBe('CLOSED');
    });

    it.each([
      ['captured by another salesman', () => photo({ capturedById: ids.other })],
      ['attached to a sibling branch', () => photo({ branchId: ids.b2 })],
    ])('carrying a photo %s is refused', async (_n, make) => {
      const p = await make();
      const sentAt = new Date();
      const edit = await prisma.customerEdit.create({
        data: {
          target: 'BRANCH',
          branchId: ids.b1,
          customerId: ids.customer,
          state: 'SUBMITTED',
          submittedById: ids.sales,
          submittedAt: sentAt,
          stageEnteredAt: sentAt,
          pendingRole: 'SUPERVISOR',
          decisionReason: 'Shop shut permanently — seen today.',
          fieldChanges: [{ field: `branch.${ids.b1}.status`, before: 'ACTIVE', after: 'CLOSED' }],
          attachmentChanges: [{ kind: 'FREE', attachmentId: p.id, action: 'EVIDENCE' }],
        },
      });
      expect(await approveClose(edit.id)).toMatchObject({ ok: false, code: 'EVIDENCE_GONE' });
      expect((await b1()).status).toBe('ACTIVE');
      expect(await editState(edit.id)).toBe('SUBMITTED');
    });

    it('a removal that commits while the approval waits on the customer lock is seen by it', async () => {
      const p = await photo();
      const editId = await sendClose(p.id);

      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Connection A: holds the customer's row lock — as Remove does — until the
      // approval is queued behind it, then removes the photo and commits.
      const holder = prisma.$transaction(
        async (t) => {
          await t.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${ids.customer} FOR UPDATE`;
          locked();
          await gate;
          await t.attachment.update({ where: { id: p.id }, data: { deletedAt: new Date(), hash: null } });
        },
        { timeout: 60_000, maxWait: 10_000 }
      );
      await isLocked;
      // Connection B: the approval, which must wait for the lock.
      const approving = approveClose(editId);
      let waited = false;
      for (let i = 0; i < 200 && !waited; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
        waited = (rows[0]?.n ?? 0) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 50));
      }
      release();
      await holder;
      const res = await approving;

      expect(waited, 'the approval queued behind the lock').toBe(true);
      expect(res).toMatchObject({ ok: false, code: 'EVIDENCE_GONE' });
      expect((await b1()).status).toBe('ACTIVE');
      expect(await editState(editId)).toBe('SUBMITTED');
    });
  });

  describe('a reactivation', () => {
    it('whose photo the salesman removed is refused; the branch stays closed; it can still be rejected', async () => {
      const t0 = new Date();
      const p = await photo();
      const editId = await sendReactivation(p.id);
      await removeAsSalesman(p.id);

      expect(await approveReactivation(editId)).toMatchObject({ ok: false, code: 'EVIDENCE_GONE' });
      expect((await b1()).status).toBe('CLOSED');
      expect(await editState(editId)).toBe('SUBMITTED');
      expect(await prisma.auditLog.count({ where: { action: 'REACTIVATE', entityId: ids.b1, at: { gte: t0 } } })).toBe(0);

      as(ids.mgr, 'MANAGER');
      const rejected = (await reacts.rejectReactivationAction(
        form({ editId, reason: 'Photo removed — send it again.' })
      )) as Result;
      expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
      // A refused close and a "Keep closed" are final since 2026-10-07 (REJECTED).
      expect(await editState(editId)).toBe('REJECTED');
      expect(await prisma.auditLog.count({ where: { action: 'REJECT', entityId: editId } })).toBe(1);
    });

    it('whose photo was taken three days before the approval still reopens the branch', async () => {
      const p = await photo();
      const editId = await sendReactivation(p.id);
      await prisma.attachment.update({ where: { id: p.id }, data: { capturedAt: new Date(Date.now() - 3 * DAY) } });
      const res = await approveReactivation(editId);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect((await b1()).status).toBe('ACTIVE');
    });

    it('whose branch was reopened while it waited is refused, with no REACTIVATE row (X-STATUS-1)', async () => {
      const t0 = new Date();
      const editId = await sendReactivation((await photo()).id);
      await prisma.branch.update({ where: { id: ids.b1 }, data: { status: 'ACTIVE' } });
      expect(await approveReactivation(editId)).toMatchObject({ ok: false, code: 'STATE_CHANGED' });
      expect(await editState(editId)).toBe('SUBMITTED');
      expect(await prisma.auditLog.count({ where: { action: 'REACTIVATE', entityId: ids.b1, at: { gte: t0 } } })).toBe(0);
    });

    it('whose branch and customer were archived while it waited is refused, and the customer stays archived (X-STATUS-1)', async () => {
      const editId = await sendReactivation((await photo()).id);
      const archivedAt = new Date();
      await prisma.branch.update({ where: { id: ids.b1 }, data: { deletedAt: archivedAt } });
      await prisma.customer.update({ where: { id: ids.customer }, data: { deletedAt: archivedAt, status: 'CLOSED' } });
      expect(await approveReactivation(editId)).toMatchObject({ ok: false, code: 'STATE_CHANGED' });
      const customer = await prisma.customer.findUniqueOrThrow({ where: { id: ids.customer } });
      expect(customer.deletedAt).not.toBeNull();
      expect(customer.status).toBe('CLOSED');
      expect((await b1()).status).toBe('CLOSED');
    });

    it('a rejection whose audit row cannot be written leaves the request pending (F13)', async () => {
      const editId = await sendReactivation((await photo()).id);
      const marker = `${P} audit refused`;
      const fn = `zz_refuse_audit_${tag.replace(/[^a-z0-9]/gi, '')}`;
      // DDL as the owner: the runtime role cannot create triggers.
      const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
      try {
        await owner.$executeRawUnsafe(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
           BEGIN
             IF NEW."reason" = '${marker}' THEN RAISE EXCEPTION 'zz: audit insert refused'; END IF;
             RETURN NEW;
           END $f$`
        );
        await owner.$executeRawUnsafe(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`
        );
        as(ids.mgr, 'MANAGER');
        const res = await reacts
          .rejectReactivationAction(form({ editId, reason: marker }))
          .catch((e: unknown) => ({ ok: false, thrown: e }));
        expect(res.ok).toBe(false);
        // Before F13 the claim had committed on its own: NEEDS_CORRECTION, no audit row.
        expect(await editState(editId)).toBe('SUBMITTED');
      } finally {
        await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "AuditLog"`);
        await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
        await owner.$disconnect();
      }
      as(ids.mgr, 'MANAGER');
      const again = (await reacts.rejectReactivationAction(form({ editId, reason: 'Still shut — shutters down.' }))) as Result;
      expect(again.ok, JSON.stringify(again)).toBe(true);
      // A refused close and a "Keep closed" are final since 2026-10-07 (REJECTED).
      expect(await editState(editId)).toBe('REJECTED');
    });
  });
});
