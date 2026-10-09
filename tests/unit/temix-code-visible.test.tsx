/**
 * Owner request 2026-10-10: the customer's Temix code is on its page, and on its
 * card in the /customers list when it differs from the NMWC code.
 *
 * A customer made in the CRM gets its Temix code from the Accountant at its last
 * approval (lib/create-finalize.ts); it differs from its NMWC code, and only the
 * salesman's "New customer approved" alert named it. A migrated customer's NMWC
 * code IS its Temix code: the page still shows it as the Temix code, the card
 * does not repeat it. A customer with none on record says so in words.
 *
 * The page is rendered with its session, scope and database mocked, as the
 * neighbouring profile tests do (route-inactive-forms, mobile-quick-wins).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Role } from '@prisma/client';
import { CustomerCard, cardTemixCode } from '@/components/nmwc/CustomerCard';

const h = vi.hoisted(() => ({
  role: 'SALESMAN',
  customer: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-1', role: h.role, username: 'u1' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
// Forwards aria-label: the card's accessible name is under test.
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
  loadScope: async () => ({ ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: ['g1'] }),
  canSeeCustomer: () => true,
  filterBranchesByScope: (_u: unknown, b: unknown[]) => b,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customer: { findFirst: async () => h.customer },
    customerEdit: { findUnique: async () => null },
  },
}));
vi.mock('@/app/(app)/customers/[id]/ArchiveCustomerButton', () => ({
  ArchiveCustomerButton: () => <button type="button">Archive</button>,
}));
vi.mock('@/components/nmwc/BranchStatusActions', () => ({ BranchStatusActions: () => null }));

afterEach(() => {
  cleanup();
  h.role = 'SALESMAN';
});

const profile = (nmwcCode: string, temixCode: string | null) => ({
  id: 'c1',
  nmwcCode,
  temixCode,
  legalName: 'Al Noor Trading',
  paymentTerms: 'CASH',
  crNumber: null,
  crPhoto: null,
  channel: null,
  subChannel: null,
  primaryPhone: null,
  altPhone: null,
  contactPerson: null,
  contactRole: null,
  status: 'ACTIVE',
  notes: null,
  completenessScore: 60,
  edits: [],
  branches: [
    {
      id: 'b1',
      branchName: 'Main',
      branchCode: `${nmwcCode}-01`,
      address: 'Way 1, Ruwi',
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
      shopPhoto: null,
      signboardPhoto: null,
      routeId: 'r1',
      regionId: 'g1',
      deletedAt: null,
      region: { name: 'Muscat' },
      route: { code: 'MCT-01', name: 'MCT-01', isActive: true },
    },
  ],
});

async function renderProfile(nmwcCode: string, temixCode: string | null) {
  h.customer = profile(nmwcCode, temixCode);
  const { default: Page } = await import('@/app/(app)/customers/[id]/page');
  render(await Page({ params: Promise.resolve({ id: 'c1' }) }));
}

/** The value of a labelled row of the profile: the <dd> beside its <dt>. */
function rowValue(label: string): HTMLElement {
  const dt = screen.getByText(label, { selector: 'dt' });
  const dd = dt.nextElementSibling;
  expect(dd?.tagName, `${label} has its value beside it`).toBe('DD');
  return dd as HTMLElement;
}

describe('the customer page shows the Temix code', () => {
  it('beside the NMWC code, when the Accountant gave it one of its own', async () => {
    await renderProfile('NMWC-2026-000123', 'CAA0367');
    expect(rowValue('NMWC code').textContent).toBe('NMWC-2026-000123');
    expect(rowValue('Temix code').textContent).toBe('CAA0367');
    // The rows follow each other: the two codes are read together.
    const nmwc = screen.getByText('NMWC code', { selector: 'dt' }).parentElement!;
    expect(nmwc.nextElementSibling).toBe(screen.getByText('Temix code', { selector: 'dt' }).parentElement);
    expect(rowValue('Temix code').className).toContain('font-mono');
  });

  it('for a migrated customer too, whose NMWC code IS its Temix code', async () => {
    await renderProfile('CAA0367', 'CAA0367');
    expect(rowValue('Temix code').textContent).toBe('CAA0367');
  });

  it('says in words when there is none on record, not a blank', async () => {
    await renderProfile('NMWC-2026-000124', null);
    expect(rowValue('Temix code').textContent).toBe('None recorded yet');
    expect(rowValue('Temix code').className).not.toContain('font-mono');
  });

  it.each(Object.values(Role))('to a %s who can open the page', async (role) => {
    h.role = role;
    await renderProfile('NMWC-2026-000123', 'CAA0367');
    expect(rowValue('Temix code').textContent).toBe('CAA0367');
  });
});

describe('the /customers card shows the Temix code when it differs', () => {
  const card = {
    id: 'c1',
    nmwcCode: 'NMWC-2026-000123',
    legalName: 'Al Noor Trading',
    paymentTerms: 'CASH' as const,
    status: 'ACTIVE' as const,
    completenessScore: 60,
    primaryPhone: null,
  };

  it('on a line of its own, labelled, and in the link’s name', () => {
    render(<CustomerCard customer={{ ...card, temixCode: 'CAA0367' }} href="/customers/c1" />);
    const line = screen.getByText('Temix code CAA0367');
    expect(line.tagName).toBe('P');
    expect(line.className).toContain('truncate');
    expect(screen.getByRole('link').getAttribute('aria-label')).toBe(
      'Al Noor Trading · NMWC-2026-000123 · Temix code CAA0367'
    );
  });

  it.each([
    ['a migrated customer (the same code)', 'NMWC-2026-000123'],
    ['the same code in another case', 'nmwc-2026-000123'],
    ['no code on record', null],
    ['not selected (Today)', undefined],
  ])('not for %s: the card and its name as before', (_what, temixCode) => {
    render(<CustomerCard customer={{ ...card, temixCode }} href="/customers/c1" />);
    expect(screen.queryByText(/Temix code/)).toBeNull();
    expect(screen.getByRole('link').getAttribute('aria-label')).toBe('Al Noor Trading · NMWC-2026-000123');
  });

  it('cardTemixCode keeps the code as stored', () => {
    expect(cardTemixCode({ nmwcCode: 'NMWC-2026-000123', temixCode: 'caa0367' })).toBe('caa0367');
  });
});
