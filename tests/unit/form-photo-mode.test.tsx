/**
 * Large-customer photos, part B: the two field forms tell their photo slots
 * how to load a remote photo. The edit form (EnrichmentForm) and a resumed
 * new-customer draft (CreateCustomerForm) count their remote photos: 39
 * (19 shops with a shop and a signboard photo, and a CR document) keep
 * 'direct'; 41 pass 'queued' to every slot that shows one.
 *
 * PhotoCaptureSlot is replaced by a recorder of its `initial`; the forms are
 * otherwise real (as enrichment-gate-scope and create-form-photo-slots do).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Role } from '@prisma/client';

const slots = vi.hoisted(() => ({ initial: [] as Array<{ attachmentId: string; photoMode?: string } | null | undefined> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: (p: { initial?: { attachmentId: string; photoMode?: string } | null }) => {
    slots.initial.push(p.initial);
    return <span>photo</span>;
  },
}));
vi.mock('@/components/nmwc/GpsCaptureButton', () => ({ GpsCaptureButton: () => <span>gps</span> }));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));

import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';

const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];

beforeEach(() => {
  slots.initial = [];
  window.localStorage.clear();
});
afterEach(() => cleanup());

/** The modes the slots with a remote photo were given, one per distinct photo. */
function modes(): Record<string, number> {
  const byId = new Map<string, string>();
  for (const i of slots.initial) if (i) byId.set(i.attachmentId, i.photoMode ?? '(none)');
  const out: Record<string, number> = {};
  for (const m of byId.values()) out[m] = (out[m] ?? 0) + 1;
  return out;
}

describe('edit form', () => {
  const branch = (i: number) => ({
    id: `b${i}`,
    branchName: `Shop ${i}`,
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
    shopPhotoId: `shop-${i}`,
    signboardPhotoId: `sign-${i}`,
    region: { name: 'Muscat' },
    route: { code: 'C4' },
  });
  const customer = (n: number) => ({
    id: 'cust1',
    nmwcCode: 'N-1',
    legalName: 'Load Chain',
    paymentTerms: 'CASH' as const,
    crNumber: '1234567',
    channelId: 'ch1',
    subChannelId: 'sc1',
    primaryPhone: '+96891234567',
    altPhone: null,
    contactPerson: 'Said',
    contactRole: null,
    status: 'ACTIVE' as const,
    notes: null,
    crPhotoId: 'cr-1',
    branches: Array.from({ length: n }, (_, i) => branch(i)),
  });
  const renderForm = (n: number) =>
    render(
      <EnrichmentForm customer={customer(n)} channels={channels} lockName={false} lockCr={false} userRole={Role.MANAGER} canSubmit sessionUserId="u1" />
    );

  it('39 remote photos: every slot direct', () => {
    renderForm(19);
    expect(modes()).toEqual({ direct: 39 });
  });
  it('41 remote photos: every slot queued', () => {
    renderForm(20);
    expect(modes()).toEqual({ queued: 41 });
  });
});

describe('new-customer form (a resumed draft)', () => {
  const draftBranch = (i: number, extras: string[] = []) => ({
    branchName: `Shop ${i}`,
    address: 'Way 1, Ruwi',
    areaDescription: '',
    gpsLat: 23.5,
    gpsLng: 58.3,
    gpsAccuracy: 5,
    gpsCapturedAt: '2026-09-24T08:00:00.000Z',
    gpsManualReason: null,
    dayOfVisit: 'SUN' as const,
    openingHours: '',
    deliveryWindow: '',
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    shopPhotoAttachmentId: `shop-${i}`,
    signboardPhotoAttachmentId: `sign-${i}`,
    extraPhotoAttachmentIds: extras,
  });
  const initial = (n: number, extras: string[] = []): CreateFormInitial => ({
    editId: 'd7',
    state: 'DRAFT',
    decisionReason: null,
    pendingRole: null,
    customer: {
      legalName: 'Load Chain',
      paymentTerms: 'CASH',
      crNumber: '7654321',
      channelId: 'ch1',
      subChannelId: 'sc1',
      primaryPhone: '+96891234567',
      altPhone: '',
      contactPerson: 'Said',
      contactRole: '',
      notes: '',
      crPhotoAttachmentId: 'cr-1',
      email: '',
    },
    credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
    guaranteeAttachmentIds: [],
    creditDocuments: { ID_CARD: [], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: [] },
    branches: Array.from({ length: n }, (_, i) => draftBranch(i, i === 0 ? extras : [])),
  });

  it('39 remote photos: every slot direct', () => {
    render(<CreateCustomerForm channels={channels} initial={initial(19)} sessionUserId="u1" />);
    expect(modes()).toEqual({ direct: 39 });
  });
  it('41 remote photos (two of them a shop’s extras): every slot queued', () => {
    render(<CreateCustomerForm channels={channels} initial={initial(19, ['x-1', 'x-2'])} sessionUserId="u1" />);
    expect(modes()).toEqual({ queued: 41 });
  });
});
