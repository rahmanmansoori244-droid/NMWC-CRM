// @vitest-environment node
/**
 * F10, X-STATUS-1 and F13 (reactivation reject), with Prisma mocked. The
 * services, runAction, the permission rules and lib/status-evidence.ts are real.
 *
 * F10: a close or reactivation request is sent with a photo, checked when it is
 * SENT. It was never checked again when the request was DECIDED, so a photo the
 * salesman removed afterwards still let the request be approved. The decision
 * now re-reads the photo inside its transaction, after the customer's row lock
 * (the lock Remove takes too): live, the submitter's, still on that branch. The
 * 24-hour capture-age rule is deliberately NOT re-applied.
 *
 * X-STATUS-1: approving a reactivation wrote the branch by id without asking
 * whether it was still live, still this customer's, still CLOSED — or whether
 * the customer was still live.
 *
 * F13: rejecting a reactivation committed the decision and then wrote its
 * audit row as a second statement. If the audit insert failed, the answer was
 * "Nothing was saved" while the rejection had been saved. Both now commit in
 * one transaction.
 *
 * The mocked `$transaction` hands its callback a separate `tx` and records
 * whether the callback threw — a real transaction rolls back everything the
 * callback wrote when it does.
 *
 * Each refusal tells the reviewer to reject, naming the button their queue has:
 * "Reject" on the approval page, "Keep closed" on the Reactivations queue, which
 * has no button called Reject.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError } from '@/lib/errors';
import { decisionTokenFor, type DecisionRow } from '@/lib/decision-token';
import {
  EVIDENCE_NONE_MESSAGE,
  EVIDENCE_REMOVED_MESSAGE,
  EVIDENCE_SELECT,
  REACTIVATION_EVIDENCE_NONE_MESSAGE,
  REACTIVATION_EVIDENCE_REMOVED_MESSAGE,
  REACTIVATION_STATE_CHANGED_MESSAGE,
  assertStatusEvidence,
  evidenceIds,
  standsAsEvidence,
} from '@/lib/status-evidence';

const DAY = 24 * 60 * 60 * 1000;
const SALES = 'u-sales';
const SUP = 'u-sup';
const MGR = 'u-mgr';
const CUST = 'c1';
const B1 = 'b1';
const B2 = 'b2';
const PHOTO = 'p1';

const h = vi.hoisted(() => ({
  user: { id: 'u-mgr', role: 'MANAGER', username: 'mgr' } as { id: string; role: string; username: string },
  scope: { ownedRouteId: null as string | null, teamRouteIds: [] as string[], managedRegionIds: ['g1'] },
  rolledBack: false,
}));
const tx = vi.hoisted(() => ({
  customerEdit: { updateMany: vi.fn() },
  editApproval: { create: vi.fn() },
  attachment: { findMany: vi.fn() },
  branch: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  customer: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  // lockCustomerRow
  $queryRaw: vi.fn(),
}));
const db = vi.hoisted(() => ({
  customerEdit: { findUnique: vi.fn(), updateMany: vi.fn() },
  editApproval: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  branch: { findMany: vi.fn() },
  customer: { findFirst: vi.fn() },
  attachment: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/audit', () => audit);
vi.mock('@/lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/access')>()),
  loadScope: async () => h.scope,
}));
vi.mock('@/lib/notifications', () => ({
  notifyUsers: vi.fn(),
  resolveStepAudience: vi.fn(async () => []),
  resolveStewardAudience: vi.fn(async () => []),
  settleRequestAlerts: vi.fn(async () => 0),
}));
// F1: the services also write the hierarchy's rows (lib/notify-hierarchy.ts);
// mocked here like '@/lib/notifications', so these suites keep testing what they test.
vi.mock('@/lib/notify-hierarchy', () => ({
  notifySalesmanRequest: vi.fn(async () => ({ mustAct: [], fyi: [] })),
}));
vi.mock('@/lib/completeness', () => ({ scoreCustomer: () => 50, scoreBranch: () => 50 }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { approveReactivationAction, rejectReactivationAction } from '@/services/reactivations';
import { approveEditAction } from '@/services/edits';

/** The mocked transaction client, as the helper's parameter type. */
const txc = tx as unknown as Parameters<typeof assertStatusEvidence>[0];

