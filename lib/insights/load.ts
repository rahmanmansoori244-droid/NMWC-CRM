/**
 * F2 — everything the insights dashboard (/dashboard) shows, read in one wave.
 *
 * Modelled on lib/service-status.ts: no 'use server' (nothing here is callable
 * from a browser), no session read — the page gates the role, resolves the scope
 * (lib/insights/scope.ts) and passes it in.
 *
 * Six aggregate statements run in ONE Promise.allSettled, each returning small
 * rows of counts (lib/insights/shape.ts). No row-level data leaves the database:
 * no customer, no branch, no exact point, and no person by name. Route-level
 * rows are labelled by Route.code, which is the route's salesman's username
 * (lib/compliance/pii-classification.ts), so a route's figures identify that
 * salesman's work (docs/compliance/RECORDS-OF-PROCESSING.md A4). A statement
 * that fails — or runs out of time (lib/insights/rollout.ts: its own Postgres
 * statement_timeout, and one deadline for the wave) — degrades only the cards
 * built on it: the dashboard is every Manager's and Viewer's landing page, so one
 * bad or slow query must never take the page down.
 *
 * Definitions (owner decisions, defaults in lib/insights/policy.ts):
 *   - new customers: CREATE requests APPROVED in the window, by reviewedAt,
 *     counted as requests, attributed to the draft's route and that route's
 *     current region (the /approvals/[id] gate for a CREATE);
 *   - customers updated: APPROVED UPDATE requests on the customer (target
 *     CUSTOMER, not reactivations), by reviewedAt, salesman requests apart from
 *     direct writes (submittedById = reviewedById), attributed to the customer's
 *     live branches in view, by their current route and region; for ranking
 *     ROUTES by their salesmen's work ("byRequestOnRoute") a request counts only
 *     on the route of a branch it changed (branch.<id>.* in fieldChanges) or,
 *     when it changed no branch, on its submitter's own route — never on every
 *     route a chain customer has a branch on;
 *   - "the period before" (every prev count) runs exactly as long as the window
 *     has run so far (lib/insights/period.ts prevTo): like for like;
 *   - closures and reactivations: branch requests on the branch's own region;
 *   - the request pipeline and "Pending approval": the /approvals/[id] gate
 *     (lib/service-status.ts countedInRegionsSql), states only, no timings —
 *     /status has those, under its own privacy rules;
 *   - everything branch-level (customers in view, gaps, the map): live branches of
 *     live customers, on the branch's own region and route.
 *
 * Raw-SQL rules kept here: every count is cast ::int and every average ::float8
 * (a BigInt or a Decimal neither renders nor crosses to a client component);
 * time buckets are computed once in a CTE and grouped by name, with the grain
 * and the Oman offset spliced from whitelisted literals (Prisma.raw), never bound
 * twice; fieldChanges is read only when jsonb_typeof says it is an array; no
 * findMany, no unbounded result (the map is capped at MAP.maxCells cells); no
 * cache of any kind — nothing here may be shared between viewers.
 * Customer.updatedAt is never read: it moves on imports, photo wiring and rescoring.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import type { Grain, InsightPeriod } from './period';
import { MANAGER_PENDING_STEP_ROLES, MAP, NEW_CUSTOMERS, OMAN_OFFSET_HOURS, UPDATED_CUSTOMERS } from './policy';
import { STATEMENT_TIMEOUT_MS, WAVE_DEADLINE_MS, withinDeadline } from './rollout';
import { singleRegionInView, type InsightScope } from './scope';
import { branchInScopeSql, draftInScopeSql, requestInScopeSql } from './sql';
import {
  shapeCreated,
  shapeHeat,
  shapePipeline,
  shapeState,
  shapeStatusChanges,
  shapeUpdated,
  type CreatedData,
  type CreatedRow,
  type HeatData,
  type HeatRow,
  type PipelineData,
  type RequestRow,
  type Section,
  type StateData,
  type StateRow,
  type StatusChangeData,
  type StatusRow,
  type UpdatedData,
  type UpdatedRow,
} from './shape';

export type ActiveScope = Exclude<InsightScope, { kind: 'none' }>;

export type Insights = {
  state: Section<StateData>;
  created: Section<CreatedData>;
  updated: Section<UpdatedData>;
  statusChanges: Section<StatusChangeData>;
  pipeline: Section<PipelineData>;
  heat: Section<HeatData>;
};

/** date_trunc's unit, from a whitelist: a literal in the SQL text, never a bound parameter. */
const GRAIN_SQL: Record<Grain, Prisma.Sql> = {
  day: Prisma.raw(`'day'`),
  week: Prisma.raw(`'week'`),
  month: Prisma.raw(`'month'`),
};
const OMAN_OFFSET = Prisma.raw(`interval '${Math.trunc(OMAN_OFFSET_HOURS)} hours'`);

