// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — what each DECISION writes about a reason
 * (services/edits.ts), with the database mocked and the real approve and reject
 * services (the harness of tests/unit/decision-token.test.ts).
 *
 * A request kept one reason line, so the last approver's words replaced the ones
 * before, and a request that moved on kept an answered send-back's reason:
 *
 *  - a decision's reason is written to ITS decision row (EditApproval) — always;
 *  - the request row carries a copy of the latest send-back only while it stands
 *    sent back or stepped back: an approval that moves it on, and the approval
 *    that creates the customer, clear it;
 *  - a refused close-shop request has neither reason column written: the
 *    salesman's own reason is never replaced by the reviewer's;
 *  - the salesman's alert carries the round's earlier reasons when a send-back is
 *    relayed, by step; with one send-back in the round it reads as it always did.
 *
 * The submit writers are in tests/unit/request-reason-submit.test.ts, the upload
 * of the signed form in signed-form.test.ts, a reactivation's decision in
 * status-evidence.test.ts, and the same round trip on Postgres in
 * tests/integration/request-reasons.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditProcess, PaymentTerms, Prisma } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { decisionTokenFor, type DecisionRow } from '@/lib/decision-token';
import { omanDayTime } from '@/lib/tz';
import { LEGACY_CREDIT_CHAIN } from '../support/legacy-chain';

type User = { id: string; role: string; username: string };
type FindManyArgs = { where: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: unknown };

const h = vi.hoisted(() => ({
  user: null as { id: string; role: string; username: string } | null,
  managedRegionIds: [] as string[],
  rows: new Map<string, Record<string, unknown>>(),
  findUnique: vi.fn(),
  approvalFindMany: vi.fn(),
  priorRejects: vi.fn(),
  /** The REJECTED decision rows of the round, as the database would return them. */
  roundRejections: [] as Array<Record<string, unknown>>,
  transaction: vi.fn(),
  updateMany: vi.fn(),
  approvalCreate: vi.fn(),
  writeAudit: vi.fn(),
  notifyUsers: vi.fn(),
  finalize: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({ redirect: () => {} }));
vi.mock('@/lib/access', () => ({ loadScope: async () => ({ managedRegionIds: h.managedRegionIds }) }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: h.writeAudit,
}));
vi.mock('@/lib/notifications', () => ({
  resolveStepAudience: async () => ['approver-of-that-step'],
  resolveStewardAudience: async () => [],
  notifyUsers: h.notifyUsers,
  settleRequestAlerts: async () => 0,
}));
vi.mock('@/lib/notify-hierarchy', () => ({
  notifySalesmanRequest: vi.fn(async () => ({ mustAct: [], fyi: [] })),
}));
vi.mock('@/lib/create-finalize', () => ({
  assertFinalizable: () => {},
  finalizeCreateInTx: h.finalize,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findUnique: h.findUnique },
    editApproval: { findMany: h.approvalFindMany, count: h.priorRejects },
    $transaction: h.transaction,
  },
}));

import { approveEditAction, rejectEditAction } from '@/services/edits';

const NAME = 'Al Noor Trading';
const STAGE = new Date('2026-11-09T06:00:00.123Z');
const T = (min: number) => new Date(Date.UTC(2026, 10, 9, 5, min, 0));

const SUP: User = { id: 'sup1', role: 'SUPERVISOR', username: 'sup.one' };
const ACC: User = { id: 'acc1', role: 'ACCOUNTANT', username: 'acc.one' };
const FM: User = { id: 'fm1', role: 'FINANCE_MANAGER', username: 'fm.one' };
const GM: User = { id: 'gm1', role: 'GM', username: 'gm.one' };

const CASH_CHAIN = resolveChain(EditProcess.CREATE, PaymentTerms.CASH); // Supervisor → Accountant
const CREDIT_CHAIN = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT); // … → signed form (2) → FM (3) → GM (4) → Accountant