/** The evidence photo as the decision reads it, captured three days before the decision. */
const photo = (over: Record<string, unknown> = {}) => ({
  id: PHOTO,
  deletedAt: null as Date | null,
  capturedById: SALES,
  branchId: B1,
  branchExtraId: B1,
  capturedAt: new Date(Date.now() - 3 * DAY),
  ...over,
});
const EVIDENCE = [{ kind: 'FREE', attachmentId: PHOTO, action: 'EVIDENCE' }];

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

function reactivation(over: Record<string, unknown> = {}) {
  return {
    id: 'e-r',
    isReactivation: true,
    state: 'SUBMITTED',
    customerId: CUST,
    branchId: B1,
    submittedById: SALES,
    submittedBy: { id: SALES },
    branch: { id: B1, regionId: 'g1', customerId: CUST, status: 'CLOSED', deletedAt: null },
    customer: { id: CUST, deletedAt: null },
    attachmentChanges: EVIDENCE,
    decisionReason: 'Shop open again under the same owner.',
    ...over,
  };
}

function closeRequest(over: Record<string, unknown> = {}) {
  const sentAt = new Date(Date.now() - 3 * DAY);
  return {
    id: 'e-c',
    process: 'UPDATE',
    target: 'BRANCH',
    state: 'SUBMITTED',
    isReactivation: false,
    customerId: CUST,
    branchId: B1,
    submittedById: SALES,
    submittedBy: { id: SALES, supervisorId: SUP, fullName: 'Salesman One' },
    customer: {
      id: CUST,
      legalName: 'Al Noor Trading',
      status: 'ACTIVE',
      paymentTerms: 'CASH',
      deletedAt: null,
      branches: [{ id: B1, regionId: 'g1', routeId: 'r1', deletedAt: null }],
    },
    customerDraft: null,
    branchDrafts: [],
    approvalChain: null,
    currentStepIndex: 0,
    cycle: 1,
    submittedAt: sentAt,
    stageEnteredAt: sentAt,
    slaDueAt: null,
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    fieldChanges: [{ field: `branch.${B1}.status`, before: 'ACTIVE', after: 'CLOSED' }],
    attachmentChanges: EVIDENCE,
    decisionReason: 'Shop shut permanently.',
    ...over,
  };
}

/** Every write a decision makes after its evidence and state checks. */
const decisionWrites = () =>
  tx.branch.update.mock.calls.length +
  tx.branch.updateMany.mock.calls.length +
  tx.customer.update.mock.calls.length +
  tx.customer.updateMany.mock.calls.length +
  audit.writeAudit.mock.calls.length;

const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0] ?? -1;

beforeEach(() => {
  h.rolledBack = false;
  h.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] };
  for (const group of [tx.customerEdit, tx.editApproval, tx.attachment, tx.branch, tx.customer]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  for (const group of [db.customerEdit, db.editApproval, db.user, db.branch, db.customer, db.attachment]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  tx.$queryRaw.mockReset().mockResolvedValue([]);
  db.$transaction.mockReset().mockImplementation(async (fn: (t: typeof tx) => unknown) => {
    try {
      return await fn(tx);
    } catch (err) {
      h.rolledBack = true;
      throw err;
    }
  });
  audit.writeAudit.mockReset().mockResolvedValue(undefined);
  audit.getAuditEnvelope.mockReset().mockResolvedValue({ actorId: 'x', ip: null, userAgent: null });

  tx.customerEdit.updateMany.mockResolvedValue({ count: 1 });
  tx.attachment.findMany.mockResolvedValue([photo()]);
  tx.branch.findUnique.mockResolvedValue({ customerId: CUST, status: 'CLOSED', deletedAt: null });
  tx.customer.findUnique.mockResolvedValue({ deletedAt: null });
  tx.branch.findMany.mockResolvedValue([{ id: B1, status: 'ACTIVE' }]);
  tx.branch.findUniqueOrThrow.mockResolvedValue({ version: 0, status: 'ACTIVE' });
  tx.branch.updateMany.mockResolvedValue({ count: 1 });
  tx.customer.findUniqueOrThrow.mockResolvedValue({ id: CUST, branches: [{ id: B1 }] });
  tx.customer.updateMany.mockResolvedValue({ count: 0 });
  db.editApproval.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({ role: 'SALESMAN' });
  db.branch.findMany.mockResolvedValue([{ id: B1, customerId: CUST, routeId: 'r1' }]);
});