/** The Oman bucket a UTC timestamp column falls in, as 'YYYY-MM-DD'. */
function bucketSql(column: Prisma.Sql, grain: Grain): Prisma.Sql {
  return Prisma.sql`to_char(date_trunc(${GRAIN_SQL[grain]}, ${column} + ${OMAN_OFFSET}), 'YYYY-MM-DD')`;
}

const REGION_NAMES = Prisma.sql`rg."name" AS "regionName", rg."code" AS "regionCode"`;
const ROUTE_NAMES = Prisma.sql`rt."code" AS "routeCode", rt."name" AS "routeName", rt."regionId" AS "routeRegionId",
       rr."name" AS "routeRegionName",
       (rt."id" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "User" u WHERE u."ownedRouteId" = rt."id" AND u."isActive")) AS "routeHasOwner"`;
const NAME_JOINS = Prisma.sql`LEFT JOIN "Region" rg ON rg."id" = agg."regionId"
  LEFT JOIN "Route" rt ON rt."id" = agg."routeId"
  LEFT JOIN "Region" rr ON rr."id" = rt."regionId"`;

/** 1. Branches and customers in view now, per region, per route and in total. */
function stateSql(scope: ActiveScope, p: InsightPeriod): Prisma.Sql {
  const imported = NEW_CUSTOMERS.showImported
    ? Prisma.sql`(c."importBatchId" IS NOT NULL AND c."createdAt" >= ${p.from} AND c."createdAt" < ${p.to})`
    : Prisma.sql`FALSE`;
  return Prisma.sql`/* insights:state */
WITH v AS (
  SELECT b."regionId", b."routeId", b."customerId", b."status"::text AS "status",
         (b."gpsLat" IS NOT NULL AND b."gpsLng" IS NOT NULL) AS "hasGps",
         (b."dayOfVisit" IS NULL) AS "noDay",
         (b."shopPhotoId" IS NULL) AS "noShop",
         (b."signboardPhotoId" IS NULL) AS "noSign",
         b."equipmentConfirmed" AS "equipment",
         b."completenessScore" AS "score",
         COALESCE(b."lastStatusChangeAt" >= ${p.from} AND b."lastStatusChangeAt" < ${p.to}, FALSE) AS "changedInPeriod",
         (c."crPhotoId" IS NULL) AS "noCr",
         ${imported} AS "importedInPeriod"
    FROM "Branch" b
    JOIN "Customer" c ON c."id" = b."customerId"
   WHERE b."deletedAt" IS NULL AND c."deletedAt" IS NULL
     AND ${branchInScopeSql(scope, 'b')}
), agg AS (
  SELECT "regionId", "routeId", GROUPING("regionId", "routeId")::int AS "g",
         count(*)::int AS "branches",
         count(DISTINCT "customerId")::int AS "customers",
         count(*) FILTER (WHERE "status" = 'ACTIVE')::int AS "open",
         count(*) FILTER (WHERE "status" = 'CLOSED')::int AS "closed",
         count(*) FILTER (WHERE "status" = 'CLOSED' AND "changedInPeriod")::int AS "closedInPeriod",
         count(*) FILTER (WHERE "status" = 'ACTIVE' AND "hasGps")::int AS "openWithGps",
         count(*) FILTER (WHERE "status" = 'ACTIVE' AND "noDay")::int AS "openNoDay",
         count(*) FILTER (WHERE "status" = 'ACTIVE' AND "noShop")::int AS "openNoShop",
         count(*) FILTER (WHERE "status" = 'ACTIVE' AND "noSign")::int AS "openNoSign",
         count(*) FILTER (WHERE "status" = 'ACTIVE' AND NOT "equipment")::int AS "openNoEquipment",
         count(DISTINCT "customerId") FILTER (WHERE "noCr")::int AS "customersNoCr",
         count(DISTINCT "customerId") FILTER (WHERE "importedInPeriod")::int AS "imported",
         (avg("score") FILTER (WHERE "status" = 'ACTIVE'))::float8 AS "avgScore"
    FROM v
   GROUP BY GROUPING SETS (("regionId"), ("routeId"), ())
)
SELECT agg.*, ${REGION_NAMES}, ${ROUTE_NAMES}
  FROM agg
  ${NAME_JOINS}`;
}

