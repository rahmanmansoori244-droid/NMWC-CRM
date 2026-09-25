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
// here is simply "already attached".
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: ({ onChange }: { onChange?: (p: { attachmentId: string }) => void }) => {
    useEffect(() => {
      onChange?.({ attachmentId: 'att-evidence' });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <span>photo</span>;
  },
}));
vi.mock('@/components/nmwc/GpsCaptureButton', () => ({ GpsCaptureButton: () => <span>gps</span> }));

import { BranchStatusActions } from '@/components/nmwc/BranchStatusActions';
import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { enrichmentBase } from '@/lib/enrichment-draft';
import { CreateCustomerForm } from '@/app/(app)/customers/new/CreateCustomerForm';
import {
  FIX_FIELDS_MESSAGE,
  OFFLINE_AFTER_EARLIER_MESSAGE,
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

  it('a first-time submit is said beside the button before it moves on, to a page the cache cannot hold', async () => {
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
    // A fresh URL, so the one navigation fetches fresh data — not a cached page
    // plus a second full refresh on weak signal.
    expect(router.replace).toHaveBeenCalledWith('/customers/cust1?sent=e1');
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

  it('with his changes already pending, "Draft saved" says approval of them replaces it', async () => {
    render(
      <EnrichmentForm
        customer={customer}
        channels={[]}
        lockName
        lockCr={false}
        userRole="MANAGER"
        canSubmit={false}
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
});

describe('the new-customer form', () => {
  const newKey = 'nmwc:create:u1:new';
  const sid = '3f1c1d2e-7a4b-4c5d-9e8f-0a1b2c3d4e5f';
  const renderCreate = () => render(<CreateCustomerForm channels={[]} initial={null} sessionUserId="u1" />);
  const seed = (extra: Record<string, unknown> = {}) =>
    window.localStorage.setItem(newKey, JSON.stringify({ legalName: 'Blue Sea Cafe', crNumber: '7654321', ...extra }));

  it('a send with no answer is remembered on the phone, so a reload can ask', async () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: 'Blue Sea Cafe' } });
    replies.push(noAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('button', { name: 'Try again' });
    const stored = JSON.parse(window.localStorage.getItem(newKey)!);
    expect(stored.unanswered).toEqual([sent[0]!.body.submissionId]);
    expect(isSubmissionId(stored.unanswered[0])).toBe(true);
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
});
