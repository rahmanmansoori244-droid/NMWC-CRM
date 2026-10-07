/**
 * Launch fix (review): the edit page fills in a sent-back update only when the
 * salesman asks for it, and lets him clear one he will not send again.
 *
 * It used to fill in what he sent on EVERY visit to that customer's form, from
 * any link, until he sent something. A month later he edited only the opening
 * hours — and the phone he had been told not to send went back with it, the
 * filled-in box counting as a change. And a request he should not send again
 * could never leave Needs correction: a submit with no change is refused.
 *
 *   - Every visit says who sent it back, when and why.
 *   - ?returned=<that request> fills the form (Work and Needs correction link
 *     so); otherwise the form is the customer as it is, with "Fill in what I
 *     sent". Filled in, "Start from the customer as it is" goes back.
 *   - "Nothing to send again — clear this" is on the banner either way.
 *   - The customer profile, where his notification lands, says why too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  openIds: [] as string[],
  formProps: null as null | { returned?: { id: string; prefill: { customer: Record<string, unknown> } } },
  formKey: null as string | null,
  cleared: [] as Array<{ editId: string; then: string }>,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-sales', role: 'SALESMAN', username: 'mct01' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/returned-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/returned-work')>()),
  openReturnedIds: vi.fn(async () => h.openIds),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: [] }),
  canSeeCustomer: () => true,
  canEditCustomer: () => true,
  filterBranchesByScope: (_u: unknown, b: unknown[]) => b,
}));
vi.mock('@/app/(app)/customers/[id]/edit/EnrichmentForm', () => ({
  EnrichmentForm: (p: NonNullable<typeof h.formProps>) => {
    h.formProps = p;
    return <div>the form</div>;
  },
}));
vi.mock('@/app/(app)/rejected/ClearReturned', () => ({
  ClearReturned: (p: { editId: string; then: string }) => {
    h.cleared.push(p);
    return <button>Nothing to send again — clear this</button>;
  },
}));

const branch = {
  id: 'b1',
  branchName: 'Main',
  branchCode: 'NMWC-000001-01',
  address: 'Way 1, Ruwi',
  areaDescription: null,
  gpsLat: null,
  gpsLng: null,
  gpsAccuracy: null,
  gpsCapturedAt: null,
  dayOfVisit: null,
  openingHours: null,
  deliveryWindow: null,
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  status: 'ACTIVE',
  shopPhotoId: null,
  signboardPhotoId: null,
  shopPhoto: null,
  signboardPhoto: null,
  routeId: 'r1',
  regionId: 'reg1',
  deletedAt: null,
  completenessScore: 50,
  region: { name: 'Muscat' },
  route: { code: 'MCT-01', name: 'MCT-01' },
};
const customer = {
  id: 'c1',
  nmwcCode: 'NMWC-000001',
  legalName: 'Al Noor Trading',
  paymentTerms: 'CASH',
  crNumber: null,
  crPhotoId: null,
  crPhoto: null,
  channelId: null,
  subChannelId: null,
  channel: null,
  subChannel: null,
  primaryPhone: '+96891234567',
  altPhone: null,
  contactPerson: 'Said',
  contactRole: 'Owner',
  status: 'ACTIVE',
  notes: null,
  completenessScore: 60,
  edits: [],
  branches: [branch],
};

vi.mock('@/lib/db', () => ({
  prisma: {
    customer: { findFirst: async () => structuredClone(customer) },
    user: { findUniqueOrThrow: async () => ({ ownedRouteId: 'r1' }) },
    channel: { findMany: async () => [] },
    customerEdit: {
      findFirst: async () => null,
      findUnique: async () => ({
        // He sent a new phone; the Supervisor said the one on file is right.
        fieldChanges: [{ field: 'customer.primaryPhone', before: '+96891234567', after: '+96899999999' }],
        decisionReason: 'The phone on file is right — do not change it.',
        reviewedAt: new Date('2026-10-04T08:00:00Z'),
        reviewedBy: { fullName: 'Manager Muna' },
      }),
    },
  },
}));

beforeEach(() => {
  h.openIds = ['e1'];
  h.formProps = null;
  h.cleared = [];
});
afterEach(cleanup);

async function editPage(returned?: string) {
  const { default: Page } = await import('@/app/(app)/customers/[id]/edit/page');
  render(
    await Page({
      params: Promise.resolve({ id: 'c1' }),
      searchParams: Promise.resolve(returned ? { returned } : {}),
    })
  );
}

describe('the edit page, with an update sent back to him', () => {
  it('a plain visit says why, but opens on the customer as it is', async () => {
    await editPage();
    expect(screen.getByText(/The phone on file is right/)).toBeTruthy();
    expect(screen.getByText(/Sent back to you by Manager Muna/)).toBeTruthy();
    expect(h.formProps!.returned).toBeUndefined();
    expect(screen.getByText('The form below shows the customer as it is now.')).toBeTruthy();
    expect(screen.getByText('Fill in what I sent').closest('a')!.getAttribute('href')).toBe('/customers/c1/edit?returned=e1');
    expect(screen.queryByText(/What you sent is filled in/)).toBeNull();
    expect(h.cleared).toEqual([{ editId: 'e1', then: '/customers/c1/edit' }]);
  });

  it('?returned= that request fills it in, and offers the way back to the customer as it is', async () => {
    await editPage('e1');
    expect(h.formProps!.returned).toMatchObject({ id: 'e1', prefill: { customer: { primaryPhone: '+96899999999' } } });
    expect(screen.getByText(/What you sent is filled in below/)).toBeTruthy();
    expect(screen.getByText('Start from the customer as it is').closest('a')!.getAttribute('href')).toBe('/customers/c1/edit');
    expect(h.cleared).toHaveLength(1);
  });

  it('?returned= anything else — answered, cleared, another customer’s — fills nothing in', async () => {
    await editPage('e-old');
    expect(h.formProps!.returned).toBeUndefined();
    cleanup();
    h.openIds = [];
    h.cleared = [];
    await editPage('e1');
    expect(h.formProps!.returned).toBeUndefined();
    expect(screen.queryByText(/Sent back to you/)).toBeNull();
    expect(h.cleared).toEqual([]);
  });
});

describe('the customer profile, where his "Correction" notification lands', () => {
  it('says why, and links to the form filled in with what he sent', async () => {
    const { default: Profile } = await import('@/app/(app)/customers/[id]/page');
    render(await Profile({ params: Promise.resolve({ id: 'c1' }) }));
    expect(screen.getByText(/Your changes were sent back by Manager Muna/)).toBeTruthy();
    expect(screen.getByText(/The phone on file is right/)).toBeTruthy();
    expect(screen.getByText('Open the form to fix it').closest('a')!.getAttribute('href')).toBe(
      '/customers/c1/edit?returned=e1'
    );
  });

  it('says nothing when nothing waits on him', async () => {
    h.openIds = [];
    const { default: Profile } = await import('@/app/(app)/customers/[id]/page');
    render(await Profile({ params: Promise.resolve({ id: 'c1' }) }));
    expect(screen.queryByText(/sent back/)).toBeNull();
  });
});