/** 2. New customers: CREATE requests finalized in the window and the one before. */
function createdSql(scope: ActiveScope, p: InsightPeriod): Prisma.Sql {
  return Prisma.sql`/* insights:created */
WITH v AS (
  SELECT e."id", e."paymentTermsAtSubmit"::text AS "terms",
         (e."reviewedAt" >= ${p.from}) AS "cur",
         (e."reviewedAt" < ${p.prevTo}) AS "inPrev",
         CASE WHEN e."reviewedAt" >= ${p.from} THEN ${bucketSql(Prisma.sql`e."reviewedAt"`, p.grain)} END AS "bucket",
         r."regionId", d."routeId"
    FROM "CustomerEdit" e
    JOIN "EditBranchDraft" d ON d."editId" = e."id"
    JOIN "Route" r ON r."id" = d."routeId"
   WHERE e."process" = 'CREATE' AND e."state" = 'APPROVED'
     AND e."reviewedAt" >= ${p.prevFrom} AND e."reviewedAt" < ${p.to}
     AND ${draftInScopeSql(scope, 'd', 'r')}
), agg AS (
  SELECT "bucket", "regionId", "routeId", "terms",
         GROUPING("bucket", "regionId", "routeId", "terms")::int AS "g",
         count(DISTINCT "id") FILTER (WHERE "cur")::int AS "n",
         count(DISTINCT "id") FILTER (WHERE "inPrev")::int AS "prev"
    FROM v
   GROUP BY GROUPING SETS (("bucket", "terms"), ("regionId"), ("routeId"), ("terms"), ())
)
SELECT agg.*, ${REGION_NAMES}, ${ROUTE_NAMES}
  FROM agg
  ${NAME_JOINS}`;
}

/** fieldChanges paths, grouped as the cards name them (lib/change-report.ts grammar). */
const FAMILY_SQL = Prisma.sql`
    bool_or(x."f" LIKE 'branch.%.gpsLat'
            AND NOT (jsonb_typeof(x."after") = 'number' AND x."before" = x."after")) AS "gps",
    bool_or(x."f" IN ('customer.primaryPhone', 'customer.altPhone')) AS "phone",
    bool_or(x."f" LIKE 'branch.%.address' OR x."f" LIKE 'branch.%.areaDescription') AS "address",
    bool_or(x."f" LIKE 'branch.%.dayOfVisit') AS "visitDay",
    bool_or(x."f" IN ('customer.channelId', 'customer.subChannelId')) AS "channel",
    bool_or(x."f" LIKE 'branch.%.coolersCount' OR x."f" LIKE 'branch.%.standsCount'
            OR x."f" LIKE 'branch.%.emptyBottlesCount' OR x."f" LIKE 'branch.%.equipmentConfirmed') AS "equipment",
    bool_or(x."f" IN ('customer.contactPerson', 'customer.contactRole')) AS "contact"`;

