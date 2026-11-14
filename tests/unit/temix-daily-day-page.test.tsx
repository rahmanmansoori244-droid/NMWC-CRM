/**
 * The daily Temix import, stage 6: the day's drill-down (/temix-daily/day/<day>),
 * rendered with a stubbed database. Synthetic codes, ids and names only.
 *
 *  - The day's summary in the alert's words, and that the alert is switched off.
 *  - Each section lists its lines with a link to the customer's History page:
 *    a route move from route to route, a missing customer's spell, an
 *    Accountant code, a name difference with the Temix name (or that the row
 *    was cleared), a switched-off route with its live shops; a reviewed line
 *    says who and when, any other carries the Reviewed button.
 *  - The second view lists the spells still open that started earlier.
 *  - Data Steward only; a day that is not a day is not found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

type L = {
  id: bigint;
  kind: string;
  applied: boolean;
  customerId: string | null;
  branchId: string | null;
  rowId: string | null;
  fromValue: string | null;
  toValue: string | null;
  detailCode: string | null;
  fileId: string;
  loadDay: Date;
  createdAt: Date;
  reviews: Array<{ reviewedAt: Date; reviewedBy: { fullName: string } }>;
};

const h = vi.hoisted(() => ({
  user: { id: 'stw-1', role: 'STEWARD' } as { id: string; role: string } | null,
  lines: [] as L[],
  latest: [] as unknown[],
}));

vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  usePathname: () => '/temix-daily/day/2026-11-14',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/services/temix-daily-review', () => ({ reviewTemixChangesAction: async () => ({ ok: true, data: { reviewed: 0 } }) }));

const D = new Date('2026-11-14T00:00:00Z');
const D_EARLY = new Date('2026-11-10T00:00:00Z');

const matches = (l: L, w: Record<string, unknown>) =>
  (w.kind === undefined || l.kind === w.kind) &&
  (w.applied === undefined || l.applied === w.applied) &&
  (w.loadDay === undefined || l.loadDay.getTime() === (w.loadDay as Date).getTime()) &&
  (!(w.id as { in?: bigint[] })?.in || (w.id as { in: bigint[] }).in.includes(l.id)) &&
  (!(w.reviews as object) || l.reviews.length === 0);

vi.mock('@/lib/db', () => ({
  prisma: {
    temixDailyFile: {
      findMany: async (q: { where: { loadDay?: Date; id?: { in: string[] } } }) =>
        q.where.id
          ? [{ id: 'f1', filename: 'daily-1114.csv' }]
          : [{ id: 'f1', filename: 'daily-1114.csv', state: 'LOADED', totalRows: 9, appliedRows: 1, noChangeRows: 5, heldRows: 3, noticeRows: 5, loadedAt: new Date('2026-11-14T06:00:00Z') }],
      aggregate: async () => ({ _sum: { heldRows: 3 } }),
    },
    temixChange: {
      groupBy: async () => [
        { kind: 'ROUTE_MOVE', applied: true, detailCode: 'VIA_EXACT_CODE', _count: { _all: 1 } },
        { kind: 'MISSING_FROM_FILE', applied: false, detailCode: 'SPELL_OPENED', _count: { _all: 1 } },
        { kind: 'NAME_DIFFERS', applied: false, detailCode: null, _count: { _all: 2 } },
      ],
      count: async (q: { where: Record<string, unknown> }) => h.lines.filter((l) => matches(l, q.where)).length,
      findMany: async (q: { where: Record<string, unknown> }) => h.lines.filter((l) => matches(l, q.where)),
    },
    customer: {
      findMany: async () => [
        { id: 'c1', nmwcCode: 'ZC1', legalName: 'ZZ Customer One' },
        { id: 'c2', nmwcCode: 'ZC2', legalName: 'ZZ Customer Two' },
        { id: 'c3', nmwcCode: 'NMWC-2026-000009', legalName: 'ZZ Customer Three' },
      ],
    },
    branch: { findMany: async () => [{ id: 'b1', branchCode: 'ZC1-01' }] },
    route: {
      findMany: async () => [
        { id: 'rt1', code: 'ZR1', isActive: true },
        { id: 'rt2', code: 'ZR2', isActive: true },
        { id: 'rtx', code: 'ZRX', isActive: false },
      ],
    },
    $queryRaw: async (q: { strings?: string[]; sql?: string }) => {
      const sql = (q.sql ?? q.strings?.join('?') ?? '').replace(/\s+/g, ' ');
      if (/DISTINCT ON/.test(sql)) return h.latest;
      if (/custName/.test(sql)) return [{ id: 'row-5', name: 'ZZ Customer 1 LLC' }];
      if (/"isActive" = false/.test(sql)) return [{ id: 'rtx', code: 'ZRX', shops: 4n }];
      throw new Error(`unexpected SQL ${sql}`);
    },
  },
}));

import TemixDailyDayPage from '@/app/(app)/temix-daily/day/[loadDay]/page';

const line = (id: number, over: Partial<L>): L => ({
  id: BigInt(id),
  kind: 'MISSING_FROM_FILE',
  applied: false,
  customerId: null,
  branchId: null,
  rowId: null,
  fromValue: null,
  toValue: null,
  detailCode: null,
  fileId: 'f1',
  loadDay: D,
  createdAt: D,
  reviews: [],
  ...over,
});

const page = (loadDay = '2026-11-14', view?: string) =>
  TemixDailyDayPage({ params: Promise.resolve({ loadDay }), searchParams: Promise.resolve(view ? { view } : {}) });

beforeEach(() => {
  h.user = { id: 'stw-1', role: 'STEWARD' };
  h.lines = [
    line(1, { kind: 'ROUTE_MOVE', applied: true, customerId: 'c1', branchId: 'b1', fromValue: 'rt1', toValue: 'rt2', detailCode: 'VIA_EXACT_CODE', reviews: [{ reviewedAt: new Date('2026-11-14T08:00:00Z'), reviewedBy: { fullName: 'ZZ Steward' } }] }),
    line(2, { customerId: 'c2', detailCode: 'SPELL_OPENED' }),
    line(3, { kind: 'ACCOUNTANT_CODE_NOT_SEEN', customerId: 'c3', toValue: 'TZ9', detailCode: 'SPELL_OPENED' }),
    line(4, { kind: 'NAME_DIFFERS', customerId: 'c1', rowId: 'row-5' }),
    line(5, { kind: 'NAME_DIFFERS', customerId: 'c2', rowId: 'row-gone' }),
    line(6, { kind: 'ROUTE_INACTIVE', toValue: 'rtx', detailCode: 'SPELL_OPENED' }),
    line(7, { customerId: 'c1', detailCode: 'SPELL_OPENED', loadDay: D_EARLY }),
  ];
  h.latest = [{ id: 7n, kind: 'MISSING_FROM_FILE', customerId: 'c1', toValue: null, detailCode: 'SPELL_OPENED', loadDay: D_EARLY, fileId: 'f1' }];
});
afterEach(cleanup);

const section = (title: RegExp) => screen.getByRole('heading', { name: title }).closest('section')!;

describe('/temix-daily/day/<day>', () => {
  it("shows the day's summary in the alert's words, and says the alert is off", async () => {
    render(await page());
    expect(
      screen.getByText(
        '1 shop moved to another route; 2 name differences; 1 customer newly missing from the file; 3 rows held back. Open the Temix daily file page for the details.'
      )
    ).toBeTruthy();
    expect(screen.getByText(/The alert itself is switched off: nothing is sent yet/)).toBeTruthy();
    expect(screen.getByText(/1 applied, 5 no change, 3 held, 5 listed/)).toBeTruthy();
  });

  it('lists each section with links to the History page and the Reviewed marks', async () => {
    render(await page());
    const moves = section(/Shops moved to another route \(1\)/);
    expect(within(moves).getByRole('link', { name: 'ZC1' }).getAttribute('href')).toBe('/customers/c1/history');
    expect(within(moves).getByText('ZC1-01')).toBeTruthy();
    expect(within(moves).getByText(/From route/).textContent).toBe('From route ZR1 to ZR2');
    expect(within(moves).getByText(/ZZ Steward, /)).toBeTruthy();
    expect(within(moves).queryByRole('button', { name: 'Reviewed' })).toBeNull();

    const missing = section(/Customers missing from the file \(1\)/);
    expect(within(missing).getByText('Missing from the file: started')).toBeTruthy();
    expect(within(missing).getByRole('button', { name: 'Reviewed' })).toBeTruthy();
    expect(within(missing).queryByText('ZC1')).toBeNull(); // the earlier day's spell is not this day's

    const acc = section(/Temix codes the Accountant typed, not in the file \(1\)/);
    expect(within(acc).getByText(/not in the file: started/).textContent).toBe('Temix code TZ9 not in the file: started');

    const names = section(/Name differences \(each listed once\) \(2\)/);
    expect(within(names).getByText('ZZ Customer 1 LLC')).toBeTruthy();
    expect(within(names).getByText("(the file's row has been cleared)")).toBeTruthy();
    expect(within(names).getByText('ZZ Customer One')).toBeTruthy();

    const routes = section(/Switched-off routes still holding shops \(1\)/);
    expect(within(routes).getByText('ZRX')).toBeTruthy();
    expect(within(routes).getByText(/4 live shops on it now/)).toBeTruthy();

    expect(screen.getByRole('button', { name: /Mark all \d+ not yet reviewed/ })).toBeTruthy();
  });

  it('the second view lists the spells still open that started on an earlier day', async () => {
    render(await page('2026-11-14', 'open'));
    const open = section(/Still open, started before 2026-11-14 \(1\)/);
    expect(within(open).getByText('2026-11-10')).toBeTruthy();
    expect(within(open).getByRole('link', { name: 'ZC1' }).getAttribute('href')).toBe('/customers/c1/history');
    expect(screen.queryByRole('heading', { name: /Shops moved/ })).toBeNull();
  });

  it("is the Data Steward's only, and a day must be a day", async () => {
    for (const role of ['MANAGER', 'SALESMAN', 'ACCOUNTANT', 'GM', 'VIEWER']) {
      h.user = { id: 'u', role };
      await expect(page(), role).rejects.toThrow('REDIRECT /home');
    }
    h.user = null;
    await expect(page()).rejects.toThrow('REDIRECT /login');
    h.user = { id: 'stw-1', role: 'STEWARD' };
    await expect(page('2026-13-40')).rejects.toThrow('NOT_FOUND');
    await expect(page('yesterday')).rejects.toThrow('NOT_FOUND');
  });
});
