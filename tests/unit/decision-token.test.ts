// @vitest-environment node
/**
 * N01 / X-APPR-1 (auditor recheck, 2026-09-27): a decision is bound to the
 * request as the reviewer's page showed it.
 *
 * The auditor's case: a Finance Manager opens a cycle-1 credit application for
 * OMR 400. It is sent back, the salesman corrects it to OMR 10,000 / 90 days,
 * and cycle 2 returns to finance under the same id. The old tab's Approve sent
 * only the id, the server reloaded cycle 2 and approved figures the tab never
 * showed. These tests run the real approve, reject and bulk services with the
 * database mocked, and pin what they write — nothing — when the view is stale.
 * The same scenarios against Postgres are in tests/integration/credit-chain-e2e.test.ts.
 *
 * The guarantee documents of a new-customer request are bound too. They are
 * attachments, and the salesman can Remove one while the request is SUBMITTED
 * without touching the row, so a page showing two could decide a request with
 * one. The token carries a digest of the ids the page rendered, and each
 * decision re-reads them inside its transaction, after its claim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditProcess, PaymentTerms, Prisma } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import {
  MISSING_TOKEN_MESSAGE,
  STALE_VIEW_MESSAGE,
  decisionTokenFor,
  decisionView,
  formatRequestedLimit,
  guaranteeDigest,
  parseDecisionToken,
  sameDecisionView,
  serializeDecisionToken,
  type DecisionRow,
  type DecisionView,
} from '@/lib/decision-token';
import { BULK_DECISION_LIMIT, BULK_DECISION_LIMIT_MESSAGE, CREDIT_BULK_REFUSED_MESSAGE } from '@/lib/bulk-run';

type User = { id: string; role: string; username: string };

const h = vi.hoisted(() => ({
  user: null as { id: string; role: string; username: string } | null,
  managedRegionIds: [] as string[],
  rows: new Map<string, Record<string, unknown>>(),
  findUnique: vi.fn(),
  priorDecisions: vi.fn(),
  priorRejects: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
  approvalCreate: vi.fn(),
  writeAudit: vi.fn(),
  notifyUsers: vi.fn(),
  finalize: vi.fn(),
  /** The live GUARANTEE ids the database holds, by request id. */
  guarantees: new Map<string, string[]>(),
  queryRaw: vi.fn(),
  rolledBack: false,
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
  resolveStepAudience: async () => [],
  resolveStewardAudience: async () => [],
  notifyUsers: h.notifyUsers,
  settleRequestAlerts: async () => 0,
}));
// F1: the services also write the hierarchy's rows (lib/notify-hierarchy.ts);
// mocked here like '@/lib/notifications', so these suites keep testing what they test.
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
    editApproval: { findMany: h.priorDecisions, count: h.priorRejects },
    $transaction: h.transaction,
  },
}));

import {
  approveEditAction,
  rejectEditAction,
  bulkApproveEditsAction,
  bulkRejectEditsAction,
} from '@/services/edits';

const CHAIN = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT); // SUP → FM → GM → ACC
const T_CYCLE1 = new Date('2026-09-20T06:00:00.123Z'); // the FM stage the old tab showed
const T_EARLIER_VISIT = new Date('2026-09-22T07:30:00.456Z'); // cycle 2, before a GM step-back
const T_NOW = new Date('2026-09-23T09:15:00.789Z'); // cycle 2, the FM stage as it is now

const FM: User = { id: 'fm1', role: 'FINANCE_MANAGER', username: 'fm.one' };
const GM: User = { id: 'gm1', role: 'GM', username: 'gm.one' };
const ACC: User = { id: 'acc1', role: 'ACCOUNTANT', username: 'acc.one' };
const SUP: User = { id: 'sup1', role: 'SUPERVISOR', username: 'sup.one' };