/**
 * 3. Customers updated: approved UPDATE requests on the customer, in the window
 * and the one before.
 *
 * "onRoute" is the work a branch's ROUTE did: the request changed that branch
 * (its fieldChanges name branch.<id>), or it changed no branch at all
 * (customer-level fields, or photos only) and its submitter owns that branch's
 * route today. Only "byRequestOnRoute" reads it — the figure the route ranking
 * and the idle-route count rest on — so one salesman's change to a chain
 * customer's branch never counts as work on the other routes that customer has
 * branches on. Every other figure keeps counting the customer on each of its
 * branches in view, as the cards say.
 */
function updatedSql(scope: ActiveScope, p: InsightPeriod): Prisma.Sql {
  const directWrites = UPDATED_CUSTOMERS.includeDirectWrites
    ? Prisma.empty
    : Prisma.sql`AND e."reviewedById" IS DISTINCT FROM e."submittedById"`;
  return Prisma.sql`/* insights:updated */
WITH ed AS (
  SELECT e."id", e."customerId", e."submittedById",
         COALESCE(e."submittedById" = e."reviewedById", FALSE) AS "direct",
         (e."reviewedAt" >= ${p.from}) AS "cur",
         (e."reviewedAt" < ${p.prevTo}) AS "inPrev",
         CASE WHEN e."reviewedAt" >= ${p.from} THEN ${bucketSql(Prisma.sql`e."reviewedAt"`, p.grain)} END AS "bucket",
         CASE WHEN jsonb_typeof(e."fieldChanges") = 'array' THEN e."fieldChanges" ELSE '[]'::jsonb END AS "fc"
    FROM "CustomerEdit" e
   WHERE e."process" = 'UPDATE' AND e."target" = 'CUSTOMER' AND e."state" = 'APPROVED'
     AND NOT e."isReactivation" AND e."customerId" IS NOT NULL
     AND e."reviewedAt" >= ${p.prevFrom} AND e."reviewedAt" < ${p.to}
     ${directWrites}
), fam AS (
  SELECT ed."id", ${FAMILY_SQL},
         array_agg(DISTINCT split_part(x."f", '.', 2)) FILTER (WHERE x."f" LIKE 'branch.%.%') AS "branchIds"
    FROM ed
    CROSS JOIN LATERAL (
      SELECT el->>'field' AS "f", el->'before' AS "before", el->'after' AS "after"
        FROM jsonb_array_elements(ed."fc") el
       WHERE jsonb_typeof(el) = 'object') x
   GROUP BY ed."id"
), v AS (
  SELECT ed."id", ed."customerId", ed."direct", ed."cur", ed."inPrev", ed."bucket", b."regionId", b."routeId",
         COALESCE(fam."gps", FALSE) AS "gps", COALESCE(fam."phone", FALSE) AS "phone",
         COALESCE(fam."address", FALSE) AS "address", COALESCE(fam."visitDay", FALSE) AS "visitDay",
         COALESCE(fam."channel", FALSE) AS "channel", COALESCE(fam."equipment", FALSE) AS "equipment",
         COALESCE(fam."contact", FALSE) AS "contact",
         (CASE WHEN cardinality(fam."branchIds") > 0 THEN b."id" = ANY(fam."branchIds")
               ELSE COALESCE(s."ownedRouteId" = b."routeId", FALSE) END) AS "onRoute"
    FROM ed
    JOIN "Customer" c ON c."id" = ed."customerId" AND c."deletedAt" IS NULL
    JOIN "Branch" b ON b."customerId" = ed."customerId" AND b."deletedAt" IS NULL
     AND ${branchInScopeSql(scope, 'b')}
    LEFT JOIN fam ON fam."id" = ed."id"
    LEFT JOIN "User" s ON s."id" = ed."submittedById"
), agg AS (
  SELECT "bucket", "regionId", "routeId", GROUPING("bucket", "regionId", "routeId")::int AS "g",
         count(DISTINCT "customerId") FILTER (WHERE "cur")::int AS "customers",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND NOT "direct")::int AS "byRequest",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND NOT "direct" AND "onRoute")::int AS "byRequestOnRoute",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "direct")::int AS "byDirect",
         count(DISTINCT "id") FILTER (WHERE "cur")::int AS "changes",
         count(DISTINCT "customerId") FILTER (WHERE "inPrev")::int AS "prev",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "gps")::int AS "gps",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "phone")::int AS "phone",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "address")::int AS "address",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "visitDay")::int AS "visitDay",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "channel")::int AS "channel",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "equipment")::int AS "equipment",
         count(DISTINCT "customerId") FILTER (WHERE "cur" AND "contact")::int AS "contact"
    FROM v
   GROUP BY GROUPING SETS (("bucket"), ("regionId"), ("routeId"), ())
)
SELECT agg.*, ${REGION_NAMES}, ${ROUTE_NAMES}
  FROM agg
  ${NAME_JOINS}`;
}

