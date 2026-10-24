/**
 * The /duplicates card actions (app/(app)/duplicates/MergeForm.tsx), benchmark
 * item 16. "Mark distinct" hides the pair from every later scan, so it asks
 * first, like the merge buttons always did — and since the owner's decision of
 * 2026-09-25 the question says the pair can come back and be undone. A refusal
 * no longer shows in the same green as "✓ Merged".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  merge: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/services/duplicates', () => ({
  mergeCustomersAction: h.merge,
  dismissDuplicateAction: h.dismiss,
}));

import { MergeForm } from '@/app/(app)/duplicates/MergeForm';

const props = { aId: 'a', bId: 'b', aLabel: 'Al Noor (N-1)', bLabel: 'Al Nour (N-2)' };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MergeForm', () => {
  it('"Mark distinct" asks first, naming both customers, and does nothing when declined', () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MergeForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark distinct' }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain('Al Noor (N-1)');
    expect(ask.mock.calls[0][0]).toContain('Al Nour (N-2)');
    // No longer permanent (owner decision 2026-09-25): the question says when the
    // pair comes back and where to undo it, and no longer that it cannot be undone.
    expect(ask.mock.calls[0][0]).not.toMatch(/cannot be undone/);
    expect(ask.mock.calls[0][0]).toMatch(/hidden until they come to share a different CR number, name or phone/);
    expect(ask.mock.calls[0][0]).toMatch(/undo this under "Marked distinct"/);
    expect(h.dismiss).not.toHaveBeenCalled();
  });

  it('once confirmed, sends the pair and refreshes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.dismiss.mockResolvedValue({ ok: true, data: undefined });
    render(<MergeForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark distinct' }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    const sent = h.dismiss.mock.calls[0][0] as FormData;
    expect([sent.get('aId'), sent.get('bId')]).toEqual(['a', 'b']);
    expect(screen.getByRole('status').textContent).toBe('Marked as distinct.');
    expect(screen.getByRole('status').className).toContain('emerald');
  });

  it('a refused merge reads as an error, not in success green', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.merge.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { _form: 'The losing customer was just merged or archived by another action. Refresh and retry the merge.' },
    });
    render(<MergeForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Keep ←/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/just merged or archived/);
    expect(alert.className).toContain('red');
    expect(alert.className).not.toContain('emerald');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a refused "Mark distinct" reads as an error too', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.dismiss.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      message: 'One of these customers was merged or archived. Refresh the page.',
    });
    render(<MergeForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark distinct' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/merged or archived/);
    expect(alert.className).toContain('red');
  });

  it('a merge that succeeds is green', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.merge.mockResolvedValue({ ok: true, data: { winnerId: 'a' } });
    render(<MergeForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Keep ←/ }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toBe('✓ Merged.');
    expect(screen.getByRole('status').className).toContain('emerald');
  });
});

describe('MergeForm — the cross-region reason box', () => {
  // It had only a placeholder for a name, and appeared beside the buttons with
  // focus left on the Keep button that revealed it.
  it('is named, takes focus when it appears, and its reason is what is sent', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.merge.mockResolvedValueOnce({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'This is a cross-region merge: confirm it with a reason.',
    });
    render(<MergeForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Keep ←/ }));
    const box = await screen.findByRole('textbox', { name: 'Reason for the cross-region merge' });
    await waitFor(() => expect(document.activeElement).toBe(box));

    h.merge.mockResolvedValueOnce({ ok: true, data: { winnerId: 'a' } });
    fireEvent.change(box, { target: { value: 'Same owner, moved region' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cross-region merge' }));
    await waitFor(() => expect(h.merge).toHaveBeenCalledTimes(2));
    const sent = h.merge.mock.calls[1][0] as FormData;
    expect([sent.get('confirmCrossRegion'), sent.get('reason')]).toEqual(['yes', 'Same owner, moved region']);
  });
});
