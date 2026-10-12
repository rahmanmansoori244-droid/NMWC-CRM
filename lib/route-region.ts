/**
 * Gap 16 (data audit 2026-10-10), restated by the owner on 2026-10-11: a route
 * NEVER moves to another region. Routes are never renamed, split or merged
 * either; a route may be closed and its customers moved to other routes, and a
 * route for another region is a new route.
 *
 * Enforced twice, in the same words:
 *   - the database refuses any change of Route.regionId (trigger
 *     route_region_fixed, prisma/migrations/20261015100100_route_region_fixed),
 *     for every role and every path, with no override;
 *   - the account-master import holds back a Routes row whose region differs
 *     from the stored route's, with this message, before it ever reaches the
 *     database (services/imports.ts). Its label (name) may still change.
 *
 * tests/unit/route-region.test.ts pins that the migration raises exactly this
 * text, so the Steward reads the same sentence whichever layer refuses.
 *
 * PURE: no imports.
 */
export const ROUTE_REGION_FIXED_MESSAGE =
  'Routes never move to another region. Close this route and open a new one in the other region.';

/** The account import's issue text for a held-back Routes row. */
export function routeRegionHeldMessage(input: {
  routeCode: string;
  storedRegionCode: string;
  sheetRegionCode: string;
  renamed: boolean;
}): string {
  const where = `Route ${input.routeCode} is in region ${input.storedRegionCode}; this row says ${input.sheetRegionCode}.`;
  const label = input.renamed ? ' Its new name was saved.' : '';
  return `${ROUTE_REGION_FIXED_MESSAGE} ${where}${label}`;
}

/** True when a database error is the route_region_fixed refusal. */
export function isRouteRegionRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes(ROUTE_REGION_FIXED_MESSAGE);
}