/**
 * 4. Close-shop and reactivation requests, on the branch's own region and route.
 * A refused close and a "Keep closed" end REJECTED since the launch fix of
 * 2026-10-07 (NEEDS_CORRECTION before it), so both states count as refused.
 */
function statusSql(scope: ActiveScope, p: InsightPeriod): Prisma.Sql {
  return Prisma.sql`/* insights:status */
WITH v AS (
  SELECT e."isReactivation" AS "react", e."state"::text AS "state",
         (e."state" <> 'SUBMITTED' AND e."reviewedAt" >= ${p.from}) AS "cur",
         (e."state" <> 'SUBMITTED' AND e."reviewedAt" < ${p.prevTo}) AS "prev",
         CASE WHEN e."state" <> 'SUBMITTED' AND e."reviewedAt" >= ${p.from}
              THEN ${bucketSql(Prisma.sql`e."reviewedAt"`, p.grain)} END AS "bucket",
         b."regionId"
    FROM "CustomerEdit" e
    JOIN "Branch" b ON b."id" = e."branchId" AND b."deletedAt" IS NULL
    JOIN "Customer" c ON c."id" = b."customerId" AND c."deletedAt" IS NULL
   WHERE e."process" = 'UPDATE' AND (e."target" = 'BRANCH' OR e."isReactivation")
     AND (e."state" = 'SUBMITTED'
          OR (e."state" IN ('APPROVED', 'NEEDS_CORRECTION', 'REJECTED')
              AND e."reviewedAt" >= ${p.prevFrom} AND e."reviewedAt" < ${p.to}))
     AND ${branchInScopeSql(scope, 'b')}
), agg AS (
  SELECT "bucket", "regionId", GROUPING("bucket", "regionId")::int AS "g",
         count(*) FILTER (WHERE "cur" AND NOT "react" AND "state" = 'APPROVED')::int AS "closed",
         count(*) FILTER (WHERE "cur" AND "react" AND "state" = 'APPROVED')::int AS "reactivated",
         count(*) FILTER (WHERE "cur" AND NOT "react" AND "state" IN ('NEEDS_CORRECTION', 'REJECTED'))::int AS "closeRefused",
         count(*) FILTER (WHERE "cur" AND "react" AND "state" IN ('NEEDS_CORRECTION', 'REJECTED'))::int AS "keptClosed",
         count(*) FILTER (WHERE "prev" AND NOT "react" AND "state" = 'APPROVED')::int AS "prevClosed",
         count(*) FILTER (WHERE "prev" AND "react" AND "state" = 'APPROVED')::int AS "prevReactivated",
         count(*) FILTER (WHERE "state" = 'SUBMITTED' AND NOT "react")::int AS "closeWaiting",
         count(*) FILTER (WHERE "state" = 'SUBMITTED' AND "react")::int AS "reactWaiting"
    FROM v
   GROUP BY GROUPING SETS (("bucket"), ("regionId"), ())
)
SELECT agg.*, ${REGION_NAMES}
  FROM agg
  LEFT JOIN "Region" rg ON rg."id" = agg."regionId"`;
}

