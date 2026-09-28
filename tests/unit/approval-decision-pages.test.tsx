/**
 * N01 / X-APPR-1 / X-APPR-2 (auditor recheck, 2026-09-27): the two approval
 * pages hand their client components a decision token made from the very row
 * they render, the credit figures the queue card shows, and the words for what
 * approving the current step does.
 *
 * The pages are rendered with their database and session mocked. The queue's
 * mocked query honours the page's `select`, so a token field the page forgot
 * to select arrives as undefined here exactly as it would from Prisma.
 *
 * A new-customer request's token also binds the live guarantee documents the
 * page listed; the mocked attachment table answers the guarantee queries the
 * way Postgres would — live GUARANTEE rows of the requests asked about.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EditProcess, PaymentTerms, Prisma } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { decisionView, guaranteeDigest, parseDecisionToken, type DecisionRow } from '@/lib/decision-token';

type Att = { id: string; editId: string; kind: string; deletedAt: Date | null };
const h = vi.hoisted(() => ({
  role: 'FINANCE_MANAGER',
  edit: null as unknown,
  queueRows: [] as Array<Record<string, unknown>>,
  actionProps: [] as Array<Record<string, unknown>>,
  queueItems: [] as Array<Record<string, unknown>>,
  attachments: [] as Array<{ id: string; editId: string; kind: string; deletedAt: Date | null }>,
}));

/** The attachment table, for a `where` of { editId | editId.in, kind, deletedAt: null }. */
function attachmentsFor(where: { editId?: string | { in: string[] }; kind?: string; deletedAt?: null }): Att[] {
  if (where.editId === undefined) return [];
  const ids = typeof where.editId === 'string' ? [where.editId] : where.editId.in;
  return h.attachments.filter(
    (a) =>
      ids.includes(a.editId) &&
      (where.kind === undefined || a.kind === where.kind) &&
      (where.deletedAt !== null || a.deletedAt === null)
  );
}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-viewer', role: h.role, username: 'viewer.x' } }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ managedRegionIds: ['g1'] }),
  filterBranchesByScope: (_u: unknown, branches: unknown[]) => branches,
}));

/** Prisma's `select`, applied: only the selected keys come back. */
function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const nested = row[k] as Record<string, unknown> | null | undefined;
      out[k] = nested == null ? nested : project(nested, (v as { select: Record<string, unknown> }).select);
    }
  }
  return out;
}
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: {
      findUnique: async () => h.edit,
      findMany: async (args: { select: Record<string, unknown> }) => h.queueRows.map((r) => project(r, args.select)),
    },
    attachment: {
      findMany: async (args: { where: Parameters<typeof attachmentsFor>[0] }) =>
        attachmentsFor(args.where).map(({ id, editId }) => ({ id, editId })),
    },
    branch: { findMany: async () => [] },
    channel: { findMany: async () => [] },
    subChannel: { findMany: async () => [] },
  },
}));
vi.mock('@/app/(app)/approvals/[id]/ApproveRejectActions', () => ({
  ApproveRejectActions: (props: Record<string, unknown>) => {
    h.actionProps.push(props);
    return <div data-testid="actions" />;
  },
}));
vi.mock('@/app/(app)/approvals/BulkApprovalQueue', () => ({
  BulkApprovalQueue: ({ items }: { items: Array<Record<string, unknown>> }) => {
    h.queueItems = items;
    return <div data-testid="queue" />;
  },
}));

beforeEach(() => {
  h.role = 'FINANCE_MANAGER';
  h.actionProps = [];
  h.queueItems = [];
  h.attachments = [];
});

const guarantee = (id: string, editId = 'e1', deletedAt: Date | null = null): Att => ({
  id,
  editId,
  kind: 'GUARANTEE',
  deletedAt,
});
afterEach(cleanup);

const STAGE = new Date('2026-09-23T09:15:00.789Z');

