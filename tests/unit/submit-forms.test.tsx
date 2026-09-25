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

type Sent = { url: string; body: Record<string, unknown> };
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
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return next();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('a first-time submit is said beside the button before it moves on, and refreshes what it moves to', async () => {
    renderForm();
    replies.push(
      answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: '2026-09-25T06:42:00.000Z', replayed: false } })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('✓ Saved (auto-approved as MANAGER).'));
    expect(screen.getByRole('button', { name: 'Sent ✓' })).toBeTruthy();
    expect(router.replace).toHaveBeenCalledWith('/customers/cust1');
    expect(router.refresh).toHaveBeenCalled();
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
});
