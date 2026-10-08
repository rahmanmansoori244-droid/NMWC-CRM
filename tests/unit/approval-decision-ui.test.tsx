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
 *   Reject   the reject form says where rejecting this step sends the request:
 *            back one step to the previous approver, or to the salesman; the
 *            bulk dialog, deciding many at once, words both rules.
 *   Temix    owner decision 2026-10-08: the last step of a new-customer request
 *            asks for the Temix code the Accountant gave it in Temix, sends it,
 *            and its card in the queue is locked like a credit card.
 *
 * The pages that render the tokens are in approval-decision-pages.test.tsx; the
 * services that check them are in decision-token.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { getRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError, RedirectType } from 'next/dist/client/components/redirect-error';
import { MISSING_TOKEN_MESSAGE, STALE_VIEW_MESSAGE } from '@/lib/decision-token';
import {
  BULK_DECISION_LIMIT,
  BULK_DECISION_LIMIT_MESSAGE,
  CREDIT_BULK_REFUSED_MESSAGE,
  TEMIX_CODE_BULK_REFUSED_MESSAGE,
} from '@/lib/bulk-run';
import {
  TEMIX_CODE_CRM_MESSAGE,
  TEMIX_CODE_REQUIRED_MESSAGE,
  TEMIX_CODE_SHAPE_MESSAGE,
  TEMIX_CODE_SPACES_MESSAGE,
} from '@/lib/temix-code';

const h = vi.hoisted(() => ({
  approve: vi.fn(),
  approveStay: vi.fn(),
  refresh: vi.fn(),
  reject: vi.fn(),
  bulkApprove: vi.fn(),
  bulkReject: vi.fn(),
}));

vi.mock('@/services/edits', () => ({
  approveEditAndGoAction: h.approve,
  approveEditAction: h.approveStay,
  rejectEditAndGoAction: h.reject,
  bulkApproveEditsAction: h.bulkApprove,
  bulkRejectEditsAction: h.bulkReject,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  // The real one: it decides which errors are Next's to handle.
  unstable_rethrow: (await importOriginal<typeof import('next/navigation')>()).unstable_rethrow,
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh }),
}));
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
  type RejectOutcome,
} from '@/app/(app)/approvals/[id]/ApproveRejectActions';
import { BulkApprovalQueue, type ApprovalQueueItem } from '@/app/(app)/approvals/BulkApprovalQueue';
import { resolveRejectTarget } from '@/lib/approval-chains';

const TOKEN = '{"v":1,"cycle":2,"step":1,"stage":1758618900789,"limit":"10000.000","days":90}';
const formOf = (fn: ReturnType<typeof vi.fn>) => Object.fromEntries((fn.mock.calls[0]![0] as FormData).entries());

beforeEach(() => {
  h.approve.mockReset().mockResolvedValue(undefined);
  h.approveStay.mockReset().mockResolvedValue({ ok: true });
  h.refresh.mockReset();
  h.reject.mockReset().mockResolvedValue(undefined);
  h.bulkApprove.mockReset().mockResolvedValue({ ok: true, data: { successes: [], failures: [], notAttempted: [] } });
  h.bulkReject.mockReset().mockResolvedValue({ ok: true, data: { successes: [], failures: [], notAttempted: [] } });
});
afterEach(cleanup);

