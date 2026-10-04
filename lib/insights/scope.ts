/**
 * F2 — whose data the insights dashboard aggregates.
 *
 * One rule, stated three ways that must agree:
 *   - resolveInsightScope: the viewer's role scope (customerListBranchScope, the
 *     fail-closed role → branch matrix shared with /customers and its export)
 *     INTERSECTED with the URL's region and route filters. A filter never widens
 *     a scope, and an empty intersection stays empty ('__none__'), never "no
 *     filter" (SR-EXP-01).
 *   - branchInView: the same test on one branch, in JS — held equal to
 *     lib/access.ts filterBranchesByScope for every role by
 *     tests/unit/insights-scope.test.ts.
 *   - lib/insights/sql.ts branchInScopeSql / draftInScopeSql / requestInScopeSql:
 *     the SQL twins, held equal to filterBranchesByScope, canSeeCustomer and the
 *     /approvals/[id] gate on real Postgres by tests/integration/insights.test.ts.
 *
 * Every branch-level figure (customers, heat cells, gaps, route counts) is taken
 * on the BRANCH's own region and route, so a customer with branches in two
 * regions adds nothing from the other region's branches to a region Manager's
 * view. Request-level figures (the pipeline, "Pending approval") reuse the gate
 * /approvals/[id] applies — lib/service-status.ts openableInRegionsSql and
 * countedInRegionsSql, by name — so a count holds nothing the viewer could not
 * open one request at a time.
 *
 * Pure: no 'use server', no database client, no session. The page reads the
 * role scope (lib/access.ts loadScope) and passes it in.
 */
import type { Role } from '@prisma/client';
import { customerListBranchScope } from '../customer-filters';

/** The id no row has: an empty intersection matches nothing, as Prisma's `in: ['__none__']` does. */
export const NONE = '__none__';

/** The most ids one filter may carry, and the longest id; beyond either the filter matches nothing. */
const MAX_FILTER_IDS = 500;
const MAX_ID_LENGTH = 128;

export type InsightFilters = {
  regionIds: string[];
  routeIds: string[];
  /** A filter was too long to read: it is applied as "matches nothing", never dropped. */
  rejected: boolean;
};

