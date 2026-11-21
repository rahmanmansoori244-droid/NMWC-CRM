/**
 * Large-customer photos, part B: the customer profile's photos.
 *
 * 40 photos or fewer: the server HTML carries exactly the <img> tags it always
 * had (compared as strings), and nothing of the queue. More than 40: each
 * photo is a placeholder and no <img> or photo address is in the HTML, except
 * the links that open a photo. The page is rendered with its session, scope
 * and database mocked, as temix-code-visible.test.tsx does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';

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

async function html(shops: number): Promise<string> {
  h.customer = customer(shops);
  const { default: Page } = await import('@/app/(app)/customers/[id]/page');
  return renderToString(await Page({ params: Promise.resolve({ id: 'c1' }) }));
}

/** The <img> tags the page rendered before part B, in page order. */
function todaysImgs(shops: number): string[] {
  const out = [`<img src="/api/photos/${pid('cc', 0)}" alt="CR document" class="h-10 w-10 rounded object-cover ring-1 ring-emerald-200"/>`];
  for (let i = 0; i < shops; i++) {
    out.push(`<img src="/api/photos/${pid('aa', i)}" alt="Shop" class="absolute inset-0 h-full w-full object-cover"/>`);
    out.push(`<img src="/api/photos/${pid('bb', i)}" alt="Signboard" class="absolute inset-0 h-full w-full object-cover"/>`);
  }
  return out;
}
const imgTags = (s: string) => s.match(/<img [^>]*>/g) ?? [];

describe('customer profile photos', () => {
  it("39 photos: today's <img> tags, string for string, and nothing of the queue", async () => {
    const s = await html(19);
    expect(imgTags(s)).toEqual(todaysImgs(19));
    expect(s).not.toContain('data-photo-state');
    expect(s).not.toContain('aria-live');
    expect(s).not.toContain('Showing');
    // The links around them are unchanged.
    expect(s).toContain(`<a href="/api/photos/${pid('aa', 3)}" target="_blank" rel="noreferrer" class="relative flex h-24 flex-1 items-end overflow-hidden rounded-md border border-emerald-200 bg-emerald-50 text-sm font-medium text-white" aria-label="Shop photo">`);
  });

  it('41 photos: placeholders, no <img>, no photo address but the links', async () => {
    const s = await html(20);
    expect(imgTags(s)).toEqual([]);
    expect(s.match(/data-photo-state="waiting"/g)).toHaveLength(41);
    expect(s).toContain('aria-label="Shop: loading"');
    expect(s).toContain('aria-label="CR document: loading"');
    // Every photo address left is a link's href (41 of them), none a src.
    expect(s).not.toMatch(/src="\/api\/photos\//);
    expect(s.match(/href="\/api\/photos\//g)).toHaveLength(41);
    expect(s).not.toContain('Try again');
  });
});