function createRow(paymentTerms: 'CASH' | 'CREDIT', currentStepIndex: number, over: Record<string, unknown> = {}) {
  const credit = paymentTerms === 'CREDIT';
  return {
    id: 'e1',
    process: 'CREATE',
    state: 'SUBMITTED',
    customerId: null,
    customer: null,
    approvalChain: resolveChain(EditProcess.CREATE, credit ? PaymentTerms.CREDIT : PaymentTerms.CASH),
    currentStepIndex,
    cycle: 2,
    stageEnteredAt: STAGE,
    slaDueAt: new Date(STAGE.getTime() + 8 * 3600_000),
    escalationLevel: 0,
    submittedAt: new Date('2026-09-22T07:00:00.000Z'),
    requestedCreditLimit: credit ? new Prisma.Decimal('10000') : null,
    requestedPaymentTermDays: credit ? 90 : null,
    fieldChanges: [],
    decisionReason: null,
    reviewedAt: null,
    reviewedBy: null,
    submittedBy: { id: 's1', fullName: 'Salesman One', username: 'salesman.one', supervisorId: 'sup1' },
    steps: [],
    customerDraft: {
      legalName: 'Al Noor Trading',
      crNumber: '1234567',
      paymentTerms,
      channel: { label: 'Retail' },
      subChannel: null,
      primaryPhone: null,
      altPhone: null,
      contactPerson: 'Ali',
      contactRole: null,
      notes: null,
      crPhotoAttachmentId: null,
    },
    branchDrafts: [],
    ...over,
  };
}

async function renderDetail(edit: unknown) {
  h.edit = edit;
  const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
  render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
  expect(h.actionProps).toHaveLength(1);
  return h.actionProps[0]!;
}