/** Cycle 2 of a corrected credit application, waiting on the Finance Manager. */
function creditRow(id = 'e1', over: Record<string, unknown> = {}) {
  return {
    id,
    process: 'CREATE',
    state: 'SUBMITTED',
    isReactivation: false,
    customerId: null,
    customer: null,
    submittedById: 'sales1',
    submittedBy: { id: 'sales1', supervisorId: 'sup1', fullName: 'Salesman One' },
    approvalChain: CHAIN,
    currentStepIndex: 1,
    cycle: 2,
    stageEnteredAt: T_NOW,
    slaDueAt: new Date(T_NOW.getTime() + 8 * 3600_000),
    submittedAt: new Date('2026-09-22T07:00:00.000Z'),
    requestedCreditLimit: new Prisma.Decimal('10000'),
    requestedPaymentTermDays: 90,
    customerDraft: { legalName: 'Al Noor Trading' },
    branchDrafts: [{ route: { regionId: 'g1' } }],
    ...over,
  };
}

/** The two guarantee documents of e1, as the database returns them (not sorted). */
const G = ['g-b', 'g-a'];
/** The token a page renders: the row, and the guarantees it listed (by default, the live ones). */
const tokenOf = (row: Record<string, unknown>, shown: string[] = h.guarantees.get(row.id as string) ?? []) =>
  decisionTokenFor(row as unknown as DecisionRow, shown);
/** What the Finance Manager's tab rendered on cycle 1: OMR 400 over 30 days. */
const CYCLE1_TOKEN = serializeDecisionToken({
  cycle: 1,
  stepIndex: 1,
  stageEnteredAt: T_CYCLE1,
  creditLimit: '400.000',
  paymentTermDays: 30,
  guarantees: guaranteeDigest(G),
});

const form = (entries: Record<string, string | undefined>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) fd.set(k, v);
  return fd;
};
const approve = (editId: string, decisionToken?: string) => approveEditAction(form({ editId, decisionToken }));
const reject = (editId: string, decisionToken?: string) =>
  rejectEditAction(form({ editId, decisionToken, reason: 'Credit figures need rework.', category: 'wrong_info' }));

beforeEach(() => {
  vi.clearAllMocks();
  h.user = FM;
  h.managedRegionIds = [];
  h.rows = new Map([['e1', creditRow('e1')]]);
  h.findUnique.mockImplementation(async (args: { where: { id: string } }) => h.rows.get(args.where.id) ?? null);
  h.priorDecisions.mockResolvedValue([]);
  h.priorRejects.mockResolvedValue(0);
  h.updateMany.mockResolvedValue({ count: 1 });
  h.approvalCreate.mockResolvedValue({});
  h.writeAudit.mockResolvedValue(undefined);
  h.notifyUsers.mockResolvedValue(undefined);
  h.finalize.mockResolvedValue({ customerId: 'c9', legalName: 'Al Noor Trading', nmwcCode: 'NMWC-000900' });
  h.guarantees = new Map([['e1', [...G]]]);
  h.rolledBack = false;
  // A tagged template: the SQL text, then its values — the first is the request id.
  h.queryRaw.mockImplementation(async (_sql: TemplateStringsArray, editId: string) =>
    (h.guarantees.get(editId) ?? []).map((id) => ({ id }))
  );
  // A callback that throws is a transaction that rolled back everything it wrote.
  h.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    try {
      return await cb({
        customerEdit: { updateMany: h.updateMany },
        editApproval: { create: h.approvalCreate },
        $queryRaw: h.queryRaw,
      });
    } catch (err) {
      h.rolledBack = true;
      throw err;
    }
  });
});

/** Nothing a decision writes was written. */
function expectNothingWritten() {
  expect(h.transaction).not.toHaveBeenCalled();
  expect(h.updateMany).not.toHaveBeenCalled();
  expect(h.approvalCreate).not.toHaveBeenCalled();
  expect(h.writeAudit).not.toHaveBeenCalled();
  expect(h.notifyUsers).not.toHaveBeenCalled();
  expect(h.finalize).not.toHaveBeenCalled();
}

