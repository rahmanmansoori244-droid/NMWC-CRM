/**
 * Benchmark item 22, driven through the real forms (jsdom): a submit with no
 * answer offers Try again, and Try again sends the SAME request — same form,
 * same submission id, same draft-or-submit — so the server can answer "Already
 * received" instead of writing it twice. The structural guard
 * (submit-wiring-guard.test.ts) could not see a form that kept a fresh id per
 * submit, swapped the close and reactivate routes, or retried a Save draft as a
 * Submit; these can.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { useEffect } from 'react';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
// The photo and GPS widgets talk to the camera, R2 and geolocation; a photo
// here is simply "already attached". Its two buttons stand for an upload that
// starts and one that ends — the onBusyChange contract, which
// photo-slot-busy.test.tsx pins on the real slot.
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: ({
    kind,
    onChange,
    onBusyChange,
  }: {
    kind: string;
    onChange?: (p: { attachmentId: string }) => void;
    onBusyChange?: (busy: boolean) => void;
  }) => {
    useEffect(() => {
      onChange?.({ attachmentId: 'att-evidence' });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return (
      <span>
        photo
        <button type="button" onClick={() => onBusyChange?.(true)}>{`start ${kind} upload`}</button>
        <button type="button" onClick={() => onBusyChange?.(false)}>{`finish ${kind} upload`}</button>
      </span>
    );
  },
}));
vi.mock('@/components/nmwc/GpsCaptureButton', () => ({ GpsCaptureButton: () => <span>gps</span> }));
// A document load after a submit (lib/navigate.ts); jsdom cannot spy on location.replace.
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { BranchStatusActions } from '@/components/nmwc/BranchStatusActions';
import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { enrichmentBase } from '@/lib/enrichment-draft';
import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import {
  FIX_FIELDS_MESSAGE,
  OFFLINE_AFTER_EARLIER_MESSAGE,
  OFFLINE_AFTER_UNCONFIRMED_MESSAGE,
  OFFLINE_MESSAGE,
  PHOTO_UPLOADING_MESSAGE,
  submissionIdSchema,
} from '@/lib/submission';

/** A real v4 id: a comparison of two missing ids (undefined === undefined) proves nothing. */
const isSubmissionId = (v: unknown) => submissionIdSchema.safeParse(v).success;

type Sent = { url: string; method: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let replies: Array<() => Promise<Response>> = [];
const answer = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const noAnswer = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

beforeEach(() => {
  sent = [];
  replies = [];
  for (const f of Object.values(router)) f.mockReset();
  nav.hardReplace.mockReset();
  window.localStorage.clear();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {} });
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return next();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** No network interface at all: postForm reports "offline" (nothing left the phone). */
const goOffline = () => {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  replies.push(noAnswer);
};

/** Under fake timers, where waitFor cannot poll: let the submit's continuation run. */
const settleUntil = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  expect(done()).toBe(true);
};

describe('close / reactivate', () => {
  it('no answer, then Try again: the same route and the same id; "Already received" closes the form', async () => {
    render(<BranchStatusActions branchId="b1" status="ACTIVE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Shop shut for good.' } });
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Submit closure' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('alert').textContent).toMatch(/cannot tell if it arrived/);

    replies.push(
      answer({
        ok: true,
        data: { editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: true },
      })
    );
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^✓ Already received at/));

    expect(sent.map((s) => s.url)).toEqual(['/api/forms/branch-close', '/api/forms/branch-close']);
    expect(sent[0]!.body).toMatchObject({ branchId: 'b1', reason: 'Shop shut for good.', attachmentId: 'att-evidence' });
    expect(isSubmissionId(sent[0]!.body.submissionId)).toBe(true);
    expect(sent[1]!.body.submissionId).toBe(sent[0]!.body.submissionId);
    expect(screen.queryByRole('button', { name: 'Submit closure' })).toBeNull(); // form closed
    expect(router.refresh).toHaveBeenCalled();
  });

  it('a reactivation goes to the reactivation route', async () => {
    render(<BranchStatusActions branchId="b1" status="CLOSED" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request reactivation' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Open again, same owner.' } });
    replies.push(answer({ ok: true, data: { editId: 'e2', state: 'SUBMITTED', submittedAt: null, replayed: false } }));
    fireEvent.click(screen.getByRole('button', { name: 'Request reactivation' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('✓ Reactivation request sent for approval.'));
    expect(sent.map((s) => s.url)).toEqual(['/api/forms/branch-reactivate']);
  });
});

