/**
 * Launch fix: a sent-back update opens on the edit form with what the salesman
 * sent filled in (app/(app)/customers/[id]/edit/returned.ts), instead of the
 * customer as it is — his phone draft was deleted when he submitted, so he
 * typed it all again.
 *
 * A stored change goes back into its box only while the customer still holds
 * the value it was sent against; one changed since is left as it is now and
 * named. The form then sends each as an ordinary change from the value it
 * loaded (F06), so nothing newer is put back unseen.
 *
 * Only when he asks for it (the page passes `returned` for ?returned=<id>): a
 * phone draft started from what he sent is never restored on a plain visit, so a
 * value he was told not to send cannot go back with a later, unrelated edit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { returnedPrefill } from '@/app/(app)/customers/[id]/edit/returned';
import { enrichmentBase } from '@/lib/enrichment-draft';
import type { LoadedCustomer } from '@/lib/enrichment-patch';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <button>Photo fixture</button> }));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';

const CAPTURED = '2026-09-20T08:00:00.000Z';
const loaded = (over: Partial<LoadedCustomer> = {}): LoadedCustomer => ({
  legalName: 'Al Noor Trading',
  crNumber: '1234567',
  channelId: 'ch1',
  subChannelId: 'sub1',
  primaryPhone: '+96891234567',
  altPhone: null,
  contactPerson: 'Said',
  contactRole: 'Owner',
  status: 'ACTIVE',
  notes: 'Old note',
  branches: [
    {
      id: 'b1',
      address: 'Way 1, Ruwi',
      areaDescription: null,
      gpsLat: 23.6,
      gpsLng: 58.4,
      gpsAccuracy: 8,
      gpsCapturedAt: new Date(CAPTURED),
      dayOfVisit: null,
      openingHours: null,
      deliveryWindow: null,
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      equipmentConfirmed: false,
    },
  ],
  ...over,
});

/** What he sent, as fieldChanges stores it. */
const sent = [
  { field: 'customer.contactRole', before: 'Owner', after: 'Partner' },
  { field: 'customer.notes', before: 'Old note', after: null },
  { field: 'branch.b1.dayOfVisit', before: null, after: 'SUN' },
  { field: 'branch.b1.coolersCount', before: 0, after: 2 },
  { field: 'branch.b1.equipmentConfirmed', before: false, after: true },
  { field: 'branch.b1.gpsLat', before: 23.6, after: 23.61, gpsSource: 'MANUAL', gpsManualReason: 'No fix inside the mall' },
  { field: 'branch.b1.gpsLng', before: 58.4, after: 58.4, gpsSource: 'MANUAL', gpsManualReason: 'No fix inside the mall' },
  { field: 'branch.b1.gpsAccuracy', before: 8, after: null, gpsSource: 'MANUAL', gpsManualReason: 'No fix inside the mall' },
  { field: 'branch.b1.gpsCapturedAt', before: CAPTURED, after: '2026-10-03T07:00:00.000Z' },
];
const LOCKS = { lockName: true, lockCr: false };

describe('returnedPrefill', () => {
  it('puts back every change whose field still holds the value it was sent against', () => {
    const { state, notFilled } = returnedPrefill(loaded(), sent, LOCKS);
    expect(notFilled).toEqual([]);
    expect(state.customer).toMatchObject({ contactRole: 'Partner', notes: '', contactPerson: 'Said' });
    expect(state.branches.b1).toMatchObject({
      dayOfVisit: 'SUN',
      coolers: 2,
      confirmed: true,
      gps: {
        lat: 23.61,
        lng: 58.4,
        accuracy: null,
        capturedAt: '2026-10-03T07:00:00.000Z',
        // Item 41: a typed point goes back typed, with its reason.
        isManual: true,
        manualReason: 'No fix inside the mall',
      },
    });
  });

  it('leaves a field changed since as it is now, and names it', () => {
    const now = loaded({ contactRole: 'Manager' });
    now.branches[0]!.gpsLat = 23.7;
    now.branches[0]!.dayOfVisit = 'MON';
    const { state, notFilled } = returnedPrefill(now, sent, LOCKS);
    expect(state.customer.contactRole).toBe('Manager');
    expect(state.branches.b1!.dayOfVisit).toBe('MON');
    expect(state.branches.b1!.gps).toMatchObject({ lat: 23.7, lng: 58.4 });
    expect(notFilled).toEqual(['Contact role', 'Branch 1: Day of visit', 'Branch 1: Location']);
  });

  it('a value already live needs nothing; a locked field and a branch no longer shown are not put back', () => {
    const now = loaded({ contactRole: 'Partner' });
    const { state, notFilled } = returnedPrefill(
      now,
      [
        { field: 'customer.contactRole', before: 'Owner', after: 'Partner' },
        { field: 'customer.legalName', before: 'Al Noor Trading', after: 'Renamed' },
        { field: 'branch.b9.address', before: 'x', after: 'Way 9' },
        { field: 'draft.0.gps', before: null, after: { lat: 1, lng: 2 } },
      ],
      LOCKS
    );
    expect(state.customer).toMatchObject({ contactRole: 'Partner', legalName: 'Al Noor Trading' });
    expect(notFilled).toEqual(['a branch that is no longer on your route']);
  });

  it('reads defensively: fieldChanges is unvalidated JSON', () => {
    expect(returnedPrefill(loaded(), { not: 'a list' }, LOCKS).notFilled).toEqual([]);
    expect(returnedPrefill(loaded(), [null, 3, { field: 7 }], LOCKS).state.customer.contactRole).toBe('Owner');
  });
});

