/**
 * Large-customer photos, part B: each profile photo is keyed by its id.
 *
 * RoutePhoto keeps its mode, phase, attempt and queue key for its life. If a
 * server refresh brings a new photo id to the same tile (a photo replaced in
 * another tab), the tile must be a new RoutePhoto, not the old one with a new
 * src. RoutePhoto is replaced here by a stand-in that remembers the id it was
 * mounted with.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('@/components/nmwc/RoutePhoto', () => ({
  RoutePhoto: ({ id }: { id: string }) => {
    const [first] = useState(id);
    return <i data-first={first} data-id={id} />;
  },
}));

const h = vi.hoisted(() => ({ customer: null as null | Record<string, unknown> }));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-1', role: 'SUPERVISOR', username: 'u1' } }) }));
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
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/returned-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/returned-work')>()),
  openReturnedIds: vi.fn(async () => []),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] }),
  canSeeCustomer: () => true,
  filterBranchesByScope: (_u: unknown, b: unknown[]) => b,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customer: { findFirst: async () => h.customer },
    customerEdit: { findUnique: async () => null },
  },
}));
vi.mock('@/app/(app)/customers/[id]/ArchiveCustomerButton', () => ({ ArchiveCustomerButton: () => null }));
vi.mock('@/components/nmwc/BranchStatusActions', () => ({ BranchStatusActions: () => null }));

afterEach(() => {
  h.customer = null;
});

const pid = (k: string, i: number) => `0000${k}00-0000-4000-8000-${String(i).padStart(12, '0')}`;

function customer(shops: number) {
  return {
    id: 'c1',
    nmwcCode: 'NMWC-2026-000123',
    temixCode: null,
    legalName: 'Load Chain',
    paymentTerms: 'CASH',
    crNumber: null,
    crPhoto: { id: pid('cc', 0) },
    channel: null,
    subChannel: null,
    primaryPhone: null,
    altPhone: null,
    contactPerson: null,
    contactRole: null,
    email: null,
    status: 'ACTIVE',
    notes: null,
    completenessScore: 60,
    edits: [],
    branches: Array.from({ length: shops }, (_, i) => ({
      id: `b${i}`,
      branchName: `Shop ${i}`,
      branchCode: `NMWC-2026-000123-${i}`,
      address: 'Way 1',
      gpsLat: null,
      gpsLng: null,
      dayOfVisit: null,
      openingHours: null,
      deliveryWindow: null,
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      completenessScore: 50,
      status: 'ACTIVE',
      shopPhoto: { id: pid('aa', i) },
      signboardPhoto: { id: pid('bb', i) },
      routeId: 'r1',
      regionId: 'g1',
      deletedAt: null,
      region: { name: 'Muscat' },
      route: { code: 'MCT-01', name: 'MCT-01', isActive: true },
    })),
  };
}

async function tree(c: ReturnType<typeof customer>) {
  h.customer = c;
  const { default: Page } = await import('@/app/(app)/customers/[id]/page');
  return Page({ params: Promise.resolve({ id: 'c1' }) });
}

describe('customer profile photos: keyed by id', () => {
  it('a new photo id on a refresh mounts a new RoutePhoto (tile and CR pill)', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const c = customer(3);
    const first = await tree(c);
    await act(async () => root.render(first));
    expect(container.querySelectorAll('i[data-id]')).toHaveLength(7);

    // The same customer, with shop 1's photo and the CR document replaced.
    const c2 = customer(3);
    (c2.branches[1] as { shopPhoto: { id: string } }).shopPhoto = { id: pid('dd', 1) };
    c2.crPhoto = { id: pid('dd', 0) };
    const second = await tree(c2);
    await act(async () => root.render(second));
    const tiles = [...container.querySelectorAll('i[data-id]')];
    expect(tiles.map((t) => t.getAttribute('data-id'))).toContain(pid('dd', 1));
    expect(tiles.map((t) => t.getAttribute('data-id'))).toContain(pid('dd', 0));
    for (const t of tiles) expect(t.getAttribute('data-first')).toBe(t.getAttribute('data-id'));
    act(() => root.unmount());
    container.remove();
  });
});
