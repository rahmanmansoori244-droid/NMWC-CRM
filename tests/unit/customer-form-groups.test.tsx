/**
 * The new-customer and customer update forms, for a screen reader (launch
 * browser suite follow-up, 8 Oct).
 *
 *  - "CR document photo", "Guarantee / security documents", "Location",
 *    "Equipment at the shop" and "Photos" were <label>s with no control to
 *    name: a photo slot, the GPS capture and the steppers have no single field
 *    to point at. Each caption now names its group (role=group), and the
 *    group's error, when shown, describes it.
 *  - The Channel, Sub-channel and Day of visit selects showed their error as a
 *    bare line: the select is now aria-invalid and described by it, as every
 *    LabeledField is.
 *
 * The real forms; the photo slot and GPS capture are mocked (they talk to the
 * camera, R2 and geolocation), and the form route answers through fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: ({ kind }: { kind: string }) => <span>{`${kind} photo`}</span>,
}));
vi.mock('@/components/nmwc/GpsCaptureButton', () => ({
  GpsCaptureButton: () => <button type="button">Capture GPS</button>,
}));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));

import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';

let replies: unknown[] = [];
beforeEach(() => {
  replies = [];
  window.localStorage.clear();
  vi.stubGlobal('fetch', async () => {
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const refused = (fields: Record<string, string>) => ({ ok: false, code: 'VALIDATION_FAILED', message: 'x', fields });

describe('the new-customer form', () => {
  const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];
  const credit: CreateFormInitial = {
    editId: 'd7',
    state: 'DRAFT',
    decisionReason: null,
    pendingRole: null,
    customer: {
      legalName: 'Blue Sea Cafe',
      paymentTerms: 'CREDIT',
      crNumber: '7654321',
      channelId: '',
      subChannelId: '',
      primaryPhone: '+96891234567',
      altPhone: '',
      contactPerson: 'Said',
      contactRole: '',
      notes: '',
      crPhotoAttachmentId: null,
    },
    credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
    guaranteeAttachmentIds: [],
    branches: [
      {
        branchName: 'Main',
        address: 'Way 1, Ruwi',
        areaDescription: '',
        gpsLat: null,
        gpsLng: null,
        gpsAccuracy: null,
        gpsCapturedAt: null,
        gpsManualReason: null,
        dayOfVisit: null,
        openingHours: '',
        deliveryWindow: '',
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        shopPhotoAttachmentId: null,
        signboardPhotoAttachmentId: null,
        extraPhotoAttachmentIds: [],
      },
    ],
  };

  const ERRORS = {
    'customer.crPhoto': 'Capture the CR document.',
    'customer.channelId': 'Pick a channel.',
    'customer.subChannelId': 'Pick a sub-channel.',
    guarantee: 'Add at least one guarantee document.',
    'branch.0.gps': 'Capture the location.',
    'branch.0.dayOfVisit': 'Pick a day of visit.',
    'branch.0.shopPhoto': 'Capture the shop front.',
  };

  async function refusedDraft() {
    render(<CreateCustomerForm channels={channels} initial={credit} sessionUserId="u1" />);
    replies.push(refused(ERRORS));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Pick a channel.');
  }

  it('each caption over a photo slot, the GPS capture or the steppers names its group', () => {
    render(<CreateCustomerForm channels={channels} initial={credit} sessionUserId="u1" />);
    expect(within(screen.getByRole('group', { name: 'CR document photo *' })).getByText('CR photo')).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Guarantee / security documents * (at least one)' })).getByText(
        'GUARANTEE photo'
      )
    ).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Location * (required to submit)' })).getByRole('button', {
        name: 'Capture GPS',
      })
    ).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Equipment at the shop' })).getByLabelText('Coolers')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Photos' })).getByText('SHOP photo')).toBeTruthy();
  });

  it('a group with an error is described by it', async () => {
    await refusedDraft();
    for (const [name, error] of [
      ['CR document photo *', ERRORS['customer.crPhoto']],
      ['Guarantee / security documents * (at least one)', ERRORS.guarantee],
      ['Location * (required to submit)', ERRORS['branch.0.gps']],
      ['Photos', ERRORS['branch.0.shopPhoto']],
    ] as const) {
      expect(screen.getByRole('group', { name }), name).toHaveAccessibleDescription(error);
    }
    expect(screen.getByRole('group', { name: 'Equipment at the shop' })).toHaveAccessibleDescription('');
  });

  it('a select with an error is invalid and described by it', async () => {
    await refusedDraft();
    for (const [name, error] of [
      ['Channel *', ERRORS['customer.channelId']],
      ['Sub-channel *', ERRORS['customer.subChannelId']],
      ['Day of visit *', ERRORS['branch.0.dayOfVisit']],
    ] as const) {
      const select = screen.getByRole('combobox', { name });
      expect(select, name).toHaveAttribute('aria-invalid', 'true');
      expect(select, name).toHaveAccessibleDescription(error);
    }
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
        equipmentConfirmed: false,
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

  it('each caption over a photo slot, the GPS capture or the steppers names its group', () => {
    renderForm();
    expect(within(screen.getByRole('group', { name: /^CR document photo/ })).getByText('CR photo')).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Location * (required to submit)' })).getByRole('button', {
        name: 'Capture GPS',
      })
    ).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Equipment at the shop' })).getByLabelText('Coolers')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Photos' })).getByText('SHOP photo')).toBeTruthy();
  });

  it('a location error describes the Location group', async () => {
    renderForm();
    replies.push(refused({ 'branch.b1.gps': 'Capture the location again, at the shop.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Location * (required to submit)' })).toHaveAccessibleDescription(
        'Capture the location again, at the shop.'
      )
    );
  });
});
