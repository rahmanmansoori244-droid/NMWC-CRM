/**
 * F2: whose data the insights dashboard aggregates (lib/insights/scope.ts) and
 * the SQL fragments that keep it there (lib/insights/sql.ts).
 *
 * The scope is the role scope of the customer list (customerListBranchScope,
 * fail-closed for every role) INTERSECTED with the URL's filters: a filter never
 * widens it, and an empty intersection stays empty. The JS twin branchInView is
 * held here to lib/access.ts filterBranchesByScope for every role; the SQL twins
 * are held to the access gates on real Postgres by tests/integration/insights.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { filterBranchesByScope } from '@/lib/access';
import {
  NONE,
  branchInView,
  isCompanyWide,
  parseInsightFilters,
  resolveInsightScope,
  roleScopeIsOrgWide,
  singleRegionInView,
  type InsightScope,
  type RoleScope,
} from '@/lib/insights/scope';
import { branchInScopeSql, draftInScopeSql, requestInScopeSql, __gates } from '@/lib/insights/sql';
import { DASHBOARD_ROLES, isDashboardRole } from '@/lib/insights/policy';

const none = { regionIds: [] as string[], routeIds: [] as string[], rejected: false };
const empty: RoleScope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };
const ORG_WIDE: Role[] = [Role.STEWARD, Role.VIEWER, Role.FINANCE_MANAGER, Role.GM];

function scoped(s: InsightScope) {
  if (s.kind === 'none') throw new Error('expected a scope, got none');
  return s;
}

describe('the URL filters', () => {
  it('reads comma-separated ids, trimmed and de-duplicated, from a string or repeated params', () => {
    expect(parseInsightFilters({ region: ' a, b ,a,,', route: ['x', 'y,z'] })).toEqual({
      regionIds: ['a', 'b'],
      routeIds: ['x', 'y', 'z'],
      rejected: false,
    });
    expect(parseInsightFilters({})).toEqual(none);
  });

  it('a filter too long to read matches nothing — it is never dropped, which would widen the view', () => {
    const many = Array.from({ length: 501 }, (_, i) => `r${i}`).join(',');
    expect(parseInsightFilters({ region: many })).toEqual({ regionIds: [NONE], routeIds: [], rejected: true });
    expect(parseInsightFilters({ route: 'x'.repeat(129) })).toEqual({ regionIds: [], routeIds: [NONE], rejected: true });
  });
});

describe('who sees what', () => {
  it('the dashboard admits the Manager, the Viewer and the Steward — the owner-decision default', () => {
    expect([...DASHBOARD_ROLES]).toEqual(['MANAGER', 'VIEWER', 'STEWARD']);
    for (const role of Object.values(Role)) expect(isDashboardRole(role)).toBe(DASHBOARD_ROLES.includes(role));
    expect(isDashboardRole('NEW_ROLE')).toBe(false);
  });

  it.each(ORG_WIDE)('%s: the whole organisation, with nothing to read from the user record', (role) => {
    const s = scoped(resolveInsightScope(role, empty, none));
    expect(s).toMatchObject({ kind: 'company', regionIds: null, routeIds: null, roleRegionIds: null, roleRouteIds: null });
    expect(isCompanyWide(s)).toBe(true);
    expect(roleScopeIsOrgWide(role)).toBe(true);
  });

  it.each([Role.MANAGER, Role.ACCOUNTANT])('%s: his regions; none at all sees nothing', (role) => {
    const s = scoped(resolveInsightScope(role, { ...empty, managedRegionIds: ['r1', 'r2'] }, none));
    expect(s).toMatchObject({ kind: 'regions', regionIds: ['r1', 'r2'], routeIds: null, roleRegionIds: ['r1', 'r2'] });
    expect(isCompanyWide(s)).toBe(false);
    expect(resolveInsightScope(role, empty, none)).toEqual({ kind: 'none' });
    expect(roleScopeIsOrgWide(role)).toBe(false);
  });

  it('SALESMAN: his route; SUPERVISOR: his team’s routes; without one, nothing', () => {
    expect(scoped(resolveInsightScope(Role.SALESMAN, { ...empty, ownedRouteId: 'rt1' }, none))).toMatchObject({
      kind: 'routes',
      regionIds: null,
      routeIds: ['rt1'],
    });
    expect(scoped(resolveInsightScope(Role.SUPERVISOR, { ...empty, teamRouteIds: ['a', 'b'] }, none))).toMatchObject({
      kind: 'routes',
      routeIds: ['a', 'b'],
    });
    expect(resolveInsightScope(Role.SALESMAN, empty, none)).toEqual({ kind: 'none' });
    expect(resolveInsightScope(Role.SUPERVISOR, empty, none)).toEqual({ kind: 'none' });
  });

  it('every role the shared matrix scopes resolves to a slice this page can apply, or to nothing', () => {
    const full: RoleScope = { ownedRouteId: 'rt1', teamRouteIds: ['a'], managedRegionIds: ['r1'] };
    for (const role of Object.values(Role)) {
      const s = resolveInsightScope(role, full, none);
      if (s.kind === 'none') continue;
      expect(s.kind === 'company' || s.regionIds !== null || s.routeIds !== null, role).toBe(true);
    }
  });

  it('a role nobody has decided yet sees nothing', () => {
    expect(resolveInsightScope('NEW_ROLE' as Role, { ...empty, managedRegionIds: ['r1'] }, none)).toEqual({ kind: 'none' });
    expect(roleScopeIsOrgWide('NEW_ROLE' as Role)).toBe(false);
  });
});

describe('filters narrow, never widen', () => {
  const mgr = { ...empty, managedRegionIds: ['r1', 'r2'] };

  it('a Manager’s region filter is intersected with his regions', () => {
    expect(scoped(resolveInsightScope(Role.MANAGER, mgr, { ...none, regionIds: ['r2', 'r9'] })).regionIds).toEqual(['r2']);
  });

  it('a region outside his scope becomes "matches nothing", not "no filter"', () => {
    const s = scoped(resolveInsightScope(Role.MANAGER, mgr, { ...none, regionIds: ['r9'] }));
    expect(s.regionIds).toEqual([NONE]);
    expect(s.filtered).toBe(true);
    expect(singleRegionInView(s)).toBeNull();
  });

  it('a route filter is kept beside the region scope, to be tested on the same branch row', () => {
    const s = scoped(resolveInsightScope(Role.MANAGER, mgr, { ...none, routeIds: ['x'] }));
    expect(s.regionIds).toEqual(['r1', 'r2']);
    expect(s.routeIds).toEqual(['x']);
  });

  it('a Supervisor’s team ∩ a foreign route stays empty', () => {
    const s = scoped(resolveInsightScope(Role.SUPERVISOR, { ...empty, teamRouteIds: ['a'] }, { ...none, routeIds: ['b'] }));
    expect(s.routeIds).toEqual([NONE]);
  });

  it('the organisation-wide roles take the filter as it is: a narrowing of everything', () => {
    const s = scoped(resolveInsightScope(Role.VIEWER, empty, { ...none, regionIds: ['r1'] }));
    expect(s).toMatchObject({ kind: 'company', regionIds: ['r1'], routeIds: null, filtered: true });
    expect(isCompanyWide(s)).toBe(false);
    expect(singleRegionInView(s)).toBe('r1');
  });

  it('a filter cannot bring back a scope the role does not have', () => {
    expect(resolveInsightScope(Role.MANAGER, empty, { ...none, regionIds: ['r1'] })).toEqual({ kind: 'none' });
  });

  it('one region in view, and only then, is "single region" (the map’s finer cells)', () => {
    expect(singleRegionInView(scoped(resolveInsightScope(Role.MANAGER, { ...empty, managedRegionIds: ['r1'] }, none)))).toBe('r1');
    expect(singleRegionInView(scoped(resolveInsightScope(Role.MANAGER, mgr, none)))).toBeNull();
    expect(singleRegionInView(scoped(resolveInsightScope(Role.STEWARD, empty, none)))).toBeNull();
  });
});

describe('branchInView is filterBranchesByScope, for every role', () => {
  const branches = [
    { regionId: 'r1', routeId: 'a', deletedAt: null },
    { regionId: 'r1', routeId: 'b', deletedAt: null },
    { regionId: 'r2', routeId: 'c', deletedAt: null },
    { regionId: 'r3', routeId: 'd', deletedAt: null },
    { regionId: 'r1', routeId: 'a', deletedAt: new Date('2026-01-01T00:00:00Z') },
  ];
  const roleScopes: RoleScope[] = [
    empty,
    { ownedRouteId: 'a', teamRouteIds: [], managedRegionIds: [] },
    { ownedRouteId: null, teamRouteIds: ['b', 'c'], managedRegionIds: [] },
    { ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['r1'] },
    { ownedRouteId: 'd', teamRouteIds: ['a'], managedRegionIds: ['r2', 'r3'] },
  ];

  it.each(Object.values(Role))('%s, unfiltered: the same branches', (role) => {
    for (const rs of roleScopes) {
      const user = { id: 'u', role, username: 'u' } as never;
      const gate = filterBranchesByScope(user, branches, rs);
      const s = resolveInsightScope(role, rs, none);
      const twin = branches.filter((b) => branchInView(s, b));
      expect(twin, JSON.stringify(rs)).toEqual(gate);
    }
  });

  it.each(Object.values(Role))('%s, filtered: a subset of the gate', (role) => {
    for (const rs of roleScopes) {
      for (const f of [{ ...none, regionIds: ['r1'] }, { ...none, routeIds: ['a', 'c'] }, { regionIds: ['r2'], routeIds: ['a'], rejected: false }]) {
        const user = { id: 'u', role, username: 'u' } as never;
        const gate = filterBranchesByScope(user, branches, rs);
        const twin = branches.filter((b) => branchInView(resolveInsightScope(role, rs, f), b));
        for (const b of twin) expect(gate).toContain(b);
      }
    }
  });
});

describe('the SQL twins', () => {
  const mgr = scoped(resolveInsightScope(Role.MANAGER, { ...empty, managedRegionIds: ['r1', 'r2'] }, { ...none, routeIds: ['x'] }));

  // Launch fix (2026-10-07): the organisation's view leaves out inactive regions
  // (the ZZTEST test region); a region-scoped view is not touched.
  it('no scope selects nothing; the unfiltered organisation selects every active region', () => {
    expect(branchInScopeSql({ kind: 'none' }, 'b').sql).toBe('FALSE');
    expect(requestInScopeSql({ kind: 'none' }).sql).toBe('FALSE');
    const org = scoped(resolveInsightScope(Role.STEWARD, empty, none));
    expect(branchInScopeSql(org, 'b').sql).toBe('b."regionId" IN (SELECT ar."id" FROM "Region" ar WHERE ar."isActive")');
    expect(draftInScopeSql(org, 'd', 'r').sql).toBe('r."regionId" IN (SELECT ar."id" FROM "Region" ar WHERE ar."isActive")');
    expect(requestInScopeSql(org).sql).toContain('ar."isActive"');
    expect(requestInScopeSql(org).values).toEqual([]);
    // A filtered organisation view keeps the active-region test beside the filter.
    const picked = scoped(resolveInsightScope(Role.VIEWER, empty, { ...none, regionIds: ['r1'] }));
    expect(branchInScopeSql(picked, 'b').text).toBe(
      'b."regionId" IN (SELECT ar."id" FROM "Region" ar WHERE ar."isActive") AND b."regionId" = ANY($1::text[])'
    );
  });

  it('a Manager’s regions are taken as his role gives them, active or not', () => {
    const own = scoped(resolveInsightScope(Role.MANAGER, { ...empty, managedRegionIds: ['r1'] }, none));
    expect(branchInScopeSql(own, 'b').sql).not.toContain('isActive');
    expect(draftInScopeSql(own, 'd', 'r').sql).not.toContain('isActive');
    expect(requestInScopeSql(own).sql).not.toContain('isActive');
  });

  it('region and route are tested on the same row, and ids are bound, never spliced', () => {
    const q = branchInScopeSql(mgr, 'b');
    expect(q.text).toBe('b."regionId" = ANY($1::text[]) AND b."routeId" = ANY($2::text[])');
    expect(q.values).toEqual([['r1', 'r2'], ['x']]);
    const d = draftInScopeSql(mgr, 'd', 'r');
    expect(d.text).toBe('r."regionId" = ANY($1::text[]) AND d."routeId" = ANY($2::text[])');
  });

  it('a request is counted by countedInRegionsSql itself, then narrowed by the route', () => {
    const regionsOnly = scoped(resolveInsightScope(Role.MANAGER, { ...empty, managedRegionIds: ['r1'] }, none));
    expect(requestInScopeSql(regionsOnly).sql).toBe(__gates.countedInRegionsSql(['r1']).sql);
    const narrowed = requestInScopeSql(mgr).sql;
    expect(narrowed.startsWith(__gates.countedInRegionsSql(['r1', 'r2']).sql + ' AND (')).toBe(true);
  });

  it('a table alias is never taken from anywhere but a fixed list', () => {
    expect(() => branchInScopeSql(mgr, 'b; DROP TABLE x')).toThrow('bad SQL alias');
  });
});
