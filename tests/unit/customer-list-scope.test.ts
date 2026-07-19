/**
 * SR-M2 regression — the customers LIST/EXPORT branch-scope helper must be
 * fail-closed. The P1 bug: a Manager with no assigned regions fell through
 * UNSCOPED and read the entire nationwide customer master (twin of the export
 * leak). This pins the query twin of lib/access.canSeeCustomer.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { customerListBranchScope } from '@/lib/customer-filters';

const empty = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };

describe('SR-M2: customerListBranchScope is fail-closed', () => {
  it('region-less MANAGER sees NOTHING (not the whole master)', () => {
    const s = customerListBranchScope(Role.MANAGER, empty);
    expect(s.forceEmpty).toBe(true);
  });

  it('region-less ACCOUNTANT sees NOTHING (aligned with canSeeCustomer)', () => {
    expect(customerListBranchScope(Role.ACCOUNTANT, empty).forceEmpty).toBe(true);
  });

  it('route-less SALESMAN sees NOTHING', () => {
    expect(customerListBranchScope(Role.SALESMAN, empty).forceEmpty).toBe(true);
  });

  it('SUPERVISOR with no team routes sees NOTHING', () => {
    expect(customerListBranchScope(Role.SUPERVISOR, empty).forceEmpty).toBe(true);
  });

  it('scoped MANAGER gets a region-scoped branch predicate, not force-empty', () => {
    const s = customerListBranchScope(Role.MANAGER, { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['r1', 'r2'] });
    expect(s.forceEmpty).toBe(false);
    expect(s.branchSome).toEqual({ regionId: { in: ['r1', 'r2'] }, deletedAt: null });
  });

  it('scoped SALESMAN gets a route predicate', () => {
    const s = customerListBranchScope(Role.SALESMAN, { ownedRouteId: 'rt1', teamRouteIds: [], managedRegionIds: [] });
    expect(s.forceEmpty).toBe(false);
    expect(s.branchSome).toEqual({ routeId: 'rt1', deletedAt: null });
  });

  it('STEWARD / VIEWER / FINANCE_MANAGER / GM are org-wide (no branch scope, not empty)', () => {
    for (const role of [Role.STEWARD, Role.VIEWER, Role.FINANCE_MANAGER, Role.GM]) {
      const s = customerListBranchScope(role, empty);
      expect(s.forceEmpty, `${role} must not be force-empty`).toBe(false);
      expect(s.branchSome, `${role} must have no branch scope`).toBeUndefined();
    }
  });

  it('every Role resolves (no role silently falls through to org-wide)', () => {
    for (const role of Object.values(Role)) {
      const s = customerListBranchScope(role as Role, empty);
      // With an EMPTY scope, only the four org-wide roles may be non-empty.
      const orgWide = ([Role.STEWARD, Role.VIEWER, Role.FINANCE_MANAGER, Role.GM] as Role[]).includes(role as Role);
      if (!orgWide) expect(s.forceEmpty, `${role} must be fail-closed on empty scope`).toBe(true);
    }
  });
});
