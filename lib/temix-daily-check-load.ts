/**
 * The daily Temix import, stage 4: the reads the Check is made from
 * (lib/temix-daily-check.ts checkDailyFile). READS ONLY: no write of any kind,
 * no lock, no change context. The client is passed in, so the apply (stage 5)
 * can make the same reads inside its own transaction. loadCheckInput reads the
 * whole Customer and Branch tables on each call: right for the preview (it also
 * counts the customers no row names), but before stage 5 calls it once per
 * slice of customers it needs a variant that reads only the slice's customers
 * and their shops.
 *
 * Only codes, ids, enum values and figures are read: the staged rows' names,
 * phones, addresses and CR numbers are never selected (the rows are read with
 * the parsed fields named one by one), and no customer's name is read.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { CheckInput, CheckRow, CrmRoute, RouteMapEntry, WaitingRequest } from './temix-daily-check';

type Db = Pick<PrismaClient, '$queryRaw' | 'customer' | 'branch' | 'route' | 'temixRouteMap' | 'customerEdit'>;

type RawRow = {
  id: string;
  rowNumber: number;
  custCodeKey: string | null;
  branchCodeKey: string | null;
  holdReasons: string[] | null;
  emptied: boolean;
  branchCodeWritten: string | null;
  route: string | null;
  paymentTerms: string | null;
  creditLimit: string | null;
  paymentTermDays: string | null;
  status: string | null;
};

const numOrNull = (s: string | null): number | null => {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** A file's staged rows, as the Check reads them; `emptied` when a row's payload was cleared (retention). */
export async function loadCheckRows(db: Db, fileId: string): Promise<{ rows: CheckRow[]; emptied: number }> {
  const raw = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT r."id", r."rowNumber", r."custCodeKey", r."branchCodeKey", r."holdReasons",
           (r."parsed" IS NULL) AS "emptied",
           r."parsed"->>'branchCodeWritten' AS "branchCodeWritten",
           r."parsed"->>'route' AS "route",
           r."parsed"->>'paymentTerms' AS "paymentTerms",
           r."parsed"->>'creditLimit' AS "creditLimit",
           r."parsed"->>'paymentTermDays' AS "paymentTermDays",
           r."parsed"->>'status' AS "status"
      FROM "TemixDailyRow" r
     WHERE r."fileId" = ${fileId}
     ORDER BY r."rowNumber"`);
  let emptied = 0;
  const rows: CheckRow[] = [];
  for (const r of raw) {
    if (r.emptied) {
      emptied++;
      continue;
    }
    rows.push({
      id: r.id,
      rowNumber: r.rowNumber,
      custCodeKey: r.custCodeKey,
      branchCodeKey: r.branchCodeKey,
      branchCodeWritten: r.branchCodeWritten,
      route: r.route,
      paymentTerms: r.paymentTerms,
      creditLimit: numOrNull(r.creditLimit),
      paymentTermDays: numOrNull(r.paymentTermDays),
      status: r.status === 'A' || r.status === 'I' ? r.status : null,
      notes: r.holdReasons ?? [],
    });
  }
  return { rows, emptied };
}

/** Every route, with the code the Check resolves against. */
export async function loadRoutes(db: Db): Promise<Array<CrmRoute & { name: string }>> {
  return db.route.findMany({ select: { id: true, code: true, name: true, regionId: true, isActive: true }, orderBy: { code: 'asc' } });
}

/** The live route-map entries: ADD rows no RETIRE row names. */
export async function loadLiveRouteMap(db: Db): Promise<RouteMapEntry[]> {
  const live = await db.temixRouteMap.findMany({
    where: { action: 'ADD', retiredBy: { is: null } },
    select: { id: true, temixRouteCode: true, routeId: true },
    orderBy: { id: 'asc' },
  });
  return live.map((e) => ({ id: e.id.toString(), temixRouteCode: e.temixRouteCode, routeId: e.routeId! }));
}

/** The pilot rule's requests: new customers waiting at the Accountant. */
export async function loadPilotWaiting(db: Db): Promise<WaitingRequest[]> {
  return db.customerEdit.findMany({
    where: { process: 'CREATE', state: 'SUBMITTED', pendingRole: 'ACCOUNTANT' },
    select: { id: true, submittedAt: true },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
  });
}

/** Everything the Check of one file is made from. */
export async function loadCheckInput(db: Db, fileId: string): Promise<{ input: CheckInput; emptied: number }> {
  const { rows, emptied } = await loadCheckRows(db, fileId);
  const [customers, branches, routes, routeMap] = await Promise.all([
    db.customer.findMany({
      select: {
        id: true,
        nmwcCode: true,
        temixCode: true,
        deletedAt: true,
        mergedIntoId: true,
        isTest: true,
        status: true,
        paymentTerms: true,
        creditLimit: true,
        paymentTermDays: true,
      },
    }),
    db.branch.findMany({
      select: { id: true, customerId: true, branchCode: true, routeId: true, regionId: true, deletedAt: true, status: true },
    }),
    loadRoutes(db),
    loadLiveRouteMap(db),
  ]);
  return {
    emptied,
    input: {
      rows,
      customers: customers.map((c) => ({
        id: c.id,
        nmwcCode: c.nmwcCode,
        temixCode: c.temixCode,
        live: c.deletedAt === null && c.mergedIntoId === null,
        isTest: c.isTest,
        status: c.status,
        paymentTerms: c.paymentTerms,
        creditLimit: c.creditLimit === null ? null : c.creditLimit.toNumber(),
        paymentTermDays: c.paymentTermDays,
      })),
      branches: branches.map((b) => ({
        id: b.id,
        customerId: b.customerId,
        branchCode: b.branchCode,
        routeId: b.routeId,
        regionId: b.regionId,
        live: b.deletedAt === null,
        status: b.status,
      })),
      routes,
      routeMap,
    },
  };
}

/** The route codes of every file not yet applied (STAGED or CHECKED), with their rows (the route-map page). */
export async function loadWaitingRouteCodes(db: Db): Promise<Array<{ code: string | null; rows: number }>> {
  const rows = await db.$queryRaw<Array<{ code: string | null; rows: bigint }>>(Prisma.sql`
    SELECT r."parsed"->>'route' AS "code", count(*) AS "rows"
      FROM "TemixDailyRow" r JOIN "TemixDailyFile" f ON f."id" = r."fileId"
     WHERE f."state" IN ('STAGED', 'CHECKED') AND r."parsed" IS NOT NULL
     GROUP BY 1`);
  return rows.map((r) => ({ code: r.code, rows: Number(r.rows) }));
}

/** Switched-off routes that still hold live shops, with their counts (the route-map page). */
export async function loadSwitchedOffRoutesHoldingShops(db: Db): Promise<Array<{ id: string; code: string; shops: number }>> {
  const rows = await db.$queryRaw<Array<{ id: string; code: string; shops: bigint }>>(Prisma.sql`
    SELECT ro."id", ro."code", count(*) AS "shops"
      FROM "Branch" b JOIN "Route" ro ON ro."id" = b."routeId"
     WHERE ro."isActive" = false AND b."deletedAt" IS NULL
     GROUP BY ro."id", ro."code"
     ORDER BY ro."code"`);
  return rows.map((r) => ({ id: r.id, code: r.code, shops: Number(r.shops) }));
}