describe('lib/status-evidence', () => {
  it('evidenceIds reads the EVIDENCE entries only, once each, and survives any shape', () => {
    expect(
      evidenceIds([
        { kind: 'FREE', attachmentId: 'a', action: 'EVIDENCE' },
        { kind: 'SHOP', attachmentId: 'b', action: 'ADD' },
        { attachmentId: 'a', action: 'EVIDENCE' },
        { attachmentId: '', action: 'EVIDENCE' },
        { attachmentId: 42, action: 'EVIDENCE' },
        null,
        'EVIDENCE',
        { kind: 'SHOP', attachmentId: 'c', action: 'EVIDENCE' },
      ])
    ).toEqual(['a', 'c']);
    for (const junk of [null, undefined, {}, 'x', 7, []]) expect(evidenceIds(junk)).toEqual([]);
  });

  it('a photo stands while it is live, the submitter’s, and on that branch — as a slot photo or an extra', () => {
    const who = { branchId: B1, submittedById: SALES };
    expect(standsAsEvidence(photo(), who)).toBe(true);
    expect(standsAsEvidence(photo({ branchExtraId: null }), who)).toBe(true); // shop/signboard slot
    expect(standsAsEvidence(photo({ branchId: null }), who)).toBe(true); // extra photo
    expect(standsAsEvidence(photo({ deletedAt: new Date() }), who)).toBe(false);
    expect(standsAsEvidence(photo({ capturedById: 'someone-else' }), who)).toBe(false);
    expect(standsAsEvidence(photo({ branchId: B2, branchExtraId: B2 }), who)).toBe(false);
    expect(standsAsEvidence(undefined, who)).toBe(false); // gone for good (hard-deleted)
    expect(standsAsEvidence(photo(), { branchId: null, submittedById: SALES })).toBe(false);
  });

  it('the decision never reads the capture time, so the 24-hour rule cannot come back at approval', () => {
    expect(Object.keys(EVIDENCE_SELECT)).not.toContain('capturedAt');
  });

  it('assertStatusEvidence: intact passes; removed, foreign, sibling or missing is EVIDENCE_GONE', async () => {
    const input = { branchId: B1, submittedById: SALES, attachmentChanges: EVIDENCE, queue: 'approvals' as const };
    await expect(assertStatusEvidence(txc, input)).resolves.toBeUndefined();
    expect(tx.attachment.findMany).toHaveBeenCalledWith({ where: { id: { in: [PHOTO] } }, select: EVIDENCE_SELECT });

    for (const rows of [
      [photo({ deletedAt: new Date() })],
      [photo({ capturedById: 'someone-else' })],
      [photo({ branchId: B2, branchExtraId: B2 })],
      [],
    ]) {
      tx.attachment.findMany.mockResolvedValueOnce(rows);
      const err = await assertStatusEvidence(txc, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).toMatchObject({ code: 'EVIDENCE_GONE', message: EVIDENCE_REMOVED_MESSAGE });
    }
  });

  it('assertStatusEvidence: a request with no EVIDENCE entry, or no branch, is refused without a read', async () => {
    for (const input of [
      { branchId: B1, submittedById: SALES, attachmentChanges: [], queue: 'approvals' as const },
      { branchId: null, submittedById: SALES, attachmentChanges: EVIDENCE, queue: 'approvals' as const },
    ]) {
      await expect(assertStatusEvidence(txc, input)).rejects.toMatchObject({
        code: 'EVIDENCE_GONE',
        message: EVIDENCE_NONE_MESSAGE,
      });
    }
    expect(tx.attachment.findMany).not.toHaveBeenCalled();
  });

  it('assertStatusEvidence: every EVIDENCE photo must stand, not just one', async () => {
    const two = [...EVIDENCE, { kind: 'FREE', attachmentId: 'p2', action: 'EVIDENCE' }];
    tx.attachment.findMany.mockResolvedValueOnce([photo()]);
    await expect(
      assertStatusEvidence(txc, { branchId: B1, submittedById: SALES, attachmentChanges: two, queue: 'approvals' })
    ).rejects.toMatchObject({ code: 'EVIDENCE_GONE' });
  });

  it('the refusal names the reject button of the queue deciding it', async () => {
    const on = (queue: 'approvals' | 'reactivations', attachmentChanges: unknown) =>
      assertStatusEvidence(txc, { branchId: B1, submittedById: SALES, attachmentChanges, queue }).catch(
        (e: { message: string }) => e.message
      );
    tx.attachment.findMany.mockResolvedValue([photo({ deletedAt: new Date() })]);
    expect(await on('approvals', EVIDENCE)).toBe(EVIDENCE_REMOVED_MESSAGE);
    expect(await on('reactivations', EVIDENCE)).toBe(REACTIVATION_EVIDENCE_REMOVED_MESSAGE);
    expect(await on('approvals', [])).toBe(EVIDENCE_NONE_MESSAGE);
    expect(await on('reactivations', [])).toBe(REACTIVATION_EVIDENCE_NONE_MESSAGE);
    // The Reactivations queue has no Reject button: its reject is "Keep closed".
    for (const m of [REACTIVATION_EVIDENCE_REMOVED_MESSAGE, REACTIVATION_EVIDENCE_NONE_MESSAGE, REACTIVATION_STATE_CHANGED_MESSAGE]) {
      expect(m).toMatch(/\bUse Keep closed to reject (it|this request)\b/);
    }
    // The approval page's words are unchanged: it has "✗ Reject".
    for (const m of [EVIDENCE_REMOVED_MESSAGE, EVIDENCE_NONE_MESSAGE]) {
      expect(m).toMatch(/\bReject it\b/);
      expect(m).not.toMatch(/Keep closed/);
    }
  });
});