/** A new-customer request in review. */
function createRow(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    process: 'CREATE',
    target: 'CUSTOMER',
    state: 'SUBMITTED',
    isReactivation: false,
    customerId: null,
    customer: null,
    branchId: null,
    submittedById: 'sales1',
    submittedBy: { id: 'sales1', supervisorId: 'sup1', fullName: 'Salesman One', ownedRouteId: 'r1', ownedRoute: { regionId: 'g1' } },
    approvalChain: CASH_CHAIN,
    currentStepIndex: 0,
    cycle: 1,
    stageEnteredAt: STAGE,
    slaDueAt: new Date(STAGE.getTime() + 8 * 3600_000),
    submittedAt: new Date('2026-11-09T05:00:00.000Z'),
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    fieldChanges: [],
    submitGate: null,
    // A step-back left its reason here; the rejections themselves are decision rows.
    decisionReason: null,
    decisionCategory: null,
    customerDraft: { legalName: NAME, paymentTerms: 'CASH' },
    branchDrafts: [{ route: { regionId: 'g1' } }],
    ...over,
  };
}

/** A close-shop request, as the build writes it now: his reason in both columns (the rollback bridge). */
function closeRow(over: Record<string, unknown> = {}) {
  return createRow({
    id: 'c1',
    process: 'UPDATE',
    target: 'BRANCH',
    customerId: 'cust1',
    branchId: 'b1',
    customer: { legalName: 'Muscat Pearl', branches: [{ id: 'b1', routeId: 'r1', regionId: 'g1', deletedAt: null }] },
    customerDraft: null,
    branchDrafts: [],
    approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
    fieldChanges: [{ field: 'branch.b1.status', before: 'ACTIVE', after: 'CLOSED' }],
    requestReason: 'Shop shut for good',
    decisionReason: 'Shop shut for good',
    ...over,
  });
}

const tokenOf = (row: Record<string, unknown>) => decisionTokenFor(row as unknown as DecisionRow, []);
const form = (entries: Record<string, string | undefined>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) fd.set(k, v);
  return fd;
};
const approve = (row: Record<string, unknown>, temixCode?: string) =>
  approveEditAction(form({ editId: row.id as string, decisionToken: tokenOf(row), temixCode }));
const reject = (row: Record<string, unknown>, reason: string, category = 'wrong_info') =>
  rejectEditAction(form({ editId: row.id as string, decisionToken: tokenOf(row), reason, category }));

/** The one claim a decision makes on the request row. */
const claimData = () => {
  expect(h.updateMany).toHaveBeenCalledTimes(1);
  return h.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
};
/** The notification rows written, by kind and title. */
const notified = () =>
  h.notifyUsers.mock.calls.map((c) => ({ to: c[1] as string[], ...(c[2] as { kind: string; title: string; body: string }) }));
/** Whether the round's earlier rejections were read (the read that feeds the salesman's alert). */
const earlierReads = () =>
  h.approvalFindMany.mock.calls.filter((c) => (c[0] as FindManyArgs).where.decision === 'REJECTED');

const rejectionRow = (role: string, stepIndex: number, min: number, reason: string, cycle = 1) => ({
  cycle,
  stepIndex,
  role,
  decision: 'REJECTED',
  reason,
  at: T(min),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.user = SUP;
  h.managedRegionIds = ['g1'];
  h.rows = new Map();
  h.roundRejections = [];
  h.findUnique.mockImplementation(async (args: { where: { id: string } }) => h.rows.get(args.where.id) ?? null);
  // Two reads go through editApproval.findMany: who decided the other steps
  // (separation of duty), and — new — the round's rejections for the alert.
  h.approvalFindMany.mockImplementation(async (args: FindManyArgs) =>
    args.where.decision === 'REJECTED' ? h.roundRejections.filter((r) => r.cycle === args.where.cycle) : []
  );
  h.priorRejects.mockResolvedValue(0);
  h.updateMany.mockResolvedValue({ count: 1 });
  h.approvalCreate.mockResolvedValue({});
  h.writeAudit.mockResolvedValue(undefined);
  h.notifyUsers.mockResolvedValue(undefined);
  h.finalize.mockImplementation(async (...args: unknown[]) => ({
    customerId: 'c9',
    legalName: NAME,
    nmwcCode: 'NMWC-000900',
    temixCode: args[4],
  }));
  h.queryRaw.mockResolvedValue([]);
  h.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      customerEdit: { updateMany: h.updateMany },
      editApproval: { create: h.approvalCreate },
      $queryRaw: h.queryRaw,
      $executeRaw: async () => 1,
    })
  );
});