/**
 * 5. Requests submitted in the window by kind and the state they are in now, and
 * what waits now. Direct writes never queue and are left out.
 */
function requestsSql(scope: ActiveScope, p: InsightPeriod): Prisma.Sql {
  return Prisma.sql`/* insights:requests */
SELECT CASE WHEN e."process" = 'CREATE' THEN 'create'
            WHEN e."isReactivation" THEN 'reactivation'
            WHEN e."target" = 'BRANCH' THEN 'close'
            ELSE 'update' END AS "kind",
       e."state"::text AS "state",
       count(*) FILTER (WHERE e."submittedAt" >= ${p.from} AND e."submittedAt" < ${p.to})::int AS "submitted",
       count(*) FILTER (WHERE e."state" = 'SUBMITTED')::int AS "waiting",
       count(*) FILTER (WHERE e."state" = 'SUBMITTED'
                          AND COALESCE(e."pendingRole"::text, 'SUPERVISOR') = ANY(${[...MANAGER_PENDING_STEP_ROLES]}::text[]))::int AS "waitingFirstStep"
  FROM "CustomerEdit" e
 WHERE e."state" <> 'DRAFT'
   AND e."reviewedById" IS DISTINCT FROM e."submittedById"
   AND (e."state" = 'SUBMITTED' OR (e."submittedAt" >= ${p.from} AND e."submittedAt" < ${p.to}))
   AND ${requestInScopeSql(scope)}
 GROUP BY 1, 2`;
}

/** 6. GPS cells of open branches in view, densest first, plus the coverage totals. */
function heatSql(scope: ActiveScope, cellDeg: number): Prisma.Sql {
  const perDeg = Math.round(1 / cellDeg);
  const { latMin, latMax, lngMin, lngMax } = MAP.bounds;
  return Prisma.sql`/* insights:heat */
WITH base AS (
  SELECT b."gpsLat" AS "lat", b."gpsLng" AS "lng"
    FROM "Branch" b
    JOIN "Customer" c ON c."id" = b."customerId"
   WHERE b."deletedAt" IS NULL AND c."deletedAt" IS NULL AND b."status" = 'ACTIVE'
     AND ${branchInScopeSql(scope, 'b')}
), cells AS (
  SELECT floor("lat" * ${perDeg})::int AS "cy", floor("lng" * ${perDeg})::int AS "cx", count(*)::int AS "n"
    FROM base
   WHERE "lat" IS NOT NULL AND "lng" IS NOT NULL
     AND "lat" >= ${latMin} AND "lat" <= ${latMax} AND "lng" >= ${lngMin} AND "lng" <= ${lngMax}
   GROUP BY 1, 2
), ranked AS (
  SELECT "cy", "cx", "n", row_number() OVER (ORDER BY "n" DESC, "cy", "cx") AS "rk" FROM cells
)
SELECT 'cell'::text AS "kind", "cy", "cx", "n", 0::int AS "m" FROM ranked WHERE "rk" <= ${MAP.maxCells}
UNION ALL
SELECT 'total', NULL::int, NULL::int,
       (SELECT count(*)::int FROM base),
       (SELECT count(*)::int FROM base WHERE "lat" IS NOT NULL AND "lng" IS NOT NULL)
UNION ALL
SELECT 'cells', NULL::int, NULL::int,
       (SELECT count(*)::int FROM cells),
       (SELECT COALESCE(sum("n"), 0)::int FROM cells)`;
}

