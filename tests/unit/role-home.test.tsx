/**
 * lib/role-home.ts: where each role lands on entering the app.
 *
 * The approver roles (ACCOUNTANT, FINANCE_MANAGER, GM) used to land on Customers
 * "for now", behind a comment saying the pendingRole-routed queue was still to
 * come. It had long since come: app/(app)/approvals/page.tsx admits all three and
 * filters on their own step. They now land there.
 *
 * Two ways that can break, and neither fails a build:
 *   - the approvals page stops admitting one of them. It redirects a refused role
 *     to /home, and /home redirects it straight back to its landing page — an
 *     endless redirect on sign-in, for every account of that role. So the page is
 *     RENDERED here as each of them, with its session and database mocked.
 *   - the queue they land on is not their own step. The query's `where` is read
 *     whole: every `pendingRole` in it must be the viewer's role and must sit on
 *     an AND path, because one under an OR would let other steps' rows through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Role } from '@prisma/client';

const h = vi.hoisted(() => ({
  role: 'ACCOUNTANT',
  regions: ['r-north'] as string[],
  wheres: [] as unknown[],
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u', role: h.role, username: 'u' } }),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/approvals',
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: {
      findMany: async (args: { where: unknown }) => {
        h.wheres.push(args.where);
        return [];
      },
      // The queue header's true pending count (approvals page) reads the same
      // where; the queue query above is the one these tests inspect.
      count: async () => 0,
    },
    attachment: { findMany: async () => [] },
  },
}));
vi.mock('@/app/(app)/approvals/BulkApprovalQueue', () => ({ BulkApprovalQueue: () => null }));

import { HOME_BY_ROLE, homeForRole } from '@/lib/role-home';
import { NAV_BY_ROLE } from '@/components/nmwc/Sidebar';
import ApprovalsPage from '@/app/(app)/approvals/page';

const APPROVERS = ['ACCOUNTANT', 'FINANCE_MANAGER', 'GM'] as const;

/** Every `pendingRole` constraint in a Prisma where, and whether an OR sits above it. */
function pendingRoleConstraints(
  where: unknown,
  underOr = false
): Array<{ value: unknown; underOr: boolean }> {
  if (!where || typeof where !== 'object') return [];
  if (Array.isArray(where)) return where.flatMap((w) => pendingRoleConstraints(w, underOr));
  return Object.entries(where).flatMap(([k, v]) =>
    k === 'pendingRole' ? [{ value: v, underOr }] : pendingRoleConstraints(v, underOr || k === 'OR')
  );
}

beforeEach(() => {
  h.regions = ['r-north'];
  h.wheres = [];
});
afterEach(cleanup);

describe('landing pages', () => {
  it('the approver roles land on Approvals; every other role is where it was', () => {
    expect(HOME_BY_ROLE).toEqual({
      SALESMAN: '/today',
      SUPERVISOR: '/approvals',
      MANAGER: '/dashboard',
      STEWARD: '/import',
      VIEWER: '/dashboard',
      ACCOUNTANT: '/approvals',
      FINANCE_MANAGER: '/approvals',
      GM: '/approvals',
    });
    for (const role of APPROVERS) expect(homeForRole(role)).toBe('/approvals');
  });

  it.each(Object.keys(HOME_BY_ROLE))('%s lands on a page its own menu offers', (role) => {
    const home = HOME_BY_ROLE[role as Role];
    expect(NAV_BY_ROLE[role as Role].map((i) => i.href)).toContain(home);
  });
});

describe('the approvals page admits each approver role and shows it its own step', () => {
  it.each(APPROVERS)('%s opens the queue without being sent back to /home', async (role) => {
    h.role = role;
    render(await ApprovalsPage());
    expect(screen.getByRole('heading', { name: 'Approval queue' })).toBeTruthy();
    expect(h.wheres).toHaveLength(1);
  });

  it.each(APPROVERS)(
    '%s: every pendingRole in the queue query is its own, on an AND path',
    async (role) => {
      h.role = role;
      render(await ApprovalsPage());
      const where = h.wheres[0] as Record<string, unknown>;
      expect(where.state).toBe('SUBMITTED');
      const constraints = pendingRoleConstraints(where);
      expect(constraints.length).toBeGreaterThan(0);
      expect(constraints).toEqual(constraints.map(() => ({ value: role, underOr: false })));
    }
  );

  it('an ACCOUNTANT with no regions still opens it, to an empty queue (fail-closed, not a redirect)', async () => {
    h.role = 'ACCOUNTANT';
    h.regions = [];
    render(await ApprovalsPage());
    // Told why it is empty (tests/unit/approvals-no-region.test.tsx).
    expect(screen.getByText(/No regions are assigned to this account/)).toBeTruthy();
    expect((h.wheres[0] as Record<string, unknown>).id).toBe('__none__');
  });

  it('control: the Manager fallback queue is the Supervisor step, so the reader above is not vacuous', async () => {
    h.role = 'MANAGER';
    render(await ApprovalsPage());
    const values = pendingRoleConstraints(h.wheres[0]).map((c) => c.value);
    expect(values).toEqual(['SUPERVISOR', null]);
  });
});
