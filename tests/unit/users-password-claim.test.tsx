/**
 * The Users page answers the day-1 operator check — who has not claimed their
 * account yet — per row and as a count line, and the count covers exactly the
 * rows the table renders.
 *
 *   mustChangePassword && never signed in  → "Not signed in yet"
 *   mustChangePassword && signed in        → "Password change pending"
 *   otherwise                              → nothing
 *
 * The page is rendered with its session and database mocked. The mocked user
 * query honours the page's `select`, so a page that forgot to select
 * mustChangePassword gets it as undefined here exactly as it would from Prisma,
 * and every badge silently disappears — which is what the first test would see.
 *
 * The count is the part that can leak: a Manager administers their regions only
 * (lib/permissions.ts), and a figure over more rows than they can open tells
 * them, by subtraction, about accounts elsewhere. So the Manager cases put
 * flagged accounts OUTSIDE the Manager's scope and assert they are neither shown
 * nor counted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';

type Row = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  ownedRouteId: string | null;
  supervisorId: string | null;
  supervisor: { fullName: string; username: string } | null;
  ownedRoute: { code: string; name: string; regionId: string; region: { code: string } } | null;
  reports: Array<{ ownedRoute: { regionId: string } | null }>;
  managedRegions: Array<{ id: string }>;
};

const h = vi.hoisted(() => ({
  user: { id: 'steward', role: 'STEWARD', username: 'steward.x' } as {
    id: string;
    role: string;
    username: string;
  },
  rows: [] as Row[],
  regions: [] as string[],
  userQueries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// The client components post to server actions; nothing here is about them.
vi.mock('@/app/(app)/users/UserRowActions', () => ({
  UserRowActions: () => null,
  UsersFeedback: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/(app)/users/CreateUserForm', () => ({ CreateUserForm: () => null }));

/** Prisma's `select`, applied: only the selected keys come back. */
function project(
  row: Record<string, unknown>,
  select: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const nested = row[k] as
        Record<string, unknown> | Array<Record<string, unknown>> | null | undefined;
      const inner = (v as { select: Record<string, unknown> }).select;
      out[k] =
        nested == null
          ? nested
          : Array.isArray(nested)
            ? nested.map((n) => project(n, inner))
            : project(nested, inner);
    }
  }
  return out;
}
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: async (args: { select: Record<string, unknown> }) => {
        h.userQueries.push(args);
        return h.rows.map((r) => project(r as unknown as Record<string, unknown>, args.select));
      },
    },
    route: { findMany: async () => [] },
    region: { findMany: async () => [] },
  },
}));

import UsersPage from '@/app/(app)/users/page';

const SIGNED_IN = new Date('2026-09-30T06:00:00Z');

function account(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    username: id,
    fullName: `Person ${id}`,
    role: 'SALESMAN',
    isActive: true,
    lastLoginAt: null,
    mustChangePassword: false,
    ownedRouteId: null,
    supervisorId: null,
    supervisor: null,
    ownedRoute: null,
    reports: [],
    managedRegions: [],
    ...over,
  };
}

/** A salesman on a route in `regionId`. */
const salesman = (id: string, regionId: string, over: Partial<Row> = {}) =>
  account(id, {
    ownedRouteId: `route-${id}`,
    ownedRoute: { code: `R-${id}`, name: `Route ${id}`, regionId, region: { code: regionId } },
    ...over,
  });

async function renderPage(status?: string) {
  render(await UsersPage({ searchParams: Promise.resolve(status ? { status } : {}) }));
}

const rowOf = (fullName: string) =>
  screen.getByRole('row', { name: new RegExp(`^${fullName}\\b`) });
const BADGES = ['Not signed in yet', 'Password change pending'];
const badgesIn = (fullName: string) =>
  BADGES.filter((b) => within(rowOf(fullName)).queryByText(b) !== null);

beforeEach(() => {
  h.user = { id: 'steward', role: 'STEWARD', username: 'steward.x' };
  h.rows = [];
  h.regions = [];
  h.userQueries = [];
});
afterEach(cleanup);

