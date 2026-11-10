/**
 * Owner decisions 2026-10-11 — the salesman's upload of the customer's signed
 * credit application (app/(app)/customers/new/SignedFormUpload.tsx): his pages
 * and his page's decision token go over the field-form route; Send waits for an
 * upload in flight; a refusal is said; no answer offers Try again with the same
 * pages and token (the server answers a landed one as landed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

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
import { announceRequestClosed, announceSignOut, clearDeviceDrafts, countDeviceDrafts } from '@/lib/device-drafts';
import { LEAVE_FORM_QUESTION, NO_PULL_REFRESH_CLASS } from '@/lib/leave-guard';

const base = {
  editId: 'e1',
  // Whose phone copy of the pages it is (code review 2026-11-10, finding 4).
  sessionUserId: 'u1',
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
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.className = '';
});

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
    // The refusal can be on screen a render before the transition ends: Send is
    // still "Sending…" (disabled) then, and a click on it is lost. Send again only
    // once it is enabled again, as a salesman would.
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });

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

/**
 * Code review 2026-11-10, finding 4: the pages lived only in the page's memory.
 * A reload before Send — Android dropping the tab behind the camera, a pull down
 * at the top of the page — showed an empty list, with up to six pages already
 * uploaded. The list of page ids is now kept on the phone, per salesman and
 * request, for this visit of the step.
 */
