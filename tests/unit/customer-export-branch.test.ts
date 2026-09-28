// @vitest-environment node
/**
 * F17: the filtered export (and the /customers card) show a branch the filters
 * MATCH, not merely one in the caller's scope.
 *
 * The customer was matched on `branches.some {regionId in [R1], routeId in [B]}`
 * while the branch it exported was picked by `{regionId in [R1]}`, oldest first —
 * so a customer with an older route-A branch exported route A's Region, Route,
 * Address, GPS and Day of visit under a route-B filter.
 *
 * The pure predicate is pinned in customer-list-scope.test.ts; here, what the
 * export actually asks the database for, and a structural guard that both
 * surfaces take the branch shown from the shared helper. Against Postgres:
 * tests/integration/customer-export-branch-filter.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const h = vi.hoisted(() => ({
  user: { id: 'mgr', role: 'MANAGER', username: 'manager.x' },
  me: {} as Record<string, unknown>,
  findMany: vi.fn(),
  count: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: h.writeAudit,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUniqueOrThrow: async () => h.me,
      findMany: async () => [],
      findUnique: async () => null,
    },
    customer: { count: h.count, findMany: h.findMany },
  },
}));

import { exportFilteredCustomersAction } from '@/services/customer-export';

const exportWith = async (urlParams: string) => {
  const fd = new FormData();
  fd.set('urlParams', urlParams);
  return exportFilteredCustomersAction(fd);
};
const branchWhere = () => h.findMany.mock.calls[0][0].include.branches.where;

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: 'mgr', role: 'MANAGER', username: 'manager.x' };
  h.me = { id: 'mgr', role: 'MANAGER', ownedRouteId: null, reports: [], managedRegions: [{ id: 'R1' }] };
  h.count.mockResolvedValue(1);
  h.findMany.mockResolvedValue([]);
  h.writeAudit.mockResolvedValue(undefined);
});

describe('exportFilteredCustomersAction — F17', () => {
  it('a Manager filtering to route B exports the route-B branch: the include carries the route', async () => {
    const res = await exportWith('route=ROUTE_B');
    expect(res.ok).toBe(true);
    const args = h.findMany.mock.calls[0][0];
    const expected = { regionId: { in: ['R1'] }, routeId: { in: ['ROUTE_B'] }, deletedAt: null };
    expect(args.where.branches.some).toEqual(expected);
    expect(branchWhere()).toEqual(expected);
    expect(args.include.branches.take).toBe(1);
    expect(args.include.branches.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('a customer matched by its name still gets a branch: the search is not in the include', async () => {
    await exportWith('q=Lulu');
    expect(branchWhere()).toEqual({ regionId: { in: ['R1'] }, deletedAt: null });
  });

  it('an org-wide role with a region filter shows a branch in that region', async () => {
    h.user = { id: 'stew', role: 'STEWARD', username: 'steward.x' };
    h.me = { id: 'stew', role: 'STEWARD', ownedRouteId: null, reports: [], managedRegions: [] };
    await exportWith('region=R9');
    expect(branchWhere()).toEqual({ regionId: { in: ['R9'] }, deletedAt: null });
  });

  it('a fail-closed scope stays __none__ for the branch too', async () => {
    h.me = { id: 'mgr', role: 'MANAGER', ownedRouteId: null, reports: [], managedRegions: [] };
    await exportWith('route=ROUTE_B');
    expect(h.findMany.mock.calls[0][0].where.id).toBe('__none__');
    expect(branchWhere()).toEqual({ id: '__none__' });
  });
});

describe('structural: both surfaces take the branch shown from customerBranchPredicate', () => {
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

  it('the filtered export', () => {
    const s = src('services/customer-export.ts');
    expect(s).toMatch(
      /const shownBranchWhere: Prisma\.BranchWhereInput = listScope\.forceEmpty\s*\?\s*\{ id: '__none__' \}\s*:\s*customerBranchPredicate\(branchSomeBase, filters, routeIdsForSupervisor, routeIdForSalesman\);/
    );
    expect(s).toMatch(/branches: \{\s*where: shownBranchWhere,/);
    expect(s).not.toMatch(/scopedBranchWhere/);
    expect(s).not.toMatch(/where: listScope\.branchSome/);
  });

  it('the /customers card', () => {
    const s = src('app/(app)/customers/page.tsx');
    expect(s).toMatch(
      /const branchInclude: Prisma\.Customer\$branchesArgs = \{\s*where: listScope\.forceEmpty\s*\?\s*\{ id: '__none__' \}\s*:\s*customerBranchPredicate\(branchSomeBase, filters, routeIdsForSupervisor, routeIdForSalesman\),/
    );
    expect(s).not.toMatch(/branchInclude\.where\s*=/);
    expect(s).toMatch(/branches: \{ \.\.\.branchInclude,/);
  });

  it('and applyCustomerFilters matches on that same helper', () => {
    const s = src('lib/customer-filters.ts');
    const apply = s.slice(s.indexOf('export function applyCustomerFilters'), s.indexOf('export function customerBranchPredicate'));
    expect(apply).toMatch(/const branchSome = customerBranchPredicate\(/);
    expect(apply).toMatch(/where\.branches = \{ some: branchSome \}/);
    expect(apply).not.toMatch(/mergeStringIn\(/);
  });
});
