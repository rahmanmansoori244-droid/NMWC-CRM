import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

type Branch = {
  id: string;
  branchName: string;
  routeId: string;
  dayOfVisit: string | null;
  deletedAt: Date | null;
  customer: { id: string; deletedAt?: Date | null };
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
  CustomerCard: ({ customer, href }: { customer: { id: string }; href?: string }) => (
    <div data-testid="visit" data-href={href}>{customer.id}</div>
  ),
}));
vi.mock('@/lib/db', () => {
  type Where = {
    routeId: string; deletedAt: null; customer?: { deletedAt: null }; dayOfVisit?: string | null;
  };
  // A key the page leaves out does not filter; `dayOfVisit: null` filters for null.
  const matching = (where: Where) => state.branches.filter((b) =>
    b.routeId === where.routeId && b.deletedAt === where.deletedAt &&
    (!where.customer || (b.customer.deletedAt ?? null) === where.customer.deletedAt) &&
    (!('dayOfVisit' in where) || b.dayOfVisit === where.dayOfVisit)
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
  // Id order opposes name order, and duplicate names straddle page boundaries.
  id: `branch-${String(999 - i).padStart(3, '0')}`,
  branchName: `Branch ${String(Math.floor(i / 3)).padStart(3, '0')}`,
  routeId: 'route-a', dayOfVisit: 'FRI', deletedAt: null,
  customer: { id: `customer-${i}` }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'SALESMAN';
  state.route = 'route-a';
  state.signedIn = true;
  state.branches = Array.from({ length: 465 }, (_, i) => branch(i));
  state.branches.push(
    branch(500, { routeId: 'other-route' }),
    branch(501, { dayOfVisit: 'SAT' }),
    branch(502, { deletedAt: new Date('2026-01-01') }),
    // A live branch of an archived customer: its profile is not found.
    branch(503, { customer: { id: 'customer-503', deletedAt: new Date('2026-01-01') } })
  );
});

// A Stat tile: the number sits just above its label.
const tile = (label: string) => screen.getByText(label).previousElementSibling?.textContent;
afterEach(cleanup);

describe('Today route-day pagination', () => {
  it('orders and links all three pages of 465 branches without duplication or scope leakage', async () => {
    render(await TodayPage({}));
    expect(screen.getByRole('heading', { name: "Today's visits (465)" })).toBeTruthy();
    expect(screen.getByText('Showing 200 of 465 visits · Page 1 of 3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All my customers' })).toBeTruthy();
    expect(tile('Route branches')).toBe('466');
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    const next = screen.getByRole('link', { name: 'Next' });
    expect(next.getAttribute('href')).toBe('/today?page=2');
    const page = new URL(next.getAttribute('href')!, 'https://test.invalid').searchParams.get('page')!;
    const first = screen.getAllByTestId('visit').map((el) => el.textContent);
    // Name comes first; ascending id reverses the three customers sharing each name.
    expect(first[0]).toBe('customer-2');
    expect(first[first.length - 1]).toBe('customer-199');
    cleanup();
    // Database row order is unspecified for ties unless the query orders by id too.
    state.branches.reverse();
    render(await TodayPage({ searchParams: Promise.resolve({ page }) }));
    const second = screen.getAllByTestId('visit').map((el) => el.textContent);
    expect(screen.getByText('Showing 200 of 465 visits · Page 2 of 3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/today?page=1');
    const lastPage = screen.getByRole('link', { name: 'Next' });
    expect(lastPage.getAttribute('href')).toBe('/today?page=3');
    const pageThree = new URL(lastPage.getAttribute('href')!, 'https://test.invalid').searchParams.get('page')!;
    cleanup();
    state.branches.reverse();
    render(await TodayPage({ searchParams: Promise.resolve({ page: pageThree }) }));
    const third = screen.getAllByTestId('visit').map((el) => el.textContent);
    expect(screen.getByText('Showing 65 of 465 visits · Page 3 of 3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/today?page=2');
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(200);
    expect(third).toHaveLength(65);
    expect(new Set([...first, ...second, ...third])).toEqual(new Set(Array.from({ length: 465 }, (_, i) => `customer-${i}`)));
  });

  it.each(['0', '-1', '1.5', 'abc', '1e3', '9007199254740992', ['2', '3']])(
    'uses the first page for an invalid page parameter %j', async (page) => {
      render(await TodayPage({ searchParams: Promise.resolve({ page }) }));
      expect(screen.getByText('Showing 200 of 465 visits · Page 1 of 3')).toBeTruthy();
    }
  );

  it('clamps a stale page link after the route shrinks', async () => {
    render(await TodayPage({ searchParams: Promise.resolve({ page: '999999' }) }));
    expect(screen.getByText('Showing 65 of 465 visits · Page 3 of 3')).toBeTruthy();
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

// Go-live: a branch with no visit day never matches Today's day, and /customers
// cannot ask for "no visit day", so the no-day view is the only list of them.
// 205 of them are two pages, where Today's 465 are three: a page count read off
// the wrong total shows.
const UNDATED = 205;
const undated = (i: number, extra: Partial<Branch> = {}): Branch => branch(i, {
  // Same shape as `branch`: id order opposes name order, names repeat in threes.
  id: `undated-${String(999 - i).padStart(3, '0')}`,
  branchName: `Undated ${String(Math.floor(i / 3)).padStart(3, '0')}`,
  dayOfVisit: null,
  customer: { id: `undated-customer-${i}` },
  ...extra,
});
const noDayPage = (page?: string) =>
  TodayPage({ searchParams: Promise.resolve(page ? { view: 'no-day', page } : { view: 'no-day' }) });
const shown = () => screen.getAllByTestId('visit').map((el) => el.textContent);
// Reads the view and page back off a rendered link, as a tap would.
const follow = (link: HTMLElement) => {
  const params = new URL(link.getAttribute('href')!, 'https://test.invalid').searchParams;
  return TodayPage({
    searchParams: Promise.resolve({ view: params.get('view') ?? undefined, page: params.get('page') ?? undefined }),
  });
};

describe('Today: branches with no visit day', () => {
  beforeEach(() => {
    state.branches.push(
      ...Array.from({ length: UNDATED }, (_, i) => undated(i)),
      undated(600, { routeId: 'other-route', customer: { id: 'stray-other-route' } }),
      undated(601, { deletedAt: new Date('2026-01-01'), customer: { id: 'stray-archived-branch' } }),
      undated(602, { customer: { id: 'stray-archived-customer', deletedAt: new Date('2026-01-01') } })
    );
  });

  it('links from Today with its count, and labels what each number counts', async () => {
    render(await TodayPage({}));
    const link = screen.getByRole('link', { name: `Branches with no visit day (${UNDATED})` });
    expect(link.getAttribute('href')).toBe('/today?view=no-day');
    // 465 today + 1 on another day + 205 with none; no other route, nothing archived.
    expect(tile('Route branches')).toBe('671');
    expect(screen.queryByText('Route customers')).toBeNull();
    // /customers counts customers, not branches, so its link carries no number.
    expect(screen.getByRole('link', { name: 'All my customers' }).getAttribute('href')).toBe('/customers');
    expect(screen.queryByText(/Day of visit\. It leaves this list/)).toBeNull();
  });

  it('lists only his own live null-day branches, 200 a page, each opening its customer', async () => {
    render(await noDayPage());
    expect(screen.getByRole('heading', { name: `Branches with no visit day (${UNDATED})` })).toBeTruthy();
    expect(screen.getByText('Showing 200 of 205 branches · Page 1 of 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: "Today's visits (465)" }).getAttribute('href')).toBe('/today');
    expect(screen.queryByRole('link', { name: /Branches with no visit day/ })).toBeNull();
    expect(tile('Route branches')).toBe('671');
    // Setting the day waits for approval, and the page says so.
    expect(screen.getByText(/tap Enrich and set the branch's Day of visit\. It leaves this list once the change is approved\./)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    const next = screen.getByRole('link', { name: 'Next' });
    expect(next.getAttribute('href')).toBe('/today?view=no-day&page=2');
    const first = shown();
    // Name first, then ascending id — the same stable key as Today.
    expect(first[0]).toBe('undated-customer-2');
    expect(first[first.length - 1]).toBe('undated-customer-199');
    // The Today row: each card opens its own customer.
    for (const row of screen.getAllByTestId('visit')) {
      expect(row.getAttribute('data-href')).toBe(`/customers/${row.textContent}`);
    }
    cleanup();
    // Database row order is unspecified for ties unless the query orders by id too.
    state.branches.reverse();
    render(await follow(next));
    const second = shown();
    expect(screen.getByText('Showing 5 of 205 branches · Page 2 of 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/today?view=no-day&page=1');
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(5);
    // Exactly the count the Today link showed, each once: no stray, no visit-day branch.
    expect(new Set([...first, ...second])).toEqual(
      new Set(Array.from({ length: UNDATED }, (_, i) => `undated-customer-${i}`))
    );
  });

  it('reads Today\'s own route scope for every list and count', async () => {
    render(await noDayPage());
    const route = { routeId: 'route-a', deletedAt: null, customer: { deletedAt: null } };
    const wheres = [
      ...vi.mocked(prisma.branch.count).mock.calls,
      ...vi.mocked(prisma.branch.findMany).mock.calls,
    ].map(([args]) => args?.where);
    expect(wheres).toEqual([
      { ...route, dayOfVisit: 'FRI' },
      { ...route, dayOfVisit: null },
      route,
      { ...route, dayOfVisit: null },
    ]);
  });

  it('clamps a stale page link to the last page of the no-day list', async () => {
    render(await noDayPage('3'));
    expect(screen.getByText('Showing 5 of 205 branches · Page 2 of 2')).toBeTruthy();
  });

  it('says so when every branch on the route has a visit day', async () => {
    state.branches = state.branches.filter((b) => b.dayOfVisit !== null || b.customer.id.startsWith('stray-'));
    render(await TodayPage({}));
    expect(screen.getByRole('link', { name: 'Branches with no visit day (0)' })).toBeTruthy();
    cleanup();
    render(await noDayPage('2'));
    expect(screen.getByText('Every branch has a visit day')).toBeTruthy();
    // nothing to open, so no 'open the shop' hint either
    expect(screen.queryByText(/Day of visit\. It leaves this list/)).toBeNull();
    expect(screen.getByText('Showing 0 of 0 branches · Page 1 of 1')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Branch pages' })).toBeNull();
    expect(screen.queryAllByTestId('visit')).toHaveLength(0);
  });

  it.each([{ view: 'other' }, { view: ['no-day', 'no-day'] }])('treats view $view as Today', async ({ view }) => {
    render(await TodayPage({ searchParams: Promise.resolve({ view }) }));
    expect(screen.getByRole('heading', { name: "Today's visits (465)" })).toBeTruthy();
    expect(screen.getByText('Showing 200 of 465 visits · Page 1 of 3')).toBeTruthy();
  });

  it('keeps the no-route state without querying branches', async () => {
    state.route = null;
    render(await noDayPage());
    expect(screen.getByText('No route assigned')).toBeTruthy();
    expect(prisma.branch.count).not.toHaveBeenCalled();
    expect(prisma.branch.findMany).not.toHaveBeenCalled();
  });

  it.each(['anonymous', 'MANAGER'])('redirects %s before querying branches', async (role) => {
    state.signedIn = role !== 'anonymous';
    state.role = role;
    await expect(noDayPage()).rejects.toThrow(role === 'anonymous' ? 'REDIRECT /login' : 'REDIRECT /home');
    expect(prisma.branch.count).not.toHaveBeenCalled();
    expect(prisma.branch.findMany).not.toHaveBeenCalled();
  });
});
