/**
 * The Manager's reactivation decision (ReactivationDecisionForm), for a screen
 * reader (launch browser suite follow-up, 8 Oct). The "Keep closed" reason box
 * had a placeholder and no label: once typing hid the placeholder it had no
 * name, and getByLabel could not find it. A refusal of either decision was a
 * plain line of red text, never read out.
 *
 * The real form, with the two server actions mocked to what runAction returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn(), refresh: vi.fn() }));
vi.mock('@/services/reactivations', () => ({
  approveReactivationAction: h.approve,
  rejectReactivationAction: h.reject,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));

import { ReactivationDecisionForm } from '@/app/(app)/reactivations/ReactivationDecisionForm';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function keepClosed(reason: string) {
  render(<ReactivationDecisionForm editId="e1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep closed' }));
  const box = screen.getByLabelText('Reason for keeping it closed');
  fireEvent.change(box, { target: { value: reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep closed' }));
  return box;
}

describe('the reactivation decision, for a screen reader', () => {
  it('the Keep closed reason box is found by its label', () => {
    render(<ReactivationDecisionForm editId="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep closed' }));
    const box = screen.getByRole('textbox', { name: 'Reason for keeping it closed' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.getAttribute('name')).toBe('reason');
  });

  it('a refused Keep closed is read out', async () => {
    h.reject.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { reason: 'Reason must be at least 5 characters.' },
    });
    keepClosed('Still shut, no stock.');
    expect((await screen.findByRole('alert')).textContent).toBe('Reason must be at least 5 characters.');
    expect((h.reject.mock.calls[0]![0] as FormData).get('reason')).toBe('Still shut, no stock.');
  });

  it('a refused Reactivate is read out', async () => {
    h.approve.mockResolvedValue({ ok: false, code: 'STATE_CHANGED', message: 'This request was decided already.' });
    render(<ReactivationDecisionForm editId="e1" />);
    fireEvent.click(screen.getByRole('button', { name: '✓ Reactivate' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reactivate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This request was decided already.');
  });
});