describe('the token (lib/decision-token.ts)', () => {
  it('prints the credit limit the way the approval screens print it', () => {
    expect(formatRequestedLimit(new Prisma.Decimal('10000'))).toBe('10000.000');
    expect(formatRequestedLimit(new Prisma.Decimal('0.5'))).toBe('0.500');
    expect(formatRequestedLimit(7777)).toBe('7777.000');
    expect(formatRequestedLimit(null)).toBeNull();
  });

  it('reads back exactly what it wrote, a null stage and null figures included', () => {
    const views: DecisionView[] = [
      { cycle: 2, stepIndex: 1, stageEnteredAt: T_NOW, creditLimit: '10000.000', paymentTermDays: 90, guarantees: guaranteeDigest(G) },
      // A row older than the stage columns, and an UPDATE (no figures, no guarantees).
      { cycle: 1, stepIndex: 0, stageEnteredAt: null, creditLimit: null, paymentTermDays: null, guarantees: null },
      // Decimal(14,3) at its edges: eleven integer digits, and a sign; a CREATE with no guarantee left.
      { cycle: 7, stepIndex: 3, stageEnteredAt: T_CYCLE1, creditLimit: '99999999999.999', paymentTermDays: 365, guarantees: guaranteeDigest([]) },
      { cycle: 1, stepIndex: 2, stageEnteredAt: T_CYCLE1, creditLimit: '-12.500', paymentTermDays: 0, guarantees: null },
    ];
    for (const v of views) {
      const back = parseDecisionToken(serializeDecisionToken(v));
      expect(back).toEqual(v);
      expect(sameDecisionView(back!, v)).toBe(true);
    }
    // And from a row: the Decimal column, the stage's milliseconds and the guarantees survive.
    const row = creditRow();
    expect(parseDecisionToken(tokenOf(row))).toEqual({
      cycle: 2,
      stepIndex: 1,
      stageEnteredAt: T_NOW,
      creditLimit: '10000.000',
      paymentTermDays: 90,
      guarantees: guaranteeDigest(G),
    });
  });

  it('the guarantees are one order-free value for a CREATE, and nothing for an UPDATE', () => {
    expect(guaranteeDigest(['g-a', 'g-b'])).toBe(guaranteeDigest(['g-b', 'g-a']));
    expect(guaranteeDigest(['g-a', 'g-b'])).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [['g-a'], ['g-a', 'g-b', 'g-c'], [], ['g-ag-b']]) {
      expect(guaranteeDigest(other), JSON.stringify(other)).not.toBe(guaranteeDigest(['g-a', 'g-b']));
    }
    const create = creditRow() as unknown as DecisionRow;
    expect(decisionView(create, G).guarantees).toBe(guaranteeDigest(G));
    // An UPDATE has no guarantee documents: whatever a caller passes, none are bound.
    expect(decisionView({ ...create, process: 'UPDATE' }, G).guarantees).toBeNull();
  });

  it('refuses anything it did not write', () => {
    const good = JSON.parse(serializeDecisionToken(decisionView(creditRow() as unknown as DecisionRow, G)));
    const variants: unknown[] = [
      undefined,
      null,
      42,
      '',
      'not json',
      '[]',
      'null',
      // Version 1 had no guarantees: a page rendered before them is out of date.
      JSON.stringify({ ...good, v: 1 }),
      JSON.stringify({ ...good, v: 3 }),
      JSON.stringify({ ...good, cycle: 1.5 }),
      JSON.stringify({ ...good, cycle: '2' }),
      JSON.stringify({ ...good, step: undefined }),
      // A safe integer outside the Date range: an Invalid Date in a WHERE throws.
      JSON.stringify({ ...good, stage: 9e15 }),
      JSON.stringify({ ...good, stage: '2026-09-23' }),
      JSON.stringify({ ...good, limit: '10000' }),
      JSON.stringify({ ...good, limit: 10000 }),
      JSON.stringify({ ...good, days: '90' }),
      JSON.stringify({ ...good, g: undefined }),
      JSON.stringify({ ...good, g: 'g-a,g-b' }),
      JSON.stringify({ ...good, g: good.g.toUpperCase() }),
      JSON.stringify({ ...good, g: 5 }),
      JSON.stringify({ ...good, pad: 'x'.repeat(300) }),
    ];
    for (const v of variants) expect(parseDecisionToken(v), String(v)).toBeNull();
    expect(parseDecisionToken(JSON.stringify(good))).not.toBeNull();
  });

  it('two views differ when any one part differs', () => {
    const base: DecisionView = {
      cycle: 2,
      stepIndex: 1,
      stageEnteredAt: T_NOW,
      creditLimit: '10000.000',
      paymentTermDays: 90,
      guarantees: guaranteeDigest(G),
    };
    const same = { ...base, stageEnteredAt: new Date(T_NOW.getTime()) };
    expect(sameDecisionView(base, same)).toBe(true);
    for (const over of [
      { cycle: 1 },
      { stepIndex: 2 },
      { stageEnteredAt: new Date(T_NOW.getTime() + 1) },
      { stageEnteredAt: null },
      { creditLimit: '10000.001' },
      { creditLimit: null },
      { paymentTermDays: 60 },
      { paymentTermDays: null },
      { guarantees: guaranteeDigest(['g-a']) },
      { guarantees: null },
    ]) {
      expect(sameDecisionView(base, { ...base, ...over }), JSON.stringify(over)).toBe(false);
    }
  });
});