describe('an approval that moves the request on clears the answered send-back', () => {
  it('advance: the Supervisor re-approves a request the Accountant stepped back — the reason leaves the row', async () => {
    const row = createRow({ decisionReason: 'CR number does not match the photo', decisionCategory: 'wrong_info' });
    h.rows.set('e1', row);
    const res = await approve(row);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claimData()).toMatchObject({
      currentStepIndex: 1,
      pendingRole: 'ACCOUNTANT',
      decisionReason: null,
      decisionCategory: null,
    });
    // The approval's own decision row carries no reason; the rejection's row is untouched (append-only).
    expect(h.approvalCreate).toHaveBeenCalledTimes(1);
    expect(h.approvalCreate.mock.calls[0]![0].data).toMatchObject({ decision: 'APPROVED', stepIndex: 0 });
    expect(h.approvalCreate.mock.calls[0]![0].data).not.toHaveProperty('reason');
    // An approval reads no earlier rejections: it has nobody to tell them to.
    expect(earlierReads()).toHaveLength(0);
  });

  it('the approval that creates the customer leaves no reason on the approved request', async () => {
    h.user = ACC;
    const row = createRow({ currentStepIndex: 1, decisionReason: 'left by an older build', decisionCategory: 'other' });
    h.rows.set('e1', row);
    const res = await approve(row, 'CAA0367');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.finalize).toHaveBeenCalledTimes(1);
    const data = claimData();
    expect(data).toEqual({
      state: 'APPROVED',
      pendingRole: null,
      reviewedById: 'acc1',
      reviewedAt: expect.any(Date),
      decisionReason: null,
      decisionCategory: null,
    });
  });
});