describe('the edit form, opened on a sent-back update', () => {
  const customer = {
    id: 'c1',
    nmwcCode: 'NMWC-000001',
    paymentTerms: 'CASH' as const,
    crPhotoId: 'p-cr',
    ...loaded(),
    branches: loaded().branches.map((b) => ({
      ...b,
      branchName: 'Main',
      status: 'ACTIVE' as const,
      shopPhotoId: 'p-shop',
      signboardPhotoId: 'p-sign',
      region: { name: 'Muscat' },
      route: { code: 'MCT-01' },
    })),
  };
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true, data: { editId: 'e2', state: 'SUBMITTED', replayed: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const DRAFT_KEY = 'nmwc:draft:u-sales:c1';
  const form = (fill: boolean = true) =>
    render(
      <EnrichmentForm
        customer={customer}
        channels={[]}
        lockName
        lockCr={false}
        userRole="SALESMAN"
        canSubmit
        sessionUserId="u-sales"
        gate="CORE"
        returned={fill ? { id: 'e1', prefill: returnedPrefill(customer, sent, LOCKS).state } : undefined}
      />
    );
  const phoneDraft = (over: Record<string, unknown>) =>
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ notes: 'Typed on the phone', savedAt: Date.now(), base: enrichmentBase(customer), ...over })
    );
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

  it('opens with what he sent, and Submit sends it as changes from the values loaded', async () => {
    form();
    expect(screen.getByLabelText(/Notes/)).toHaveValue('');
    expect(screen.getByText('23.610000, 58.400000')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval ▶' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bodies).toHaveLength(1);
    const body = bodies[0]! as {
      customer: Record<string, unknown>;
      customerBase: Record<string, unknown>;
      branches: Array<Record<string, unknown>>;
    };
    expect(body.customer).toEqual({ contactRole: 'Partner', notes: null });
    // The base is what the page loaded — never what he sent.
    expect(body.customerBase).toEqual({ contactRole: 'Owner', notes: 'Old note' });
    expect(body.branches[0]).toMatchObject({
      branchId: 'b1',
      dayOfVisit: 'SUN',
      coolersCount: 2,
      equipmentConfirmed: true,
      gpsLat: 23.61,
      gpsManualReason: 'No fix inside the mall',
      base: { dayOfVisit: null, coolersCount: 0, equipmentConfirmed: false, gpsLat: 23.6, gpsLng: 58.4 },
    });
  });

  it('a phone draft not started from what he sent is not put over it', async () => {
    phoneDraft({});
    form();
    await settle();
    expect(screen.getByLabelText(/Notes/)).toHaveValue('');
    expect(screen.queryByText(/Restored a local draft/)).toBeNull();
    expect(screen.queryByText(/older than the latest server changes/)).toBeNull();
  });

  it('the phone copy says it started from what he sent, and comes back when he asks for it again', async () => {
    form();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY)!)).toMatchObject({ returnedId: 'e1', contactRole: 'Partner' });
    cleanup();
    phoneDraft({ returnedId: 'e1' });
    form();
    await settle();
    expect(screen.getByLabelText(/Notes/)).toHaveValue('Typed on the phone');
    expect(screen.getByText('Restored a local draft from your last visit.')).toBeTruthy();
  });

  it('opened on the customer as it is, a phone copy of what he sent is not restored, and is replaced', async () => {
    // The reviewer's case: he once opened what he sent, and a month later edits
    // only the opening hours. The contact role he was told not to send stays out.
    phoneDraft({ returnedId: 'e1', contactRole: 'Partner' });
    form(false);
    await settle();
    expect(screen.getByLabelText(/Notes/)).toHaveValue('Old note');
    expect(screen.queryByText(/Restored a local draft/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const copy = JSON.parse(window.localStorage.getItem(DRAFT_KEY)!);
    expect(copy.returnedId).toBeUndefined();
    expect(copy.contactRole).toBe('Owner');
  });
});
