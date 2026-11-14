/**
 * The daily Temix import, stage 4: the preview (/temix-daily/<fileId>) and the
 * route-map page (/temix-daily/routes), rendered with a stubbed database. The
 * preview is fed the synthetic file of tests/support/temix-daily-check-fixture.ts
 * through a stubbed loader, so each figure it shows is the one
 * tests/unit/temix-daily-check.test.ts proves; this checks they reach the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { id: 'stw-1', role: 'STEWARD' } as { id: string; role: string } | null,
  file: null as unknown,
  orderFiles: [] as unknown[],
  waiting: [] as unknown[],
  emptied: 0,
  routeMap: [] as Array<{ id: string; temixRouteCode: string; routeId: string }>,
  entries: [] as unknown[],
  codeCounts: [] as unknown[],
  offRoutes: [] as unknown[],
  /** Replaces the synthetic file's input, for cases it does not hold. */
  input: null as unknown,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
  usePathname: () => '/temix-daily',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/services/temix-daily-routes', () => ({
  addTemixRouteMapAction: async () => ({ ok: false, message: 'x' }),
  retireTemixRouteMapAction: async () => ({ ok: false, message: 'x' }),
}));
vi.mock('@/lib/temix-daily-check-load', async () => {
  const { checkInput: input, ROUTES } = await import('../support/temix-daily-check-fixture');
  return {
    loadCheckInput: async () => ({ input: h.input ?? input(h.routeMap), emptied: h.emptied }),
    loadPilotWaiting: async () => h.waiting,
    loadRoutes: async () => ROUTES.map((r) => ({ ...r, name: `Route ${r.code}` })),
    loadLiveRouteMap: async () => h.routeMap,
    loadWaitingRouteCodes: async () => h.codeCounts,
    loadSwitchedOffRoutesHoldingShops: async () => h.offRoutes,
  };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    temixDailyFile: {
      findUnique: async () => h.file,
      findMany: async () => h.orderFiles,
    },
    temixRouteMap: {
      findMany: async (q: { where?: unknown }) => (q.where ? h.entries.filter((e) => (e as { live?: boolean }).live) : h.entries),
    },
    $queryRaw: async () => {
      throw new Error('the page ran raw SQL of its own');
    },
  },
}));

import CheckPage from '@/app/(app)/temix-daily/[fileId]/page';
import RoutesPage from '@/app/(app)/temix-daily/routes/page';

const SHA = 'b'.repeat(64);
const file = (id: string, loadDay: string, state: string) => ({
  id,
  filename: `${id}.xlsx`,
  loadDay: new Date(`${loadDay}T00:00:00Z`),
  uploadedAt: new Date(`${loadDay}T06:00:00Z`),
  state,
  fileSha256: SHA,
  totalRows: 19,
});
const open = (id = 'f1') => CheckPage({ params: Promise.resolve({ fileId: id }) });
const section = (name: RegExp) => screen.getByRole('heading', { name }).closest('section')!;
const figure = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;

beforeEach(() => {
  h.user = { id: 'stw-1', role: 'STEWARD' };
  h.file = file('f1', '2026-11-14', 'STAGED');
  h.orderFiles = [h.file];
  h.waiting = [];
  h.emptied = 0;
  h.routeMap = [];
  h.entries = [];
  h.codeCounts = [];
  h.offRoutes = [];
  h.input = null;
});
afterEach(cleanup);

