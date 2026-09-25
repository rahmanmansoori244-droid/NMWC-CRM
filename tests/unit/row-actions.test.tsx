/**
 * The batch page's Fix column (app/(app)/import/[batchId]/RowActions.tsx),
 * item 20, pre-merge review. The Correct form kept its first values across
 * router.refresh: after a partial fix the row named fewer cells, the form still
 * sent the old ones, and every later save was refused for a cell the Steward
 * could not even see. And it sent every offered cell, so cells nobody touched
 * were recorded as "corrected in the app".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  correct: vi.fn(),
  withdraw: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/services/import-fixes', () => ({
  correctImportRowAction: h.correct,
  excludeImportRowsAction: vi.fn(),
  includeImportRowAction: vi.fn(),
  recheckImportRowAction: vi.fn(),
  releaseImportRowPhoneAction: vi.fn(),
  withdrawImportRowFixAction: h.withdraw,
}));

import { RowActions } from '@/app/(app)/import/[batchId]/RowActions';

const base = { rowId: 'r1', batchId: 'b1', canRelease: false, canRecheck: true, excluded: null };
const sentCells = (i = 0) => JSON.parse(String((h.correct.mock.calls[i][0] as FormData).get('cells')));

beforeEach(() => {
  vi.clearAllMocks();
  h.correct.mockResolvedValue({ ok: true, data: { clean: 0, held: 1 } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RowActions — Correct', () => {
  it('sends only the cells the Steward changed', async () => {
    render(<RowActions {...base} state="QUARANTINED" editable={['phone', 'day_of_visit']} current={{ phone: '12', day_of_visit: 'XYZ' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    fireEvent.change(screen.getByLabelText(/Visit day/), { target: { value: 'SAT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and re-check' }));
    await waitFor(() => expect(h.correct).toHaveBeenCalledTimes(1));
    expect(sentCells()).toEqual({ day_of_visit: 'SAT' });
  });

  it('says so when nothing changed, and sends nothing', () => {
    render(<RowActions {...base} state="QUARANTINED" editable={['phone']} current={{ phone: '12' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and re-check' }));
    expect(h.correct).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing changed/);
  });

  it('after a partial fix the form starts from the row as it stands, not from its first values', async () => {
    const view = render(
      <RowActions {...base} state="QUARANTINED" editable={['phone', 'day_of_visit']} current={{ phone: '12', day_of_visit: 'XYZ' }} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    fireEvent.change(screen.getByLabelText(/Visit day/), { target: { value: 'SAT' } });
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '34' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and re-check' }));
    await waitFor(() => expect(h.correct).toHaveBeenCalledTimes(1));
    // router.refresh re-renders the SAME instance: the row now names only the phone.
    view.rerender(<RowActions {...base} state="QUARANTINED" editable={['phone']} current={{ phone: '34' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    expect(screen.queryByLabelText(/Visit day/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '99758980' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and re-check' }));
    await waitFor(() => expect(h.correct).toHaveBeenCalledTimes(2));
    expect(sentCells(1)).toEqual({ phone: '99758980' });
  });
});

describe('RowActions — Correct, reopened', () => {
  it('reopening the form shows the row as it stands, not text typed and never saved', () => {
    render(<RowActions {...base} state="QUARANTINED" editable={['phone']} current={{ phone: '12' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: 'abandoned' } });
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' })); // close without saving
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' })); // open again
    expect((screen.getByLabelText(/^Phone/) as HTMLInputElement).value).toBe('12');
  });
});

describe('RowActions — the row changes under an open Correct form (post-merge review)', () => {
  it('closes the form, so a cell it never held is not sent as blank', () => {
    // Opened for a rejected row's branch_code…
    const view = render(<RowActions {...base} state="REJECTED" editable={['branch_code']} current={{ branch_code: '' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    expect(screen.getByLabelText(/Branch code/)).toBeTruthy();
    // …then a fix of a sibling re-checked it: now held back for its phone.
    view.rerender(<RowActions {...base} state="QUARANTINED" editable={['phone']} current={{ phone: '99758980' }} />);
    expect(screen.queryByRole('button', { name: 'Save and re-check' })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/problem changed while the form was open/);
    expect(h.correct).not.toHaveBeenCalled();
    // Opened again, it holds the row as it stands.
    fireEvent.click(screen.getByRole('button', { name: 'Correct…' }));
    expect((screen.getByLabelText(/^Phone/) as HTMLInputElement).value).toBe('99758980');
  });
});

describe('RowActions — a customer linked to Temix', () => {
  it('says a fix loads only the branch', () => {
    render(<RowActions {...base} state="QUARANTINED" canRelease editable={['phone']} current={{ phone: '99758980' }} linkedToTemix />);
    expect(document.body.textContent).toMatch(/linked to Temix, so a fix here loads only this row.s branch/);
    expect(document.body.textContent).toMatch(/not written to the customer/);
  });
});

describe('RowActions — a fixed row waiting to promote', () => {
  it('says so when a newer upload overtook it, and still offers Withdraw fix', () => {
    render(<RowActions {...base} state="CLEAN" editable={[]} current={{}} superseded="Customer F is also in a newer upload, so this fix will not load." />);
    expect(document.body.textContent).toMatch(/this fix will not load/);
    expect(document.body.textContent).not.toMatch(/loads on the next promote/);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Withdraw fix']);
  });

  it('says how many rows went back when the fix took its customer’s other rows with it', async () => {
    h.withdraw.mockResolvedValue({ ok: true, data: { rows: 3 } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RowActions {...base} state="CLEAN" editable={[]} current={{}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw fix' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Fix withdrawn — 3 rows back to what they were.'));
  });

  it('offers only Withdraw fix, and asks first', async () => {
    h.withdraw.mockResolvedValue({ ok: true, data: undefined });
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<RowActions {...base} state="CLEAN" editable={[]} current={{}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Withdraw fix']);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw fix' }));
    expect(h.withdraw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw fix' }));
    await waitFor(() => expect(h.withdraw).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
