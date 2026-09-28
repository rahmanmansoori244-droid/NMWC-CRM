/**
 * N01 / X-APPR-1 / X-APPR-2 (auditor recheck, 2026-09-27): the two approval
 * pages hand their client components a decision token made from the very row
 * they render, the credit figures the queue card shows, and the words for what
 * approving the current step does.
 *
 * The pages are rendered with their database and session mocked. The queue's
 * mocked query honours the page's `select`, so a token field the page forgot
 * to select arrives as undefined here exactly as it would from Prisma.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EditProcess, PaymentTerms, Prisma } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { decisionView, parseDecisionToken, type DecisionRow } from '@/lib/decision-token';

const h = vi.hoisted(() => ({
  role: 'FINANCE_MANAGER',
  edit: null as unknown,
  queueRows: [] as Array<Record<string, unknown>>,
  actionProps: [] as Array<Record<string, unknown>>,
  queueItems: [] as Array<Record<string, unknown>>,
}));

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
    attachment: { findMany: async () => [] },
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
    expect(parseDecisionToken(props.decisionToken)).toEqual(decisionView(row as unknown as DecisionRow));
    // X-APPR-1: the figures bound are the figures printed.
    expect(screen.getByText('OMR 10000.000')).toBeTruthy();
    expect(screen.getByText('90 days')).toBeTruthy();
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
    expect(parseDecisionToken(c!.decisionToken)).toEqual(decisionView(credit as unknown as DecisionRow));
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
    });
  });
});
