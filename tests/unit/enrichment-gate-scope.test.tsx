/**
 * Owner decisions 4 and 2 (2026-10-07) on the customer edit form, driven
 * through the real EnrichmentForm (jsdom).
 *
 * 4 — the form's "missing" list mirrors the server's submit gate
 *     (lib/validation/gate-scope.ts): only the branches the salesman's changes
 *     touch are held to address, GPS and shop photo, and the customer-level
 *     fields only when he changes one. It used to list every branch shown — a
 *     phone fix waited until every shop of his had GPS and a photo.
 * 2 — the CR document slot of a CREDIT customer is shown to a salesman but
 *     cannot be captured, replaced or removed, with the reason beside it, and
 *     is not on his missing list; a Manager's slot, and a CASH customer's, work
 *     as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Role } from '@prisma/client';

const slots = vi.hoisted(() => ({ props: [] as Array<{ kind: string; disabled?: boolean; required?: boolean }> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: (p: { kind: string; disabled?: boolean; required?: boolean }) => {
    slots.props.push(p);
    return <span>photo</span>;
  },
}));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));

import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { CR_DOCUMENT_LOCKED_MESSAGE } from '@/lib/permissions';
import type { SubmitGate } from '@/lib/submit-gate';

const branch = (id: string, branchName: string, complete: boolean) => ({
  id,
  branchName,
  address: 'Way 1, Ruwi',
  areaDescription: null,
  gpsLat: complete ? 23.5 : null,
  gpsLng: complete ? 58.3 : null,
  gpsAccuracy: complete ? 5 : null,
  gpsCapturedAt: complete ? new Date('2026-09-24T08:00:00.000Z') : null,
  dayOfVisit: 'SUN' as const,
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  status: 'ACTIVE' as const,
  shopPhotoId: complete ? 'att-shop' : null,
  signboardPhotoId: 'att-sign',
  region: { name: 'Muscat' },
  route: { code: 'C4' },
});

/** Complete at customer level; branch 1 complete, branch 2 never visited (no GPS, no shop photo). */
const customer = (over: Record<string, unknown> = {}) => ({
  id: 'cust1',
  nmwcCode: 'N-1',
  legalName: 'Al Noor',
  paymentTerms: 'CASH' as 'CASH' | 'CREDIT',
  crNumber: '1234567',
  channelId: 'ch1',
  subChannelId: 'sc1',
  primaryPhone: '+96891234567',
  altPhone: null,
  contactPerson: 'Said',
  contactRole: null,
  status: 'ACTIVE' as const,
  notes: null,
  crPhotoId: null as string | null,
  branches: [branch('b1', 'Main', true), branch('b2', 'Second', false)],
  ...over,
});
const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];

function renderForm(
  c: ReturnType<typeof customer>,
  { role = Role.SALESMAN as Role, gate = 'CORE' as SubmitGate } = {}
) {
  const salesman = role === Role.SALESMAN;
  render(
    <EnrichmentForm
      customer={c}
      channels={channels}
      lockName={salesman}
      lockCr={salesman && c.paymentTerms === 'CREDIT'}
      userRole={role}
      canSubmit
      sessionUserId="u1"
      gate={gate}
    />
  );
}
const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
const section = (title: string) => within(screen.getByText(title).closest('details')!);
const setPhone = (v: string) => fireEvent.change(screen.getByLabelText('Primary phone *'), { target: { value: v } });
const setDay = (title: string, v: string) => fireEvent.change(section(title).getByLabelText('Day of visit'), { target: { value: v } });

beforeEach(() => {
  slots.props = [];
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('owner decision 4: the form holds complete only what the change touches', () => {
  it('nothing changed yet: no missing list from the shop he has not visited', () => {
    renderForm(customer());
    expect(screen.queryByText(/Cannot submit yet/)).toBeNull();
    expect(submitBtn().getAttribute('title')).toBe('');
  });

  it('a phone fix can be submitted with branch 2 still without GPS or a shop photo', () => {
    renderForm(customer());
    setPhone('+96898765432');
    expect(screen.queryByText(/Cannot submit yet/)).toBeNull();
    expect(submitBtn()).toBeEnabled();
  });

  it('a customer-level change is held to the customer-level fields', () => {
    renderForm(customer({ contactPerson: null }));
    setPhone('+96898765432');
    expect(submitBtn().getAttribute('title')).toBe('Missing: Contact person');
    expect(submitBtn()).toBeDisabled();
  });

  it('the visit day of branch 1 can be set without branch 2 — or a contact person — on file', () => {
    renderForm(customer({ contactPerson: null }));
    setDay('Branch 1: Main', 'MON');
    expect(submitBtn()).toBeEnabled();
    expect(screen.queryByText(/Cannot submit yet/)).toBeNull();
  });

  it('a change to branch 2 lists branch 2’s gaps, and only those', () => {
    renderForm(customer({ contactPerson: null }));
    setDay('Branch 2: Second', 'MON');
    expect(submitBtn().getAttribute('title')).toBe('Missing: Branch 2 GPS, Branch 2 shop photo');
    expect(screen.getByText(/Cannot submit yet/).parentElement!.textContent).not.toMatch(/Branch 1|Contact person/);
  });
});

describe('owner decision 2: the CR document of a credit customer', () => {
  const crSlot = () => slots.props.filter((p) => p.kind === 'CR').at(-1)!;

  it('a salesman sees it, cannot change it, and is told who can', () => {
    renderForm(customer({ paymentTerms: 'CREDIT', crPhotoId: 'att-cr' }));
    expect(crSlot()).toMatchObject({ disabled: true, required: false });
    expect(screen.getByText(CR_DOCUMENT_LOCKED_MESSAGE)).toBeTruthy();
  });

  it('under the FULL gate a missing one is not on his list', () => {
    renderForm(customer({ paymentTerms: 'CREDIT', crPhotoId: null }), { gate: 'FULL' });
    setPhone('+96898765432');
    expect(submitBtn().getAttribute('title')).toBe('');
    expect(crSlot()).toMatchObject({ disabled: true, required: false });
  });

  it('a cash customer’s is his to take, as before', () => {
    renderForm(customer({ crPhotoId: null }), { gate: 'FULL' });
    expect(crSlot()).toMatchObject({ disabled: false, required: true });
    expect(screen.queryByText(CR_DOCUMENT_LOCKED_MESSAGE)).toBeNull();
    setPhone('+96898765432');
    expect(submitBtn().getAttribute('title')).toBe('Missing: CR document photo');
  });

  it('a Manager replaces a credit customer’s', () => {
    renderForm(customer({ paymentTerms: 'CREDIT', crPhotoId: 'att-cr' }), { role: Role.MANAGER });
    expect(crSlot()).toMatchObject({ disabled: false });
    expect(screen.queryByText(CR_DOCUMENT_LOCKED_MESSAGE)).toBeNull();
  });
});