/** Exported for tests/unit/insights-load.test.ts and the integration suite, which run the SQL text. */
export const __sql = { stateSql, createdSql, updatedSql, statusSql, requestsSql, heatSql, bucketSql };

function section<R, T>(card: string, result: PromiseSettledResult<R>, shape: (rows: R) => T): Section<T> {
  if (result.status === 'fulfilled') {
    try {
      return { ok: true, data: shape(result.value) };
    } catch (err) {
      logCardFailure(card, err);
      return { ok: false };
    }
  }
  logCardFailure(card, result.reason);
  return { ok: false };
}

/**
 * Only the card and the error's class and code reach the log — never its message,
 * which can quote the statement (lib/logger.ts scrubs, but there is nothing here
 * a reader of the log needs beyond what failed and how).
 */
function logCardFailure(card: string, err: unknown): void {
  const e = err as { name?: unknown; code?: unknown } | null;
  logger.error(
    { card, errorClass: typeof e?.name === 'string' ? e.name : typeof err, code: typeof e?.code === 'string' ? e.code : undefined },
    'insights.card_failed'
  );
}

/** A literal in the SQL text (SET takes no bound parameter), from an integer constant. */
const SET_TIMEOUT = Prisma.raw(`SET LOCAL statement_timeout = ${Math.trunc(STATEMENT_TIMEOUT_MS)}`);

/**
 * One statement, built inside this async function (so even a failure while
 * building it becomes its own rejection, not the wave's), run in its own short
 * transaction under SET LOCAL statement_timeout: Postgres cancels it, and frees
 * the connection, if it runs too long. SET LOCAL ends with the transaction, so
 * nothing leaks to the next user of a pooled connection.
 */
async function run<T>(build: () => Prisma.Sql): Promise<T> {
  const statement = build();
  const [, rows] = await prisma.$transaction([prisma.$executeRaw(SET_TIMEOUT), prisma.$queryRaw<T>(statement)]);
  return rows;
}

/** The cell size the map uses for this view: finer when exactly one region is in view. */
export function cellDegFor(scope: ActiveScope): number {
  return singleRegionInView(scope) ? MAP.cellDegRegion : MAP.cellDegCountry;
}

/**
 * `scope` and `period` have no defaults: the page resolves both. A scope of kind
 * 'none' never reaches here — the page shows its empty state instead.
 */
export async function loadInsights(scope: ActiveScope, period: InsightPeriod): Promise<Insights> {
  const cellDeg = cellDegFor(scope);
  // Every statement races the same deadline: a slow one fails its own section
  // and the page renders the rest, instead of every card waiting on it.
  const timed = <T>(build: () => Prisma.Sql) => withinDeadline(run<T>(build), WAVE_DEADLINE_MS);
  const [state, created, updated, statusChanges, pipeline, heat] = await Promise.allSettled([
    timed<StateRow[]>(() => stateSql(scope, period)),
    timed<CreatedRow[]>(() => createdSql(scope, period)),
    timed<UpdatedRow[]>(() => updatedSql(scope, period)),
    timed<StatusRow[]>(() => statusSql(scope, period)),
    timed<RequestRow[]>(() => requestsSql(scope, period)),
    timed<HeatRow[]>(() => heatSql(scope, cellDeg)),
  ]);
  return {
    state: section('state', state, shapeState),
    created: section('created', created, (rows) => shapeCreated(rows, period)),
    updated: section('updated', updated, (rows) => shapeUpdated(rows, period)),
    statusChanges: section('status', statusChanges, (rows) => shapeStatusChanges(rows, period)),
    pipeline: section('requests', pipeline, shapePipeline),
    heat: section('heat', heat, (rows) => shapeHeat(rows, cellDeg)),
  };
}