function renderActions(
  outcome: ApproveOutcome = { kind: 'APPLY' },
  rejectOutcome: RejectOutcome = { kind: 'TO_SALESMAN' }
) {
  return render(
    <ApproveRejectActions editId="e1" decisionToken={TOKEN} outcome={outcome} rejectOutcome={rejectOutcome} />
  );
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

describe("launch fix — the redirect back to the queue is Next's to follow, not a message", () => {
  // On success approveEditAndGoAction and rejectEditAndGoAction redirect('/approvals').
  // Next 15.5's client rejects the awaited action with its NEXT_REDIRECT error so
  // its RedirectBoundary finishes the move; the catch printed that error's
  // message in red under the buttons until the queue loaded (launch browser suite).
  let caught: unknown[] = [];
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    override componentDidCatch(error: unknown) {
      caught.push(error);
    }
    override render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  function renderInBoundary() {
    return render(
      <Boundary>
        <ApproveRejectActions
          editId="e1"
          decisionToken={TOKEN}
          outcome={{ kind: 'APPLY' }}
          rejectOutcome={{ kind: 'TO_SALESMAN' }}
        />
      </Boundary>
    );
  }
  beforeEach(() => {
    caught = [];
    // React reports the error it hands a boundary on console.error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['approve', h.approve, approveThroughModal],
    ['send back', h.reject, rejectWithReason],
  ] as const)('%s: the redirect goes on to Next and "NEXT_REDIRECT" is never shown', async (_name, action, decide) => {
    action.mockRejectedValue(getRedirectError('/approvals', RedirectType.push));
    renderInBoundary();
    await decide();
    await waitFor(() => expect(caught).toHaveLength(1));
    expect(isRedirectError(caught[0])).toBe(true);
    expect(screen.queryByText(/NEXT_REDIRECT/)).toBeNull();
  });

  it.each([
    ['approve', h.approve, approveThroughModal],
    ['send back', h.reject, rejectWithReason],
  ] as const)('%s: any other failure is still shown in place', async (_name, action, decide) => {
    action.mockRejectedValue(new Error('The server did not answer.'));
    renderInBoundary();
    await decide();
    expect(await screen.findByText('The server did not answer.')).toBeTruthy();
    expect(caught).toHaveLength(0);
  });
});

/** Owner decision 2026-10-08: the Accountant types the Temix code he created the customer under. */
function typeTemixCode(value: string) {
  fireEvent.change(screen.getByLabelText('Temix code *'), { target: { value } });
}

describe('launch fix — "Approve and create" stays on the request, which then shows the new code', () => {
  async function confirm() {
    typeTemixCode('CAA0367');
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve' }));
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]!);
  }

  it('the last step of a new-customer request approves without leaving, then refreshes this page', async () => {
    renderActions({ kind: 'CREATE' });
    await confirm();
    await waitFor(() => expect(h.approveStay).toHaveBeenCalledTimes(1));
    expect(formOf(h.approveStay)).toEqual({ editId: 'e1', decisionToken: TOKEN, temixCode: 'CAA0367' });
    expect(h.approve).not.toHaveBeenCalled();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    // Until the refreshed page lands, nothing can be tapped again: a second
    // Approve answered the Accountant "already APPROVED" (review finding).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Created — loading…' })).toBeDisabled());
    expect(screen.getByRole('button', { name: '✗ Reject' })).toBeDisabled();
    expect(h.approveStay).toHaveBeenCalledTimes(1);
  });

  it('a refusal is shown and nothing is refreshed', async () => {
    h.approveStay.mockResolvedValue({ ok: false, code: 'DUPLICATE_CR', message: 'Already a customer.' });
    renderActions({ kind: 'CREATE' });
    await confirm();
    expect(await screen.findByText('Already a customer.')).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('every other approval still returns to the queue in one round trip', async () => {
    for (const outcome of [{ kind: 'APPLY' }, { kind: 'ADVANCE', nextRole: 'ACCOUNTANT' }] as const) {
      h.approve.mockClear();
      renderActions(outcome);
      await approveThroughModal();
      expect(h.approveStay).not.toHaveBeenCalled();
      cleanup();
    }
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
    if (outcome.kind === 'CREATE') typeTemixCode('CAA0367');
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

describe('owner decision 2026-10-08 — the Temix code at the last step of a new-customer request', () => {
  function openConfirm() {
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve' }));
    return screen.queryByRole('dialog');
  }
  async function confirmCreate() {
    const dialog = openConfirm()!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and create' }));
    await waitFor(() => expect(h.approveStay).toHaveBeenCalledTimes(1));
  }

  it('only the last step of a new-customer request asks for it', () => {
    renderActions({ kind: 'CREATE' });
    const box = screen.getByLabelText('Temix code *');
    expect(box.getAttribute('aria-describedby')).toBe('temix-code-help');
    expect(screen.getByText('Create the customer in Temix first, then type the code Temix gave it.')).toBeTruthy();
    for (const outcome of [{ kind: 'APPLY' }, { kind: 'ADVANCE', nextRole: 'ACCOUNTANT' }] as const) {
      cleanup();
      renderActions(outcome);
      expect(screen.queryByLabelText('Temix code *')).toBeNull();
    }
  });

  it('without one, Approve says it is needed and asks nothing else', () => {
    renderActions({ kind: 'CREATE' });
    expect(openConfirm()).toBeNull();
    expect(screen.getByText(TEMIX_CODE_REQUIRED_MESSAGE)).toBeTruthy();
    const box = screen.getByLabelText('Temix code *');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    // Read out with the box: the message is one of what describes it.
    expect(box.getAttribute('aria-describedby')).toBe('temix-code-help temix-code-error');
    expect(document.getElementById('temix-code-error')!.textContent).toBe(TEMIX_CODE_REQUIRED_MESSAGE);
    expect(h.approveStay).not.toHaveBeenCalled();
  });

  it.each([
    ['CAA 0367', TEMIX_CODE_SPACES_MESSAGE],
    ['=CAA0367', TEMIX_CODE_SHAPE_MESSAGE],
    // The new customer's own NMWC code, or any other code of this CRM.
    ['nmwc-2026-000123', TEMIX_CODE_CRM_MESSAGE],
  ])('%j is refused under the box before anything is sent', (typed, message) => {
    renderActions({ kind: 'CREATE' });
    typeTemixCode(typed);
    expect(openConfirm()).toBeNull();
    expect(screen.getByText(message)).toBeTruthy();
    // Typing again clears it.
    typeTemixCode('CAA0367');
    expect(screen.queryByText(message)).toBeNull();
  });

  it('the confirmation names the code, and the code is sent as Temix codes are stored', async () => {
    renderActions({ kind: 'CREATE' });
    typeTemixCode(' caa\u0660367 ');
    const dialog = openConfirm()!;
    expect(dialog.textContent).toMatch(/created in the customer master now, as shown on this page, with Temix code CAA0367\./);
    await confirmCreate();
    expect(formOf(h.approveStay)).toEqual({ editId: 'e1', decisionToken: TOKEN, temixCode: 'CAA0367' });
  });

  it("the server's refusal of the code (a customer has it) is shown under the box, not at the top", async () => {
    const taken = 'Temix code CAA0367 already belongs to customer NMWC-2026-000012. Check the code in Temix: every customer has its own.';
    h.approveStay.mockResolvedValue({ ok: false, code: 'TEMIX_CODE_TAKEN', message: taken, fields: { temixCode: taken } });
    renderActions({ kind: 'CREATE' });
    typeTemixCode('CAA0367');
    await confirmCreate();
    const shown = await screen.findByText(taken);
    expect(shown.previousElementSibling!.id).toBe('temix-code-help');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('every other approval sends no code', async () => {
    renderActions({ kind: 'ADVANCE', nextRole: 'ACCOUNTANT' });
    await approveThroughModal();
    expect(formOf(h.approve)).toEqual({ editId: 'e1', decisionToken: TOKEN });
  });

  it('the confirmation copy without a code is unchanged for every outcome', () => {
    expect(approveConfirmCopy({ kind: 'CREATE' }).message).toBe(
      'This is the final approval: the new customer is created in the customer master now, as shown on this page. This cannot be undone.'
    );
  });
});

describe('the reject form says where rejecting this step sends the request', () => {
  /** Open the reject form and read its words: the reason label, the placeholder, the send button. */
  function openReject(rejectOutcome: RejectOutcome) {
    renderActions({ kind: 'APPLY' }, rejectOutcome);
    fireEvent.click(screen.getByRole('button', { name: '✗ Reject' }));
    const form = screen.getByRole('textbox').closest('form')!;
    return {
      form,
      label: form.querySelector('textarea')!.parentElement!.querySelector('label')!.textContent,
      placeholder: screen.getByRole('textbox').getAttribute('placeholder'),
      send: within(form).getByRole('button', { name: /^✗ Send back to/ }),
    };
  }

  it.each([
    ['SUPERVISOR', 'Supervisor'],
    ['FINANCE_MANAGER', 'Finance Manager'],
    ['GM', 'GM'],
  ])('a step back to %s names that role, and not the salesman, as who gets it', (toRole, name) => {
    const f = openReject({ kind: 'STEP_BACK', toRole });
    expect(f.send.textContent).toBe(`✗ Send back to ${name}`);
    expect(f.label).toBe(`Reason for the ${name} *`);
    expect(f.placeholder).toMatch(new RegExp(`^Be specific so the ${name} knows what to re-check\\.`));
    expect(f.placeholder).toContain('not to the salesman');
    expect(within(f.form).queryByRole('button', { name: /salesman/i })).toBeNull();
    expect(f.label).not.toMatch(/salesman/i);
  });

  it('a rejection that goes to the salesman keeps the salesman wording', () => {
    const f = openReject({ kind: 'TO_SALESMAN' });
    expect(f.send.textContent).toBe('✗ Send back to salesman');
    expect(f.label).toBe('Reason for the salesman *');
    expect(f.placeholder).toBe('Be specific so the salesman knows what to fix.');
  });

  it('a step back still sends the same decision', async () => {
    renderActions({ kind: 'ADVANCE', nextRole: 'GM' }, { kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
    await rejectWithReason();
    expect(formOf(h.reject)).toEqual({
      editId: 'e1',
      decisionToken: TOKEN,
      category: 'other',
      reason: 'Credit figures need rework.',
    });
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
    needsTemixCode: false,
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

  it('owner decision 2026-10-05: a credit application has no tick box, and Select all leaves it out', () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    expect(screen.queryByLabelText('Select edit for Shop c1')).toBeNull();
    const lock = screen.getByRole('img', { name: 'Credit application: open it to decide' });
    expect(lock.getAttribute('title')).toBe(CREDIT_BULK_REFUSED_MESSAGE);
    const card = lock.closest('li')!;
    expect(card.textContent).toContain('Shop c1');
    // It still opens on its own page, where it is decided.
    expect(card.querySelector('a')!.getAttribute('href')).toBe('/approvals/c1');
    fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
    expect(screen.getByRole('button', { name: '✓ Approve 2' })).toBeTruthy();
  });

  it('owner decision 2026-10-08: a new customer at its last step has a lock instead of a tick box, and Select all leaves it out', () => {
    const items = [item('k-last', { needsTemixCode: true }), item('k-sup'), ITEMS[2]!];
    render(<BulkApprovalQueue items={items} />);
    expect(screen.queryByLabelText('Select edit for Shop k-last')).toBeNull();
    const lock = screen.getByRole('img', { name: 'Enter its Temix code: open it to approve' });
    expect(lock.getAttribute('title')).toBe(TEMIX_CODE_BULK_REFUSED_MESSAGE);
    const card = lock.closest('li')!;
    expect(card.textContent).toContain('Shop k-last');
    expect(card.querySelector('a')!.getAttribute('href')).toBe('/approvals/k-last');
    // A cash request at the Supervisor step keeps its tick box.
    expect(screen.getByLabelText('Select edit for Shop k-sup')).toBeTruthy();
    expect(
      screen.getByText(
        'New customers at their last step are approved one at a time: open each card marked with a lock and enter its Temix code.'
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
    expect(screen.getByRole('button', { name: '✓ Approve 2' })).toBeTruthy();
  });

  it("an Accountant's queue — every card at its last step — shows no dead Select all; a credit card there keeps the credit lock", () => {
    render(
      <BulkApprovalQueue
        items={[
          item('k1', { needsTemixCode: true }),
          item('c9', { needsTemixCode: true, paymentTerms: 'CREDIT', credit: { limit: '500.000', termDays: 30 } }),
        ]}
      />
    );
    expect(screen.queryByLabelText('Select up to 50 on this page')).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Enter its Temix code: open it to approve' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'Credit application: open it to decide' })).toHaveLength(1);
  });

  it('no card at its last step, no Temix note', () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    expect(screen.queryByText(/enter its Temix code/)).toBeNull();
  });

  it('a page with credit cards says, in words, that they are decided one at a time', () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    expect(screen.getByText(/Credit applications are approved one at a time/)).toBeTruthy();
    cleanup();
    render(<BulkApprovalQueue items={[item('c2')]} />);
    expect(screen.queryByText(/Credit applications are approved one at a time/)).toBeNull();
  });

  it('a queue of credit applications only (the Finance Manager’s, the GM’s) shows no dead Select all', () => {
    render(<BulkApprovalQueue items={[item('c1', { paymentTerms: 'CREDIT' }), item('c4', { paymentTerms: 'CREDIT' })]} />);
    expect(screen.queryByLabelText('Select up to 50 on this page')).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Credit application: open it to decide' })).toHaveLength(2);
  });

  it('N01: bulk approve sends each selected card with its own token, and no bare id list', async () => {
    render(<BulkApprovalQueue items={ITEMS} />);
    fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve 2' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 2' }));
    await waitFor(() => expect(h.bulkApprove).toHaveBeenCalledTimes(1));
    const fd = h.bulkApprove.mock.calls[0]![0] as FormData;
    expect(fd.get('editIds')).toBeNull();
    // c1 is a credit application: never in a bulk action (owner decision 2026-10-05).
    expect(JSON.parse(String(fd.get('decisions')))).toEqual([
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

  it('the reject dialog words both rules rejecting follows — the step back and the loop guard — and names nobody for the reason', () => {
    // The rules the words describe (rejectEditCore): the first step goes to the
    // salesman, a later one steps back, and a step that already rejected the
    // request once this round sends it to the salesman.
    expect(resolveRejectTarget(0, 0)).toEqual({ kind: 'TO_SALESMAN' });
    expect(resolveRejectTarget(2, 0)).toEqual({ kind: 'STEP_BACK', toStepIndex: 1 });
    expect(resolveRejectTarget(2, 1)).toEqual({ kind: 'TO_SALESMAN' });

    render(<BulkApprovalQueue items={ITEMS} />);
    fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
    fireEvent.click(screen.getByRole('button', { name: '✗ Reject 2' }));
    const dialog = screen.getByRole('dialog');
    const words = dialog.textContent!.replace(/\s+/g, ' ');
    expect(words).toMatch(/goes back to the previous approver/);
    expect(words).toMatch(/to the salesman when it is at the first step/);
    // The loop guard: it said "previous approver" for a step's second rejection,
    // and the server sent that request to the salesman.
    expect(words).toMatch(/when this step has already rejected it once since the salesman last sent it/);
    // The reason goes to whoever gets the request back, not always a salesman.
    const reason = within(dialog).getByRole('textbox');
    expect(reason.closest('label')!.textContent).not.toMatch(/salesm[ae]n/i);
    expect(reason.getAttribute('placeholder')).not.toMatch(/salesm[ae]n/i);
  });

  it('a card refused as stale is reported with its message', async () => {
    h.bulkApprove.mockResolvedValue({
      ok: true,
      data: { successes: ['c2'], failures: [{ editId: 'u1', code: 'STALE_VIEW', message: STALE_VIEW_MESSAGE }], notAttempted: [] },
    });
    render(<BulkApprovalQueue items={ITEMS} />);
    fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Approve 2' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 2' }));
    expect(await screen.findByText(/1 processed, 1 failed/)).toBeTruthy();
    expect(screen.getByText(new RegExp(STALE_VIEW_MESSAGE.slice(0, 30)))).toBeTruthy();
  });

  describe('Select all stops at the bulk limit', () => {
    const CAPPED = `Selected the first ${BULK_DECISION_LIMIT} — the limit per action.`;
    const many = (n: number) => Array.from({ length: n }, (_, i) => item(`q${String(i).padStart(3, '0')}`));

    it('a queue of 60: the first 50 in the order shown are selected, and it says so', async () => {
      const items = many(60);
      render(<BulkApprovalQueue items={items} />);
      fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
      expect(screen.getByRole('status').textContent).toBe(CAPPED);
      expect(screen.getByRole('button', { name: `✓ Approve ${BULK_DECISION_LIMIT}` })).toBeTruthy();
      const ticked = items.filter((i) => (screen.getByLabelText(`Select edit for Shop ${i.id}`) as HTMLInputElement).checked);
      expect(ticked.map((i) => i.id)).toEqual(items.slice(0, BULK_DECISION_LIMIT).map((i) => i.id));
      // The header box reads as checked, so the next click deselects them.
      expect((screen.getByLabelText('Select up to 50 on this page') as HTMLInputElement).checked).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: `✓ Approve ${BULK_DECISION_LIMIT}` }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: `Approve ${BULK_DECISION_LIMIT}` }));
      await waitFor(() => expect(h.bulkApprove).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(String((h.bulkApprove.mock.calls[0]![0] as FormData).get('decisions')));
      expect(sent).toEqual(
        items.slice(0, BULK_DECISION_LIMIT).map((i) => ({ editId: i.id, decisionToken: i.decisionToken }))
      );
    });

    it('Deselect all clears it, and the note goes with it', () => {
      render(<BulkApprovalQueue items={many(60)} />);
      fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
      fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getAllByText('0 selected')).toHaveLength(1);
    });

    it('the note is only for exactly the first 50 of a longer queue', () => {
      render(<BulkApprovalQueue items={many(60)} />);
      fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
      // One more ticked by hand: no longer "the first 50".
      fireEvent.click(screen.getByLabelText('Select edit for Shop q055'));
      expect(screen.queryByRole('status')).toBeNull();
      cleanup();

      // A queue at the limit is selected whole, with nothing to explain.
      render(<BulkApprovalQueue items={many(BULK_DECISION_LIMIT)} />);
      fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
      expect(screen.getAllByText(`${BULK_DECISION_LIMIT} selected`).length).toBeGreaterThan(0);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it("the server's refusal of a longer list is shown with what to do, not counted as one failed request", async () => {
      h.bulkApprove.mockResolvedValue({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: BULK_DECISION_LIMIT_MESSAGE,
        fields: { decisions: BULK_DECISION_LIMIT_MESSAGE },
      });
      render(<BulkApprovalQueue items={ITEMS} />);
      fireEvent.click(screen.getByLabelText('Select up to 50 on this page'));
      fireEvent.click(screen.getByRole('button', { name: '✓ Approve 2' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 2' }));
      expect(await screen.findByText(BULK_DECISION_LIMIT_MESSAGE)).toBeTruthy();
      expect(screen.getByText('Nothing was processed.')).toBeTruthy();
      expect(screen.queryByText(/processed, 1 failed/)).toBeNull();
      // The selection stays, to be cut down and sent again. Found, not got: the refusal
      // can render while the transition still shows "Working…" on that button, and a
      // loaded machine lets the test look in between.
      expect(await screen.findByRole('button', { name: '✓ Approve 2' })).toBeTruthy();
    });
  });
});
