/**
 * Launch review of the switched-off route fix: Today said he cannot submit an
 * enrichment, mark a shop closed or request a reactivation, but the forms said
 * nothing. He could fill one in and upload the evidence photo before Submit was
 * refused (services/edits.ts, services/reactivations.ts).
 *
 *   - The enrichment page says so at the top and holds Submit, with the same
 *     words as its title; Save draft stays (a draft is still saved).
 *   - The customer profile shows the words in place of Mark closed and Request
 *     reactivation, so the form never opens.
 *   - On a live route nothing changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ROUTE_INACTIVE_MESSAGE } from '@/lib/errors';

const h = vi.hoisted(() => ({
  isActive: false,
  formProps: null as null | { canSubmit: boolean; submitHeldTitle?: string },
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
  openReturnedIds: vi.fn(async () => []),
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

const branch = () => ({
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
  route: { code: 'MCT-01', name: 'MCT-01', isActive: h.isActive },
});
const customer = () => ({
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
  branches: [branch()],
});

vi.mock('@/lib/db', () => ({
  prisma: {
    customer: { findFirst: async () => customer() },
    user: {
      findUniqueOrThrow: async () => ({ ownedRouteId: 'r1', ownedRoute: { isActive: h.isActive } }),
    },
    channel: { findMany: async () => [] },
    customerEdit: { findFirst: async () => null, findUnique: async () => null },
  },
}));

beforeEach(() => {
  h.formProps = null;
});
afterEach(cleanup);

async function editPage() {
  const { default: Page } = await import('@/app/(app)/customers/[id]/edit/page');
  render(await Page({ params: Promise.resolve({ id: 'c1' }), searchParams: Promise.resolve({}) }));
}
async function profile() {
  const { default: Profile } = await import('@/app/(app)/customers/[id]/page');
  render(await Profile({ params: Promise.resolve({ id: 'c1' }) }));
}

describe('on a switched-off route', () => {
  beforeEach(() => {
    h.isActive = false;
  });

  it('the enrichment page says so at the top and holds Submit, in the same words', async () => {
    await editPage();
    const main = screen.getByRole('main');
    expect(main.textContent).toContain(ROUTE_INACTIVE_MESSAGE);
    expect(main.textContent).toContain('You can save a draft, but you cannot submit it until the route is active again.');
    expect(h.formProps).toMatchObject({ canSubmit: false, submitHeldTitle: ROUTE_INACTIVE_MESSAGE });
  });

  it('the customer profile says so in place of Mark closed, so the form never opens', async () => {
    await profile();
    expect(screen.getByText(ROUTE_INACTIVE_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark closed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request reactivation' })).toBeNull();
  });
});

describe('on a live route', () => {
  beforeEach(() => {
    h.isActive = true;
  });

  it('the enrichment page says nothing of it, and Submit is not held for it', async () => {
    await editPage();
    expect(screen.getByRole('main').textContent).not.toMatch(/route is inactive/i);
    expect(h.formProps).toMatchObject({ canSubmit: true });
    expect(h.formProps!.submitHeldTitle).toBeUndefined();
  });

  it('the customer profile offers Mark closed', async () => {
    await profile();
    expect(screen.getByRole('button', { name: 'Mark closed' })).toBeTruthy();
    expect(screen.queryByText(ROUTE_INACTIVE_MESSAGE)).toBeNull();
  });
});
