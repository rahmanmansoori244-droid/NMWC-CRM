/**
 * F2: the insights dashboard page — who gets in, that the menu offers it to
 * exactly those people, whose figures it asks for, what each role is shown, and
 * that one failed card leaves the rest of the page standing, and that the kill
 * switch (lib/insights/rollout.ts) leaves only links and runs nothing. The loader
 * is mocked; its SQL is tested in tests/unit/insights-load.test.ts and on Postgres
 * in tests/integration/insights.test.ts.
 *
 * The page reads the clock once; here the clock is fixed and every expectation
 * about dates is derived from that one value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import type { Insights } from '@/lib/insights/load';
import type { InsightScope } from '@/lib/insights/scope';
import type { InsightPeriod } from '@/lib/insights/period';

const h = vi.hoisted(() => ({
  user: { id: 'u-1', role: 'MANAGER', username: 'u' } as { id: string; role: string; username: string } | null,
  regions: ['r-north', 'r-south'] as string[],
  scopeFails: false,
  scopeFor: vi.fn(),
  load: vi.fn(),
  push: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('@/lib/access', () => ({
  loadScope: async (userId: string) => {
    h.scopeFor(userId);
    if (h.scopeFails) throw new Error('database unreachable');
    return { ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions };
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: h.push }),
}));
vi.mock('@/lib/insights/load', () => ({ loadInsights: h.load }));
vi.mock('@/lib/reference-data', () => ({
  getAllActiveRegions: async () => [
    { id: 'r-east', name: 'East', code: 'E' },
    { id: 'r-north', name: 'North', code: 'N' },
    { id: 'r-south', name: 'South', code: 'S' },
  ],
  getAllActiveRoutes: async () => [
    { id: 'rt-e1', code: 'E1', name: 'East one', regionId: 'r-east' },
    { id: 'rt-n1', code: 'N1', name: 'North one', regionId: 'r-north' },
    { id: 'rt-s1', code: 'S1', name: 'South one', regionId: 'r-south' },
    // An active route of an inactive region (getAllActiveRegions leaves the region out).
    { id: 'rt-z1', code: 'ZZTEST-R1', name: 'Test route', regionId: 'r-zztest' },
  ],
}));

import DashboardPage from '@/app/(app)/dashboard/page';
import Loading from '@/app/(app)/dashboard/loading';
import { NAV_BY_ROLE, Sidebar } from '@/components/nmwc/Sidebar';
import { DASHBOARD_ROLES, HISTORY_BASELINE_DAY } from '@/lib/insights/policy';
import { omanDateISO } from '@/lib/tz';
import { addDays, parsePeriod } from '@/lib/insights/period';

// One instant, read once: 20:30 UTC is already the next day in Oman.
const NOW = new Date('2026-10-05T20:30:00Z');
const TODAY = omanDateISO(NOW);

const route = (id: string, code: string, regionId: string, hasOwner: boolean) => ({
  id, code, name: `${code} route`, regionId, regionName: regionId, hasOwner,
});
const region = (id: string, name: string) => ({ id, name, code: name.slice(0, 1) });
const counts = (over: Record<string, number | null> = {}) => ({
  branches: 70, customers: 60, open: 65, closed: 5, closedInPeriod: 1, openWithGps: 26, openNoDay: 15,
  openNoShop: 35, openNoSign: 40, openNoEquipment: 45, customersNoCr: 30, imported: 3, completenessPct: 55, ...over,
});

function fixture(buckets: string[]): Insights {
  return {
    state: {
      ok: true,
      data: {
        total: counts({ branches: 140, customers: 120, open: 130, closed: 10, openWithGps: 52, imported: 7 }),
        regions: [
          { ...counts(), region: region('r-north', 'North') },
          { ...counts(), region: region('r-south', 'South') },
        ],
        routes: [
          { ...counts(), route: route('rt-n1', 'N1', 'r-north', true) },
          { ...counts(), route: route('rt-s1', 'S1', 'r-south', false) },
        ],
      },
    },
    created: {
      ok: true,
      data: {
        total: 9, prevTotal: 6, cash: 7, credit: 2, unrecorded: 0,
        series: buckets.map((b, i) => ({ bucket: b, cash: i === 0 ? 7 : 0, credit: i === 1 ? 2 : 0, other: 0 })),
        regions: [{ region: region('r-north', 'North'), n: 6 }, { region: region('r-south', 'South'), n: 3 }],
        routes: [{ route: route('rt-n1', 'N1', 'r-north', true), n: 9 }],
      },
    },
    updated: {
      ok: true,
      data: {
        customers: 24, byRequest: 20, directOnly: 4, changes: 31, prevCustomers: 30,
        families: { gps: 11, phone: 8, address: 5, visitDay: 3, channel: 0, equipment: 2, contact: 1 },
        series: buckets.map((b) => ({ bucket: b, byRequest: 2, directOnly: 1 })),
        regions: [{ region: region('r-north', 'North'), customers: 24, byRequest: 20 }],
        routes: [
          { route: route('rt-n1', 'N1', 'r-north', true), customers: 24, byRequest: 20, byRequestOnRoute: 20 },
          // A chain customer's update by N1's salesman also reaches S1's branch of it:
          // S1 counts the customer, but did none of the work.
          { route: route('rt-s1', 'S1', 'r-south', false), customers: 1, byRequest: 1, byRequestOnRoute: 0 },
        ],
      },
    },
    statusChanges: {
      ok: true,
      data: {
        closed: 3, reactivated: 1, closeRefused: 1, keptClosed: 0, prevClosed: 2, prevReactivated: 0, closeWaiting: 2, reactWaiting: 1,
        series: buckets.map((b) => ({ bucket: b, closed: 0, reactivated: 0 })),
        regions: [],
      },
    },
    pipeline: {
      ok: true,
      data: {
        submitted: {
          create: { SUBMITTED: 3, NEEDS_CORRECTION: 1, APPROVED: 9, REJECTED: 0 },
          update: { SUBMITTED: 4, NEEDS_CORRECTION: 2, APPROVED: 20, REJECTED: 1 },
          close: { SUBMITTED: 2, NEEDS_CORRECTION: 1, APPROVED: 3, REJECTED: 0 },
          reactivation: { SUBMITTED: 1, NEEDS_CORRECTION: 0, APPROVED: 1, REJECTED: 0 },
        },
        // Every step: 12. The Supervisor step: 9.
        waitingAnyStep: { create: 5, update: 4, close: 2, reactivation: 1 },
        waitingFirstStep: { create: 3, update: 4, close: 2, reactivation: 0 },
      },
    },
    heat: {
      ok: true,
      data: {
        cellDeg: 0.05,
        cells: [{ lat: 23.6, lng: 58.4, n: 30 }, { lat: 17.0, lng: 54.1, n: 20 }],
        totalCells: 2, located: 50, openBranches: 130, openWithGps: 52,
      },
    },
  };
}

type Search = { period?: string | string[]; from?: string; to?: string; region?: string | string[]; route?: string };
const open = async (search: Search = {}) => render(await DashboardPage({ searchParams: Promise.resolve(search) }));
const lastScope = () => h.load.mock.calls.at(-1)![0] as Exclude<InsightScope, { kind: 'none' }>;
const lastPeriod = () => h.load.mock.calls.at(-1)![1] as InsightPeriod;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.user = { id: 'u-1', role: 'MANAGER', username: 'u' };
  h.regions = ['r-north', 'r-south'];
  h.scopeFails = false;
  h.scopeFor.mockReset();
  h.push.mockReset();
  h.load.mockReset().mockImplementation(async (_scope: unknown, period: InsightPeriod) => fixture(period.buckets));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('who gets in', () => {
  it.each(['SALESMAN', 'SUPERVISOR', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM'])(
    '%s is sent home without anything being loaded',
    async (role) => {
      h.user = { id: 'x', role, username: 'x' };
      await expect(open()).rejects.toThrow('REDIRECT /home');
      expect(h.load).not.toHaveBeenCalled();
      expect(h.scopeFor).not.toHaveBeenCalled();
    }
  );

  it('signed out goes to /login', async () => {
    h.user = null;
    await expect(open()).rejects.toThrow('REDIRECT /login');
  });

  it.each(['MANAGER', 'VIEWER', 'STEWARD'])('%s sees the page', async (role) => {
    h.user = { id: 'x', role, username: 'x' };
    await open();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New customers over time' })).toBeTruthy();
  });
});

describe('the menu offers /dashboard to exactly the roles the page admits', () => {
  it.each(Object.keys(NAV_BY_ROLE))('%s', (role) => {
    const offered = NAV_BY_ROLE[role as keyof typeof NAV_BY_ROLE].some((i) => i.href === '/dashboard');
    expect(offered).toBe((DASHBOARD_ROLES as readonly string[]).includes(role));
  });
});

describe('whose figures it asks for', () => {
  it('a Manager: his regions, read from the database; the window ends today in Oman', async () => {
    await open();
    expect(h.scopeFor).toHaveBeenCalledWith('u-1');
    expect(lastScope()).toMatchObject({ kind: 'regions', regionIds: ['r-north', 'r-south'], routeIds: null });
    expect(lastPeriod().toDay).toBe(TODAY);
    expect(lastPeriod().fromDay).toBe(addDays(TODAY, -29));
  });

  it.each(['VIEWER', 'STEWARD'])('%s: the whole organisation, with no scope read at all', async (role) => {
    h.user = { id: 'x', role, username: 'x' };
    await open();
    expect(h.scopeFor).not.toHaveBeenCalled();
    expect(lastScope()).toMatchObject({ kind: 'company', regionIds: null, routeIds: null });
  });

  it('a region outside a Manager’s scope narrows to nothing; it never widens', async () => {
    await open({ region: 'r-east' });
    expect(lastScope().regionIds).toEqual(['__none__']);
  });

  it('a Manager’s own region filter is kept, with his routes beside it', async () => {
    await open({ region: 'r-south,r-east', route: 'rt-s1', period: '90d' });
    expect(lastScope()).toMatchObject({ regionIds: ['r-south'], routeIds: ['rt-s1'] });
    expect(lastPeriod()).toMatchObject({ key: '90d', grain: 'week' });
  });

  it('a Manager with no regions sees the notice and nothing is loaded', async () => {
    h.regions = [];
    await open();
    expect(screen.getByText('No regions assigned')).toBeTruthy();
    expect(h.load).not.toHaveBeenCalled();
  });

  it('when his regions cannot be read, it says so and shows nothing rather than the wrong figures', async () => {
    h.scopeFails = true;
    await open();
    expect(screen.getByText('Your regions could not be read')).toBeTruthy();
    expect(h.load).not.toHaveBeenCalled();
  });
});

describe('what each role is shown', () => {
  it('a Manager is never shown company or national figures, and his view is named as his', async () => {
    const { container } = await open();
    expect(container.textContent).toMatch(/Your regions: North, South/);
    expect(container.textContent).not.toMatch(/whole organisation|company-wide|national|company average/i);
  });

  it('the Steward and the Viewer see the whole organisation named as such', async () => {
    h.user = { id: 'x', role: 'VIEWER', username: 'x' };
    const { container } = await open();
    expect(container.textContent).toMatch(/Whole organisation/);
  });

  it('a Manager’s Pending approval is his Supervisor-step queue, new-customer requests included', async () => {
    await open();
    const tile = screen.getByText('Pending approval').parentElement!;
    expect(within(tile).getByText('9')).toBeTruthy();
    expect(tile.textContent).toMatch(/new-customer requests included/);
    const link = within(tile).getByRole('link', { name: 'Open the approval queue' });
    expect(link.getAttribute('href')).toBe('/approvals');
  });

  it('the reactivations that wait for a Manager are shown beside it, not hidden by it', async () => {
    // The old tile counted them; the Supervisor-step count does not, so they get a line of their own.
    await open();
    const tile = screen.getByText('Pending approval').parentElement!;
    expect(tile.textContent).toMatch(/Not counted above: 1 reactivation waiting for your decision/);
    const link = within(tile).getByRole('link', { name: '1 reactivation waiting for your decision' });
    expect(link.getAttribute('href')).toBe('/reactivations');
  });

  it('the Steward’s Pending approval counts every step, and offers no queue it cannot open', async () => {
    h.user = { id: 'x', role: 'STEWARD', username: 'x' };
    await open();
    const tile = screen.getByText('Pending approval').parentElement!;
    expect(within(tile).getByText('12')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the approval queue' })).toBeNull();
    expect(tile.textContent).not.toMatch(/Not counted above/);
  });

  it('the comparison with the period before says it runs to the same time of day while today is under way', async () => {
    await open();
    const tile = screen.getByText('New customers').parentElement!;
    expect(tile.textContent).toMatch(/\+50% vs the 30 days before, to the same time of day/);
    cleanup();
    await open({ period: 'custom', from: '2026-09-01', to: '2026-09-30' });
    const ended = screen.getByText('New customers').parentElement!;
    expect(ended.textContent).toMatch(/vs the 30 days before/);
    expect(ended.textContent).not.toMatch(/same time of day/);
  });

  it('the link to /approvals the go-live browser test follows is still the menu’s “Approvals”', async () => {
    await open();
    // Nothing on the page is named exactly "Approvals" (the e2e clicks the first one).
    expect(screen.queryAllByRole('link', { name: /^approvals$/i })).toHaveLength(0);
    cleanup();
    render(<Sidebar role="MANAGER" />);
    const links = screen.getAllByRole('link', { name: /^approvals$/i });
    expect(links[0]!.getAttribute('href')).toBe('/approvals');
  });

  it.each([
    ['MANAGER', true],
    ['STEWARD', true],
    ['VIEWER', false],
  ])('%s: the link to Service status is offered only to its roles', async (role, offered) => {
    h.user = { id: 'x', role, username: 'x' };
    await open();
    expect(screen.queryAllByRole('link', { name: 'Service status' }).length > 0).toBe(offered);
  });

  it('drill-downs open the same slice in Customers', async () => {
    await open({ region: 'r-north' });
    expect(screen.getByRole('link', { name: 'Open the customer list' }).getAttribute('href')).toBe('/customers?region=r-north');
    const route = screen.getAllByRole('link', { name: /Route N1: open its customers/ })[0]!;
    expect(route.getAttribute('href')).toBe('/customers?region=r-north&route=rt-n1');
  });

  it('the map says what it is and is not, beside the coverage', async () => {
    const { container } = await open();
    expect(container.textContent).toMatch(/Outline approximate, not a survey map/);
    expect(container.textContent).toMatch(/40%of open branches in view have GPS/);
    expect(container.querySelectorAll('svg rect title')).toHaveLength(2);
  });

  it('every card says what it counts', async () => {
    const { container } = await open();
    const cards = container.querySelectorAll('section[aria-labelledby]');
    expect(cards.length).toBe(10);
    for (const card of cards) {
      expect(card.querySelector('p')?.textContent?.length ?? 0, card.querySelector('h2')?.textContent ?? '').toBeGreaterThan(40);
    }
  });
});

describe('one failed card leaves the rest of the page standing', () => {
  it('the new-customer query failed: its card and tile say so, the others render', async () => {
    h.load.mockImplementation(async (_s: unknown, p: InsightPeriod) => ({ ...fixture(p.buckets), created: { ok: false } }));
    await open();
    const card = screen.getByRole('heading', { name: 'New customers over time' }).closest('section')!;
    expect(card.textContent).toMatch(/could not be loaded just now/);
    const tile = screen.getByText('New customers').parentElement!;
    expect(tile.textContent).toMatch(/Not available just now/);
    const updated = screen.getByRole('heading', { name: 'Customers updated over time' }).closest('section')!;
    expect(updated.textContent).not.toMatch(/could not be loaded/);
    expect(updated.textContent).toMatch(/31 approved changes/);
  });

  it('every query failed: the page still renders, every card with its notice', async () => {
    h.load.mockResolvedValue({
      state: { ok: false }, created: { ok: false }, updated: { ok: false },
      statusChanges: { ok: false }, pipeline: { ok: false }, heat: { ok: false },
    });
    const { container } = await open();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    // Ten cards, ten notices: "What stands out" says it could not be read, never "nothing to report".
    expect(screen.getAllByText(/could not be loaded just now/).length).toBe(10);
    expect(container.textContent).not.toMatch(/Nothing to report/);
    expect(screen.getAllByText('Not available just now')).toHaveLength(7);
    expect(container.querySelectorAll('section[aria-labelledby]').length).toBe(10);
  });

  it('some of what "What stands out" reads failed: it reads the rest, and says that some is missing', async () => {
    h.load.mockImplementation(async (_s: unknown, p: InsightPeriod) => ({ ...fixture(p.buckets), heat: { ok: false }, statusChanges: { ok: false } }));
    await open();
    const card = screen.getByRole('heading', { name: 'What stands out' }).closest('section')!;
    expect(card.querySelectorAll('li').length).toBeGreaterThan(0);
    expect(card.textContent).toMatch(/Some figures could not be loaded just now, so this reading leaves them out/);
  });
});

describe('Routes: most and least active', () => {
  const card = () => screen.getByRole('heading', { name: 'Routes: most and least active' }).closest('section')!;

  it('ranks each route by its own salesman’s work, not by a chain customer’s other branches', async () => {
    await open();
    const most = within(card()).getByText('Most active').parentElement!;
    expect(most.textContent).toMatch(/N1/);
    // S1 counts the chain customer (byRequest 1) but did none of the work.
    expect(most.textContent).not.toMatch(/S1/);
    expect(card().textContent).toMatch(/1 route with customers had no approved new-customer or update request/);
  });

  it('no route had any approved update: none is called "most active"', async () => {
    h.load.mockImplementation(async (_s: unknown, p: InsightPeriod) => {
      const d = fixture(p.buckets);
      if (!d.updated.ok) throw new Error('fixture');
      return { ...d, updated: { ok: true, data: { ...d.updated.data, routes: d.updated.data.routes.map((r) => ({ ...r, byRequestOnRoute: 0 })) } } };
    });
    await open();
    const most = within(card()).getByText('Most active').parentElement!;
    expect(most.textContent).toMatch(/No route in view had an approved update request in the last 30 days/);
    expect(most.textContent).not.toMatch(/0%/);
    // The least active still lists them, honestly, at 0%.
    expect(within(card()).getByText('Least active').parentElement!.textContent).toMatch(/0%/);
  });
});

describe('the kill switch', () => {
  it.each([
    ['MANAGER', ['/approvals', '/reactivations', '/customers', '/status']],
    ['STEWARD', ['/customers', '/status']],
    ['VIEWER', ['/customers']],
  ])('%s: a notice and working links, and no query, no scope read', async (role, hrefs) => {
    vi.stubEnv('INSIGHTS_DASHBOARD_DISABLED', 'true');
    h.user = { id: 'x', role, username: 'x' };
    const { container } = await open();
    expect(screen.getByText('Switched off for now')).toBeTruthy();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.scopeFor).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(hrefs);
    expect(container.querySelectorAll('section[aria-labelledby]')).toHaveLength(0);
  });

  it('the roles the page refuses are still refused while it is off', async () => {
    vi.stubEnv('INSIGHTS_DASHBOARD_DISABLED', 'true');
    h.user = { id: 'x', role: 'SALESMAN', username: 'x' };
    await expect(open()).rejects.toThrow('REDIRECT /home');
  });

  it.each(['', '1', 'TRUE', 'yes'])('only the exact value "true" switches it off (%j does not)', async (value) => {
    vi.stubEnv('INSIGHTS_DASHBOARD_DISABLED', value);
    await open();
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Switched off for now')).toBeNull();
  });
});

describe('the filter bar', () => {
  it('offers a Manager only his own regions and their routes', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Region/ }));
    const regions = screen.getByRole('dialog', { name: 'Region' });
    expect(within(regions).getByLabelText('North')).toBeTruthy();
    expect(within(regions).queryByLabelText('East')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Route/ }));
    const routes = screen.getByRole('dialog', { name: 'Route' });
    expect(within(routes).queryByLabelText('E1 · East one')).toBeNull();
    expect(within(routes).getByLabelText('N1 · North one')).toBeTruthy();
  });

  // Launch fix (2026-10-07): the organisation's view counts active regions only
  // (lib/insights/sql.ts), so the ZZTEST test region offers no route either.
  it('offers the Steward no route of an inactive region', async () => {
    h.user = { id: 'u-s', role: 'STEWARD', username: 's' };
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Route/ }));
    const routes = screen.getByRole('dialog', { name: 'Route' });
    expect(within(routes).getByLabelText('E1 · East one')).toBeTruthy();
    expect(within(routes).queryByLabelText('ZZTEST-R1 · Test route')).toBeNull();
  });

  it('tells the organisation’s view that switched-off regions are left out, and not a Manager', async () => {
    const note = /Regions that are switched off are left out of these figures/;
    h.user = { id: 'u-v', role: 'VIEWER', username: 'v' };
    await open();
    expect(screen.getByText(note)).toBeTruthy();
    cleanup();
    h.user = { id: 'u-1', role: 'MANAGER', username: 'u' };
    await open();
    expect(screen.queryByText(note)).toBeNull();
  });

  it('a Manager of one region has no region control', async () => {
    h.regions = ['r-north'];
    await open();
    expect(screen.queryByRole('button', { name: /Region/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Route/ })).toBeTruthy();
  });

  it('a period preset is one navigation, keeping the filters', async () => {
    await open({ region: 'r-north' });
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith('/dashboard?period=7d&region=r-north');
  });

  it.each(['7d', '30d', '12m'])('%s: a window or comparison reaching back before go-live carries a caveat', async (key) => {
    const p = parsePeriod({ period: key }, NOW);
    const { container } = await open({ period: key });
    const text = container.textContent ?? '';
    expect(/starts before go-live/.test(text)).toBe(p.fromDay < HISTORY_BASELINE_DAY);
    expect(/comparison with the period before reaches back before go-live/.test(text)).toBe(
      p.fromDay >= HISTORY_BASELINE_DAY && p.prevFromDay < HISTORY_BASELINE_DAY
    );
  });

  it('repeated keys in the address do not break the landing page', async () => {
    await open({ period: ['7d', '90d'], region: ['r-north', 'r-south'] });
    expect(lastPeriod().key).toBe('7d');
    expect(lastScope().regionIds).toEqual(['r-north', 'r-south']);
  });

  it('an adjusted period says so', async () => {
    await open({ period: 'custom', from: '2020-01-01', to: '2026-10-01' });
    expect(screen.getByText(/limited to 366 days/)).toBeTruthy();
  });

  it.each(['toString', 'constructor', '__proto__'])('?period=%s is an unknown period: the default, with a note, and no NaN', async (key) => {
    const { container } = await open({ period: key });
    expect(lastPeriod().key).toBe('30d');
    expect(screen.getByText(/Unknown period; showing the default/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|undefined/);
    // The filter bar does not carry the bad key on.
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(h.push).toHaveBeenCalledWith('/dashboard?period=7d');
  });
});

describe('the loading skeleton mirrors the page', () => {
  it('seven figures and one placeholder per card', async () => {
    const { container: page } = await open();
    const cards = page.querySelectorAll('section[aria-labelledby]').length;
    cleanup();
    const { container } = render(<Loading />);
    const grids = container.querySelectorAll('.grid');
    expect(grids[0]!.children).toHaveLength(7);
    expect(grids[1]!.children).toHaveLength(cards);
  });
});

describe('source rules for the dashboard', () => {
  const DIRS = ['app/(app)/dashboard', 'components/insights'];
  const files = DIRS.flatMap((d) => readdirSync(d).map((f) => join(d, f).replace(/\\/g, '/'))).filter((f) => /\.tsx?$/.test(f));
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

  it('found the files to check', () => {
    expect(files).toEqual(expect.arrayContaining(['app/(app)/dashboard/page.tsx', 'app/(app)/dashboard/cards.tsx', 'components/insights/OmanHeatMap.tsx']));
  });

  it('no cache shared between viewers, no server action, no Customer.updatedAt', () => {
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/unstable_cache|'use server'|"use server"|updatedAt/);
      expect(s, f).not.toMatch(/export\s+const\s+revalidate/);
    }
    expect(src('app/(app)/dashboard/page.tsx')).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('the filter bar is the only client component, and nothing here reads the database', () => {
    const clients = files.filter((f) => /^\s*['"]use client['"]/.test(src(f)));
    expect(clients).toEqual(['app/(app)/dashboard/InsightFilters.tsx']);
    for (const f of files) expect(src(f), f).not.toMatch(/from ['"]@\/lib\/db['"]|\$queryRaw|\.findMany\(/);
  });

  it('the client component imports nothing that can reach the database or the session', () => {
    const imports = [...src('app/(app)/dashboard/InsightFilters.tsx').matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      ['@/components/nmwc/MultiSelectFilter', '@/lib/insights/policy', '@/lib/insights/url', 'next/link', 'next/navigation', 'react'].sort()
    );
    // Those two modules are pure in turn.
    for (const f of ['lib/insights/policy.ts', 'lib/insights/url.ts']) {
      for (const m of src(f).matchAll(/from ['"]([^'"]+)['"]/g)) expect(['@prisma/client', './policy', './period'], f).toContain(m[1]);
    }
  });

  it('no Google Maps URL, no external image, no <table>', () => {
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/google\.com\/maps|https?:\/\//);
      expect(s, f).not.toMatch(/<table\b/);
    }
  });
});