describe('a rejection: its reason on its own decision row, and a copy on the row while it stands', () => {
  it('step-back (Accountant → Supervisor): the copy is this rejection’s; the salesman is not told a reason he cannot act on', async () => {
    h.user = ACC;
    const row = createRow({ currentStepIndex: 1 });
    h.rows.set('e1', row);
    const res = await reject(row, 'CR number does not match the photo');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.approvalCreate.mock.calls[0]![0].data).toMatchObject({
      decision: 'REJECTED',
      stepIndex: 1,
      role: 'ACCOUNTANT',
      reason: 'CR number does not match the photo',
      category: 'wrong_info',
    });
    expect(claimData()).toMatchObject({
      currentStepIndex: 0,
      pendingRole: 'SUPERVISOR',
      decisionReason: 'CR number does not match the photo',
      decisionCategory: 'wrong_info',
    });
    expect(claimData()).not.toHaveProperty('state');
    // It has not come back to the salesman, so nothing is read for his alert.
    expect(earlierReads()).toHaveLength(0);
    expect(notified().map((n) => n.title)).toEqual(['Request returned to your step', 'Request stepped back']);
  });

  it('to the salesman, the only send-back of the round: the alert is the sentence it has always been', async () => {
    const row = createRow();
    h.rows.set('e1', row);
    const res = await reject(row, 'Phone number format is incorrect');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claimData()).toMatchObject({
      state: 'NEEDS_CORRECTION',
      decisionReason: 'Phone number format is incorrect',
      decisionCategory: 'wrong_info',
    });
    expect(notified()).toEqual([
      {
        to: ['sales1'],
        kind: 'EDIT_NEEDS_CORRECTION',
        title: 'Needs correction',
        body: `${NAME} — returned to you: Phone number format is incorrect`,
        editId: 'e1',
        customerId: undefined,
      },
    ]);
    // The round's rejections were read once, by round and decision, oldest first, before the transaction.
    expect(earlierReads()).toHaveLength(1);
    expect(earlierReads()[0]![0]).toMatchObject({
      where: { editId: 'e1', cycle: 1, decision: 'REJECTED' },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    expect(h.approvalFindMany.mock.invocationCallOrder.at(-1)!).toBeLessThan(h.transaction.mock.invocationCallOrder[0]!);
  });

  it('relayed (Accountant’s reason, then the Supervisor’s): the salesman is told both — the earlier one by step', async () => {
    h.roundRejections = [
      rejectionRow('ACCOUNTANT', 1, 30, 'CR number does not match the photo'),
      rejectionRow('ACCOUNTANT', 1, 10, 'from the round before', 0),
    ];
    const row = createRow({ decisionReason: 'CR number does not match the photo', decisionCategory: 'wrong_info' });
    h.rows.set('e1', row);
    const res = await reject(row, 'Phone number format is incorrect');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // The row's copy is now the LATEST send-back; the Accountant's stays on his decision row.
    expect(claimData()).toMatchObject({ state: 'NEEDS_CORRECTION', decisionReason: 'Phone number format is incorrect' });
    expect(notified()[0]!.body).toBe(
      `${NAME} — returned to you: Phone number format is incorrect (Earlier in this round — Accountant step: CR number does not match the photo)`
    );
    // Steps, not people: no approver's name is in a notification.
    expect(notified()[0]!.body).not.toMatch(/acc\.one|Acc One/);
  });

  it('the loop guard (a step rejecting twice in a round goes to the salesman): its first reason is the earlier one', async () => {
    h.user = ACC;
    h.priorRejects.mockResolvedValue(1);
    h.roundRejections = [rejectionRow('ACCOUNTANT', 1, 30, 'CR number does not match the photo')];
    const row = createRow({ currentStepIndex: 1 });
    h.rows.set('e1', row);
    const res = await reject(row, 'Still the wrong CR number');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claimData()).toMatchObject({ state: 'NEEDS_CORRECTION', currentStepIndex: 0 });
    expect(notified()[0]!.body).toBe(
      `${NAME} — returned to you: Still the wrong CR number (Earlier in this round — Accountant step: CR number does not match the photo)`
    );
  });

  it('a close-shop request refused: neither reason column is written — his reason is not replaced by the reviewer’s', async () => {
    const row = closeRow();
    h.rows.set('c1', row);
    const res = await reject(row, 'Shop is open, I passed it today');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = claimData();
    expect(data).toMatchObject({ state: 'REJECTED', decisionCategory: 'wrong_info' });
    expect(data).not.toHaveProperty('decisionReason');
    expect(data).not.toHaveProperty('requestReason');
    // The reviewer's reason is on his decision row, the audit row and the alert.
    expect(h.approvalCreate.mock.calls[0]![0].data).toMatchObject({ decision: 'REJECTED', reason: 'Shop is open, I passed it today' });
    expect(h.writeAudit.mock.calls.map((c) => c[2])).toContainEqual(
      expect.objectContaining({ action: 'REJECT', entityId: 'c1', reason: 'Shop is open, I passed it today' })
    );
    expect(notified()).toEqual([
      expect.objectContaining({
        title: 'Close-shop request refused',
        body: 'Muscat Pearl — your close-shop request was refused, so the branch is not closed: Shop is open, I passed it today',
      }),
    ]);
    // One step, so there is no earlier reason to read.
    expect(earlierReads()).toHaveLength(0);
  });

  it('no decision writes requestReason — on any path', async () => {
    const paths: Array<() => Promise<unknown>> = [
      async () => {
        const row = createRow();
        h.rows.set('e1', row);
        return approve(row);
      },
      async () => {
        const row = createRow();
        h.rows.set('e1', row);
        return reject(row, 'Phone number format is incorrect');
      },
      async () => {
        h.user = ACC;
        const row = createRow({ currentStepIndex: 1 });
        h.rows.set('e1', row);
        return reject(row, 'CR number does not match the photo');
      },
    ];
    for (const run of paths) {
      h.updateMany.mockClear();
      h.user = SUP;
      expect(await run()).toMatchObject({ ok: true });
      expect(claimData()).not.toHaveProperty('requestReason');
    }
  });
});

