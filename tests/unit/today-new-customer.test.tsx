/**
 * A salesman on a phone can start a new customer from Today (owner decision
 * 2026-09-25, found by the third item-22 review). The sidebar holds the only
 * other link to a blank form, and it is hidden below the md breakpoint; the
 * bottom bar has none. Every other link to /customers/new opens an existing
 * request (?edit=).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', role: 'SALESMAN', username: 's' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUniqueOrThrow: async () => ({ id: 'u1', fullName: 'Said Ali', ownedRouteId: 'r1' }) },
    customerEdit: { count: async () => 0 },
    branch: { findMany: async () => [], count: async () => 12 },
  },
}));

import TodayPage from '@/app/(app)/today/page';

afterEach(cleanup);

describe('/today', () => {
  it('has a New customer button that opens a blank form, visible without the sidebar', async () => {
    render(await TodayPage());
    const link = screen.getByRole('link', { name: /New customer/ });
    expect(link.getAttribute('href')).toBe('/customers/new');
    // Not tucked behind a breakpoint: no hidden / md:-only class on it.
    expect(link.className).not.toMatch(/(^|\s)hidden(\s|$)|md:inline|md:flex|md:block/);
  });
});
