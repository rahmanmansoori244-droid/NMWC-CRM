/**
 * The one-tap decisions beside the forms say a refusal out loud (launch browser
 * suite follow-up, 8 Oct): a salesman's Withdraw this request and "Nothing to
 * send again — clear this", and a Manager's Archive. Each showed a refusal, or
 * "No answer — we cannot tell…", as a plain line of red text, so a screen
 * reader said nothing after the tap. Each is now an alert.
 *
 * The real components, with their server actions mocked to what runAction returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ withdraw: vi.fn(), clear: vi.fn(), archive: vi.fn(), replace: vi.fn() }));
vi.mock('@/services/creates', () => ({ withdrawCreateAction: h.withdraw }));
vi.mock('@/services/edits', () => ({ clearReturnedEditAction: h.clear }));
vi.mock('@/services/customers', () => ({ archiveCustomerAction: h.archive }));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: h.replace, refresh: vi.fn() }) }));

import { WithdrawRequest } from '@/app/(app)/customers/new/WithdrawRequest';
import { ClearReturned } from '@/app/(app)/rejected/ClearReturned';
import { ArchiveCustomerButton } from '@/app/(app)/customers/[id]/ArchiveCustomerButton';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

/** ConfirmModal's confirm: the last button in its dialog. */
const confirm = () => {
  const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]!);
};

describe('a refused one-tap decision is read out', () => {
  it('Withdraw this request', async () => {
    h.withdraw.mockResolvedValue({ ok: false, code: 'EDIT_LOCKED', message: 'This request is in review, so it cannot be withdrawn now.' });
    render(<WithdrawRequest editId="e1" isDraft={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw this request' }));
    confirm();
    expect((await screen.findByRole('alert')).textContent).toBe('This request is in review, so it cannot be withdrawn now.');
  });

  it('Withdraw with no answer', async () => {
    h.withdraw.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<WithdrawRequest editId="e1" isDraft />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
    confirm();
    expect((await screen.findByRole('alert')).textContent).toMatch(/^No answer — we cannot tell if it was withdrawn/);
  });

  it('Nothing to send again — clear this', async () => {
    h.clear.mockResolvedValue({ ok: false, code: 'STATE_CHANGED', message: 'This request is no longer waiting on you.' });
    render(<ClearReturned editId="e1" then="/rejected" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nothing to send again — clear this' }));
    confirm();
    expect((await screen.findByRole('alert')).textContent).toBe('This request is no longer waiting on you.');
  });

  it('Archive', async () => {
    h.archive.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { reason: 'Reason must be 5–1000 characters.' },
    });
    render(<ArchiveCustomerButton customerId="c1" legalName="Al Noor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.change(screen.getByLabelText(/^Reason \(kept in the audit log\)/), { target: { value: 'Shop shut for good.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archive customer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Reason must be 5–1000 characters.');
    expect(h.replace).not.toHaveBeenCalled();
  });
});
