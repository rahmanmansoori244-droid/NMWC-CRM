/**
 * The customer import never changes the route of a shop that ALREADY EXISTS
 * (owner's answer of 2026-11-11 to "two ways the Import screen can still move a
 * shop to another route — stop or keep?": "A1 stop"; background decision of
 * 2026-10-11: route moves are made in Temix, never in the CRM).
 *
 * This file is the ONE place that rule lives. Every lane of the promote
 * (services/imports.ts: the full lane's upsert, the fixed lane's update) and
 * the "Before you promote" summary (lib/import-plan.ts) pass a row for a shop
 * that exists through `holdShopRoute`, and build what they write on it with
 * `existingShopWrite`, which has no route in it at all. A structural test
 * (tests/unit/import-shop-route-guard.test.ts) fails if any import code writes
 * a route on a shop by any other way.
 *
 * What is still done:
 *  - a NEW shop (a new customer's, or a new shop of a customer in the CRM) is
 *    created on the route the sheet names, exactly as before: that is how the
 *    owner's customer file lands on an emptied database;
 *  - the REGION repair: a shop whose stored region is not its own route's (a
 *    route moved region before routes were fixed to their region, migration
 *    20261015100100) is put back into its own route's region when the row names
 *    a route. That is not a route move: the route stays as it is.
 *
 * What the Steward is told: a row that names another route for a shop that
 * exists is NOT refused for that. Everything else it would write is written;
 * the route is not, and the row says so (`routeNotAppliedNote`), and the
 * end-of-load notice counts it.
 *
 * Pure: no database, no Prisma.
 */
import { ROUTE_NOT_APPLIED } from './import-shop-notice';

/** A row's route cells, as services/imports.ts and lib/import-plan.ts resolve them. */
export type RouteCells = { routeResolved: boolean; routeId: string; regionId: string };

/** A route by its id: its region, and its code when the caller has it (for the row's note). */
export type RouteById = ReadonlyMap<string, { regionId: string; code?: string }>;

/** The route a row named and the route the shop keeps, as codes, for the row's note. */
export type RouteNotApplied = { sheetRoute: string; keptRoute: string };

/**
 * The row as the import may write it on a shop that exists: its route is the
 * shop's own, and its region the region of that route. `routeResolved` stays as
 * the row had it, so a row that names no route still compares and writes no
 * region (item 20: a blank cell keeps the stored value); it is false too when
 * the shop's own route is unknown, so nothing about the region is written then.
 *
 * `notApplied` is set when the row named a route (one that exists) other than
 * the shop's: that route is NOT applied.
 */
export function holdShopRoute<T extends RouteCells>(
  row: T,
  stored: { routeId: string },
  routeById: RouteById
): { row: T; notApplied: RouteNotApplied | null } {
  const own = routeById.get(stored.routeId) ?? null;
  const notApplied =
    row.routeResolved && row.routeId !== stored.routeId
      ? {
          sheetRoute: routeById.get(row.routeId)?.code ?? row.routeId,
          keptRoute: own?.code ?? stored.routeId,
        }
      : null;
  return {
    row: {
      ...row,
      routeId: stored.routeId,
      regionId: own ? own.regionId : '',
      routeResolved: row.routeResolved && !!own,
    },
    notApplied,
  };
}

/** What a row gives a shop that exists, in the shape the write reads. */
export type ExistingShopRow = {
  nameGiven: boolean;
  branchName: string;
  sheetAddress: string | null;
  dayOfVisit: string | null;
  status: string | null;
  routeResolved: boolean;
  regionId: string;
};

/**
 * Everything an import may write on a shop that ALREADY EXISTS. There is no
 * route in it, by construction: `routeId` is not a key of the result. The region
 * is written only when the row names a route, and it is then the region of the
 * shop's own route (pass the row through `holdShopRoute` first). An undefined
 * value writes nothing (Prisma), and lists no field in the audit row.
 */
export function existingShopWrite(r: ExistingShopRow): {
  branchName: string | undefined;
  regionId: string | undefined;
  address: string | undefined;
  dayOfVisit: string | undefined;
  status: string | undefined;
} {
  return {
    branchName: r.nameGiven ? r.branchName : undefined,
    regionId: r.routeResolved && r.regionId ? r.regionId : undefined,
    address: r.sheetAddress ?? undefined,
    dayOfVisit: r.dayOfVisit ?? undefined,
    status: r.status ?? undefined,
  };
}

/**
 * The row's note when its route was not applied: which route the sheet names,
 * which route the shop keeps, and the owner-approved sentence (ROUTE_NOT_APPLIED,
 * lib/import-shop-notice.ts) exactly.
 */
export function routeNotAppliedNote(branchCode: string, r: RouteNotApplied): string {
  return `shop ${branchCode}: the sheet names route ${r.sheetRoute}; the shop is on route ${r.keptRoute}. ${ROUTE_NOT_APPLIED}`;
}
