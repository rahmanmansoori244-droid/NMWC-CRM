/**
 * Code review 2026-11-10, finding 6: "Discard batch" on the batch page asks
 * first, says what happens (nothing is deleted; the rows already loaded stay),
 * needs a reason, and shows a refusal in the server's words.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ discard: vi.fn(), refresh: vi.fn() }));
vi.mock('@/services/import-fixes', () => ({ discardImportBatchAction: h.discard }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));

import { DiscardBatch } from '@/app/(app)/import/[batchId]/DiscardBatch';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const fields = (fd: FormData) => Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));

describe('Discard batch', () => {
  it('asks first, says what happens, and needs a reason before it can discard', async () => {
    h.discard.mockResolvedValue({ ok: true, data: { status: 'DISCARDED' } });
    render(<DiscardBatch batchId="b1" waiting={12} loaded={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard batch' }));
    const dialog = screen.getByRole('dialog', { name: 'Discard this batch?' });
    expect(dialog.textContent).toContain('It can then never be promoted or resumed, and it leaves your Work list.');
    expect(dialog.textContent).toContain('12 row(s) still waiting are simply not loaded, and the 30 row(s) an earlier promote already loaded stay loaded');
    const go = within(dialog).getByRole('button', { name: 'Discard this batch' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Why is it discarded? (5+ characters)'), {
      target: { value: 'a corrected sheet was loaded instead' },
    });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(h.discard).toHaveBeenCalledTimes(1));
    expect(fields(h.discard.mock.calls[0]![0])).toEqual({ batchId: 'b1', reason: 'a corrected sheet was loaded instead' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.refresh).toHaveBeenCalled();
  });

  it('Cancel discards nothing', () => {
    render(<DiscardBatch batchId="b1" waiting={1} loaded={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard batch' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.discard).not.toHaveBeenCalled();
  });

  it('a refusal is shown in the server’s words and the dialog stays open', async () => {
    h.discard.mockResolvedValue({
      ok: false,
      code: 'BATCH_PROMOTING',
      message: 'This batch is being promoted right now — wait for it to finish, then try again.',
    });
    render(<DiscardBatch batchId="b1" waiting={1} loaded={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard batch' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Why is it discarded? (5+ characters)'), { target: { value: 'old sheet' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard this batch' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This batch is being promoted right now — wait for it to finish, then try again.'
    );
  });
});
