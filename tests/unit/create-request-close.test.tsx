/**
 * Launch fix on the new-customer request page: a request in review is
 * read-only, its location included. "Recapture GPS" and "Enter coordinates
 * manually" still changed the chip on a request nothing on the page could save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <span>photo</span> }));

import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';

const initial = (state: CreateFormInitial['state']): CreateFormInitial => ({
  editId: 'e1',
  state,
  decisionReason: null,
  pendingRole: state === 'SUBMITTED' ? 'SUPERVISOR' : null,
  customer: {
    legalName: 'Al Noor Shop',
    paymentTerms: 'CASH',
    crNumber: '1234567',
    channelId: '',
    subChannelId: '',
    primaryPhone: '',
    altPhone: '',
    contactPerson: '',
    contactRole: '',
    notes: '',
    crPhotoAttachmentId: null,
  },
  credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
  guaranteeAttachmentIds: [],
  branches: [
    {
      branchName: 'Main',
      address: 'Way 1',
      areaDescription: '',
      gpsLat: 23.6,
      gpsLng: 58.4,
      gpsAccuracy: 8,
      gpsCapturedAt: '2026-10-01T06:00:00.000Z',
      gpsManualReason: null,
      dayOfVisit: 'SUN',
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
});

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(cleanup);

describe('the location on a request that is not his to change now', () => {
  it.each(['SUBMITTED'] as const)('%s: neither GPS control can be used', (state) => {
    render(<CreateCustomerForm channels={[]} initial={initial(state)} sessionUserId="u1" />);
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Enter coordinates manually/ })).toBeDisabled();
  });

  it('on a draft both still work', () => {
    render(<CreateCustomerForm channels={[]} initial={initial('DRAFT')} sessionUserId="u1" />);
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Enter coordinates manually/ })).toBeEnabled();
  });
});