function splitIds(raw: string | string[] | undefined): { ids: string[]; ok: boolean } {
  const joined = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  const ids = [...new Set(joined.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  const ok = ids.length <= MAX_FILTER_IDS && ids.every((id) => id.length <= MAX_ID_LENGTH);
  return { ids: ok ? ids : [NONE], ok };
}

/** ?region=a,b&route=x — comma-separated, like /customers. */
export function parseInsightFilters(sp: { region?: string | string[]; route?: string | string[] }): InsightFilters {
  const region = splitIds(sp.region);
  const route = splitIds(sp.route);
  return { regionIds: region.ids, routeIds: route.ids, rejected: !region.ok || !route.ok };
}

export type RoleScope = { ownedRouteId: string | null; teamRouteIds: string[]; managedRegionIds: string[] };

export type InsightScope =
  | { kind: 'none' }
  | {
      /** company: the whole organisation; regions / routes: the role's own slice. */
      kind: 'company' | 'regions' | 'routes';
      /** Effective region test on the branch row (role ∩ filter); null = any region. */
      regionIds: string[] | null;
      /** Effective route test on the same branch row; null = any route. */
      routeIds: string[] | null;
      /** The role's own regions before any filter (null = not region-scoped). */
      roleRegionIds: string[] | null;
      /** The role's own routes before any filter (null = not route-scoped). */
      roleRouteIds: string[] | null;
      /** A URL filter narrowed the role scope. */
      filtered: boolean;
    };

function intersect(scope: string[] | null, filter: string[]): string[] {
  if (filter.length === 0) return scope ?? [];
  if (scope === null) return filter;
  if (scope.length === 0) return [NONE];
  const both = scope.filter((id) => filter.includes(id));
  return both.length > 0 ? both : [NONE];
}

/**
 * The scope the dashboard aggregates over. Built on customerListBranchScope, so
 * every role resolves through the same fail-closed matrix as the customer list:
 * a region-less Manager or Accountant, a route-less Salesman or a report-less
 * Supervisor gets `none`, and so does any role added later until it is decided
 * there. Which roles may open the page at all is DASHBOARD_ROLES; this function
 * does not admit anyone.
 */
export function resolveInsightScope(role: Role, roleScope: RoleScope, filters: InsightFilters): InsightScope {
  const list = customerListBranchScope(role, roleScope);
  if (list.forceEmpty) return { kind: 'none' };
  const branchSome = list.branchSome;
  let roleRegionIds: string[] | null = null;
  let roleRouteIds: string[] | null = null;
  if (branchSome) {
    // Any other condition the shared matrix may grow is one this function cannot
    // express: refuse rather than drop it and widen the view.
    if (Object.keys(branchSome).some((k) => !['regionId', 'routeId', 'deletedAt'].includes(k))) return { kind: 'none' };
    const region = branchSome.regionId;
    const route = branchSome.routeId;
    if (region !== undefined) {
      if (typeof region === 'object' && region !== null && Array.isArray((region as { in?: unknown }).in)) {
        roleRegionIds = [...(region as { in: string[] }).in];
      } else {
        // A shape this function does not know is not read as "no restriction".
        return { kind: 'none' };
      }
    }
    if (route !== undefined) {
      if (typeof route === 'string') roleRouteIds = [route];
      else if (typeof route === 'object' && route !== null && Array.isArray((route as { in?: unknown }).in)) {
        roleRouteIds = [...(route as { in: string[] }).in];
      } else {
        return { kind: 'none' };
      }
    }
    if (roleRegionIds === null && roleRouteIds === null) return { kind: 'none' };
  }
  const regionIds = roleRegionIds === null && filters.regionIds.length === 0 ? null : intersect(roleRegionIds, filters.regionIds);
  const routeIds = roleRouteIds === null && filters.routeIds.length === 0 ? null : intersect(roleRouteIds, filters.routeIds);
  return {
    kind: roleRegionIds ? 'regions' : roleRouteIds ? 'routes' : 'company',
    regionIds,
    routeIds,
    roleRegionIds,
    roleRouteIds,
    filtered: filters.regionIds.length > 0 || filters.routeIds.length > 0,
  };
}

/** Exactly one real region in view: the map uses its finer cells. */
export function singleRegionInView(scope: InsightScope): string | null {
  if (scope.kind === 'none' || !scope.regionIds) return null;
  return scope.regionIds.length === 1 && scope.regionIds[0] !== NONE ? scope.regionIds[0]! : null;
}

/** The whole organisation, unfiltered: the only view that is a company figure. */
export function isCompanyWide(scope: InsightScope): boolean {
  return scope.kind === 'company' && scope.regionIds === null && scope.routeIds === null;
}

/** branchInScopeSql, in JS: is this branch in the view? */
export function branchInView(
  scope: InsightScope,
  branch: { regionId: string; routeId: string; deletedAt: Date | null }
): boolean {
  if (scope.kind === 'none' || branch.deletedAt) return false;
  if (scope.regionIds && !scope.regionIds.includes(branch.regionId)) return false;
  if (scope.routeIds && !scope.routeIds.includes(branch.routeId)) return false;
  return true;
}

const NO_ROLE_SCOPE: RoleScope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };

/**
 * Whether a role sees the whole organisation whatever its user record says
 * (customerListBranchScope with an empty record): then the page need not read
 * the record at all. Any other role's scope is read from the database.
 */
export function roleScopeIsOrgWide(role: Role): boolean {
  const s = customerListBranchScope(role, NO_ROLE_SCOPE);
  return !s.forceEmpty && !s.branchSome;
}