describe('the signed application sent back (credit chain)', () => {
  const atFinance = (over: Record<string, unknown> = {}) =>
    createRow({
      approvalChain: CREDIT_CHAIN,
      currentStepIndex: 3,
      requestedCreditLimit: new Prisma.Decimal('500'),
      requestedPaymentTermDays: 30,
      customerDraft: { legalName: NAME, paymentTerms: 'CREDIT' },
      ...over,
    });
  const signedFormAlert = () => notified().find((n) => n.kind === 'SIGNED_FORM_REQUESTED')!;
  const dueOf = () => omanDayTime(claimData().slaDueAt as Date);

  it('the Finance Manager’s own send-back: the alert reads as it always did, with no bracket', async () => {
    h.user = FM;
    const row = atFinance();
    h.rows.set('e1', row);
    const res = await reject(row, 'The stamp is missing on page 2');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claimData()).toMatchObject({ currentStepIndex: 2, pendingRole: 'SALESMAN', decisionReason: 'The stamp is missing on page 2' });
    expect(signedFormAlert()).toMatchObject({
      to: ['sales1'],
      title: 'Signed application sent back',
      body: `${NAME} — sent back by the Finance Manager: The stamp is missing on page 2 — upload the signed credit application again by ${dueOf()}.`,
    });
    expect(earlierReads()).toHaveLength(1);
  });

  it('relaying the GM: the same sentence, then the GM’s reason in the bracket', async () => {
    h.user = FM;
    h.roundRejections = [rejectionRow('GM', 4, 40, 'Limit too high for a new shop')];
    const row = atFinance();
    h.rows.set('e1', row);
    const res = await reject(row, 'Have the customer sign for OMR 300');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(signedFormAlert().body).toBe(
      `${NAME} — sent back by the Finance Manager: Have the customer sign for OMR 300 — upload the signed credit application again by ${dueOf()}. (Earlier in this round — GM step: Limit too high for a new shop)`
    );
    // Whoever prints the form is told it came back, not why in the approvers' words.
    const printer = notified().find((n) => n.kind === 'EDIT_STAGE_ADVANCED')!;
    expect(printer.body).not.toContain('Limit too high');
  });

  it('the GM’s step-back to the Finance Manager does not reach the salesman: no read, no reason in his ping', async () => {
    h.user = GM;
    const row = atFinance({ currentStepIndex: 4 });
    h.rows.set('e1', row);
    const res = await reject(row, 'Limit too high for a new shop');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(claimData()).toMatchObject({ currentStepIndex: 3, pendingRole: 'FINANCE_MANAGER', decisionReason: 'Limit too high for a new shop' });
    expect(earlierReads()).toHaveLength(0);
    for (const n of notified()) expect(n.body).not.toContain('Limit too high');
  });

  it('a request frozen on the older credit chain (no signed-form step) is relayed to the salesman the same way', async () => {
    h.roundRejections = [rejectionRow('FINANCE_MANAGER', 1, 20, 'Credit figures need rework')];
    const row = createRow({
      approvalChain: LEGACY_CREDIT_CHAIN,
      requestedCreditLimit: new Prisma.Decimal('500'),
      requestedPaymentTermDays: 30,
      customerDraft: { legalName: NAME, paymentTerms: 'CREDIT' },
    });
    h.rows.set('e1', row);
    const res = await reject(row, 'Please re-verify and resubmit');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(notified()[0]!.body).toBe(
      `${NAME} — returned to you: Please re-verify and resubmit (Earlier in this round — Finance Manager step: Credit figures need rework)`
    );
  });
});
