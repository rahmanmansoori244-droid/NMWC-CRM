/**
 * The approval screens' side of N01, X-APPR-1 and X-APPR-2 (auditor recheck,
 * 2026-09-27), on the real client components with the server actions mocked:
 *
 *   N01      every approve and reject — single and bulk — sends the decision
 *            token the page rendered, and a refusal (STALE_VIEW, or a missing
 *            token) is shown, never swallowed.
 *   X-APPR-1 a credit application's requested limit and term are on its queue
 *            card, where Select all → Approve used to decide them unseen.
 *   X-APPR-2 the approve confirmation says what approving this step does: send
 *            it on, create the customer, or change a live one.
 *
 * The pages that render the tokens are in approval-decision-pages.test.tsx; the
 * services that check them are in decision-token.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MISSING_TOKEN_MESSAGE, STALE_VIEW_MESSAGE } from '@/lib/decision-token';

const h = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  bulkApprove: vi.fn(),
  bulkReject: vi.fn(),
}));

vi.mock('@/services/edits', () => ({
  approveEditAndGoAction: h.approve,
  rejectEditAndGoAction: h.reject,
  bulkApproveEditsAction: h.bulkApprove,
  bulkRejectEditsAction: h.bulkReject,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import {
  ApproveRejectActions,
  approveConfirmCopy,
  type ApproveOutcome,
} from '@/app/(app)/approvals/[id]/ApproveRejectActions';
import { BulkApprovalQueue, type ApprovalQueueItem } from '@/app/(app)/approvals/BulkApprovalQueue';

const TOKEN = '{"v":1,"cycle":2,"step":1,"stage":1758618900789,"limit":"10000.000","days":90}';
const formOf = (fn: ReturnType<typeof vi.fn>) => Object.fromEntries((fn.mock.calls[0]![0] as FormData).entries());

beforeEach(() => {
  h.approve.mockReset().mockResolvedValue(undefined);
  h.reject.mockReset().mockResolvedValue(undefined);
  h.bulkApprove.mockReset().mockResolvedValue({ ok: true, data: { successes: [], failures: [], notAttempted: [] } });
  h.bulkReject.mockReset().mockResolvedValue({ ok: true, data: { successes: [], failures: [], notAttempted: [] } });
});
afterEach(cleanup);

function renderActions(outcome: ApproveOutcome = { kind: 'APPLY' }) {
  return render(<ApproveRejectActions editId="e1" decisionToken={TOKEN} outcome={outcome} />);
}
async function approveThroughModal() {
  fireEvent.click(screen.getByRole('button', { name: '✓ Approve' }));
  const dialog = screen.getByRole('dialog');
  const buttons = within(dialog).getAllByRole('button');
  // The last button in the card is the confirm button (backdrop, Cancel, Confirm).
  fireEvent.click(buttons[buttons.length - 1]!);
  await waitFor(() => expect(h.approve).toHaveBeenCalledTimes(1));
}
async function rejectWithReason() {
  fireEvent.click(screen.getByRole('button', { name: '✗ Reject' }));
  fireEvent.change(screen.getByPlaceholderText(/Be specific/), { target: { value: 'Credit figures need rework.' } });
  fireEvent.click(screen.getByRole('button', { name: /Send back/ }));
  await waitFor(() => expect(h.reject).toHaveBeenCalledTimes(1));
}

describe('N01 — the single-request page sends its token with every decision', () => {
  it('approve sends the id and the token the page rendered', async () => {
    renderActions();
    await approveThroughModal();
    expect(formOf(h.approve)).toEqual({ editId: 'e1', decisionToken: TOKEN });
  });

  it('reject sends them too, with the reason and category', async () => {
    renderActions();
    await rejectWithReason();
    expect(formOf(h.reject)).toEqual({
      editId: 'e1',
      decisionToken: TOKEN,
      category: 'other',
      reason: 'Credit figures need rework.',
    });
  });

  it('a STALE_VIEW refusal is shown', async () => {
    h.approve.mockResolvedValue({ ok: false, code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE });
    renderActions();
    await approveThroughModal();
    expect(await screen.findByText(STALE_VIEW_MESSAGE)).toBeTruthy();
  });

  it('a missing-token refusal is shown on both paths, though it names a field the form has no input for', async () => {
    const res = {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: MISSING_TOKEN_MESSAGE,
      fields: { decisionToken: MISSING_TOKEN_MESSAGE },
    };
    h.approve.mockResolvedValue(res);
    renderActions();
    await approveThroughModal();
    expect(await screen.findByText(MISSING_TOKEN_MESSAGE)).toBeTruthy();
    cleanup();

    h.reject.mockResolvedValue(res);
    renderActions();
    await rejectWithReason();
    expect(await screen.findByText(MISSING_TOKEN_MESSAGE)).toBeTruthy();
  });

  it('a reason error still sits under the reason box', async () => {
    h.reject.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { reason: 'Reason must be 5–1000 characters.' },
    });
    renderActions();
    await rejectWithReason();
    expect(await screen.findByText('Reason must be 5–1000 characters.')).toBeTruthy();
    expect(screen.queryByText('Validation failed')).toBeNull();
  });
});

describe('X-APPR-2 — the approve confirmation says what this step does', () => {
  const cases: Array<[ApproveOutcome, RegExp, RegExp]> = [
    [{ kind: 'ADVANCE', nextRole: 'FINANCE_MANAGER' }, /^Send on to Finance Manager\?$/, /moves to the Finance Manager step/],
    [{ kind: 'ADVANCE', nextRole: 'ACCOUNTANT' }, /^Send on to Accountant\?$/, /Nothing is written to the customer master/],
    [{ kind: 'CREATE' }, /^Create this customer\?$/, /new customer is created in the customer master now/],
    [{ kind: 'APPLY' }, /^Approve this edit\?$/, /Changes will go live on the customer immediately/],
  ];

  it.each(cases)('%j', (outcome, title, message) => {
    renderActions(outcome);
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toMatch(title);
    expect(dialog.textContent).toMatch(message);
  });

  it('only a change to a live customer says it goes live', () => {
    for (const [outcome] of cases) {
      const copy = approveConfirmCopy(outcome);
      expect(/go live/i.test(`${copy.title} ${copy.message}`), JSON.stringify(outcome)).toBe(outcome.kind === 'APPLY');
    }
  });
});

describe('the bulk queue', () => {
  const item = (id: string, over: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem => ({
    id,
    decisionToken: `token-of-${id}`,
    ageHours: 3,
    changesCount: 0,
    manualGps: false,
    sla: null,
    escalationLevel: 0,
    isCreate: true,
    paymentTerms: 'CASH',
    credit: null,
    customer: { legalName: `Shop ${id}`, nmwcCode: 'NEW', completenessScore: 0 },
    submittedByFullName: 'Salesman One',
    ...over,
  });
  const ITEMS = [
    item('c1', { paymentTerms: 'CREDIT', credit: { limit: '10000.000', termDays: 90 } }),
    item('c2'),
    item('u1', { isCreate: false, paymentTerms: null, changesCount: 2, customer: { legalName: 'Shop u1', nmwcCode: 'NMWC-000123', completenessScore: 70 } }),
  ];

  it('X-APPR-1: a credit application shows its requested limit and term on the card, and only it', () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    const lines = screen.getAllByText(/^Requested credit:/);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe('Requested credit: OMR 10000.000 · 90 days');
    expect(lines[0]!.closest('li')!.textContent).toContain('Shop c1');
  });

  it('a credit application with no figures says so rather than showing nothing', () => {
    render(<BulkApprovalQueue items={[item('c3', { paymentTerms: 'CREDIT', credit: { limit: null, termDays: null } })]} />);
    expect(screen.getByText(/^Requested credit:/).textContent).toBe('Requested credit: no limit given · no term given');
  });

  it('N01: bulk approve sends each selected card with its own token, and no bare id list', async () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    fireEvent.click(screen.getByLabelText('Select all on page'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve 3' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 3' }));
    await waitFor(() => expect(h.bulkApprove).toHaveBeenCalledTimes(1));
    const fd = h.bulkApprove.mock.calls[0]![0] as FormData;
    expect(fd.get('editIds')).toBeNull();
    expect(JSON.parse(String(fd.get('decisions')))).toEqual([
      { editId: 'c1', decisionToken: 'token-of-c1' },
      { editId: 'c2', decisionToken: 'token-of-c2' },
      { editId: 'u1', decisionToken: 'token-of-u1' },
    ]);
  });

  it('N01: bulk reject too', async () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    fireEvent.click(screen.getByLabelText('Select edit for Shop c2'));
    fireEvent.click(screen.getByRole('button', { name: '✗ Reject 1' }));
    fireEvent.change(screen.getByPlaceholderText(/Be specific/), { target: { value: 'Photos are blurry, retake.' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject 1' }));
    await waitFor(() => expect(h.bulkReject).toHaveBeenCalledTimes(1));
    const fd = h.bulkReject.mock.calls[0]![0] as FormData;
    expect(fd.get('editIds')).toBeNull();
    expect(JSON.parse(String(fd.get('decisions')))).toEqual([{ editId: 'c2', decisionToken: 'token-of-c2' }]);
    expect(fd.get('reason')).toBe('Photos are blurry, retake.');
  });

  it('a card refused as stale is reported with its message', async () => {
    h.bulkApprove.mockResolvedValue({
      ok: true,
      data: { successes: ['c2'], failures: [{ editId: 'c1', code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE }], notAttempted: [] },
    });
    render(<BulkApprovalQueue items={ITEMS} />);
    fireEvent.click(screen.getByLabelText('Select all on page'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve 3' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 3' }));
    expect(await screen.findByText(/1 processed, 1 failed/)).toBeTruthy();
    expect(screen.getByText(new RegExp(STALE_VIEW_MESSAGE.slice(0, 30)))).toBeTruthy();
  });
});