describe('approving a reactivation (F10 + X-STATUS-1)', () => {
  beforeEach(() => {
    h.user = { id: MGR, role: 'MANAGER', username: 'mgr' };
    db.customerEdit.findUnique.mockResolvedValue(reactivation());
  });

  it('with its photo intact — taken three days ago — the branch reopens, with its audit row', async () => {
    expect(await approveReactivationAction(form({ editId: 'e-r' }))).toEqual({ ok: true, data: undefined });
    expect(tx.branch.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: B1 }, data: expect.objectContaining({ status: 'ACTIVE' }) })
    );
    expect(audit.writeAudit).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ action: 'REACTIVATE' }));
  });

  it('reads the branch, the customer and the photo after the customer lock, and before the branch write', async () => {
    expect((await approveReactivationAction(form({ editId: 'e-r' }))).ok).toBe(true);
    const lock = order(tx.$queryRaw);
    const [sql, id] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/FROM "Customer" WHERE "id" = \? FOR UPDATE/);
    expect(id).toBe(CUST);
    for (const read of [tx.branch.findUnique, tx.customer.findUnique, tx.attachment.findMany]) {
      expect(order(read)).toBeGreaterThan(lock);
      expect(order(read)).toBeLessThan(order(tx.branch.update));
    }
  });

  it.each([
    ['removed', [photo({ deletedAt: new Date() })]],
    ['gone altogether', []],
    ['captured by someone else', [photo({ capturedById: 'someone-else' })]],
    ['on a sibling branch', [photo({ branchId: B2, branchExtraId: B2 })]],
  ])('photo %s: refused as EVIDENCE_GONE, the transaction rolls back, nothing is written', async (_n, rows) => {
    tx.attachment.findMany.mockResolvedValue(rows);
    const res = await approveReactivationAction(form({ editId: 'e-r' }));
    // Worded for this queue: it tells the Manager to use Keep closed.
    expect(res).toMatchObject({ ok: false, code: 'EVIDENCE_GONE', message: REACTIVATION_EVIDENCE_REMOVED_MESSAGE });
    expect(h.rolledBack).toBe(true);
    expect(decisionWrites()).toBe(0);
  });

  it('a request carrying no evidence entry is refused, not waved through', async () => {
    db.customerEdit.findUnique.mockResolvedValue(reactivation({ attachmentChanges: [] }));
    const res = await approveReactivationAction(form({ editId: 'e-r' }));
    expect(res).toMatchObject({ ok: false, code: 'EVIDENCE_GONE', message: REACTIVATION_EVIDENCE_NONE_MESSAGE });
    expect(decisionWrites()).toBe(0);
  });

  it.each([
    ['the branch was removed', { branch: { customerId: CUST, status: 'CLOSED', deletedAt: new Date() } }],
    ['the branch is gone', { branch: null }],
    ['the branch moved to another customer', { branch: { customerId: 'c2', status: 'CLOSED', deletedAt: null } }],
    ['the branch is no longer closed', { branch: { customerId: CUST, status: 'ACTIVE', deletedAt: null } }],
    ['the customer was archived', { customer: { deletedAt: new Date() } }],
    ['the customer is gone', { customer: null }],
  ])('%s: STATE_CHANGED, rolled back, no reopening and no REACTIVATE row', async (_n, now) => {
    if ('branch' in now) tx.branch.findUnique.mockResolvedValue(now.branch);
    if ('customer' in now) tx.customer.findUnique.mockResolvedValue(now.customer);
    const res = await approveReactivationAction(form({ editId: 'e-r' }));
    expect(res).toMatchObject({ ok: false, code: 'STATE_CHANGED', message: REACTIVATION_STATE_CHANGED_MESSAGE });
    expect(h.rolledBack).toBe(true);
    expect(decisionWrites()).toBe(0);
  });
});

