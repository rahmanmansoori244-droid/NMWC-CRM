/**
 * Launch fixes, the salesman's pages for work that came back to him:
 *
 *   - Today's "Needs correction" count, Work's sent-back rows and /rejected
 *     read the sent-back requests that still wait on him (lib/returned-work.ts),
 *     not every NEEDS_CORRECTION row: an update he has sent again stayed there
 *     for good, and the red counter never cleared.
 *   - The red tile on Today, and a line on Work, link to /rejected — on a phone
 *     a salesman had no way to it.
 *   - A sent-back update opens on the edit form (which shows why and has what
 *     he sent filled in), not the profile; a close or reactivation still opens
 *     the profile, a new-customer request its create form.
 *   - Nothing says "your supervisor" where a Manager decides: /rejected's
 *     subtitle and a pending reactivation on Work.
 *
 * Which rows are still waiting is proven against Postgres in
 * tests/integration/golive-update-flow.test.ts; here the query is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  role: 'SALESMAN',
  openIds: [] as string[],
  openCount: 0,
  rows: [] as Array<Record<string, unknown>>,
  findManyArgs: [] as Array<{ where: Record<string, unknown> }>,
  customer: null as unknown,
  customerArgs: null as unknown,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-sales', role: h.role, username: 'mct01' } }) }));
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
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/returned-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/returned-work')>()),
  openReturnedIds: vi.fn(async () => h.openIds),
  countOpenReturned: vi.fn(async () => h.openCount),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: [] }),
  canSeeCustomer: () => true,
  filterBranchesByScope: (_u: unknown, b: unknown[]) => b,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUniqueOrThrow: async () => ({ id: 'u-sales', fullName: 'Said Ali', ownedRouteId: 'r1' }) },
    customerEdit: {
      count: async () => 0,
      findMany: async (args: { where: Record<string, unknown> }) => {
        h.findManyArgs.push(args);
        const w = args.where as { id?: { in: string[] }; state?: string };
        if (w.id) return h.rows.filter((r) => w.id!.in.includes(r.id as string));
        return h.rows.filter((r) => r.state === w.state && (!('process' in w) || r.process === (w as { process: string }).process));
      },
    },
    branch: { count: async () => 0, findMany: async () => [] },
    customer: {
      findFirst: async (args: unknown) => {
        h.customerArgs = args;
        return h.customer;
      },
    },
  },
}));

const returned = (over: Record<string, unknown>) => ({
  process: 'UPDATE',
  target: 'CUSTOMER',
  isReactivation: false,
  state: 'NEEDS_CORRECTION',
  customerId: 'c1',
  customer: { id: 'c1', legalName: 'Al Noor Trading', nmwcCode: 'NMWC-000001' },
  customerDraft: null,
  decisionReason: 'Contact role looks wrong.',
  reviewedAt: new Date('2026-10-04T08:00:00Z'),
  reviewedBy: { fullName: 'Manager Muna' },
  submittedAt: new Date('2026-10-03T08:00:00Z'),
  updatedAt: new Date('2026-10-04T08:00:00Z'),
  pendingRole: null,
  ...over,
});

beforeEach(() => {
  h.role = 'SALESMAN';
  h.openIds = [];
  h.openCount = 0;
  h.rows = [];
  h.findManyArgs = [];
  h.customer = null;
  h.customerArgs = null;
});
afterEach(cleanup);

describe('Today', () => {
  it('counts only what still waits on him, and the red tile opens Needs correction', async () => {
    h.openCount = 2;
    const { default: TodayPage } = await import('@/app/(app)/today/page');
    render(await TodayPage({}));
    const tile = screen.getByText('Needs correction').closest('a')!;
    expect(tile.getAttribute('href')).toBe('/rejected');
    expect(within(tile).getByText('2')).toBeTruthy();
    const { countOpenReturned } = await import('@/lib/returned-work');
    expect(countOpenReturned).toHaveBeenCalledWith(expect.anything(), 'u-sales');
  });
});

describe('Work, for a salesman', () => {
  async function renderWork() {
    const { default: WorkPage } = await import('@/app/(app)/work/page');
    render(await WorkPage());
  }

  it('lists only the sent-back requests still waiting, each opening where it is corrected', async () => {
    h.rows = [
      returned({ id: 'e-upd' }),
      returned({ id: 'e-new', process: 'CREATE', customerId: null, customer: null, customerDraft: { legalName: 'New Shop' } }),
      returned({ id: 'e-close', target: 'BRANCH', customer: { id: 'c2', legalName: 'Closed Shop', nmwcCode: 'N2' }, customerId: 'c2' }),
      // Sent back, but answered since: not among the ids the query returns.
      returned({ id: 'e-answered', customer: { id: 'c3', legalName: 'Answered Shop', nmwcCode: 'N3' }, customerId: 'c3' }),
    ];
    h.openIds = ['e-upd', 'e-new', 'e-close'];
    await renderWork();
    const link = (name: string) => screen.getByText(name).closest('a')!.getAttribute('href');
    expect(link('Al Noor Trading')).toBe('/customers/c1/edit');
    expect(link('New Shop')).toBe('/customers/new?edit=e-new');
    expect(link('Closed Shop')).toBe('/customers/c2');
    expect(screen.queryByText('Answered Shop')).toBeNull();
    // No list of every NEEDS_CORRECTION row of his any more.
    expect(h.findManyArgs.some((a) => a.where.state === 'NEEDS_CORRECTION')).toBe(false);
    // "Needs correction", not "Rejected": it was sent back to be fixed.
    expect(screen.queryByText('Rejected')).toBeNull();
    expect(screen.getAllByText('Needs correction').length).toBeGreaterThan(0);
    // And the way to the full list, with why each came back.
    expect(screen.getByRole('link', { name: 'Sent back to you (3) — see why' }).getAttribute('href')).toBe('/rejected');
  });

  it('a pending reactivation is with a Manager, not "your supervisor"', async () => {
    h.rows = [
      returned({ id: 'e-react', state: 'SUBMITTED', target: 'BRANCH', isReactivation: true }),
      returned({ id: 'e-upd', state: 'SUBMITTED' }),
    ];
    await renderWork();
    const card = (id: string) => screen.getAllByText('Al Noor Trading').map((t) => t.closest('a')!)[id === 'e-react' ? 0 : 1]!;
    expect(within(card('e-react')).getByText('Sent to a Manager')).toBeTruthy();
    expect(within(card('e-upd')).getByText('Submitted to your supervisor')).toBeTruthy();
    expect(screen.queryByText(/Sent back to you/)).toBeNull();
  });
});

describe('/rejected', () => {
  it('lists what still waits, says who sent each back, and names no supervisor in the header', async () => {
    h.rows = [returned({ id: 'e-upd' }), returned({ id: 'e-gone', customer: { id: 'c9', legalName: 'Gone', nmwcCode: 'N9' } })];
    h.openIds = ['e-upd'];
    const { default: RejectedPage } = await import('@/app/(app)/rejected/page');
    render(await RejectedPage());
    expect(screen.getByText('1 submission(s) sent back to you')).toBeTruthy();
    expect(screen.queryByText(/supervisor/i)).toBeNull();
    expect(screen.queryByText('Gone')).toBeNull();
    const card = screen.getByText('Al Noor Trading').closest('a')!;
    expect(card.getAttribute('href')).toBe('/customers/c1/edit');
    expect(within(card).getByText(/^Sent back by Manager Muna/)).toBeTruthy();
    expect(within(card).queryByText(/Rejected by/)).toBeNull();
  });
});