describe('/temix-daily/<fileId>: the Check', () => {
  it('shows the summary figures of the synthetic file', async () => {
    render(await open());
    expect(screen.getByText(/Nothing is applied from here/)).toBeTruthy();
    expect(figure('Rows')).toBe('19');
    expect(figure('Would move a shop')).toBe('2');
    expect(figure('Would change nothing')).toBe('4');
    expect(figure('Held')).toBe('13');
    expect(figure('Customers found')).toBe('8');
    expect(figure('Unknown customer codes')).toBe('1');
    expect(figure('Customers not in the file')).toBe('3');
    expect(figure('Rows whose terms differ')).toBe('2');
  });

  it('lists the two moves from route to route, one into another region', async () => {
    render(await open());
    const moves = section(/Will change: route moves \(2 shops of 2 customers\)/);
    expect(within(moves).getByText(/1 into a route of another region; 0 through a route-map entry/)).toBeTruthy();
    const rows = within(moves).getAllByRole('row').slice(1);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))).toEqual([
      ['3', 'CA1', 'CA1-02', 'C11', 'C10', '-'],
      ['7', 'CB2', 'CB2-01', 'C10', 'D20', 'another region'],
    ]);
  });

  it('counts the held rows by reason and lists each', async () => {
    render(await open());
    const held = section(/Held: 13 rows change nothing/);
    expect(within(held).getByText(/^2: no customer in the CRM has this code/)).toBeTruthy();
    expect(within(held).getByText(/^2: the same customer and shop on more than one row/)).toBeTruthy();
    expect(within(held).getByText(/^1: the customer was found by its Temix code/)).toBeTruthy();
    expect(within(held).getAllByRole('row')).toHaveLength(14);
  });

  it('routes not applied, with the code not matched and a link to the map', async () => {
    render(await open());
    const route = section(/Route not applied: 3 shops keep their route/);
    expect(within(route).getByText(/^1: the route code is not a CRM route/)).toBeTruthy();
    expect(within(route).getByText(/^1: the CRM route it names is switched off/)).toBeTruthy();
    expect(within(route).getByText(/^1: no route in the file/)).toBeTruthy();
    expect(within(route).getByText('C10MA')).toBeTruthy();
    // The codes are counted over every row, held rows included, and apart over the shops found.
    expect(within(route).getByText(/in all rows of the file, held rows included/).textContent).toContain('C10MA (1; 1)');
  });

  it('a row held for a code only in small letters shows the code as written', async () => {
    const { ROUTES } = await import('../support/temix-daily-check-fixture');
    const customer = { id: 'cQ', nmwcCode: 'CQ1', temixCode: null, live: true, isTest: false, status: 'ACTIVE', paymentTerms: 'CASH', creditLimit: null, paymentTermDays: null };
    h.input = {
      rows: [
        { id: 'r2', rowNumber: 2, custCodeKey: 'CQ1', branchCodeKey: 'MA', branchCodeWritten: 'ma', route: 'C10', paymentTerms: 'CREDIT', creditLimit: null, paymentTermDays: null, status: 'A', notes: [] },
      ],
      customers: [customer],
      branches: [{ id: 'bQ1', customerId: 'cQ', branchCode: 'CQ1-MA', routeId: 'rt-c11', regionId: 'rg-1', live: true, status: 'ACTIVE' }],
      routes: ROUTES,
      routeMap: [],
    };
    render(await open());
    const held = within(section(/Held: 1 rows change nothing/)).getAllByRole('row')[1]!;
    expect([...held.querySelectorAll('td')].map((td) => td.textContent).slice(0, 3)).toEqual(['2', 'CQ1', 'ma (MA)']);
    expect(held.textContent).toMatch(/only looks like another/);
    const terms = within(section(/Credit and terms that differ: 1 rows of 1 customers/)).getAllByRole('row')[1]!;
    expect(terms.querySelectorAll('td')[2]!.textContent).toBe('ma (MA)');
  });

  it('a file of the same bytes as an earlier day says so on its Check', async () => {
    h.file = { ...file('f1', '2026-11-14', 'STAGED'), sameBytesAs: { loadDay: new Date('2026-11-12T00:00:00Z'), filename: 'monday.xlsx' } };
    render(await open());
    expect(screen.getByText(/Exactly the same file as 2026-11-12/).textContent).toContain('"monday.xlsx"');
    cleanup();
    h.file = file('f1', '2026-11-14', 'STAGED');
    render(await open());
    expect(screen.queryByText(/Exactly the same file as/)).toBeNull();
  });

  it('credit and terms differences, not applied', async () => {
    render(await open());
    const terms = section(/Credit and terms that differ: 2 rows of 1 customers \(not applied\)/);
    expect(within(terms).getByText(/Payment terms 0, credit limit 1, credit days 1/)).toBeTruthy();
    expect(within(terms).getByText(/1 customers have rows in this file that do not agree/)).toBeTruthy();
    expect(within(terms).getByText('Credit limit: 1500')).toBeTruthy();
    expect(within(terms).getByText('Credit limit: 2000')).toBeTruthy();
    expect(within(terms).getByText('Credit days: 45')).toBeTruthy();
  });

  it('status pairs beside the customer and the shop', async () => {
    render(await open());
    const status = section(/Status: Temix A or I beside the CRM/);
    const [byCustomer, byShop] = within(status).getAllByRole('table');
    const cells = (t: HTMLElement) => within(t).getAllByRole('row').slice(1).map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    expect(cells(byCustomer!)).toEqual([
      ['A', 'ACTIVE', '11'],
      ['A', 'CLOSED', '3'],
      ['I', 'ACTIVE', '1'],
    ]);
    expect(cells(byShop!)).toEqual([
      ['A', 'ACTIVE', '8'],
      ['A', 'CLOSED', '1'],
    ]);
  });

  it('unknown and missing customers, by code, nobody flagged', async () => {
    render(await open());
    const c = section(/Customers: 1 unknown, 3 not in the file/);
    expect(within(c).getByText(/1 customer codes on 2 rows/).textContent).toContain('CNEW1');
    const missing = within(c).getByText(/3 live customers that no row names/).textContent!;
    expect(missing).toMatch(/2 of them have no Temix code yet/);
    for (const code of ['CH1', 'CM7', 'NMWC-2026-000003']) expect(missing).toContain(code);
    expect(missing).not.toContain('CT8');
  });

  it('with a route-map entry the third move appears through the map', async () => {
    h.routeMap = [{ id: '1', temixRouteCode: 'C10MA', routeId: 'rt-c10' }];
    render(await open());
    const moves = section(/Will change: route moves \(3 shops of 3 customers\)/);
    expect(within(moves).getByText('route map (C10MA)')).toBeTruthy();
  });

  it('the pilot banner lists the waiting requests', async () => {
    h.waiting = [{ id: 'edit-1', submittedAt: new Date('2026-11-13T05:00:00Z') }];
    render(await open());
    expect(screen.getByText(/Pilot rule: 1 new-customer request waits at the Accountant/)).toBeTruthy();
    expect(screen.getByText('edit-1')).toBeTruthy();
  });

  it('the order rule, a finished file, and a file whose rows were emptied', async () => {
    h.orderFiles = [file('f0', '2026-11-12', 'STAGED'), h.file];
    render(await open());
    expect(screen.getByText(/This file waits for the file of 2026-11-12/)).toBeTruthy();
    cleanup();
    h.file = file('f1', '2026-11-14', 'LOADED');
    render(await open());
    expect(screen.getByText(/There is nothing to check/)).toBeTruthy();
    expect(screen.queryByText('Summary')).toBeNull();
    cleanup();
    h.file = file('f1', '2026-11-14', 'STAGED');
    h.emptied = 4;
    render(await open());
    expect(screen.getByText(/The contents of 4 of this file's rows were cleared/)).toBeTruthy();
    expect(screen.queryByText('Summary')).toBeNull();
  });

  it('is the Data Steward\'s only; an unknown file is not found', async () => {
    for (const role of ['MANAGER', 'SALESMAN', 'ACCOUNTANT', 'GM']) {
      h.user = { id: 'u', role };
      await expect(open(), role).rejects.toThrow('REDIRECT /home');
    }
    h.user = { id: 'stw-1', role: 'STEWARD' };
    h.file = null;
    await expect(open('nope')).rejects.toThrow('NOT FOUND');
  });
});

