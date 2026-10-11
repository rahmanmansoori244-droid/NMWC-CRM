/**
 * Owner decisions 2026-10-11 — the salesman's upload of the customer's signed
 * credit application (app/(app)/customers/new/SignedFormUpload.tsx): his pages
 * and his page's decision token go over the field-form route; Send waits for an
 * upload in flight; a refusal is said; no answer offers Try again with the same
 * pages and token (the server answers a landed one as landed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  slots: [] as Array<{ kind: string; initial?: { attachmentId: string } | null; onChange?: (p: unknown) => void; onBusyChange?: (b: boolean) => void; disabled?: boolean }>,
}));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);
vi.mock('@/lib/submit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/submit-client')>()),
  postForm: h.post,
}));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: (p: (typeof h.slots)[number]) => {
    h.slots.push(p);
    return <span data-testid="slot">{p.initial?.attachmentId ?? 'empty'}</span>;
  },
}));

import { SignedFormUpload } from '@/app/(app)/customers/new/SignedFormUpload';

const base = {
  editId: 'e1',
  decisionToken: '{"v":2}',
  keptPageIds: [] as string[],
  dueText: '14/10/2026, 16:00:00',
  overdue: false,
  sentBackReason: null as string | null,
};
const lastEmpty = () => [...h.slots].reverse().find((s) => !s.initial)!;
const sendButton = () => screen.getByRole('button', { name: /Send signed application|Sending|Uploading|Sent/ });

beforeEach(() => {
  h.post.mockReset();
  h.slots = [];
  nav.hardReplace.mockReset();
});
afterEach(cleanup);

describe('SignedFormUpload', () => {
  it('says what to do and by when; Send waits for a page', () => {
    render(<SignedFormUpload {...base} />);
    const what = screen.getByText(/Your supervisor prints the credit application/).textContent!;
    // Review (2026-10-11): the pages up to the signed one, not "every page" — the
    // printout's documents annex has no page limit, this upload has.
    expect(what).toContain('take a clear photo of each page up to and including the page with the signature and stamp');
    expect(what).toContain('The “Photos & documents” pages after it are already in the CRM: leave them out.');
    expect(what).not.toMatch(/every page/);
    expect(screen.getByText(/Upload it by 14\/10\/2026, 16:00:00\./)).toBeTruthy();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(h.slots.every((s) => s.kind === 'CREDIT_FORM')).toBe(true);
  });

  it('an overdue one says so; a Finance Manager send-back shows his reason', () => {
    render(<SignedFormUpload {...base} overdue sentBackReason="The stamp is not readable." />);
    expect(screen.getByText(/Overdue — it was due 14\/10\/2026, 16:00:00\./)).toBeTruthy();
    expect(screen.getByText('Sent back by the Finance Manager:').parentElement!.textContent).toContain(
      'The stamp is not readable.'
    );
  });

  it('sends his pages and the token over the field-form route, then goes to Work by a document load', async () => {
    h.post.mockResolvedValue({ kind: 'answered', result: { ok: true, data: { editId: 'e1', pages: 2, replayed: false } } });
    render(<SignedFormUpload {...base} keptPageIds={['kept-1']} />);
    // A new page is taken; while it uploads, Send waits.
    const empty = lastEmpty();
    empty.onBusyChange!(true);
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(true));
    empty.onChange!({ attachmentId: 'new-1' });
    empty.onBusyChange!(false);
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'), { timeout: 10_000 });
    expect(h.post).toHaveBeenCalledWith('credit-form', {
      editId: 'e1',
      attachmentIds: ['kept-1', 'new-1'],
      decisionToken: '{"v":2}',
    });
  });

  it('a refusal is said and nothing moves; no answer offers Try again with the same pages and token', async () => {
    h.post.mockResolvedValueOnce({
      kind: 'answered',
      result: { ok: false, code: 'VALIDATION_FAILED', message: 'Validation failed', fields: { signedForm: 'A page of the signed application was removed. Take it again.' } },
    });
    render(<SignedFormUpload {...base} keptPageIds={['kept-1']} />);
    fireEvent.click(sendButton());
    expect(await screen.findByText('A page of the signed application was removed. Take it again.', {}, { timeout: 10_000 })).toBeTruthy();
    expect(nav.hardReplace).not.toHaveBeenCalled();

    h.post.mockResolvedValueOnce({ kind: 'unconfirmed' });
    fireEvent.click(sendButton());
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 10_000 });
    h.post.mockResolvedValueOnce({ kind: 'answered', result: { ok: true, data: { editId: 'e1', pages: 1, replayed: true } } });
    fireEvent.click(retry);
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'), { timeout: 10_000 });
    const bodies = h.post.mock.calls.map((c) => c[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it('a page taken off the list is not sent', async () => {
    h.post.mockResolvedValue({ kind: 'answered', result: { ok: true, data: { editId: 'e1', pages: 1, replayed: false } } });
    render(<SignedFormUpload {...base} keptPageIds={['kept-1', 'kept-2']} />);
    h.slots.find((s) => s.initial?.attachmentId === 'kept-1')!.onChange!(null);
    await waitFor(() => expect(screen.queryByText('kept-1')).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(h.post.mock.calls[0]![1]).toMatchObject({ attachmentIds: ['kept-2'] });
  });
});
