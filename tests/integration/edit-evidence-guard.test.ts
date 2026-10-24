// @vitest-environment node
/**
 * Gaps 8 and 19 (data audit 2026-10-10, lossless paths; migration
 * 20261014100000_lossless_paths) on Postgres: a request, once sent, is evidence.
 *
 *   - once a CustomerEdit has left DRAFT / NEEDS_CORRECTION, what it asked for,
 *     who sent it and when, its chain, its gate and its credit figures can no
 *     longer change; its state, decision, SLA clock and customer still move;
 *   - but its state only forward: a decided request is never reopened, a sent
 *     one goes back to its sender only as NEEDS_CORRECTION (never a DRAFT), and
 *     an open one is approved only once sent — so the freeze cannot be stepped
 *     around by reopening, rewriting and closing again;
 *   - a DRAFT or a request sent back is still free, so a new-customer resubmit
 *     works;
 *   - a request cannot be deleted or truncated outside the owner's maintenance
 *     window — which is what fixture clean-up uses;
 *   - gap 31: a shop (or a customer) a request is about can no longer be
 *     hard-deleted at all: CustomerEdit_branchId_fkey and _customerId_fkey are
 *     RESTRICT now (they were SET NULL), so the request keeps what it is about;
 *   - originalCustomerId is set by the database from the first customer, and a
 *     merge repointing customerId does not move it; one the back-fill could not
 *     know (NULL) stays unknown when the request is repointed;
 *   - the runtime role cannot rewrite or delete a sent request (when NMWC_APP_URL).
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/edit-evidence-guard.test.ts
 *
 * Synthetic ZZ rows only, removed again (history included) in the owner's window.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { src, withChangeContext } from '@/lib/change-context';
import { purgeCustomerEdits, purgeHistory, withAuditMaintenance } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzeg${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();
const REFUSED = /evidence, append-only|append-only|insufficient_privilege|permission denied/;

describe.skipIf(!ENABLED)('a sent request is evidence (gap 19)', () => {
  let db: PrismaClient;
  const ids = {
    region: `${sfx}-g`,
    route: `${sfx}-r`,
    user: `${sfx}-u`,
    c1: `${sfx}-c1`,
    c2: `${sfx}-c2`,
    branch: `${sfx}-b`,
    branch2: `${sfx}-b2`,
  };
  const editIds: string[] = [];
  const write = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withChangeContext(db, { actorId: null, source: src.test('edit-evidence-guard') }, fn);
  const newEdit = async (data: Record<string, unknown>) => {
    const e = await db.customerEdit.create({
      data: {
        target: 'CUSTOMER',
        submittedById: ids.user,
        fieldChanges: [{ field: 'customer.notes', before: null, after: 'x' }],
        attachmentChanges: [],
        ...data,
      } as never,
    });
    editIds.push(e.id);
    return e;
  };

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD)) throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
    await write(async (tx) => {
      await tx.region.create({ data: { id: ids.region, code: `G${SFX}`, name: `Evidence G ${sfx}` } });
      await tx.route.create({ data: { id: ids.route, code: `R${SFX}`, name: `Evidence R ${sfx}`, regionId: ids.region } });
      await tx.user.create({
        data: { id: ids.user, username: `u.${sfx}`, fullName: `Evidence ${sfx}`, role: 'SALESMAN', passwordHash: 'x' },
      });
      await tx.customer.createMany({
        data: [
          { id: ids.c1, nmwcCode: `C1${SFX}`, legalName: `Evidence one ${sfx}` },
          { id: ids.c2, nmwcCode: `C2${SFX}`, legalName: `Evidence two ${sfx}` },
        ],
      });
      await tx.branch.createMany({
        data: [ids.branch, ids.branch2].map((id, i) => ({
          id,
          customerId: ids.c1,
          branchCode: `C1${SFX}-0${i + 1}`,
          branchName: 'Main',
          regionId: ids.region,
          routeId: ids.route,
          address: 'Evidence probe address',
        })),
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await purgeCustomerEdits(db, { where: { id: { in: editIds } } });
      await write(async (tx) => {
        await tx.branch.deleteMany({ where: { customerId: { in: [ids.c1, ids.c2] } } });
        await tx.customer.deleteMany({ where: { id: { in: [ids.c1, ids.c2] } } });
        await tx.user.deleteMany({ where: { id: ids.user } });
        await tx.route.deleteMany({ where: { id: ids.route } });
        await tx.region.deleteMany({ where: { id: ids.region } });
      });
      await purgeHistory(db, {
        customerIds: [ids.c1, ids.c2],
        branchIds: [ids.branch, ids.branch2],
        userIds: [ids.user],
        routeIds: [ids.route],
        regionIds: [ids.region],
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('what a sent request asked for cannot change; its state, decision, clock and customer can', async () => {
    const e = await newEdit({ customerId: ids.c1, state: 'SUBMITTED', submittedAt: new Date(), cycle: 1 });
    for (const data of [
      { fieldChanges: [] },
      { attachmentChanges: [{ action: 'EVIDENCE', attachmentId: 'forged' }] },
      { submittedAt: new Date(Date.now() - 86_400_000) },
      { approvalChain: [] },
      { requestedCreditLimit: 99 },
      { cycle: 2 },
      { submitGate: { v: 1, branchIds: [] } },
    ]) {
      await expect(db.customerEdit.update({ where: { id: e.id }, data: data as never }), JSON.stringify(data)).rejects.toThrow(REFUSED);
    }
    await db.customerEdit.update({
      where: { id: e.id },
      data: { currentStepIndex: 1, pendingRole: 'MANAGER', slaDueAt: new Date(), escalationLevel: 1 },
    });
    await db.customerEdit.update({
      where: { id: e.id },
      data: { state: 'APPROVED', reviewedById: ids.user, reviewedAt: new Date(), decisionReason: 'ok', decisionCategory: 'other' },
    });
    // Decided: still frozen.
    await expect(db.customerEdit.update({ where: { id: e.id }, data: { fieldChanges: [] } })).rejects.toThrow(REFUSED);
  });

  it('the state moves only forward, so what was sent cannot be reopened, rewritten and closed again', async () => {
    // A decided request stays decided.
    const decided = await newEdit({ customerId: ids.c1, state: 'APPROVED', submittedAt: new Date() });
    for (const state of ['SUBMITTED', 'NEEDS_CORRECTION', 'DRAFT', 'REJECTED'] as const) {
      await expect(db.customerEdit.update({ where: { id: decided.id }, data: { state } }), state).rejects.toThrow(REFUSED);
    }
    // A sent one goes back to its sender only as a send-back, which is open again,
    // and can be re-sent and decided; never as a draft.
    const sent = await newEdit({ customerId: ids.c1, state: 'SUBMITTED', submittedAt: new Date(), cycle: 1 });
    await expect(db.customerEdit.update({ where: { id: sent.id }, data: { state: 'DRAFT' } })).rejects.toThrow(REFUSED);
    await db.customerEdit.update({ where: { id: sent.id }, data: { state: 'NEEDS_CORRECTION' } });
    await db.customerEdit.update({ where: { id: sent.id }, data: { fieldChanges: [], cycle: 2 } });
    await db.customerEdit.update({ where: { id: sent.id }, data: { state: 'SUBMITTED', submittedAt: new Date() } });
    await db.customerEdit.update({ where: { id: sent.id }, data: { state: 'APPROVED' } });
    await expect(db.customerEdit.update({ where: { id: sent.id }, data: { state: 'REJECTED' } })).rejects.toThrow(REFUSED);
    // An open one is approved only once sent; withdrawing it is allowed.
    const open = await newEdit({ state: 'DRAFT', process: 'CREATE', cycle: 1 });
    await expect(db.customerEdit.update({ where: { id: open.id }, data: { state: 'APPROVED' } })).rejects.toThrow(REFUSED);
    await db.customerEdit.update({ where: { id: open.id }, data: { state: 'REJECTED' } });
    // The owner's maintenance window gets through, as for the rest of the evidence.
    await withAuditMaintenance(db, (tx) => tx.customerEdit.update({ where: { id: decided.id }, data: { state: 'REJECTED' } }));
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: decided.id } })).state).toBe('REJECTED');
  });

  it('a draft and a request sent back stay open: a new-customer resubmit rewrites its round', async () => {
    const d = await newEdit({ state: 'DRAFT', process: 'CREATE', cycle: 1 });
    await db.customerEdit.update({ where: { id: d.id }, data: { fieldChanges: [], cycle: 1 } });
    const back = await newEdit({ state: 'NEEDS_CORRECTION', process: 'CREATE', cycle: 1, submittedAt: new Date() });
    await db.customerEdit.update({
      where: { id: back.id },
      data: { state: 'SUBMITTED', cycle: 2, submittedAt: new Date(), approvalChain: [{ role: 'SUPERVISOR' }] },
    });
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: back.id } })).cycle).toBe(2);
  });

  it('a request is never deleted or truncated outside the owner’s maintenance window, which clean-up uses', async () => {
    const e = await newEdit({ customerId: ids.c1, state: 'REJECTED', submittedAt: new Date() });
    await expect(db.customerEdit.delete({ where: { id: e.id } })).rejects.toThrow(REFUSED);
    await withAuditMaintenance(db, (tx) => tx.customerEdit.update({ where: { id: e.id }, data: { fieldChanges: [] } }));
    const gone = await withAuditMaintenance(db, (tx) => tx.customerEdit.deleteMany({ where: { id: e.id } }));
    expect(gone.count).toBe(1);
  });

  it('gap 31: a shop or customer a sent request names cannot be hard-deleted (RESTRICT); changing its branchId is refused', async () => {
    // On the other customer: one open request per customer (CustomerEdit_open_per_customer).
    const e = await newEdit({ customerId: ids.c2, branchId: ids.branch2, target: 'BRANCH', state: 'SUBMITTED', submittedAt: new Date() });
    await expect(db.customerEdit.update({ where: { id: e.id }, data: { branchId: ids.branch } })).rejects.toThrow(REFUSED);
    await expect(write((tx) => tx.branch.delete({ where: { id: ids.branch2 } }))).rejects.toThrow(/CustomerEdit_branchId_fkey|Foreign key constraint/);
    await expect(write((tx) => tx.customer.delete({ where: { id: ids.c2 } }))).rejects.toThrow(/CustomerEdit_customerId_fkey|Foreign key constraint/);
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: e.id } })).branchId).toBe(ids.branch2);
  });

  it('gap 8: originalCustomerId is set once by the database; a merge repointing customerId leaves it', async () => {
    const e = await newEdit({ customerId: ids.c1, state: 'APPROVED', submittedAt: new Date(), originalCustomerId: 'forged' });
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: e.id } })).originalCustomerId).toBe(ids.c1);
    await db.customerEdit.update({ where: { id: e.id }, data: { customerId: ids.c2 } });
    const after = await db.customerEdit.findUniqueOrThrow({ where: { id: e.id } });
    expect(after).toMatchObject({ customerId: ids.c2, originalCustomerId: ids.c1 });
    await expect(db.customerEdit.update({ where: { id: e.id }, data: { originalCustomerId: ids.c2 } })).rejects.toThrow(REFUSED);
    // A new-customer request has no customer until finalize: its first one is kept.
    const c = await newEdit({ state: 'SUBMITTED', process: 'CREATE', submittedAt: new Date() });
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: c.id } })).originalCustomerId).toBeNull();
    await db.customerEdit.update({ where: { id: c.id }, data: { state: 'APPROVED', customerId: ids.c2 } });
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: c.id } })).originalCustomerId).toBe(ids.c2);
    // One whose first customer the back-fill could not know (an earlier merge
    // may have repointed it) stays unknown: a later repoint is not its first customer.
    const unknown = await withAuditMaintenance(db, (tx) =>
      tx.customerEdit.create({
        data: {
          target: 'CUSTOMER',
          submittedById: ids.user,
          customerId: ids.c1,
          originalCustomerId: null,
          state: 'REJECTED',
          submittedAt: new Date(),
          fieldChanges: [],
          attachmentChanges: [],
        },
      })
    );
    editIds.push(unknown.id);
    expect(unknown.originalCustomerId).toBeNull();
    await db.customerEdit.update({ where: { id: unknown.id }, data: { customerId: ids.c2 } });
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: unknown.id } })).originalCustomerId).toBeNull();
  });

  const APP_URL = process.env.NMWC_APP_URL ?? '';
  it.skipIf(!APP_URL)('the runtime role cannot rewrite or delete a sent request, not even with the maintenance setting', async () => {
    if (APP_URL.includes(PROD)) throw new Error('ABORT: production');
    const e = await newEdit({ customerId: ids.c1, state: 'SUBMITTED', submittedAt: new Date() });
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      await expect(
        app.$transaction([
          app.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`),
          app.$executeRaw`UPDATE "CustomerEdit" SET "fieldChanges" = '[]' WHERE "id" = ${e.id}`,
        ])
      ).rejects.toThrow(REFUSED);
      await expect(app.$executeRaw`DELETE FROM "CustomerEdit" WHERE "id" = ${e.id}`).rejects.toThrow(REFUSED);
      // Its decision still moves.
      await app.$executeRaw`UPDATE "CustomerEdit" SET "state" = 'REJECTED', "pendingRole" = NULL WHERE "id" = ${e.id}`;
    } finally {
      await app.$disconnect();
    }
  });
});