describe('/temix-daily/routes: the route map', () => {
  it('starts empty, and lists codes nothing matches and switched-off routes holding shops', async () => {
    h.codeCounts = [
      { code: 'C10', rows: 5 },
      { code: 'C10MA', rows: 3 },
    ];
    h.offRoutes = [{ id: 'rt-z99', code: 'Z99', shops: 2 }];
    render(await RoutesPage());
    expect(screen.getByText(/The route map is empty/)).toBeTruthy();
    const unmatched = within(screen.getByRole('region', { name: /Unmatched route codes/ })).getByRole('table');
    expect(within(unmatched).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['C10MA3']);
    expect(screen.getByText(/2 shops/).textContent).toContain('Z99');
  });

  it('lists the live entry with a retire form, and earlier ones apart', async () => {
    h.routeMap = [{ id: '7', temixRouteCode: 'C10MA', routeId: 'rt-c10' }];
    const at = new Date('2026-11-14T05:00:00Z');
    const live = { id: 7n, temixRouteCode: 'C10MA', action: 'ADD', routeId: 'rt-c10', retiresId: null, reason: 'Route master 1', at, by: { fullName: 'ZZ Steward' }, live: true };
    const old = { id: 5n, temixRouteCode: 'C10MA', action: 'ADD', routeId: 'rt-c11', retiresId: null, reason: 'Route master 0', at, by: { fullName: 'ZZ Steward' } };
    const retire = { id: 6n, temixRouteCode: 'C10MA', action: 'RETIRE', routeId: null, retiresId: 5n, reason: 'Superseded', at, by: { fullName: 'ZZ Steward' } };
    h.entries = [live, retire, old];
    render(await RoutesPage());
    const inUse = within(screen.getByRole('region', { name: /Route-map entries in use/ })).getByRole('table');
    expect(within(inUse).getByText('C10 (Route C10)')).toBeTruthy();
    expect(within(inUse).getByRole('button', { name: 'Retire' })).toBeTruthy();
    const earlier = within(screen.getByRole('region', { name: /Earlier route-map entries/ })).getByRole('table');
    expect(within(earlier).getByText('Retired entry 5')).toBeTruthy();
    expect(within(earlier).getByText('Added: C11 (Route C11) (retired since)')).toBeTruthy();
    expect(within(earlier).queryByText('Route master 1')).toBeNull();
  });

  it('is the Data Steward\'s only', async () => {
    h.user = { id: 'u', role: 'MANAGER' };
    await expect(RoutesPage()).rejects.toThrow('REDIRECT /home');
    h.user = null;
    await expect(RoutesPage()).rejects.toThrow('REDIRECT /login');
  });
});

