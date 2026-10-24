/**
 * Gap 18 (data audit 2026-10-10): where a request was raised, as it was sent —
 * CustomerEdit.routeIdAtSubmit and regionIdsAtSubmit (migration
 * 20261025090100_request_scope_at_submit), written once with the SUBMITTED state
 * and frozen by the evidence guard.
 *
 *   - a new customer's request: its draft route, and that route's region (a
 *     route never changes region, so this is the attribution at the time);
 *   - an update, a close or a reactivation: the submitter's own route when he
 *     sent it (null if he held none — a Steward's or Manager's direct write), and
 *     the regions of the request's scope at that moment, by the rule the approval
 *     queue uses (lib/permissions.ts requestScopeBranches), as EditApproval's
 *     scopeRegionIds and submitterRouteId record it for a decision (gap 11).
 *
 * Nothing reads these to decide who may see what: whether a Manager's /audit and
 * the region-scoped figures follow the region at the time is the owner's open
 * question (04-PENDING-WORK A6). Rows sent before stay null and empty;
 * docs/HISTORY.md gives the as-of query that answers them.
 *
 * PURE.
 */
import { requestScopeBranches } from './permissions';

export type ScopeAtSubmit = { routeIdAtSubmit: string | null; regionIdsAtSubmit: string[] };

const regions = (ids: Iterable<string>) => [...new Set(ids)].sort();

/** A new customer's request: the draft route and its region. */
export function createScopeAtSubmit(route: { id: string; regionId: string }): ScopeAtSubmit {
  return { routeIdAtSubmit: route.id, regionIdsAtSubmit: [route.regionId] };
}

/** An update, a close or a reactivation: his route, and the regions of the request's scope now. */
export function requestScopeAtSubmit(input: {
  branches: ReadonlyArray<{ id: string; regionId: string; routeId: string; deletedAt: Date | null }>;
  fieldChanges: unknown;
  branchId?: string | null;
  homeBranchIds?: readonly string[] | null;
  submitterRouteId: string | null;
  submitterRegionId?: string | null;
}): ScopeAtSubmit {
  const scope = requestScopeBranches({
    branches: input.branches,
    fieldChanges: input.fieldChanges,
    branchId: input.branchId ?? null,
    homeBranchIds: input.homeBranchIds ?? null,
    submitterRouteId: input.submitterRouteId,
    submitterRegionId: input.submitterRegionId ?? null,
  });
  return { routeIdAtSubmit: input.submitterRouteId ?? null, regionIdsAtSubmit: regions(scope.map((b) => b.regionId)) };
}