describe('the customer update form', () => {
  const customer = {
    id: 'cust1',
    nmwcCode: 'N-1',
    legalName: 'Al Noor',
    paymentTerms: 'CASH' as const,
    crNumber: null,
    channelId: null,
    subChannelId: null,
    primaryPhone: '+96891234567',
    altPhone: null,
    contactPerson: 'Said',
    contactRole: null,
    status: 'ACTIVE' as const,
    notes: null,
    crPhotoId: null,
    updatedAt: new Date('2026-09-25T06:00:00.000Z'),
    branches: [
      {
        id: 'b1',
        branchName: 'Main',
        address: 'Way 1, Ruwi',
        areaDescription: null,
        gpsLat: 23.5,
        gpsLng: 58.3,
        gpsAccuracy: 5,
        gpsCapturedAt: new Date('2026-09-24T08:00:00.000Z'),
        dayOfVisit: 'SUN' as const,
        openingHours: null,
        deliveryWindow: null,
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        status: 'ACTIVE' as const,
        shopPhotoId: 'att-shop',
        signboardPhotoId: null,
        region: { name: 'Muscat' },
        route: { code: 'C4' },
      },
    ],
  };
  const renderForm = () =>
    render(
      <EnrichmentForm
        customer={customer}
        channels={[]}
        lockName
        lockCr={false}
        userRole="MANAGER"
        canSubmit
        sessionUserId="u1"
        gate="CORE"
      />
    );
  const draftKey = 'nmwc:draft:u1:cust1';

  it('Try again after an unanswered Save draft repeats the SAVE, with its id — and the phone copy stays', async () => {
    renderForm();
    // Let the mount-time autosave write first: were the save to delete the copy
    // after it, nothing would write it back and the check below would see that.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(window.localStorage.getItem(draftKey)).not.toBeNull();
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });

    replies.push(answer({ ok: true, data: { editId: 'd1', state: 'DRAFT', submittedAt: null, replayed: false } }));
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^✓ Draft saved\. It stays on this phone/));

    expect(sent.map((s) => s.url)).toEqual(['/api/forms/customer-edit', '/api/forms/customer-edit']);
    expect(sent.map((s) => s.body.isDraft)).toEqual([true, true]);
    expect(isSubmissionId(sent[0]!.body.submissionId)).toBe(true);
    expect(sent[1]!.body.submissionId).toBe(sent[0]!.body.submissionId);
    // The owner's call: a saved draft stays on the phone.
    expect(window.localStorage.getItem(draftKey)).not.toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(draftKey)!);
    // …and records the server values it started from, which decide later
    // whether it is stale (lib/enrichment-draft.ts).
    expect(stored.base).toBe(enrichmentBase(customer));
  });

  it('a draft typed before a photo bumped updatedAt is restored — the server values it started from are unchanged', () => {
    window.localStorage.setItem(
      draftKey,
      JSON.stringify({
        contactPerson: 'Said (typed offline)',
        savedAt: customer.updatedAt.getTime() - 60_000, // older than the photo's bump
        base: enrichmentBase(customer),
      })
    );
    renderForm();
    expect(screen.getByDisplayValue('Said (typed offline)')).toBeTruthy();
    expect(screen.getByText('Restored a local draft from your last visit.')).toBeTruthy();
  });

  it('a draft whose server values changed since is dropped, with the reason', () => {
    window.localStorage.setItem(
      draftKey,
      JSON.stringify({
        contactPerson: 'Said (typed offline)',
        savedAt: customer.updatedAt.getTime() + 60_000,
        base: enrichmentBase({ ...customer, contactPerson: 'Someone else' }),
      })
    );
    renderForm();
    expect(screen.queryByDisplayValue('Said (typed offline)')).toBeNull();
    expect(screen.getByText(/older than the latest server changes/)).toBeTruthy();
  });

  it('a first-time submit is said beside the button before it moves on, by a document load (no stale cache, forward or Back)', async () => {
    renderForm();
    // Let the mount-time autosave write the phone copy first — else the "cleared"
    // check below passes whether or not the submit clears it (post-merge review).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(window.localStorage.getItem(draftKey)).not.toBeNull();
    replies.push(
      answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: false } })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('✓ Saved (auto-approved as MANAGER).'));
    expect(screen.getByRole('button', { name: 'Sent ✓' })).toBeTruthy();
    // One document load: fresh data now, and no router cache left for Back to
    // show the customer as it was before the submit (post-merge review).
    expect(nav.hardReplace).toHaveBeenCalledWith('/customers/cust1');
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(draftKey)).toBeNull();
  });

  it('a changed payload after no answer gets a NEW id — the old one could swallow the change', async () => {
    renderForm();
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('button', { name: 'Try again' });
    fireEvent.change(screen.getByDisplayValue('Said'), { target: { value: 'Said Al Harthy' } });
    replies.push(answer({ ok: true, data: { editId: 'd1', state: 'DRAFT', submittedAt: null, replayed: false } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body.submissionId).not.toBe(sent[0]!.body.submissionId);
  });

  it('after "No answer", a changed form sent while offline keeps the doubt about the earlier send', async () => {
    renderForm();
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await screen.findByRole('button', { name: 'Try again' });
    fireEvent.change(screen.getByDisplayValue('Said'), { target: { value: 'Said Al Harthy' } });
    goOffline();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(OFFLINE_AFTER_EARLIER_MESSAGE));
    expect(screen.getByRole('alert').textContent).not.toMatch(/^No signal — nothing was sent/);
  });

  it('a field error is said beside the button — the red notice of the last try does not just vanish', async () => {
    renderForm();
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    replies.push(
      answer({ ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { 'customer.primaryPhone': 'Enter a valid Oman number.' } })
    );
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FIX_FIELDS_MESSAGE));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByText('Enter a valid Oman number.')).toBeTruthy();
  });

  // What the page passes for each pending kind is pendingReplacesDraft
  // (submission-replay.test.ts); a reactivation of a customer that is not ACTIVE
  // passes true, and reads as the test after this one.
  it('with only a close pending, "Draft saved" promises nothing about replacing it', async () => {
    render(
      <EnrichmentForm
        customer={customer}
        channels={[]}
        lockName
        lockCr={false}
        userRole="MANAGER"
        canSubmit={false}
        pendingReplacesDraft={false}
        sessionUserId="u1"
        gate="CORE"
      />
    );
    replies.push(answer({ ok: true, data: { editId: 'd1', state: 'DRAFT', submittedAt: null, replayed: false } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('✓ Draft saved. It stays on this phone until you submit.')
    );
  });

  it('with changes to this customer already pending, "Draft saved" says approval of them replaces it', async () => {
    render(
      <EnrichmentForm
        customer={customer}
        channels={[]}
        lockName
        lockCr={false}
        userRole="MANAGER"
        canSubmit={false}
        pendingReplacesDraft
        sessionUserId="u1"
        gate="CORE"
      />
    );
    replies.push(answer({ ok: true, data: { editId: 'd1', state: 'DRAFT', submittedAt: null, replayed: false } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        '✓ Draft saved on this phone. If the changes already waiting are approved first, they replace it.'
      )
    );
  });

  // Item 22 review: Submit leaves by a document load, which aborts an upload in
  // flight — the photo was lost while the salesman read "It arrived".
  it('Submit waits while any photo is still uploading — optional slots too, for every role', async () => {
    renderForm(); // a MANAGER: no mandatory gate at all, and a direct write that leaves at once
    const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
    expect(submitBtn()).toBeEnabled();
    // The CR photo, then the second FREE slot too — neither of which the gate reads.
    fireEvent.click(screen.getByRole('button', { name: 'start CR upload' }));
    expect(submitBtn()).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'start FREE upload' })[1]!);
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn().title).toBe(PHOTO_UPLOADING_MESSAGE);
    expect(screen.getByText(PHOTO_UPLOADING_MESSAGE)).toBeTruthy();
    // Save draft does not leave the page: it stays usable.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    fireEvent.click(submitBtn());
    fireEvent.click(screen.getByRole('button', { name: 'finish CR upload' }));
    expect(submitBtn()).toBeDisabled(); // counted, not a flag: the FREE photo is still going up
    fireEvent.click(submitBtn());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent).toHaveLength(0);
    expect(nav.hardReplace).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'finish FREE upload' })[1]!);
    expect(submitBtn()).toBeEnabled();
    expect(screen.queryByText(PHOTO_UPLOADING_MESSAGE)).toBeNull();
    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: null, replayed: false } }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledTimes(1));
    expect(sent).toHaveLength(1);
  });

  it('every slot holds it: the CR photo, shop, signboard and both FREE', () => {
    renderForm();
    const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
    const starts = screen.getAllByRole('button', { name: /^start \w+ upload$/ });
    const finishes = screen.getAllByRole('button', { name: /^finish \w+ upload$/ });
    expect(starts.map((b) => b.textContent)).toEqual([
      'start CR upload',
      'start SHOP upload',
      'start SIGNBOARD upload',
      'start FREE upload',
      'start FREE upload',
    ]);
    starts.forEach((start, i) => {
      fireEvent.click(start);
      expect(submitBtn(), start.textContent!).toBeDisabled();
      fireEvent.click(finishes[i]!);
      expect(submitBtn(), start.textContent!).toBeEnabled();
    });
  });

  it('Try again of a Submit waits for a photo too — it leaves the page the same way', async () => {
    renderForm();
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(screen.getByRole('button', { name: 'start SIGNBOARD upload' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent).toHaveLength(1);
    expect(screen.getByText(PHOTO_UPLOADING_MESSAGE)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'finish SIGNBOARD upload' }));
    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: null, replayed: false } }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledTimes(1));
    expect(sent[1]!.body.submissionId).toBe(sent[0]!.body.submissionId);
  });

  it('once a submit arrived, Save draft is off — a tap while the next page loads wrote a stray draft', async () => {
    renderForm();
    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: null, replayed: false } }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalled());
    // hardReplace is mocked, so the form stays — as the real one does until the
    // next document is in; the transition has ended by then.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(sent).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('✓ Submitted for approval. It arrived — nothing more to do.');
  });

  it('after a replayed "Already received", Save draft is off too — the form stays, with nothing to send', async () => {
    renderForm();
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    replies.push(
      answer({ ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: true } })
    );
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^✓ Already received at/));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(sent).toHaveLength(2);
  });

  it('an autosave already due when the submit arrives does not write the phone copy back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderForm();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(window.localStorage.getItem(draftKey)).not.toBeNull();
      fireEvent.change(screen.getByDisplayValue('Said'), { target: { value: 'Said Al Harthy' } }); // arms the 500 ms autosave
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      replies.push(answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: null, replayed: false } }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
      await settleUntil(() => nav.hardReplace.mock.calls.length > 0);
      expect(window.localStorage.getItem(draftKey)).toBeNull();
      // The page is leaving: the save due at 500 ms must not bring it back.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(window.localStorage.getItem(draftKey)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a replayed "Already received" drops the autosave already due — and a later edit still saves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderForm();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      replies.push(noAnswer);
      fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
      await settleUntil(() => screen.queryByRole('button', { name: 'Try again' }) !== null);
      // A change undone: the payload, and so its id, are the same — but the
      // autosave is armed, as by any keystroke.
      fireEvent.change(screen.getByDisplayValue('Said'), { target: { value: 'Said X' } });
      fireEvent.change(screen.getByDisplayValue('Said X'), { target: { value: 'Said' } });
      replies.push(
        answer({ ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: true } })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settleUntil(() => /^✓ Already received at/.test(screen.getByRole('status').textContent ?? ''));
      expect(sent[1]!.body.submissionId).toBe(sent[0]!.body.submissionId);
      expect(window.localStorage.getItem(draftKey)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(window.localStorage.getItem(draftKey)).toBeNull();
      // The form stays on this path: what he types next is his, and is kept.
      fireEvent.change(screen.getByDisplayValue('Said'), { target: { value: 'Said Al Harthy' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(JSON.parse(window.localStorage.getItem(draftKey)!).contactPerson).toBe('Said Al Harthy');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the new-customer form', () => {
  const newKey = 'nmwc:create:u1:new';
  const sid = '3f1c1d2e-7a4b-4c5d-9e8f-0a1b2c3d4e5f';
  const renderCreate = () => render(<CreateCustomerForm channels={[]} initial={null} sessionUserId="u1" />);
  const seed = (extra: Record<string, unknown> = {}) =>
    window.localStorage.setItem(newKey, JSON.stringify({ legalName: 'Blue Sea Cafe', crNumber: '7654321', ...extra }));
  // A saved draft with everything filled in, so Submit is enabled (the mocked
  // slots attach their photos on mount).
  const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];
  const complete: CreateFormInitial = {
    editId: 'd7',
    state: 'DRAFT',
    decisionReason: null,
    pendingRole: null,
    customer: {
      legalName: 'Blue Sea Cafe',
      paymentTerms: 'CASH',
      crNumber: '7654321',
      channelId: 'ch1',
      subChannelId: 'sc1',
      primaryPhone: '+96891234567',
      altPhone: '',
      contactPerson: 'Said',
      contactRole: '',
      notes: '',
      crPhotoAttachmentId: 'att-cr',
    },
    credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
    guaranteeAttachmentIds: [],
    branches: [
      {
        branchName: 'Main',
        address: 'Way 1, Ruwi',
        areaDescription: '',
        gpsLat: 23.5,
        gpsLng: 58.3,
        gpsAccuracy: 5,
        gpsCapturedAt: '2026-09-24T08:00:00.000Z',
        gpsManualReason: null,
        dayOfVisit: 'SUN',
        openingHours: '',
        deliveryWindow: '',
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        shopPhotoAttachmentId: 'att-shop',
        signboardPhotoAttachmentId: 'att-sign',
        extraPhotoAttachmentIds: [],
      },
    ],
  };

  it('a send with no answer is remembered on the phone — and the autosave keeps it there', async () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('button', { name: 'Try again' });
    // Let the debounced autosave rewrite the copy: it must carry the ids too
    // (post-merge review: read too early, the check passed without them).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    const stored = JSON.parse(window.localStorage.getItem(newKey)!);
    expect(stored.legalName).toBe('Blue Sea Cafe');
    expect(stored.unanswered).toEqual([sent[0]!.body.submissionId]);
    expect(isSubmissionId(stored.unanswered[0])).toBe(true);
  });

  it('the id is on the phone BEFORE the send — a reload mid-send can still ask', async () => {
    const first = renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    let dropSend!: (e: Error) => void;
    replies.push(() => new Promise<Response>((_resolve, reject) => (dropSend = reject))); // the send does not answer
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const stored = JSON.parse(window.localStorage.getItem(newKey)!);
    expect(stored.unanswered).toEqual([sent[0]!.body.submissionId]);
    // The tab is killed mid-send; the reload asks about that id.
    first.unmount();
    replies.push(answer({ ok: true, data: null }));
    renderCreate();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.url).toBe(`/api/forms/customer-create?submissionId=${sent[0]!.body.submissionId}`);
    // End the dead tab's send. React 19 entangles async transitions: one left
    // pending for good kept `pending` true in every later test in this file —
    // Try again read "Trying…" and stayed disabled (in the app, postForm's
    // timeout always ends a send).
    await act(async () => {
      dropSend(new TypeError('Failed to fetch'));
    });
  });

  it('a refused send comes off the list — it did not land', async () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    replies.push(answer({ ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { 'customer.legalName': 'Too short.' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText('Too short.')).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem(newKey) ?? '{}').unanswered ?? []).toEqual([]);
  });

  it('reloaded after a send that got no answer: it asks, and says the send arrived', async () => {
    seed({ unanswered: [sid] });
    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: true } }));
    renderCreate();
    await waitFor(() => expect(screen.getByText(/^Your last send arrived after all\. ✓ Already received at/)).toBeTruthy());
    expect(sent.map((x) => `${x.method} ${x.url}`)).toEqual([`GET /api/forms/customer-create?submissionId=${sid}`]);
    // The request is on the server: the phone copy goes, and nothing is sent again.
    expect(window.localStorage.getItem(newKey)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sent ✓' })).toBeTruthy();
    // …and a typo fixed now does not refill the never-saved copy with this shop.
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe (fixed)' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(window.localStorage.getItem(newKey)).toBeNull();
  });

  it('reloaded, and the send landed as a DRAFT: opens it by a document load, and nothing refills the phone copy', async () => {
    seed({ unanswered: [sid] });
    replies.push(answer({ ok: true, data: { editId: 'd9', state: 'DRAFT', submittedAt: null, replayed: true } }));
    renderCreate();
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/customers/new?edit=d9'));
    // The restore armed an autosave; it must not write the copy back after the
    // removal (post-merge review), nor may a keystroke before the page goes.
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe (edited)' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(window.localStorage.getItem(newKey)).toBeNull();
  });

  it('an autosave already due when the check finds the request does not write the copy back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      seed({ unanswered: [sid] });
      let answerCheck!: (r: Response) => void;
      replies.push(() => new Promise<Response>((resolve) => (answerCheck = resolve)));
      renderCreate(); // the restore sets fields, arming the 500 ms autosave
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sent).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(499);
        answerCheck(
          new Response(JSON.stringify({ ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: null, replayed: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
        // Let the check's continuation run (it drops the copy) — but fire the
        // due timer BEFORE React re-renders, which would otherwise clear it.
        for (let i = 0; i < 50 && window.localStorage.getItem(newKey) !== null; i++) await Promise.resolve();
        expect(window.localStorage.getItem(newKey)).toBeNull();
        vi.advanceTimersByTime(1);
      });
      expect(window.localStorage.getItem(newKey)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a check still waiting when the form goes does nothing to the page he moved to', async () => {
    seed({ unanswered: [sid] });
    let answerCheck!: (r: Response) => void;
    replies.push(() => new Promise<Response>((resolve) => (answerCheck = resolve)));
    const view = renderCreate();
    await waitFor(() => expect(sent).toHaveLength(1));
    view.unmount(); // he tapped Work
    await act(async () => {
      answerCheck(
        new Response(JSON.stringify({ ok: true, data: { editId: 'd9', state: 'DRAFT', submittedAt: null, replayed: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(nav.hardReplace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(newKey)).not.toBeNull();
  });

  it('reloaded, and the send did not land: the usual restore — rebuild what the phone did not keep', async () => {
    seed({ unanswered: [sid] });
    replies.push(answer({ ok: true, data: null }));
    renderCreate();
    await waitFor(() => expect(screen.getByText(/^Restored the details you typed on this phone\. Branch details/)).toBeTruthy());
    expect(screen.getByDisplayValue('Blue Sea Cafe')).toBeTruthy();
  });

  it('reloaded with no signal to ask: says the send may have arrived, before inviting a rebuild', async () => {
    seed({ unanswered: [sid] });
    replies.push(noAnswer);
    renderCreate();
    await waitFor(() => expect(screen.getByText(/Your last send got no answer and may have arrived/)).toBeTruthy());
    expect(screen.getByDisplayValue('Blue Sea Cafe')).toBeTruthy();
  });

  // Item 22 review: the send kept on the phone is not in this mount's
  // SubmissionIds, and the offline notice read "nothing was sent" over it.
  it('reloaded, the check got no answer, then an offline send: still says the earlier send may have arrived', async () => {
    seed({ unanswered: [sid] });
    replies.push(noAnswer);
    renderCreate();
    await waitFor(() => expect(screen.getByText(/Your last send got no answer and may have arrived/)).toBeTruthy());
    goOffline();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(OFFLINE_AFTER_EARLIER_MESSAGE));
    // …and it stays on the phone for the next reload to ask about; this try's own id did not leave.
    expect(JSON.parse(window.localStorage.getItem(newKey)!).unanswered).toEqual([sid]);
  });

  // Item 22 review: `refused || (unread && !triedBefore)` had no test at all —
  // both of these mutants passed every form test.
  it('no answer, then an offline Try again: the send that may have landed stays on the phone', async () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    const id = sent[0]!.body.submissionId;
    goOffline();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(OFFLINE_AFTER_UNCONFIRMED_MESSAGE));
    expect(sent[1]!.body.submissionId).toBe(id);
    expect(JSON.parse(window.localStorage.getItem(newKey)!).unanswered).toEqual([id]);
  });

  it('a first Save draft with no signal left nothing to ask about', async () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    goOffline();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(OFFLINE_MESSAGE));
    expect(JSON.parse(window.localStorage.getItem(newKey) ?? '{}').unanswered ?? []).toEqual([]);
  });

  // Item 22 review: the autosave wrote an empty copy on every visit, and the
  // next one said "Restored the details you typed" over a blank form.
  it('a visit that typed nothing leaves no copy, and the next visit claims no restore', async () => {
    const first = renderCreate();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(window.localStorage.getItem(newKey)).toBeNull();
    first.unmount();
    renderCreate();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText(/^Restored the details you typed/)).toBeNull();
  });

  it('clearing every field removes the copy — the old text does not come back', async () => {
    const first = renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(JSON.parse(window.localStorage.getItem(newKey)!).legalName).toBe('Blue Sea Cafe');
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: '' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(window.localStorage.getItem(newKey)).toBeNull();
    first.unmount();
    renderCreate();
    expect(screen.queryByText(/^Restored the details you typed/)).toBeNull();
    expect(screen.queryByDisplayValue('Blue Sea Cafe')).toBeNull();
  });

  it('an empty form whose send got no answer keeps its copy — the id still has to be asked about', async () => {
    renderCreate(); // the mount arms the autosave; the send goes before it fires
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('button', { name: 'Try again' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(JSON.parse(window.localStorage.getItem(newKey)!).unanswered).toEqual([sent[0]!.body.submissionId]);
  });

  it('an empty copy already on the phone (written before this fix) is not announced as restored', async () => {
    window.localStorage.setItem(
      newKey,
      JSON.stringify({ legalName: '  ', crNumber: '', paymentTerms: 'CASH', notes: '', savedAt: 1, unanswered: [] })
    );
    renderCreate();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText(/^Restored the details you typed/)).toBeNull();
  });

  it.each([
    ['a typed field', { legalName: 'Blue Sea Cafe' }],
    ['Credit chosen, nothing else', { paymentTerms: 'CREDIT' }],
  ])('a copy with %s in it is restored, and says so', async (_l, copy) => {
    window.localStorage.setItem(newKey, JSON.stringify(copy));
    renderCreate();
    await waitFor(() => expect(screen.getByText(/^Restored the details you typed on this phone\. Branch details/)).toBeTruthy());
  });

  it('Submit waits while a photo is still uploading — it is not in the payload yet, and leaving for Work would abort it', async () => {
    render(<CreateCustomerForm channels={channels} initial={complete} sessionUserId="u1" />);
    const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'start FREE upload' })[0]!);
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn().title).toBe(PHOTO_UPLOADING_MESSAGE);
    expect(screen.getByText(PHOTO_UPLOADING_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    fireEvent.click(submitBtn());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent).toHaveLength(0);
    expect(nav.hardReplace).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'finish FREE upload' })[0]!);
    expect(submitBtn()).toBeEnabled();
    replies.push(answer({ ok: true, data: { editId: 'd7', state: 'SUBMITTED', submittedAt: null, replayed: false } }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
  });

  it('every slot holds it: CR, each guarantee document, shop, signboard and both FREE', async () => {
    const credit: CreateFormInitial = {
      ...complete,
      customer: { ...complete.customer, paymentTerms: 'CREDIT' },
      credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
      guaranteeAttachmentIds: ['att-g1'],
    };
    render(<CreateCustomerForm channels={channels} initial={credit} sessionUserId="u1" />);
    const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    const kinds = screen.getAllByRole('button', { name: /^start \w+ upload$/ }).map((b) => b.textContent);
    for (const k of ['CR', 'GUARANTEE', 'SHOP', 'SIGNBOARD', 'FREE']) expect(kinds).toContain(`start ${k} upload`);
    expect(kinds.filter((k) => k === 'start FREE upload')).toHaveLength(2);
    // The existing guarantee document AND the empty slot for the next one.
    expect(kinds.filter((k) => k === 'start GUARANTEE upload').length).toBeGreaterThanOrEqual(2);
    kinds.forEach((kind, i) => {
      fireEvent.click(screen.getAllByRole('button', { name: /^start \w+ upload$/ })[i]!);
      expect(submitBtn(), `${kind} #${i}`).toBeDisabled();
      fireEvent.click(screen.getAllByRole('button', { name: /^finish \w+ upload$/ })[i]!);
      expect(submitBtn(), `${kind} #${i}`).toBeEnabled();
    });
  });

  it('Try again of a Submit waits for a photo too', async () => {
    render(<CreateCustomerForm channels={channels} initial={complete} sessionUserId="u1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit for approval ▶' })).toBeEnabled());
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(screen.getByRole('button', { name: 'start CR upload' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent).toHaveLength(1);
    expect(nav.hardReplace).not.toHaveBeenCalled();
  });
});