describe('SignedFormUpload — the pages survive a reload (finding 4)', () => {
  const KEY = 'nmwc:create:u1:signed:e1';
  const DAY = 24 * 60 * 60 * 1000;
  const shown = () => screen.getAllByTestId('slot').map((e) => e.textContent);
  const stored = () => {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as { v: number; savedAt: number; token: string; ids: string[] });
  };
  /** A page taken in the empty slot: busy, attached, done. */
  const addPage = (id: string) =>
    act(() => {
      const empty = lastEmpty();
      empty.onBusyChange!(true);
      empty.onChange!({ attachmentId: id });
      empty.onBusyChange!(false);
    });
  const age = (ms: number) => window.localStorage.setItem(KEY, JSON.stringify({ ...stored()!, savedAt: Date.now() - ms }));
  const unloadIsHeld = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it('nothing is written for a step merely opened', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<SignedFormUpload {...base} keptPageIds={['kept-1']} />);
    expect(setItem).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(countDeviceDrafts('u1')).toBe(0);
  });

  it('each page is kept the moment it is in; a reload shows them all, says so, and Send sends them', async () => {
    const first = render(<SignedFormUpload {...base} />);
    addPage('p1');
    expect(stored()).toMatchObject({ v: 1, token: '{"v":2}', ids: ['p1'] });
    addPage('p2');
    addPage('p3');
    expect(stored()!.ids).toEqual(['p1', 'p2', 'p3']);
    expect(countDeviceDrafts('u1')).toBe(1);
    first.unmount(); // the tab is gone

    h.slots = [];
    render(<SignedFormUpload {...base} />);
    expect(shown()).toEqual(['p1', 'p2', 'p3', 'empty']);
    expect(screen.getByText('Restored 3 pages you had added on this phone (saved just now). Check them, then send.')).toBeTruthy();
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false));

    h.post.mockResolvedValue({ kind: 'answered', result: { ok: true, data: { editId: 'e1', pages: 3, replayed: false } } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'), { timeout: 10_000 });
    expect(h.post).toHaveBeenCalledWith('credit-form', { editId: 'e1', attachmentIds: ['p1', 'p2', 'p3'], decisionToken: '{"v":2}' });
    // They are on the request now: the phone's list is gone.
    expect(stored()).toBeNull();
  });

  it('pages kept from a sent-back upload, one taken off and one added: the list comes back as he left it', () => {
    const first = render(<SignedFormUpload {...base} keptPageIds={['kept-1', 'kept-2']} />);
    act(() => h.slots.find((x) => x.initial?.attachmentId === 'kept-1')!.onChange!(null));
    addPage('p9');
    expect(stored()!.ids).toEqual(['kept-2', 'p9']);
    first.unmount();
    h.slots = [];
    render(<SignedFormUpload {...base} keptPageIds={['kept-1', 'kept-2']} />);
    expect(shown()).toEqual(['kept-2', 'p9', 'empty']);
    expect(screen.getByText('Restored 1 page you had added on this phone (saved just now). Check them, then send.')).toBeTruthy();
  });

  it('a page only taken off comes back taken off, in other words', () => {
    const first = render(<SignedFormUpload {...base} keptPageIds={['kept-1', 'kept-2']} />);
    act(() => h.slots.find((x) => x.initial?.attachmentId === 'kept-1')!.onChange!(null));
    first.unmount();
    h.slots = [];
    render(<SignedFormUpload {...base} keptPageIds={['kept-1', 'kept-2']} />);
    expect(shown()).toEqual(['kept-2', 'empty']);
    expect(screen.getByText('Restored the pages as you left them on this phone (saved just now). Check them, then send.')).toBeTruthy();
  });

  it('a list put back to what is on file leaves no copy', () => {
    render(<SignedFormUpload {...base} keptPageIds={['kept-1']} />);
    addPage('p1');
    expect(stored()).not.toBeNull();
    act(() => [...h.slots].reverse().find((x) => x.initial?.attachmentId === 'p1')!.onChange!(null));
    expect(stored()).toBeNull();
    expect(countDeviceDrafts('u1')).toBe(0);
  });

  it('another visit of the step (sent back since, or its documents changed): the pages are not put back, and he is told', () => {
    const first = render(<SignedFormUpload {...base} />);
    addPage('p1');
    first.unmount();
    h.slots = [];
    render(<SignedFormUpload {...base} decisionToken='{"v":2,"cycle":3}' keptPageIds={['kept-1']} />);
    expect(shown()).toEqual(['kept-1', 'empty']);
    expect(
      screen.getByText('The pages you had added on this phone were not restored, because this request changed since. Take them again.')
    ).toBeTruthy();
    expect(stored()).toBeNull();
  });

  it('kept seven days from the last page: an eight-day-old list is removed, and said', () => {
    const first = render(<SignedFormUpload {...base} />);
    addPage('p1');
    first.unmount();
    age(8 * DAY);
    h.slots = [];
    const old = render(<SignedFormUpload {...base} />);
    expect(shown()).toEqual(['empty']);
    expect(
      screen.getByText('Pages added on this phone 8 days ago were removed: unsent work is kept on the phone for 7 days. Take them again.')
    ).toBeTruthy();
    expect(stored()).toBeNull();
    old.unmount();

    // Six days: still there, and opening it does not make it younger.
    h.slots = [];
    const again = render(<SignedFormUpload {...base} />);
    addPage('p1');
    again.unmount();
    age(6 * DAY);
    const savedAt = stored()!.savedAt;
    h.slots = [];
    render(<SignedFormUpload {...base} />);
    expect(shown()).toEqual(['p1', 'empty']);
    expect(stored()!.savedAt).toBe(savedAt);
    addPage('p2');
    expect(stored()!.savedAt).toBeGreaterThan(savedAt);
  });

  it('never another salesman\'s pages, nor another request\'s', () => {
    const mine = render(<SignedFormUpload {...base} />);
    addPage('p1');
    mine.unmount();
    const copy = window.localStorage.getItem(KEY);

    h.slots = [];
    const other = render(<SignedFormUpload {...base} sessionUserId="u2" />);
    expect(shown()).toEqual(['empty']);
    other.unmount();
    h.slots = [];
    const otherRequest = render(<SignedFormUpload {...base} editId="e2" />);
    expect(shown()).toEqual(['empty']);
    addPage('p-of-e2');
    otherRequest.unmount();
    expect(window.localStorage.getItem(KEY), 'left alone').toBe(copy);
    expect(JSON.parse(window.localStorage.getItem('nmwc:create:u1:signed:e2')!).ids).toEqual(['p-of-e2']);
  });

  it('a damaged list is read defensively: only ids, none twice, no more than six', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ v: 1, savedAt: Date.now(), token: '{"v":2}', ids: ['p1', 'p1', '../../x', 7, 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] })
    );
    render(<SignedFormUpload {...base} />);
    // Six pages: the step is full, so no empty slot is offered.
    expect(shown()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('a send with no answer keeps the list; a refusal keeps it too', async () => {
    render(<SignedFormUpload {...base} />);
    addPage('p1');
    h.post.mockResolvedValueOnce({ kind: 'unconfirmed' });
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByRole('button', { name: 'Try again' }, { timeout: 10_000 });
    expect(stored()!.ids).toEqual(['p1']);
    h.post.mockResolvedValueOnce({
      kind: 'answered',
      result: { ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { signedForm: 'A page of the signed application was removed. Take it again.' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('A page of the signed application was removed. Take it again.', {}, { timeout: 10_000 })).toBeTruthy();
    expect(stored()!.ids).toEqual(['p1']);
    expect(nav.hardReplace).not.toHaveBeenCalled();
  });

  it('a withdrawn request and Sign out remove the list, and nothing writes it back', () => {
    const first = render(<SignedFormUpload {...base} />);
    addPage('p1');
    act(() => announceRequestClosed('e2')); // another request's
    expect(stored()).not.toBeNull();
    act(() => announceRequestClosed('e1'));
    expect(stored()).toBeNull();
    addPage('p2');
    expect(stored()).toBeNull();
    first.unmount();

    h.slots = [];
    render(<SignedFormUpload {...base} />);
    addPage('p1');
    expect(stored()).not.toBeNull();
    act(() => {
      announceSignOut();
      clearDeviceDrafts('u1');
    });
    expect(stored()).toBeNull();
    addPage('p2');
    expect(stored()).toBeNull();
  });

  it('leaving with unsent pages, or a page still going up, asks first; with none it does not', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <>
        <a href="/work" onClick={(e) => e.preventDefault()}>
          Work
        </a>
        <SignedFormUpload {...base} keptPageIds={['kept-1']} />
      </>
    );
    const tapWork = () => fireEvent.click(screen.getByRole('link', { name: 'Work' }));
    tapWork();
    expect(confirm).not.toHaveBeenCalled();
    expect(unloadIsHeld()).toBe(false);

    act(() => lastEmpty().onBusyChange!(true));
    expect(unloadIsHeld(), 'a page is going up').toBe(true);
    act(() => {
      lastEmpty().onChange!({ attachmentId: 'p1' });
      h.slots.forEach((x) => x.onBusyChange!(false));
    });
    tapWork();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(LEAVE_FORM_QUESTION);
    expect(unloadIsHeld()).toBe(true);
  });

  it('pull-to-refresh is off on the page while the step is open', () => {
    const view = render(<SignedFormUpload {...base} />);
    expect(document.documentElement.classList.contains(NO_PULL_REFRESH_CLASS)).toBe(true);
    view.unmount();
    expect(document.documentElement.classList.contains(NO_PULL_REFRESH_CLASS)).toBe(false);
  });

  it('when the phone cannot keep the list, the step says so', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic storage refusal', 'QuotaExceededError');
    });
    render(<SignedFormUpload {...base} />);
    const line = 'This phone could not keep a list of these pages. Keep this page open until you have sent them.';
    expect(screen.queryByText(line)).toBeNull();
    addPage('p1');
    expect(screen.getByText(line)).toBeTruthy();
  });
});