describe('approve: a stale page decides nothing', () => {
  it("the auditor's case: a tab opened on cycle 1 (OMR 400) cannot approve cycle 2 (OMR 10,000 / 90 days)", async () => {
    const res = await approve('e1', CYCLE1_TOKEN);
    expect(res).toEqual({ ok: false, code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE });
    expectNothingWritten();
  });

  it('the same approval from a freshly loaded page goes through, and its claim is the token', async () => {
    const res = await approve('e1', tokenOf(creditRow()));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany.mock.calls[0]![0].where).toEqual({
      id: 'e1',
      state: 'SUBMITTED',
      currentStepIndex: 1,
      cycle: 2,
      stageEnteredAt: T_NOW,
      requestedCreditLimit: '10000.000',
      requestedPaymentTermDays: 90,
    });
    expect(h.approvalCreate).toHaveBeenCalledTimes(1);
  });

  it('same cycle, same step, a later visit (a step-back and re-advance since): refused', async () => {
    const token = tokenOf(creditRow('e1', { stageEnteredAt: T_EARLIER_VISIT }));
    expect(await approve('e1', token)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expectNothingWritten();
  });

  it('X-APPR-1: the figures alone differing is enough — the decision is on the numbers shown', async () => {
    for (const over of [{ requestedCreditLimit: new Prisma.Decimal('9999.999') }, { requestedPaymentTermDays: 60 }]) {
      const token = tokenOf(creditRow('e1', over));
      expect(await approve('e1', token), JSON.stringify(over)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    }
    expectNothingWritten();
  });

  it('no token, or one this build did not write, is a reload — and the request is not even read', async () => {
    for (const token of [undefined, '', 'x', '{"v":1}']) {
      const res = await approve('e1', token);
      expect(res, String(token)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: MISSING_TOKEN_MESSAGE });
    }
    expect(h.findUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('a caller with no right to the step gets FORBIDDEN whatever the token says, so it learns nothing from it', async () => {
    h.user = GM; // the step is the Finance Manager's
    for (const token of [CYCLE1_TOKEN, tokenOf(creditRow())]) {
      expect(await approve('e1', token)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    expectNothingWritten();
  });

  it('a lost race between the read and the claim still says NOT_PENDING', async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    expect(await approve('e1', tokenOf(creditRow()))).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(h.approvalCreate).not.toHaveBeenCalled();
  });

  it('at the final step, a stale token creates no customer; a fresh one does', async () => {
    h.user = ACC;
    h.managedRegionIds = ['g1'];
    h.rows.set('e1', creditRow('e1', { currentStepIndex: 3 }));
    const stale = tokenOf(creditRow('e1', { currentStepIndex: 3, stageEnteredAt: T_EARLIER_VISIT }));
    expect(await approve('e1', stale)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expectNothingWritten();

    const fresh = await approve('e1', tokenOf(creditRow('e1', { currentStepIndex: 3 })));
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.updateMany.mock.calls[0]![0].where).toMatchObject({ currentStepIndex: 3, cycle: 2, stageEnteredAt: T_NOW });
  });
});

describe('reject: bound the same way', () => {
  it('a stale rejection writes nothing — not even the decision row that precedes its claim', async () => {
    expect(await reject('e1', CYCLE1_TOKEN)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expectNothingWritten();
  });

  it('a fresh rejection claims on the token', async () => {
    const res = await reject('e1', tokenOf(creditRow()));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.updateMany.mock.calls[0]![0].where).toEqual({
      id: 'e1',
      state: 'SUBMITTED',
      currentStepIndex: 1,
      cycle: 2,
      stageEnteredAt: T_NOW,
      requestedCreditLimit: '10000.000',
      requestedPaymentTermDays: 90,
    });
  });

  it('an UPDATE older than the stage columns: null stage and null figures round-trip and are claimed as IS NULL', async () => {
    h.user = SUP;
    h.rows.set(
      'u1',
      creditRow('u1', {
        process: 'UPDATE',
        customerId: 'c1',
        customer: { legalName: 'Muscat Pearl', branches: [{ regionId: 'g1', deletedAt: null }] },
        customerDraft: null,
        branchDrafts: [],
        approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
        currentStepIndex: 0,
        cycle: 1,
        stageEnteredAt: null,
        requestedCreditLimit: null,
        requestedPaymentTermDays: null,
      })
    );
    const res = await reject('u1', tokenOf(h.rows.get('u1')!));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.updateMany.mock.calls[0]![0].where).toMatchObject({
      stageEnteredAt: null,
      requestedCreditLimit: null,
      requestedPaymentTermDays: null,
    });
    // An UPDATE has no guarantee documents to re-read.
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('no token is a reload', async () => {
    expect(await reject('e1')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: MISSING_TOKEN_MESSAGE });
    expectNothingWritten();
  });
});

describe('bulk: every card is decided on its own token', () => {
  const decisions = (list: Array<[string, string]>) =>
    JSON.stringify(list.map(([editId, decisionToken]) => ({ editId, decisionToken })));

  beforeEach(() => {
    h.rows.set('e2', creditRow('e2'));
  });

  it('approve: the stale card fails alone with STALE_VIEW; the fresh one is approved', async () => {
    const res = await bulkApproveEditsAction(
      form({ decisions: decisions([['e1', CYCLE1_TOKEN], ['e2', tokenOf(creditRow('e2'))]]) })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.successes).toEqual(['e2']);
    expect(res.data.failures).toEqual([{ editId: 'e1', code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE }]);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany.mock.calls[0]![0].where).toMatchObject({ id: 'e2', cycle: 2, stageEnteredAt: T_NOW });
  });

  it('reject: the same', async () => {
    const fd = form({
      decisions: decisions([['e1', CYCLE1_TOKEN], ['e2', tokenOf(creditRow('e2'))]]),
      reason: 'Credit figures need rework.',
      category: 'wrong_info',
    });
    const res = await bulkRejectEditsAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.successes).toEqual(['e2']);
    expect(res.data.failures.map((f) => [f.editId, f.code])).toEqual([['e1', 'STALE_VIEW']]);
    expect(h.approvalCreate).toHaveBeenCalledTimes(1);
  });

  it('an id list without tokens (the old payload) is refused before anything is read', async () => {
    const res = await bulkApproveEditsAction(form({ editIds: JSON.stringify(['e1', 'e2']) }));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: MISSING_TOKEN_MESSAGE });
    expect(h.findUnique).not.toHaveBeenCalled();
    const rej = await bulkRejectEditsAction(
      form({ editIds: JSON.stringify(['e1']), reason: 'Credit figures need rework.', category: 'other' })
    );
    expect(rej).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: MISSING_TOKEN_MESSAGE });
    expectNothingWritten();
  });

  it('a malformed list, or the same request twice, is refused whole', async () => {
    for (const raw of [
      'nope',
      JSON.stringify([{ editId: 'e1' }]),
      JSON.stringify([{ editId: 'e1', decisionToken: 5 }]),
      JSON.stringify([]),
      decisions([['e1', tokenOf(creditRow())], ['e1', CYCLE1_TOKEN]]),
    ]) {
      expect(await bulkApproveEditsAction(form({ decisions: raw })), raw).toMatchObject({
        ok: false,
        code: 'VALIDATION_FAILED',
      });
    }
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it('over the bulk limit: refused whole, with a message that says what to do', async () => {
    // The queue shows the form-level message; it was the default "Validation failed".
    const over = decisions(
      Array.from({ length: BULK_DECISION_LIMIT + 1 }, (_, i): [string, string] => [`x${i}`, `token-${i}`])
    );
    const refused = { ok: false, code: 'VALIDATION_FAILED', message: BULK_DECISION_LIMIT_MESSAGE };
    expect(await bulkApproveEditsAction(form({ decisions: over }))).toEqual({
      ...refused,
      fields: { decisions: BULK_DECISION_LIMIT_MESSAGE },
    });
    expect(
      await bulkRejectEditsAction(form({ decisions: over, reason: 'Credit figures need rework.', category: 'other' }))
    ).toMatchObject(refused);
    expect(h.findUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('at the bulk limit: not refused — every request is decided on its own', async () => {
    const atLimit = Array.from({ length: BULK_DECISION_LIMIT }, (_, i): [string, string] => [
      `x${i}`,
      tokenOf(creditRow(`x${i}`)),
    ]);
    const res = await bulkApproveEditsAction(form({ decisions: decisions(atLimit) }));
    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true);
    if (!res.ok) return;
    // None of these requests exists, so each is looked up and fails alone; the
    // list itself was not refused.
    expect(h.findUnique).toHaveBeenCalledTimes(BULK_DECISION_LIMIT);
    expect(res.data.failures).toHaveLength(BULK_DECISION_LIMIT);
    expect(new Set(res.data.failures.map((f) => f.code))).toEqual(new Set(['NOT_FOUND']));
  });
});

describe('guarantee documents: a decision lands only on the guarantees the page showed', () => {
  /** The page listed both documents; the salesman has since removed one. */
  const shownBoth = () => tokenOf(creditRow(), [...G]);
  const removeOne = () => h.guarantees.set('e1', ['g-a']);
  const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0] ?? -1;

  /** Refused inside the transaction: the claim was made there and rolled back, and nothing after it ran. */
  function expectRolledBackBeforeAnyWrite() {
    expect(h.rolledBack).toBe(true);
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(h.notifyUsers).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  }

  it('the re-read comes after the claim, locks the live GUARANTEE rows of this request, and a match approves', async () => {
    expect((await approve('e1', shownBoth())).ok).toBe(true);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const [sql, editId] = h.queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(editId).toBe('e1');
    expect(sql.join('?').replace(/\s+/g, ' ')).toBe(
      `SELECT "id" FROM "Attachment" WHERE "editId" = ? AND "kind" = 'GUARANTEE' AND "deletedAt" IS NULL FOR SHARE`
    );
    expect(order(h.queryRaw)).toBeGreaterThan(order(h.updateMany));
    expect(order(h.queryRaw)).toBeLessThan(order(h.approvalCreate));
  });

  it('mid-chain: one removed since the page loaded is STALE_VIEW, and the advance is rolled back', async () => {
    removeOne();
    expect(await approve('e1', shownBoth())).toEqual({ ok: false, code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.approvalCreate).not.toHaveBeenCalled();
    expectRolledBackBeforeAnyWrite();
  });

  it('at the final step: no customer is created on fewer guarantees than the page showed', async () => {
    h.user = ACC;
    h.managedRegionIds = ['g1'];
    h.rows.set('e1', creditRow('e1', { currentStepIndex: 3 }));
    const token = tokenOf(creditRow('e1', { currentStepIndex: 3 }), [...G]);
    removeOne();
    expect(await approve('e1', token)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expect(h.approvalCreate).not.toHaveBeenCalled();
    expectRolledBackBeforeAnyWrite();
  });

  it('reject: refused the same way — the decision row it writes before its claim rolls back with it', async () => {
    removeOne();
    expect(await reject('e1', shownBoth())).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expect(order(h.queryRaw)).toBeGreaterThan(order(h.updateMany));
    expectRolledBackBeforeAnyWrite();
  });

  it('any other set is refused too, and the same set in another order is not', async () => {
    h.guarantees.set('e1', ['g-a', 'g-b', 'g-c']);
    expect(await approve('e1', shownBoth())).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    h.guarantees.set('e1', ['g-a', 'g-b']);
    expect((await approve('e1', shownBoth())).ok).toBe(true);
  });

  it('a new-customer token that states no guarantees, or an edit token that states some, is refused before any transaction', async () => {
    const statesNone = serializeDecisionToken({ ...decisionView(creditRow() as unknown as DecisionRow, G), guarantees: null });
    expect(await approve('e1', statesNone)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expect(await reject('e1', statesNone)).toMatchObject({ ok: false, code: 'STALE_VIEW' });

    h.user = SUP;
    const update = creditRow('u1', {
      process: 'UPDATE',
      customerId: 'c1',
      customer: { legalName: 'Muscat Pearl', branches: [{ regionId: 'g1', deletedAt: null }] },
      customerDraft: null,
      branchDrafts: [],
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      currentStepIndex: 0,
    });
    h.rows.set('u1', update);
    const statesSome = serializeDecisionToken({
      ...decisionView(update as unknown as DecisionRow, []),
      guarantees: guaranteeDigest([]),
    });
    expect(await reject('u1', statesSome)).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    expectNothingWritten();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('bulk: the card whose guarantee was removed fails alone', async () => {
    h.rows.set('e2', creditRow('e2'));
    h.guarantees.set('e2', ['g-z']);
    const fd = form({
      decisions: JSON.stringify([
        { editId: 'e1', decisionToken: shownBoth() },
        { editId: 'e2', decisionToken: tokenOf(creditRow('e2')) },
      ]),
    });
    removeOne();
    const res = await bulkApproveEditsAction(fd);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.successes).toEqual(['e2']);
    expect(res.data.failures).toEqual([{ editId: 'e1', code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE }]);
  });
});

describe('owner decision 2026-10-05 (X-APPR-1(a): no): a credit application is never approved in bulk', () => {
  /** As the database returns it: the draft carries the payment terms that route the chain. */
  const credit = (id = 'e1') =>
    creditRow(id, { customerDraft: { legalName: 'Al Noor Trading', paymentTerms: 'CREDIT' } });
  const cash = (id: string) =>
    creditRow(id, { customerDraft: { legalName: 'Corner Shop', paymentTerms: 'CASH' } });

  it('inside a bulk approve it fails alone, saying what to do, and nothing is written for it', async () => {
    h.rows.set('e1', credit('e1'));
    const res = await bulkApproveEditsAction(
      form({ decisions: JSON.stringify([{ editId: 'e1', decisionToken: tokenOf(credit('e1')) }]) })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.successes).toEqual([]);
    expect(res.data.failures).toEqual([{ editId: 'e1', code: 'VALIDATION_FAILED', message: CREDIT_BULK_REFUSED_MESSAGE }]);
    expectNothingWritten();
  });

  it('a cash application in the same bulk run is still approved', async () => {
    h.rows.set('e1', credit('e1'));
    h.rows.set('e2', cash('e2'));
    h.guarantees.set('e2', []);
    const res = await bulkApproveEditsAction(
      form({
        decisions: JSON.stringify([
          { editId: 'e1', decisionToken: tokenOf(credit('e1')) },
          { editId: 'e2', decisionToken: tokenOf(cash('e2')) },
        ]),
      })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.successes).toEqual(['e2']);
    expect(res.data.failures.map((x) => x.editId)).toEqual(['e1']);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany.mock.calls[0]![0].where).toMatchObject({ id: 'e2' });
  });

  it('the same credit application is approved from its own page', async () => {
    h.rows.set('e1', credit('e1'));
    const res = await approve('e1', tokenOf(credit('e1')));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it('a bulk reject of a credit application is still allowed: a rejection grants nothing', async () => {
    h.rows.set('e1', credit('e1'));
    const res = await bulkRejectEditsAction(
      form({
        decisions: JSON.stringify([{ editId: 'e1', decisionToken: tokenOf(credit('e1')) }]),
        reason: 'Credit figures need rework.',
        category: 'wrong_info',
      })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.data.successes).toEqual(['e1']);
  });
});
