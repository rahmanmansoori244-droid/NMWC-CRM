/**
 * Review finding 7 (phase 2, ruling 1): "Use this value" on one branch's
 * location puts the live point in that branch's box, and its GPS button — which
 * reads its point only when it mounts — is remounted to show it. Every branch's
 * button used to be remounted: a capture in flight on another branch lost its
 * "Capturing…" and, when the fix landed, its chip kept the old point while the
 * form sent the new one; a manual entry typed there but not yet saved was
 * thrown away. Driven through the real form with the real GpsCaptureButton
 * (submit-forms.test.tsx stubs the button out).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <span>photo</span> }));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { STALE_FIELDS_MESSAGE } from '@/lib/errors';
import { STALE_LOCATION_MESSAGE } from '@/lib/edit-values';

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let replies: Array<() => Promise<Response>> = [];
const answer = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** Fixes asked for and not yet answered, oldest first. */
let pendingFixes: Array<(p: GeolocationPosition) => void> = [];
const fix = (latitude: number, longitude: number, accuracy: number) =>
  act(async () => {
    pendingFixes.shift()!({ coords: { latitude, longitude, accuracy } } as GeolocationPosition);
  });

beforeEach(() => {
  sent = [];
  replies = [];
  pendingFixes = [];
  window.localStorage.clear();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} });
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return next();
  });
  Object.defineProperty(window.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: GeolocationPosition) => void) => {
        pendingFixes.push(ok);
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, 'geolocation');
});

const branch = (id: string, branchName: string, gpsLat: number, gpsLng: number) => ({
  id,
  branchName,
  address: 'Way 1, Ruwi',
  areaDescription: null,
  gpsLat,
  gpsLng,
  gpsAccuracy: 5,
  gpsCapturedAt: new Date('2026-09-24T08:00:00.000Z'),
  dayOfVisit: 'SUN' as const,
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  status: 'ACTIVE' as const,
  shopPhotoId: 'att-shop',
  signboardPhotoId: null,
  region: { name: 'Muscat' },
  route: { code: 'C4' },
});

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
  branches: [branch('b1', 'Main', 23.5, 58.3), branch('b2', 'Second', 23.4, 58.2)],
};

const section = (title: string) => within(screen.getByText(title).closest('details')!);
const first = () => section('Branch 1: Main');
const second = () => section('Branch 2: Second');
const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });

/** He moves branch 1's point and submits; the server finds it changed since. Returns the conflict list. */
async function staleOnBranchOne() {
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
  fireEvent.click(first().getByRole('button', { name: 'Recapture GPS' }));
  await fix(23.6, 58.35, 4);
  expect(first().getByText('23.600000, 58.350000')).toBeTruthy();
  replies.push(
    answer({
      ok: false,
      code: 'STALE_FIELDS',
      message: STALE_FIELDS_MESSAGE,
      fields: { 'branch.b1.gps': STALE_LOCATION_MESSAGE },
      current: {
        'branch.b1.gpsLat': 23.7,
        'branch.b1.gpsLng': 58.45,
        'branch.b1.gpsAccuracy': 3,
        'branch.b1.gpsCapturedAt': '2026-09-26T08:00:00.000Z',
      },
    })
  );
  fireEvent.click(submitBtn());
  return screen.findByRole('region', { name: 'Changed after you opened this form' });
}

describe('"Use this value" on one branch\'s location', () => {
  it("shows the live point on that branch and leaves another branch's capture in flight alone — its chip shows the point sent", async () => {
    const list = await staleOnBranchOne();
    fireEvent.click(second().getByRole('button', { name: 'Recapture GPS' }));
    expect(second().getByRole('button', { name: 'Capturing…' })).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Use this value' }));
    expect(first().getByText('23.700000, 58.450000')).toBeTruthy();
    expect(first().queryByText('23.600000, 58.350000')).toBeNull();
    expect(second().getByRole('button', { name: 'Capturing…' })).toBeTruthy();

    await fix(24.1, 57.9, 6);
    expect(second().getByText('24.100000, 57.900000')).toBeTruthy();
    expect(second().queryByText('23.400000, 58.200000')).toBeNull();

    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: null, replayed: false } }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body.branches).toEqual([
      {
        branchId: 'b2',
        gpsLat: 24.1,
        gpsLng: 57.9,
        gpsAccuracy: 6,
        gpsCapturedAt: expect.any(String),
        base: { gpsLat: 23.4, gpsLng: 58.2 },
      },
    ]);
  });

  it('keeps a manual entry typed on another branch but not yet saved', async () => {
    const list = await staleOnBranchOne();
    fireEvent.click(second().getByRole('button', { name: 'Enter coordinates manually' }));
    fireEvent.change(second().getByLabelText(/Latitude/), { target: { value: '23.41' } });
    fireEvent.change(second().getByLabelText(/Longitude/), { target: { value: '58.21' } });
    fireEvent.change(second().getByLabelText(/Why didn/), { target: { value: 'GPS chip broken in this shop' } });

    fireEvent.click(within(list).getByRole('button', { name: 'Use this value' }));
    expect(second().getByLabelText(/Latitude/)).toHaveValue('23.41');
    expect(second().getByLabelText(/Longitude/)).toHaveValue('58.21');
    expect(second().getByLabelText(/Why didn/)).toHaveValue('GPS chip broken in this shop');

    fireEvent.click(second().getByRole('button', { name: 'Save manual location' }));
    expect(second().getByText('23.410000, 58.210000')).toBeTruthy();
    replies.push(answer({ ok: true, data: { editId: 'e1', state: 'APPROVED', submittedAt: null, replayed: false } }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body.branches).toEqual([
      expect.objectContaining({
        branchId: 'b2',
        gpsLat: 23.41,
        gpsLng: 58.21,
        gpsManualReason: 'GPS chip broken in this shop',
        base: { gpsLat: 23.4, gpsLng: 58.2 },
      }),
    ]);
  });
});