describe('approving a close request (F10)', () => {
  beforeEach(() => {
    h.user = { id: SUP, role: 'SUPERVISOR', username: 'sup' };
    h.scope = { ownedRouteId: null, teamRouteIds: ['r1'], managedRegionIds: [] };
    db.customerEdit.findUnique.mockResolvedValue(closeRequest());
    // Phase 2 (F06): the approval reads the customer under the lock and decides
    // each change against it — the branch is still ACTIVE, the notes still empty.
    tx.customer.findUnique.mockResolvedValue({
      id: CUST,
      deletedAt: null,
      status: 'ACTIVE',
      paymentTerms: 'CASH',
      notes: null,
      branches: [{ id: B1, routeId: 'r1', regionId: 'g1', status: 'ACTIVE', deletedAt: null }],
    });
  });

  /**
   * Approve from a freshly loaded review page: every approval sends the token of
   * the request the page rendered (N01, 77eb204) — here, the row the service loads.
   */
  const approveClose = async () => {
    const loaded = (await db.customerEdit.findUnique()) as DecisionRow;
    return approveEditAction(form({ editId: 'e-c', decisionToken: decisionTokenFor(loaded, []) }));
  };

  it('with its photo intact — taken three days ago — the branch closes, with its APPROVE row', async () => {
    expect(await approveClose()).toEqual({ ok: true, data: undefined });
    expect(tx.branch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: B1, version: 0 }, data: expect.objectContaining({ status: 'CLOSED' }) })
    );
    expect(audit.writeAudit).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ action: 'APPROVE' }));
    // Under the lock, and before anything is applied.
    expect(order(tx.attachment.findMany)).toBeGreaterThan(order(tx.$queryRaw));
    expect(order(tx.attachment.findMany)).toBeLessThan(order(tx.branch.updateMany));
  });

  it.each([
    ['removed', [photo({ deletedAt: new Date() })]],
    ['gone altogether', []],
    ['captured by someone else', [photo({ capturedById: 'someone-else' })]],
    ['on a sibling branch', [photo({ branchId: B2, branchExtraId: B2 })]],
  ])('photo %s: EVIDENCE_GONE, rolled back — the branch stays open, no APPROVE row', async (_n, rows) => {
    tx.attachment.findMany.mockResolvedValue(rows);
    const res = await approveClose();
    expect(res).toMatchObject({ ok: false, code: 'EVIDENCE_GONE', message: EVIDENCE_REMOVED_MESSAGE });
    expect(h.rolledBack).toBe(true);
    expect(decisionWrites()).toBe(0);
  });

  it('a status-only request with no evidence entry is refused, whoever sent it', async () => {
    for (const role of ['SALESMAN', 'SUPERVISOR']) {
      db.user.findUnique.mockResolvedValue({ role });
      db.customerEdit.findUnique.mockResolvedValue(closeRequest({ attachmentChanges: [] }));
      const res = await approveClose();
      expect(res, role).toMatchObject({ ok: false, code: 'EVIDENCE_GONE', message: EVIDENCE_NONE_MESSAGE });
    }
    expect(decisionWrites()).toBe(0);
  });

  it('an enrichment edit (no status change, no evidence) is not asked for any', async () => {
    // A non-salesman submitter keeps EL-04 out of this test; it is not what it is about.
    db.user.findUnique.mockResolvedValue({ role: 'STEWARD' });
    db.customerEdit.findUnique.mockResolvedValue(
      closeRequest({
        target: 'CUSTOMER',
        branchId: null,
        fieldChanges: [{ field: 'customer.notes', before: null, after: 'Opens at 7' }],
        attachmentChanges: [],
      })
    );
    tx.customer.findUniqueOrThrow.mockResolvedValue({ id: CUST, version: 3, branches: [{ id: B1 }] });
    tx.customer.updateMany.mockResolvedValue({ count: 1 });
    expect(await approveClose()).toEqual({ ok: true, data: undefined });
    expect(tx.attachment.findMany).not.toHaveBeenCalled();
  });
});

