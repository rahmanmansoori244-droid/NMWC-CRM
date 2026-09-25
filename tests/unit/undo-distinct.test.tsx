/**
 * The Undo button on a "Marked distinct" row of /duplicates
 * (app/(app)/duplicates/UndoDistinct.tsx), owner decision 2026-09-25: asks
 * first, naming both customers; sends the pair; a refusal reads in red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ refresh: vi.fn(), undo: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/services/duplicates', () => ({ undoDismissDuplicateAction: h.undo }));

import { UndoDistinct } from '@/app/(app)/duplicates/UndoDistinct';

const props = { aId: 'a', bId: 'b', aLabel: 'Al Noor (N-1)', bLabel: 'Al Nour (N-2)' };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UndoDistinct', () => {
  it('asks first, naming both customers, and does nothing when declined', () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<UndoDistinct {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain('Al Noor (N-1)');
    expect(ask.mock.calls[0][0]).toContain('Al Nour (N-2)');
    expect(ask.mock.calls[0][0]).toMatch(/goes back on the list/);
    expect(h.undo).not.toHaveBeenCalled();
  });

  it('once confirmed, sends the pair and refreshes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.undo.mockResolvedValue({ ok: true, data: undefined });
    render(<UndoDistinct {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    const sent = h.undo.mock.calls[0][0] as FormData;
    expect([sent.get('aId'), sent.get('bId')]).toEqual(['a', 'b']);
    expect(screen.getByRole('status').textContent).toBe('Back on the list.');
    expect(screen.getByRole('status').className).toContain('emerald');
  });

  it('a refusal reads as an error, and nothing is refreshed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.undo.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { _form: 'This pair is not marked distinct, so there is nothing to undo. Refresh the page.' },
    });
    render(<UndoDistinct {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not marked distinct/);
    expect(alert.className).toContain('red');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a thrown error reads as an error too', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.undo.mockRejectedValue(new Error('network down'));
    render(<UndoDistinct {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('network down');
  });
});
