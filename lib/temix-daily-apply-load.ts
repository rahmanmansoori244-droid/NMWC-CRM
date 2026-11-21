/**
 * The daily Temix import, stage 5: what one customer's transaction of the
 * apply reads, under that customer's lock. The Check (lib/temix-daily-check.ts)
 * is then made from exactly this, so the plan that is written is the plan of
 * the CRM as it is inside the transaction, not as it was at the preview.
 *
 *  - lockGroupCustomers: every customer whose NMWC code or Temix code is the
 *    rows' customer code, live or archived, locked FOR UPDATE in id order (the
 *    lock order lib/locks.ts keeps: the customer row before its shops). Codes
 *    are compared exactly as the Check compares them (normalizeTemixCode, in
 *    customerHasCode), after a SQL pre-filter on the codes' digits that can
 *    only be wider (codeDigits; review 2026-11-15, finding 1: the earlier
 *    upper(btrim()) filter was narrower than the Check, so a customer whose
 *    stored code carried an Arabic digit or an invisible character was not
 *    seen by the apply although the preview saw it). The candidates are read
 *    without a lock, then locked by id and compared again as locked. A save of
 *    one of these customers or its shops that takes the customer lock waits
 *    for this transaction.
 *  - loadGroupRows: the group's staged rows still PENDING, locked FOR UPDATE,
 *    read with the Check's columns (codes and figures; never the row as sent).
 *  - loadGroupCrm: those customers and every shop that is theirs or carries a
 *    code one of the rows names (to see a shop of another customer), with the
 *    shops' versions for the optimistic write; every route and the live
 *    route-map entries.
 *  - loadLastMoves: the last route move the daily file made on each shop.
 *
 * Reads only; the locks are the only side effect. Never selects a name, a
 * phone, an address or a CR number.
 */
import { Prisma } from '@prisma/client';
import { rowShopCode } from './import-shop-code';
import type { CheckInput, CheckRow } from './temix-daily-check';
import {
  CHECK_ROW_COLUMNS,
  CRM_BRANCH_SELECT,
  CRM_CUSTOMER_SELECT,
  checkRowOf,
  crmBranchOf,
  crmCustomerOf,
  loadLiveRouteMap,
  loadRoutes,
  type CheckRowColumns,
} from './temix-daily-check-load';
import { FOLDED_DIGITS, codeDigits, customerHasCode, latestMoveByBranch, type LastMove } from './temix-daily-apply';

type Tx = Prisma.TransactionClient;

/** A group: one customer code's rows, or one row that has no customer code. */
export type GroupKey = { custCodeKey: string } | { rowId: string };

type CodeRow = { id: string; nmwcCode: string; temixCode: string | null };

/** A column's digits as codeDigits gives them. */
const digitsOf = (column: Prisma.Sql) =>
  Prisma.sql`regexp_replace(translate(COALESCE(${column}, ''), ${FOLDED_DIGITS.from}, ${FOLDED_DIGITS.to}), '[^0-9]', '', 'g')`;

/** Locks the customers a code names, as the Check matches them. Returns their ids. */
export async function lockGroupCustomers(tx: Tx, key: GroupKey): Promise<string[]> {
  if (!('custCodeKey' in key)) return [];
  const code = key.custCodeKey;
  const digits = codeDigits(code);
  const candidates = await tx.$queryRaw<CodeRow[]>(Prisma.sql`
    SELECT "id", "nmwcCode", "temixCode" FROM "Customer"
     WHERE ${digitsOf(Prisma.sql`"nmwcCode"`)} = ${digits} OR ${digitsOf(Prisma.sql`"temixCode"`)} = ${digits}`);
  const ids = candidates.filter((c) => customerHasCode(c, code)).map((c) => c.id);
  if (ids.length === 0) return [];
  const locked = await tx.$queryRaw<CodeRow[]>(Prisma.sql`
    SELECT "id", "nmwcCode", "temixCode" FROM "Customer"
     WHERE "id" = ANY(${ids}::text[])
     ORDER BY "id" COLLATE "C" FOR UPDATE`);
  return locked.filter((c) => customerHasCode(c, code)).map((c) => c.id);
}

/** The group's rows still waiting, locked; and how many of them had their payload emptied. */
export async function loadGroupRows(tx: Tx, fileId: string, key: GroupKey): Promise<{ rows: CheckRow[]; emptied: number }> {
  const where =
    'custCodeKey' in key ? Prisma.sql`r."custCodeKey" = ${key.custCodeKey}` : Prisma.sql`r."id" = ${key.rowId} AND r."custCodeKey" IS NULL`;
  const raw = await tx.$queryRaw<CheckRowColumns[]>(Prisma.sql`
    SELECT ${CHECK_ROW_COLUMNS}
      FROM "TemixDailyRow" r
     WHERE r."fileId" = ${fileId} AND r."outcome" = 'PENDING' AND ${where}
     ORDER BY r."rowNumber"
       FOR UPDATE`);
  return { rows: raw.filter((r) => !r.emptied).map(checkRowOf), emptied: raw.filter((r) => r.emptied).length };
}

/** The CRM the group's Check is made from, and each shop's version. */
export async function loadGroupCrm(
  tx: Tx,
  customerIds: readonly string[],
  rows: readonly CheckRow[]
): Promise<{ input: Omit<CheckInput, 'rows'>; versions: Map<string, number> }> {
  const codes = [
    ...new Set(
      rows
        .filter((r) => r.custCodeKey && (r.branchCodeWritten ?? '').trim())
        .map((r) => rowShopCode(r.custCodeKey!, (r.branchCodeWritten ?? '').trim()))
    ),
  ];
  const [customers, branches, routes, routeMap] = await Promise.all([
    customerIds.length ? tx.customer.findMany({ where: { id: { in: [...customerIds] } }, select: CRM_CUSTOMER_SELECT }) : Promise.resolve([]),
    customerIds.length || codes.length
      ? tx.branch.findMany({
          where: { OR: [{ customerId: { in: [...customerIds] } }, { branchCode: { in: codes } }] },
          select: { ...CRM_BRANCH_SELECT, version: true },
        })
      : Promise.resolve([]),
    loadRoutes(tx),
    loadLiveRouteMap(tx),
  ]);
  return {
    input: { customers: customers.map(crmCustomerOf), branches: branches.map(crmBranchOf), routes, routeMap },
    versions: new Map(branches.map((b) => [b.id, b.version])),
  };
}

/** The last route move the daily file applied to each of `branchIds`. */
export async function loadLastMoves(
  db: Pick<Tx, 'temixChange'>,
  branchIds: readonly string[]
): Promise<Map<string, LastMove>> {
  if (branchIds.length === 0) return new Map();
  const rows = await db.temixChange.findMany({
    where: { kind: 'ROUTE_MOVE', applied: true, branchId: { in: [...branchIds] } },
    orderBy: { id: 'desc' },
    select: { branchId: true, fileId: true, fromValue: true, toValue: true },
  });
  return latestMoveByBranch(rows);
}
