/**
 * F2 — the SQL twins of lib/insights/scope.ts, as Prisma.sql fragments for the
 * dashboard's raw aggregates (lib/insights/load.ts).
 *
 * Held to the access gates on real Postgres by tests/integration/insights.test.ts:
 *   - branchInScopeSql (with the caller's live-branch and live-customer tests)
 *     selects exactly the branches lib/access.ts filterBranchesByScope keeps, and
 *     the customers canSeeCustomer admits;
 *   - draftInScopeSql selects exactly the new-customer requests /approvals/[id]
 *     lets the viewer open (openableInRegions, CREATE arm);
 *   - requestInScopeSql is lib/service-status.ts countedInRegionsSql itself when
 *     the view is a set of regions, narrowed by a route filter only.
 *
 * Ids are always bound parameters. Column names come from fixed strings and the
 * table aliases from a whitelist (alias()), never from a request.
 */
import { Prisma } from '@prisma/client';
import { countedInRegionsSql, openableInRegionsSql } from '../service-status';
import type { InsightScope } from './scope';

const FALSE = Prisma.sql`FALSE`;
const TRUE = Prisma.sql`TRUE`;

function alias(a: string): string {
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(a)) throw new Error(`bad SQL alias ${a}`);
  return a;
}

function col(a: string, name: 'regionId' | 'routeId'): Prisma.Sql {
  return Prisma.raw(`${alias(a)}."${name}"`);
}

/**
 * The region and route tests on one branch row aliased `b`. Both on the SAME
 * row: a customer with one branch in the region and another on the route is not
 * "on the route in the region". The caller adds `b."deletedAt" IS NULL` and the
 * live-customer test, which it reads with the row anyway.
 */
export function branchInScopeSql(scope: InsightScope, b: string): Prisma.Sql {
  if (scope.kind === 'none') return FALSE;
  const parts: Prisma.Sql[] = [];
  if (scope.regionIds) parts.push(Prisma.sql`${col(b, 'regionId')} = ANY(${scope.regionIds}::text[])`);
  if (scope.routeIds) parts.push(Prisma.sql`${col(b, 'routeId')} = ANY(${scope.routeIds}::text[])`);
  return parts.length ? Prisma.join(parts, ' AND ') : TRUE;
}

/**
 * A new-customer request's draft branch `d`, joined to its route `r`: the
 * route's CURRENT region — the test /approvals/[id] applies to a CREATE (a route
 * moved since the request was raised moves the request with it) — and the
 * draft's route, on the same draft row.
 */
export function draftInScopeSql(scope: InsightScope, d: string, r: string): Prisma.Sql {
  if (scope.kind === 'none') return FALSE;
  const parts: Prisma.Sql[] = [];
  if (scope.regionIds) parts.push(Prisma.sql`${col(r, 'regionId')} = ANY(${scope.regionIds}::text[])`);
  if (scope.routeIds) parts.push(Prisma.sql`${col(d, 'routeId')} = ANY(${scope.routeIds}::text[])`);
  return parts.length ? Prisma.join(parts, ' AND ') : TRUE;
}

/**
 * Requests (CustomerEdit aliased `e`) a figure may count. With a region test it
 * is countedInRegionsSql — the /approvals/[id] gate, and a reactivation only on a
 * branch in those regions (the ones /reactivations shows). A route test can only
 * narrow that: a CREATE by a draft on the route, a reactivation by its own
 * branch, anything else by a live branch of the customer on the route — each on
 * the same row as the region test. With neither, every request.
 */
export function requestInScopeSql(scope: InsightScope): Prisma.Sql {
  if (scope.kind === 'none') return FALSE;
  const parts: Prisma.Sql[] = [];
  if (scope.regionIds) parts.push(countedInRegionsSql(scope.regionIds));
  if (scope.routeIds) {
    const onDraft = scope.regionIds ? Prisma.sql`AND rr."regionId" = ANY(${scope.regionIds}::text[])` : Prisma.empty;
    const onBranch = scope.regionIds ? Prisma.sql`AND rb."regionId" = ANY(${scope.regionIds}::text[])` : Prisma.empty;
    parts.push(Prisma.sql`(
      (e."process" = 'CREATE' AND EXISTS (
         SELECT 1 FROM "EditBranchDraft" rd JOIN "Route" rr ON rr."id" = rd."routeId"
          WHERE rd."editId" = e."id" AND rd."routeId" = ANY(${scope.routeIds}::text[]) ${onDraft}))
      OR (e."process" <> 'CREATE' AND EXISTS (
         SELECT 1 FROM "Branch" rb
          WHERE rb."customerId" = e."customerId" AND rb."deletedAt" IS NULL
            AND (NOT e."isReactivation" OR rb."id" = e."branchId")
            AND rb."routeId" = ANY(${scope.routeIds}::text[]) ${onBranch})))`);
  }
  return parts.length ? Prisma.join(parts, ' AND ') : TRUE;
}

/** The gates themselves, re-exported for the suite that holds the twins to them. */
export const __gates = { openableInRegionsSql, countedInRegionsSql };