describe('the review page', () => {
  it('N01: the token it hands the buttons is the row it rendered', async () => {
    const row = createRow('CREDIT', 1);
    const props = await renderDetail(row);
    expect(props.editId).toBe('e1');
    expect(parseDecisionToken(props.decisionToken)).toEqual(decisionView(row as unknown as DecisionRow, []));
    // X-APPR-1: the figures bound are the figures printed.
    expect(screen.getByText('OMR 10000.000')).toBeTruthy();
    expect(screen.getByText('90 days')).toBeTruthy();
  });

  describe('the reject form is told where a rejection sends the request (lib/approval-chains.ts)', () => {
    /** An EditApproval row as the page loads it. */
    const decided = (stepIndex: number, cycle: number, decision: 'APPROVED' | 'REJECTED', i = 0) => ({
      id: `s-${stepIndex}-${cycle}-${decision}-${i}`,
      stepIndex,
      cycle,
      decision,
      role: 'SUPERVISOR',
      reason: decision === 'REJECTED' ? 'Please re-check.' : null,
      at: new Date('2026-09-22T08:00:00.000Z'),
      actor: { fullName: 'Someone' },
    });
    const rejectOutcomeOf = async (row: unknown) => {
      cleanup();
      h.actionProps = [];
      return (await renderDetail(row)).rejectOutcome;
    };

    it('a later step, the first time this round: one step back, to the previous role', async () => {
      expect(await rejectOutcomeOf(createRow('CREDIT', 1))).toEqual({ kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
      expect(await rejectOutcomeOf(createRow('CREDIT', 2))).toEqual({ kind: 'STEP_BACK', toRole: 'FINANCE_MANAGER' });
      expect(await rejectOutcomeOf(createRow('CREDIT', 3))).toEqual({ kind: 'STEP_BACK', toRole: 'GM' });
      expect(await rejectOutcomeOf(createRow('CASH', 1))).toEqual({ kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
    });

    it('the first step: to the salesman', async () => {
      expect(await rejectOutcomeOf(createRow('CREDIT', 0))).toEqual({ kind: 'TO_SALESMAN' });
    });

    it('a step that already rejected it this round: to the salesman; an earlier round or another step does not count', async () => {
      expect(
        await rejectOutcomeOf(createRow('CREDIT', 1, { steps: [decided(1, 2, 'REJECTED'), decided(0, 2, 'APPROVED')] }))
      ).toEqual({ kind: 'TO_SALESMAN' });
      expect(
        await rejectOutcomeOf(
          createRow('CREDIT', 1, { steps: [decided(1, 1, 'REJECTED'), decided(2, 2, 'REJECTED'), decided(1, 2, 'APPROVED')] })
        )
      ).toEqual({ kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
    });
  });

  it('N01: a credit application binds exactly the guarantee documents it lists — live ones, of this request', async () => {
    h.attachments = [
      guarantee('g-b'),
      guarantee('g-a'),
      guarantee('g-removed', 'e1', new Date()),
      guarantee('g-other', 'e9'),
      { id: 'cr-1', editId: 'e1', kind: 'CR', deletedAt: null },
    ];
    const props = await renderDetail(createRow('CREDIT', 1));
    // What the page shows under "Guarantee documents".
    const row = screen.getByText('Guarantee documents (2)').parentElement!;
    const shown = within(row)
      .getAllByRole('img')
      .map((i) => i.getAttribute('src')!.replace('/api/photos/', ''));
    expect(shown.sort()).toEqual(['g-a', 'g-b']);
    expect(parseDecisionToken(props.decisionToken)!.guarantees).toBe(guaranteeDigest(shown));
  });

  it('N01: an edit of a live customer binds no guarantees', async () => {
    h.role = 'GM';
    h.attachments = [guarantee('g-a')];
    const update = createRow('CASH', 0, {
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [] },
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      customerDraft: null,
    });
    expect(parseDecisionToken((await renderDetail(update)).decisionToken)!.guarantees).toBeNull();
  });

  it('X-APPR-2: a mid-chain step sends it on to the next role', async () => {
    expect((await renderDetail(createRow('CREDIT', 1))).outcome).toEqual({ kind: 'ADVANCE', nextRole: 'GM' });
    cleanup();
    h.actionProps = [];
    expect((await renderDetail(createRow('CASH', 0))).outcome).toEqual({ kind: 'ADVANCE', nextRole: 'ACCOUNTANT' });
  });

  it('X-APPR-2: the final step of a new-customer request creates it', async () => {
    // Viewed by an org-wide role: the words follow the step, not the viewer.
    expect((await renderDetail(createRow('CREDIT', 3))).outcome).toEqual({ kind: 'CREATE' });
    cleanup();
    h.actionProps = [];
    expect((await renderDetail(createRow('CASH', 1))).outcome).toEqual({ kind: 'CREATE' });
  });

  it('X-APPR-2: an edit of a live customer changes it', async () => {
    h.role = 'GM';
    const update = createRow('CASH', 0, {
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [] },
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      customerDraft: null,
      stageEnteredAt: null,
    });
    const props = await renderDetail(update);
    expect(props.outcome).toEqual({ kind: 'APPLY' });
    // A single-step edit: a rejection always goes to the salesman.
    expect(props.rejectOutcome).toEqual({ kind: 'TO_SALESMAN' });
    // A row older than the stage columns: the token carries its null stage.
    expect(parseDecisionToken(props.decisionToken)).toMatchObject({ cycle: 2, stepIndex: 0, stageEnteredAt: null, creditLimit: null });
  });
});

describe('the approval queue', () => {
  async function renderQueue(rows: Array<Record<string, unknown>>) {
    h.queueRows = rows;
    const { default: Page } = await import('@/app/(app)/approvals/page');
    render(await Page());
    expect(screen.getByTestId('queue')).toBeTruthy();
    return h.queueItems;
  }

  it("N01 + X-APPR-1: every card's token is its row, and a credit card carries the same figures", async () => {
    const credit = createRow('CREDIT', 1);
    const cash = { ...createRow('CASH', 0), id: 'e2', stageEnteredAt: null };
    const [c, k] = await renderQueue([credit, cash]);
    expect(c!.id).toBe('e1');
    expect(parseDecisionToken(c!.decisionToken)).toEqual(decisionView(credit as unknown as DecisionRow, []));
    expect(c!.credit).toEqual({ limit: '10000.000', termDays: 90 });
    const bound = parseDecisionToken(c!.decisionToken)!;
    expect([bound.creditLimit, bound.paymentTermDays]).toEqual([
      (c!.credit as { limit: string }).limit,
      (c!.credit as { termDays: number }).termDays,
    ]);

    expect(k!.id).toBe('e2');
    expect(k!.credit).toBeNull();
    expect(parseDecisionToken(k!.decisionToken)).toEqual({
      cycle: 2,
      stepIndex: 0,
      stageEnteredAt: null,
      creditLimit: null,
      paymentTermDays: null,
      // A new-customer request with no guarantee document: bound as none.
      guarantees: guaranteeDigest([]),
    });
  });

  it("N01: each new-customer card binds its own request's live guarantees, read once for the page", async () => {
    h.attachments = [
      guarantee('g-a', 'e1'),
      guarantee('g-b', 'e1'),
      guarantee('g-gone', 'e1', new Date()),
      guarantee('g-c', 'e3'),
    ];
    const credit = createRow('CREDIT', 1);
    const other = { ...createRow('CREDIT', 1), id: 'e3' };
    const update = {
      ...createRow('CASH', 0),
      id: 'u1',
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', completenessScore: 50, paymentTerms: 'CASH' },
      customerDraft: null,
    };
    const cards = await renderQueue([credit, other, update]);
    const bound = (id: string) => parseDecisionToken(cards.find((c) => c.id === id)!.decisionToken)!.guarantees;
    expect(bound('e1')).toBe(guaranteeDigest(['g-a', 'g-b']));
    expect(bound('e3')).toBe(guaranteeDigest(['g-c']));
    expect(bound('u1')).toBeNull();
  });
});