describe('each row says whether its holder has claimed the account', () => {
  beforeEach(() => {
    h.rows = [
      account('never', { mustChangePassword: true, lastLoginAt: null }),
      account('pending', { mustChangePassword: true, lastLoginAt: SIGNED_IN }),
      account('claimed', { mustChangePassword: false, lastLoginAt: SIGNED_IN }),
      // Created with no forced change and never used: "never" in Last login, but
      // there is no issued password waiting to be replaced — no badge.
      account('unforced', { mustChangePassword: false, lastLoginAt: null }),
    ];
  });

  it('flag set, never signed in → Not signed in yet; flag set, signed in → Password change pending', async () => {
    await renderPage();
    expect(badgesIn('Person never')).toEqual(['Not signed in yet']);
    expect(badgesIn('Person pending')).toEqual(['Password change pending']);
  });

  it('flag cleared → no badge, whatever Last login says', async () => {
    await renderPage();
    expect(badgesIn('Person claimed')).toEqual([]);
    expect(badgesIn('Person unforced')).toEqual([]);
  });

  it('the count line above the table adds up the rows shown', async () => {
    await renderPage();
    expect(
      screen.getByText('Of 4 accounts shown: 1 not signed in yet · 1 password change pending')
    ).toBeTruthy();
  });

  it('mustChangePassword is selected explicitly, and the user query is no wider than before', async () => {
    await renderPage();
    const q = h.userQueries[0]!;
    expect((q.select as Record<string, unknown>).mustChangePassword).toBe(true);
    // The roster is narrowed in memory with the same rules the server actions
    // enforce; the query itself has never carried a where. Selecting one more
    // column must not have changed that.
    expect(q.where).toBeUndefined();
    expect(h.userQueries).toHaveLength(1);
  });
});

describe('the count covers exactly the rows the table renders', () => {
  it('follows the status filter, and a disabled account is never counted (it cannot sign in)', async () => {
    h.rows = [
      account('live', { mustChangePassword: true }),
      account('leftover', { isActive: false, mustChangePassword: true }),
      account('leftover-reset', { isActive: false, mustChangePassword: true, lastLoginAt: SIGNED_IN }),
    ];
    await renderPage();
    expect(
      screen.getByText('Of 1 account shown: 1 not signed in yet · 0 password change pending')
    ).toBeTruthy();
    cleanup();

    await renderPage('disabled');
    expect(
      screen.getByText('Of 2 accounts shown: 0 not signed in yet · 0 password change pending')
    ).toBeTruthy();
    expect(screen.getByText('Person leftover')).toBeTruthy();
    expect(screen.queryByText('Not signed in yet')).toBeNull();
    expect(screen.queryByText('Password change pending')).toBeNull();
    expect(screen.queryByText('Person live')).toBeNull();
    cleanup();

    await renderPage('all');
    expect(
      screen.getByText('Of 3 accounts shown: 1 not signed in yet · 0 password change pending')
    ).toBeTruthy();
  });

  it('no rows, no count line', async () => {
    h.rows = [account('live', { mustChangePassword: true })];
    await renderPage('disabled');
    expect(screen.queryByText(/accounts? shown:/)).toBeNull();
  });

  it("a Manager's figure is their own regions' accounts, never a company-wide one", async () => {
    h.user = { id: 'mgr', role: 'MANAGER', username: 'mgr.x' };
    h.regions = ['r-north'];
    h.rows = [
      account('mgr', {
        role: 'MANAGER',
        lastLoginAt: SIGNED_IN,
        managedRegions: [{ id: 'r-north' }],
      }),
      salesman('north-new', 'r-north', { mustChangePassword: true }),
      salesman('north-stuck', 'r-north', { mustChangePassword: true, lastLoginAt: SIGNED_IN }),
      // Flagged accounts the Manager cannot administer: another region's
      // salesmen, and a Steward-provisioned approver.
      salesman('south-new', 'r-south', { mustChangePassword: true }),
      salesman('south-stuck', 'r-south', { mustChangePassword: true, lastLoginAt: SIGNED_IN }),
      account('gm', { role: 'GM', mustChangePassword: true }),
    ];
    await renderPage();

    expect(
      screen.getByText('Of 3 accounts shown: 1 not signed in yet · 1 password change pending')
    ).toBeTruthy();
    for (const hidden of ['Person south-new', 'Person south-stuck', 'Person gm']) {
      expect(screen.queryByText(hidden), hidden).toBeNull();
    }
    expect(badgesIn('Person north-new')).toEqual(['Not signed in yet']);
    expect(badgesIn('Person north-stuck')).toEqual(['Password change pending']);
    expect(badgesIn('Person mgr')).toEqual([]);
  });

  it('a Manager with no regions is counted over their own row only', async () => {
    h.user = { id: 'mgr', role: 'MANAGER', username: 'mgr.x' };
    h.regions = [];
    h.rows = [
      account('mgr', { role: 'MANAGER', lastLoginAt: SIGNED_IN }),
      salesman('north-new', 'r-north', { mustChangePassword: true }),
      account('gm', { role: 'GM', mustChangePassword: true }),
    ];
    await renderPage();
    expect(
      screen.getByText('Of 1 account shown: 0 not signed in yet · 0 password change pending')
    ).toBeTruthy();
  });
});
