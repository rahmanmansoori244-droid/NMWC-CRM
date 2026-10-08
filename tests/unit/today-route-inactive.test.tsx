/**
 * Launch fix (P2, a route switched off mid-week): Today listed the route's
 * visits with no word that nothing he sent on it would be accepted. New
 * customer refused on it; an enrichment, a close and a reactivation now do too
 * (services/edits.ts, services/reactivations.ts), and so does his photo attach
 * and Remove (services/photos.ts). Today says so above the visits, which stay
 * listed, opening with the words the refusals use.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ROUTE_INACTIVE_MESSAGE } from '@/lib/errors';

const state = vi.hoisted(() => ({ isActive: false }));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', role: 'SALESMAN', username: 's' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUniqueOrThrow: async () => ({
        id: 'u1',
        fullName: 'Said Ali',
        ownedRouteId: 'r1',
        ownedRoute: { isActive: state.isActive },
      }),
    },
    customerEdit: { count: async () => 0 },
    // lib/returned-work.ts countOpenReturned: nothing sent back waits on him.
    $queryRaw: async () => [{ n: 0 }],
    branch: {
      count: async () => 1,
      findMany: async () => [
        {
          id: 'b1',
          branchName: 'Main',
          address: 'Way 1, Ruwi',
          gpsLat: null,
          gpsLng: null,
          customer: {
            id: 'c1',
            nmwcCode: 'NMWC-000001',
            legalName: 'Al Noor Grocery',
            paymentTerms: 'CASH',
            status: 'ACTIVE',
            completenessScore: 50,
            primaryPhone: null,
          },
        },
      ],
    },
  },
}));

import TodayPage from '@/app/(app)/today/page';

afterEach(cleanup);

describe('/today on a switched-off route', () => {
  it('says the route is inactive and what that stops, and still lists the visits', async () => {
    state.isActive = false;
    render(await TodayPage({}));
    const main = screen.getByRole('main');
    expect(main.textContent).toContain(ROUTE_INACTIVE_MESSAGE);
    expect(main.textContent).toMatch(
      /you cannot submit an enrichment, add or remove photos, mark a shop closed, request a reactivation or register a new customer/
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Al Noor Grocery' })).toBeTruthy();
  });

  // Launch review: the notice said he cannot register a new customer under a
  // live "New customer" button.
  it('shows New customer switched off, with no way to the form', async () => {
    state.isActive = false;
    render(await TodayPage({}));
    const button = screen.getByRole('button', { name: 'New customer' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('link', { name: 'New customer' })).toBeNull();
    expect(document.querySelector('a[href="/customers/new"]')).toBeNull();
  });

  it('says nothing of it on a live route', async () => {
    state.isActive = true;
    render(await TodayPage({}));
    expect(screen.getByRole('main').textContent).not.toMatch(/route is inactive/i);
    expect(screen.getByRole('heading', { level: 3, name: 'Al Noor Grocery' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New customer' }).getAttribute('href')).toBe('/customers/new');
    expect(screen.queryByRole('button', { name: 'New customer' })).toBeNull();
  });
});
