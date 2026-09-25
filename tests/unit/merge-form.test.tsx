/**
 * The /duplicates card actions (app/(app)/duplicates/MergeForm.tsx), benchmark
 * item 16. "Mark distinct" is permanent — the pair never returns and the app has
 * no undo — so it asks first, like the merge buttons always did. And a refusal
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
    expect(ask.mock.calls[0][0]).toMatch(/cannot be undone/);
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