describe('rejecting a reactivation (F13): the decision and its audit row are one commit', () => {
  beforeEach(() => {
    h.user = { id: MGR, role: 'MANAGER', username: 'mgr' };
    db.customerEdit.findUnique.mockResolvedValue(reactivation());
  });
  const reject = () => rejectReactivationAction(form({ editId: 'e-r', reason: 'Still shut — shutters down.' }));

  it('claims and audits on the same transaction; the evidence is not consulted', async () => {
    tx.attachment.findMany.mockResolvedValue([]); // the photo is gone: rejecting must still work
    expect(await reject()).toEqual({ ok: true, data: undefined });
    expect(db.customerEdit.updateMany).not.toHaveBeenCalled();
    expect(tx.customerEdit.updateMany).toHaveBeenCalledWith({
      where: { id: 'e-r', state: 'SUBMITTED', isReactivation: true },
      data: expect.objectContaining({ state: 'REJECTED', reviewedById: MGR }),
    });
    // Launch fix (2026-10-07): "Keep closed" is final (REJECTED, off the salesman's
    // Needs correction lists), and his own reason for asking is no longer overwritten.
    expect(tx.customerEdit.updateMany.mock.calls[0]![0].data).not.toHaveProperty('decisionReason');
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit.mock.calls[0]![0]).toBe(tx);
    expect(audit.writeAudit.mock.calls[0]![2]).toEqual({
      action: 'REJECT',
      entityType: 'CustomerEdit',
      entityId: 'e-r',
      reason: 'Still shut — shutters down.',
    });
    expect(order(audit.getAuditEnvelope)).toBeLessThan(order(db.$transaction));
    expect(tx.attachment.findMany).not.toHaveBeenCalled();
  });

  it('an audit insert that times out rolls the claim back, so "Nothing was saved" is true', async () => {
    audit.writeAudit.mockRejectedValue(
      Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), { code: 'P2024' })
    );
    const res = await reject();
    expect(res).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect((res as { message: string }).message).toMatch(/Nothing was saved/);
    // The claim ran on the transaction that rolled back — never as its own commit.
    expect(h.rolledBack).toBe(true);
    expect(tx.customerEdit.updateMany).toHaveBeenCalledTimes(1);
    expect(db.customerEdit.updateMany).not.toHaveBeenCalled();
  });

  it('a lost race answers NOT_PENDING and writes no audit row', async () => {
    tx.customerEdit.updateMany.mockResolvedValue({ count: 0 });
    expect(await reject()).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });
});
