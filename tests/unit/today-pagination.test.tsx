import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

type Branch = {
  id: string;
  branchName: string;
  routeId: string;
  dayOfVisit: string;
  deletedAt: Date | null;
  customer: { id: string };
};
const state = vi.hoisted(() => ({
  branches: [] as Branch[],
  role: 'SALESMAN',
  route: 'route-a' as string | null,
  signedIn: true,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => state.signedIn ? { user: { id: 'salesman-a', role: state.role } } : null,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
vi.mock('@/lib/tz', () => ({ omanDayOfWeek: () => 'FRI' }));
vi.mock('@/components/nmwc/CustomerCard', () => ({
  CustomerCard: ({ customer }: { customer: { id: string } }) => <div data-testid="visit">{customer.id}</div>,
}));
vi.mock('@/lib/db', () => {
  type Where = { routeId: string; deletedAt: null; dayOfVisit?: string };
  const matching = (where: Where) => state.branches.filter((b) =>
    b.routeId === where.routeId && b.deletedAt === where.deletedAt &&
    (!where.dayOfVisit || b.dayOfVisit === where.dayOfVisit)
  );
  return { prisma: {
    user: { findUniqueOrThrow: async () => ({ fullName: 'Test Salesman', ownedRouteId: state.route }) },
    customerEdit: { count: async () => 0 },
    branch: {
      count: vi.fn(async ({ where }: { where: Where }) => matching(where).length),
      findMany: vi.fn(async ({ where, skip = 0, take, orderBy }: {
        where: Where; skip?: number; take: number;
        orderBy: Record<string, string> | Record<string, string>[];
      }) => {
        const ordering = Array.isArray(orderBy) ? orderBy : [orderBy];
        return matching(where).sort((a, b) => {
          for (const rule of ordering) {
            const key = Object.keys(rule)[0] as 'id' | 'branchName';
            const compared = a[key].localeCompare(b[key]);
            if (compared) return rule[key] === 'asc' ? compared : -compared;
          }
          return 0;
        }).slice(skip, skip + take);
      }),
    },
  } };
});

import TodayPage from '@/app/(app)/today/page';
import { prisma } from '@/lib/db';

const branch = (i: number, extra: Partial<Branch> = {}): Branch => ({
  id: `branch-${String(i).padStart(3, '0')}`,
  // Duplicate names straddle the page boundary.
  branchName: `Branch ${String(Math.floor(i / 3)).padStart(3, '0')}`,
  routeId: 'route-a', dayOfVisit: 'FRI', deletedAt: null,
  customer: { id: `customer-${i}` }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'SALESMAN';
  state.route = 'route-a';
  state.signedIn = true;
  state.branches = Array.from({ length: 266 }, (_, i) => branch(i));
  state.branches.push(
    branch(300, { routeId: 'other-route' }),
    branch(301, { dayOfVisit: 'SAT' }),
    branch(302, { deletedAt: new Date('2026-01-01') })
  );
});
afterEach(cleanup);

describe('Today route-day pagination', () => {
  it('makes all 266 scheduled branches reachable without duplication or scope leakage', async () => {
    render(await TodayPage({}));
    expect(screen.getByRole('heading', { name: "Today's visits (266)" })).toBeTruthy();
    expect(screen.getByText('Showing 200 of 266 visits · Page 1 of 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All my customers (267)' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    const next = screen.getByRole('link', { name: 'Next' });
    const page = new URL(next.getAttribute('href')!, 'https://test.invalid').searchParams.get('page')!;
    const first = screen.getAllByTestId('visit').map((el) => el.textContent);
    cleanup();
    // Database row order is unspecified for ties unless the query orders by id too.
    state.branches.reverse();
    render(await TodayPage({ searchParams: Promise.resolve({ page }) }));
    const second = screen.getAllByTestId('visit').map((el) => el.textContent);
    expect(screen.getByText('Showing 66 of 266 visits · Page 2 of 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/today?page=1');
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(66);
    expect(new Set([...first, ...second])).toEqual(new Set(Array.from({ length: 266 }, (_, i) => `customer-${i}`)));
  });

  it.each(['0', '-1', '1.5', 'abc', '1e3', '9007199254740992', ['2', '3']])(
    'uses the first page for an invalid page parameter %j', async (page) => {
      render(await TodayPage({ searchParams: Promise.resolve({ page }) }));
      expect(screen.getByText('Showing 200 of 266 visits · Page 1 of 2')).toBeTruthy();
    }
  );

  it('clamps a stale page link after the route shrinks', async () => {
    render(await TodayPage({ searchParams: Promise.resolve({ page: '999999' }) }));
    expect(screen.getByText('Showing 66 of 266 visits · Page 2 of 2')).toBeTruthy();
  });

  it('keeps the empty-day message and full-route link', async () => {
    state.branches = [branch(1, { dayOfVisit: 'SAT' })];
    render(await TodayPage({ searchParams: Promise.resolve({ page: '2' }) }));
    expect(screen.getByText('No customers scheduled today')).toBeTruthy();
    expect(screen.getByText('Showing 0 of 0 visits · Page 1 of 1')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Visit pages' })).toBeNull();
  });

  it('does not query branches when no route is assigned', async () => {
    state.route = null;
    render(await TodayPage({}));
    expect(screen.getByText('No route assigned')).toBeTruthy();
    expect(prisma.branch.count).not.toHaveBeenCalled();
    expect(prisma.branch.findMany).not.toHaveBeenCalled();
  });

  it.each(['anonymous', 'MANAGER'])('redirects %s before querying branches', async (role) => {
    state.signedIn = role !== 'anonymous';
    state.role = role;
    await expect(TodayPage({})).rejects.toThrow(role === 'anonymous' ? 'REDIRECT /login' : 'REDIRECT /home');
    expect(prisma.branch.count).not.toHaveBeenCalled();
    expect(prisma.branch.findMany).not.toHaveBeenCalled();
  });
});
