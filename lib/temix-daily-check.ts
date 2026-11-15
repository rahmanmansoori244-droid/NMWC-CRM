/**
 * The daily Temix import, stage 4: the Check. A PURE PLAN of what a staged
 * daily file would do to the CRM, made from the staged rows and a read of the
 * CRM. It writes nothing anywhere: not a customer, not a shop, not the staged
 * rows, not the file. The preview page shows it; the apply (stage 5) will make
 * the same plan again inside its own transaction, because the CRM may change
 * between the preview and the apply.
 *
 * WHAT IT DECIDES (the plan's file handling, nothing beyond it):
 *
 *  CUSTOMER. A row's customer code (custCodeKey) is compared with every
 *  customer's nmwcCode and Temix code, both normalised (normalizeTemixCode).
 *    - one LIVE customer has it (by either code)        -> matched;
 *    - two different LIVE customers have it             -> held, DUPLICATE_SUSPECT;
 *    - only an archived or merged customer has it       -> held, CUSTOMER_ARCHIVED;
 *    - nobody has it                                    -> held, CUSTOMER_UNKNOWN.
 *      Creating a customer from the file waits for the owner (stage 9).
 *
 *  SHOP. The row's branch_code is composed under its customer code as the
 *  Import screen composes it (lib/import-shop-code.ts rowShopCode: "01" under
 *  C1 is C1-01), letters kept, and compared with the shop codes in the CRM.
 *    - blank branch_code                                -> held, BRANCH_CODE_BLANK
 *      (how the file marks the main account row is the owner's question; see
 *      mainRowOf below);
 *    - branch_code that is the customer's own code       -> held, BRANCH_CODE_IS_CUSTOMER_CODE
 *      ("CA1" under CA1). The owner may answer that this marks the main account
 *      row, so until he does such a row is not read as the CRM shop coded CA1
 *      (CRM shops coded exactly as their customer exist: composeBranchCode keeps
 *      them), and moves nothing;
 *    - exactly a live shop of the matched customer      -> matched;
 *    - exactly an archived shop of it                   -> held, SHOP_ARCHIVED;
 *    - exactly a shop of ANOTHER customer               -> held, SHOP_OF_ANOTHER_CUSTOMER;
 *    - looks like one of its shops (zeros or capitals)  -> held, SHOP_CODE_LOOKALIKE,
 *      until it is corrected (the Import screen's shopLookalike);
 *    - the customer was matched by its Temix code only  -> held, SHOP_NOT_LINKED:
 *      its shops carry NMWC codes and the CRM keeps no Temix code for a shop
 *      (the crosswalk waits for the owner);
 *    - otherwise                                        -> held, SHOP_UNKNOWN
 *      (creating a shop from the file waits for the owner).
 *
 *  ROUTE. The row's route code: exactly a CRM Route.code (normalised), else a
 *  LIVE route-map entry (TemixRouteMap, which starts EMPTY), else NOT MATCHED.
 *  Nothing is guessed: no suffix is cut, no near code is tried. A route that
 *  is not matched, or whose CRM route is switched off, leaves the shop on its
 *  own route; it is not a hold of the whole row. A shop whose resolved route is
 *  the one it is on would not move.
 *
 *  ROW AS A WHOLE. Held at upload for: no customer code, a duplicate row, a
 *  look-alike shop code within the file, a spreadsheet error in a cell.
 *
 * WHAT IT DOES NOT DECIDE (waits for the owner; shown, never applied):
 *  - credit and terms: which row is the main account (mainRowOf is a stub that
 *    answers "undecided"), and which words Temix writes in payment_terms. The
 *    Check lists where a row's terms, limit or days differ from the customer's
 *    as written, for every row of a matched customer, and applies none.
 *  - status: what A and I mean in the CRM, and whether status is a customer's
 *    or a shop's. The Check counts each pair (Temix A/I beside the CRM's
 *    status) and calls none of them a difference.
 *  - customers missing from the file: whether the file is the full list. The
 *    Check counts the live customers no row names (customersNotNamed); once a
 *    file is loaded, finalize lists each as an open spell for the Steward
 *    (lib/temix-daily-finalize.ts), and nothing more is done about them.
 *  - creating customers and shops; route-code variants (the map is empty until
 *    the Steward enters the owner's route master); shop codes of customers made
 *    in the CRM; thresholds; the end of the pilot rule.
 *
 * PURE: no database. Values here are codes, ids, enum values and figures; no
 * name, phone, address or CR number is read.
 */
import { rowShopCode, shopLookalike } from './import-shop-code';
import { normalizeTemixCode } from './temix-code';
import { isCellError, sortedNotes, type StagedDailyRow } from './temix-daily-file';

// ── Inputs ────────────────────────────────────────────────────────────────

/** A staged row, as the Check reads it (codes and figures from parsed only). */
export type CheckRow = {
  id: string;
  rowNumber: number;
  custCodeKey: string | null;
  branchCodeKey: string | null;
  /** The branch_code as written (letters kept), from parsed. */
  branchCodeWritten: string | null;
  /** The route code, normalised at upload. */
  route: string | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  paymentTermDays: number | null;
  status: 'A' | 'I' | null;
  /** The notes found at upload (TemixDailyRow.holdReasons). */
  notes: readonly string[];
};

export type CrmStatus = 'ACTIVE' | 'CLOSED' | 'SUSPENDED';

export type CrmCustomer = {
  id: string;
  nmwcCode: string;
  temixCode: string | null;
  /** Neither archived nor merged into another. */
  live: boolean;
  isTest: boolean;
  status: CrmStatus;
  paymentTerms: 'CASH' | 'CREDIT';
  creditLimit: number | null;
  paymentTermDays: number | null;
};

export type CrmBranch = {
  id: string;
  customerId: string;
  branchCode: string;
  routeId: string;
  regionId: string;
  live: boolean;
  status: CrmStatus;
};

export type CrmRoute = { id: string; code: string; regionId: string; isActive: boolean };

/** A live route-map entry (an ADD no RETIRE names). */
export type RouteMapEntry = { id: string; temixRouteCode: string; routeId: string };

export type CheckInput = {
  rows: readonly CheckRow[];
  customers: readonly CrmCustomer[];
  branches: readonly CrmBranch[];
  routes: readonly CrmRoute[];
  routeMap: readonly RouteMapEntry[];
};

// ── Codes ─────────────────────────────────────────────────────────────────

/** Why a whole row is held: code words only (TemixDailyRow_hold_reasons_check). */
export const CHECK_HOLDS = [
  // Found at upload (lib/temix-daily-file.ts).
  'CUST_CODE_MISSING',
  'DUPLICATE_ROW',
  'SHOP_CODE_LOOKALIKE',
  'CELL_ERROR',
  // Found by the Check.
  'CUSTOMER_UNKNOWN',
  'CUSTOMER_ARCHIVED',
  'DUPLICATE_SUSPECT',
  'BRANCH_CODE_BLANK',
  'BRANCH_CODE_IS_CUSTOMER_CODE',
  'SHOP_UNKNOWN',
  'SHOP_ARCHIVED',
  'SHOP_OF_ANOTHER_CUSTOMER',
  'SHOP_NOT_LINKED',
] as const;
export type CheckHold = (typeof CHECK_HOLDS)[number];

/** The upload notes that hold the whole row. The others only limit what is compared. */
const UPLOAD_NOTES_THAT_HOLD: ReadonlySet<string> = new Set(['CUST_CODE_MISSING', 'DUPLICATE_ROW', 'SHOP_CODE_LOOKALIKE', 'CELL_ERROR']);

export const CHECK_HOLD_LABEL: Record<CheckHold, string> = {
  CUST_CODE_MISSING: 'no customer code',
  DUPLICATE_ROW: 'the same customer and shop on more than one row of the file',
  SHOP_CODE_LOOKALIKE: 'a shop code that only looks like another (zeros or capitals differ), held until it is corrected',
  CELL_ERROR: 'a cell holds a spreadsheet error',
  CUSTOMER_UNKNOWN: 'no customer in the CRM has this code (creating customers from the file waits for the owner)',
  CUSTOMER_ARCHIVED: 'only an archived or merged customer has this code',
  DUPLICATE_SUSPECT: 'two different live customers have this code (one by its NMWC code, one by its Temix code, or both by Temix codes)',
  BRANCH_CODE_BLANK: 'no shop code (how the file marks the main account row waits for the owner)',
  BRANCH_CODE_IS_CUSTOMER_CODE:
    "the shop code is the customer's own code, which may mark the main account row (how the file marks it waits for the owner)",
  SHOP_UNKNOWN: 'the customer has no shop with this code (creating shops from the file waits for the owner)',
  SHOP_ARCHIVED: 'the shop with this code is archived',
  SHOP_OF_ANOTHER_CUSTOMER: 'this shop code belongs to another customer',
  SHOP_NOT_LINKED: 'the customer was found by its Temix code; its shops carry NMWC codes, and the CRM keeps no Temix code for a shop yet (waits for the owner)',
};

/** How a row's route code resolves. */
export type RouteResolution =
  | { kind: 'EXACT'; routeId: string; code: string }
  | { kind: 'MAP'; routeId: string; code: string; entryId: string }
  | { kind: 'NOT_MATCHED'; code: string }
  /** Two CRM routes whose codes are the same once normalised: nothing is chosen. */
  | { kind: 'AMBIGUOUS'; code: string }
  | { kind: 'MISSING' };

/** Why a shop would keep its route although the row names another. */
export type RouteHold = 'ROUTE_MISSING' | 'ROUTE_NOT_MATCHED' | 'ROUTE_AMBIGUOUS' | 'ROUTE_SWITCHED_OFF';

export const ROUTE_HOLD_LABEL: Record<RouteHold, string> = {
  ROUTE_MISSING: 'no route in the file',
  ROUTE_NOT_MATCHED: 'the route code is not a CRM route and has no route-map entry',
  ROUTE_AMBIGUOUS: 'two CRM routes have this code once capitals and spaces are set aside',
  ROUTE_SWITCHED_OFF: 'the CRM route it names is switched off',
};

// ── Route resolution ──────────────────────────────────────────────────────

/** Resolves route codes: an exact CRM Route.code first, then a live route-map entry. */
export function routeResolver(routes: readonly CrmRoute[], routeMap: readonly RouteMapEntry[]) {
  const byCode = new Map<string, CrmRoute[]>();
  for (const r of routes) {
    const k = normalizeTemixCode(r.code);
    if (!k) continue;
    byCode.set(k, [...(byCode.get(k) ?? []), r]);
  }
  const mapped = new Map<string, RouteMapEntry>();
  for (const e of routeMap) mapped.set(normalizeTemixCode(e.temixRouteCode), e);
  return (code: string | null): RouteResolution => {
    const k = normalizeTemixCode(code ?? '');
    if (!k) return { kind: 'MISSING' };
    const exact = byCode.get(k);
    if (exact && exact.length > 1) return { kind: 'AMBIGUOUS', code: k };
    if (exact && exact.length === 1) return { kind: 'EXACT', routeId: exact[0]!.id, code: k };
    const e = mapped.get(k);
    if (e) return { kind: 'MAP', routeId: e.routeId, code: k, entryId: e.id };
    return { kind: 'NOT_MATCHED', code: k };
  };
}

// ── The main account row ──────────────────────────────────────────────────

/**
 * Which of a customer's rows is its main account, the row its credit and terms
 * would be read from. THE OWNER HAS NOT SAID how the daily file marks it (a
 * blank branch_code, the customer's own code, or something else), so this
 * answers "undecided" for every customer, and nothing reads credit or terms
 * from any row. Stage 8 replaces this body once he answers; nothing else
 * decides it. (The Import screen's refresh lane reads credit from a customer's
 * FIRST row; the plan says not to copy that.)
 */
export type MainRow = { decided: false; why: 'MAIN_ROW_UNDECIDED' };

export function mainRowOf(_rowsOfCustomer: readonly CheckRow[]): MainRow {
  return { decided: false, why: 'MAIN_ROW_UNDECIDED' };
}

// ── The plan ──────────────────────────────────────────────────────────────

export type TermsField = 'paymentTerms' | 'creditLimit' | 'paymentTermDays';
export type TermsDifference = { field: TermsField; crm: string | null; file: string };

export type RowPlan = {
  rowId: string;
  rowNumber: number;
  custCodeKey: string | null;
  branchCodeKey: string | null;
  /** The branch_code as written (letters kept): what to correct in Temix. */
  branchCodeWritten: string | null;
  customerId: string | null;
  /** How the customer was found. */
  matchedBy: 'NMWC_CODE' | 'TEMIX_CODE' | 'BOTH' | null;
  branchId: string | null;
  /** Why the whole row is held (empty: it is not). */
  holds: CheckHold[];
  route: RouteResolution;
  /** Why the shop would keep its route although the row names another. */
  routeHold: RouteHold | null;
  /** The route move this row would make, or null. */
  move: { branchId: string; fromRouteId: string; toRouteId: string; fromRegionId: string; toRegionId: string; via: 'EXACT' | 'MAP' } | null;
  /** Terms, limit and days that differ as written. Never applied: mainRowOf is undecided. */
  terms: TermsDifference[];
  /** Temix's status beside the CRM's; nothing here calls it a difference. */
  status: { temix: 'A' | 'I' | null; customer: CrmStatus | null; shop: CrmStatus | null };
  /** The row's outcome if it were applied now. */
  verdict: 'HELD' | 'WOULD_MOVE' | 'NO_CHANGE';
};

export type StatusPairs = Array<{ temix: 'A' | 'I' | 'NONE'; crm: CrmStatus; rows: number }>;

export type CheckPlan = {
  rows: RowPlan[];
  counts: {
    rows: number;
    held: number;
    wouldMove: number;
    noChange: number;
    /** Held rows by reason (a row may have several). */
    holds: Partial<Record<CheckHold, number>>;
    /** Rows of a matched shop whose route part is held, by reason. */
    routeHolds: Partial<Record<RouteHold, number>>;
    moves: {
      shops: number;
      customers: number;
      /** Moves into a route of another region. */
      crossRegion: number;
      /** Moves whose route came from a route-map entry. */
      viaMap: number;
    };
    /**
     * Rows of a matched customer whose terms, limit or days differ as written.
     * customersWithRowsDisagreeing: customers whose rows in the file carry two
     * different values of one field; a blank cell is no value, so a main row
     * with terms beside shop rows left blank agrees.
     */
    terms: { rows: number; customers: number; byField: Record<TermsField, number>; customersWithRowsDisagreeing: number };
    customersMatched: number;
    unknownCustomers: { codes: number; rows: number };
    missing: { customers: number; withoutTemixCode: number };
    statusByCustomer: StatusPairs;
    statusByShop: StatusPairs;
  };
  /** Live, non-test customers no row of the file names (ids). */
  missingCustomerIds: string[];
  /**
   * Route codes not matched, over EVERY row of the file, held rows included
   * (rows), and of those the rows of a shop found and not held (shopFound),
   * which are the ones counts.routeHolds.ROUTE_NOT_MATCHED counts.
   */
  unmatchedRoutes: Array<{ code: string; rows: number; shopFound: number }>;
  mainRow: MainRow;
};

const num = (n: number | null): string | null => (n == null ? null : String(n));

const STATUS_ORDER: readonly CrmStatus[] = ['ACTIVE', 'CLOSED', 'SUSPENDED'];
const TEMIX_ORDER = ['A', 'I', 'NONE'] as const;

function pairs(counts: Map<string, number>): StatusPairs {
  const out: StatusPairs = [];
  for (const t of TEMIX_ORDER)
    for (const c of STATUS_ORDER) {
      const n = counts.get(`${t}|${c}`);
      if (n) out.push({ temix: t, crm: c, rows: n });
    }
  return out;
}

/** The Check: what the file would do, row by row, and the counts the preview shows. */
export function checkDailyFile(input: CheckInput): CheckPlan {
  const resolve = routeResolver(input.routes, input.routeMap);
  const routeById = new Map(input.routes.map((r) => [r.id, r]));

  // Customers by each normalised code.
  const byNmwc = new Map<string, CrmCustomer[]>();
  const byTemix = new Map<string, CrmCustomer[]>();
  const push = (m: Map<string, CrmCustomer[]>, k: string, c: CrmCustomer) => {
    if (k) m.set(k, [...(m.get(k) ?? []), c]);
  };
  for (const c of input.customers) {
    push(byNmwc, normalizeTemixCode(c.nmwcCode), c);
    if (c.temixCode) push(byTemix, normalizeTemixCode(c.temixCode), c);
  }
  const customerById = new Map(input.customers.map((c) => [c.id, c]));
  const branchByCode = new Map(input.branches.map((b) => [b.branchCode, b]));
  const branchesOf = new Map<string, CrmBranch[]>();
  for (const b of input.branches) branchesOf.set(b.customerId, [...(branchesOf.get(b.customerId) ?? []), b]);

  const matchCustomer = (key: string): Pick<RowPlan, 'customerId' | 'matchedBy'> & { hold: CheckHold | null } => {
    const n = byNmwc.get(key) ?? [];
    const t = byTemix.get(key) ?? [];
    const live = new Map<string, CrmCustomer>();
    for (const c of [...n, ...t]) if (c.live) live.set(c.id, c);
    if (live.size > 1) return { customerId: null, matchedBy: null, hold: 'DUPLICATE_SUSPECT' };
    if (live.size === 1) {
      const c = [...live.values()][0]!;
      const viaN = n.some((x) => x.id === c.id);
      const viaT = t.some((x) => x.id === c.id);
      return { customerId: c.id, matchedBy: viaN && viaT ? 'BOTH' : viaN ? 'NMWC_CODE' : 'TEMIX_CODE', hold: null };
    }
    if (n.length + t.length > 0) return { customerId: null, matchedBy: null, hold: 'CUSTOMER_ARCHIVED' };
    return { customerId: null, matchedBy: null, hold: 'CUSTOMER_UNKNOWN' };
  };

  const plans: RowPlan[] = [];
  for (const row of input.rows) {
    const holds: CheckHold[] = [];
    for (const n of row.notes) if (UPLOAD_NOTES_THAT_HOLD.has(n)) holds.push(n as CheckHold);
    const route = resolve(row.route);
    let customerId: string | null = null;
    let matchedBy: RowPlan['matchedBy'] = null;
    let branch: CrmBranch | null = null;

    // A spreadsheet error in the code cell is not a code: the row is held as
    // CELL_ERROR, and the error is never looked up or counted as a customer code.
    if (row.custCodeKey && !isCellError(row.custCodeKey)) {
      const m = matchCustomer(row.custCodeKey);
      customerId = m.customerId;
      matchedBy = m.matchedBy;
      if (m.hold) holds.push(m.hold);
    }
    const customer = customerId ? customerById.get(customerId)! : null;

    if (customer && row.custCodeKey) {
      const written = (row.branchCodeWritten ?? '').trim();
      if (!written) {
        holds.push('BRANCH_CODE_BLANK');
      } else if (rowShopCode(row.custCodeKey, written) === row.custCodeKey.trim().toUpperCase()) {
        holds.push('BRANCH_CODE_IS_CUSTOMER_CODE');
      } else {
        const composed = rowShopCode(row.custCodeKey, written);
        const exact = branchByCode.get(composed);
        const own = branchesOf.get(customer.id) ?? [];
        if (exact && exact.customerId === customer.id) {
          if (exact.live) branch = exact;
          else holds.push('SHOP_ARCHIVED');
        } else if (exact) {
          holds.push('SHOP_OF_ANOTHER_CUSTOMER');
        } else if (matchedBy === 'TEMIX_CODE') {
          // Composed under the customer's Temix code, the row's shop code is
          // not one of its NMWC shop codes; nothing links the two.
          holds.push('SHOP_NOT_LINKED');
        } else if (shopLookalike(row.custCodeKey, written, own.map((b) => b.branchCode), [])) {
          holds.push('SHOP_CODE_LOOKALIKE');
        } else {
          holds.push('SHOP_UNKNOWN');
        }
      }
    }
    const uniqueHolds = [...new Set(holds)];

    // The route part, for a matched shop only.
    let routeHold: RouteHold | null = null;
    let move: RowPlan['move'] = null;
    if (branch && uniqueHolds.length === 0) {
      if (route.kind === 'MISSING') routeHold = 'ROUTE_MISSING';
      else if (route.kind === 'NOT_MATCHED') routeHold = 'ROUTE_NOT_MATCHED';
      else if (route.kind === 'AMBIGUOUS') routeHold = 'ROUTE_AMBIGUOUS';
      else if (route.routeId !== branch.routeId) {
        const target = routeById.get(route.routeId);
        if (!target || !target.isActive) routeHold = 'ROUTE_SWITCHED_OFF';
        else
          move = {
            branchId: branch.id,
            fromRouteId: branch.routeId,
            toRouteId: target.id,
            fromRegionId: branch.regionId,
            toRegionId: target.regionId,
            via: route.kind,
          };
      }
    }

    // Terms as written, beside the customer's: shown, never applied.
    const terms: TermsDifference[] = [];
    if (customer) {
      if (row.paymentTerms != null && row.paymentTerms !== customer.paymentTerms)
        terms.push({ field: 'paymentTerms', crm: customer.paymentTerms, file: row.paymentTerms });
      if (row.creditLimit != null && row.creditLimit !== customer.creditLimit)
        terms.push({ field: 'creditLimit', crm: num(customer.creditLimit), file: String(row.creditLimit) });
      if (row.paymentTermDays != null && row.paymentTermDays !== customer.paymentTermDays)
        terms.push({ field: 'paymentTermDays', crm: num(customer.paymentTermDays), file: String(row.paymentTermDays) });
    }

    plans.push({
      rowId: row.id,
      rowNumber: row.rowNumber,
      custCodeKey: row.custCodeKey,
      branchCodeKey: row.branchCodeKey,
      branchCodeWritten: row.branchCodeWritten,
      customerId,
      matchedBy,
      branchId: branch?.id ?? null,
      holds: uniqueHolds,
      route,
      routeHold,
      move,
      terms,
      status: { temix: row.status, customer: customer?.status ?? null, shop: branch?.status ?? null },
      verdict: uniqueHolds.length > 0 ? 'HELD' : move ? 'WOULD_MOVE' : 'NO_CHANGE',
    });
  }

  // ── Counts ──
  const holdCounts: CheckPlan['counts']['holds'] = {};
  const routeHoldCounts: CheckPlan['counts']['routeHolds'] = {};
  const moveShops = new Set<string>();
  const moveCustomers = new Set<string>();
  let crossRegion = 0;
  let viaMap = 0;
  const termsByField: Record<TermsField, number> = { paymentTerms: 0, creditLimit: 0, paymentTermDays: 0 };
  const termsCustomers = new Set<string>();
  let termsRows = 0;
  const matched = new Set<string>();
  const unknownCodes = new Set<string>();
  let unknownRows = 0;
  const byCust = new Map<string, number>();
  const byShop = new Map<string, number>();
  const rowsOfCustomer = new Map<string, CheckRow[]>();
  const rowById = new Map(input.rows.map((r) => [r.id, r]));

  for (const p of plans) {
    for (const h of p.holds) holdCounts[h] = (holdCounts[h] ?? 0) + 1;
    if (p.routeHold) routeHoldCounts[p.routeHold] = (routeHoldCounts[p.routeHold] ?? 0) + 1;
    if (p.move) {
      moveShops.add(p.move.branchId);
      if (p.customerId) moveCustomers.add(p.customerId);
      if (p.move.fromRegionId !== p.move.toRegionId) crossRegion++;
      if (p.move.via === 'MAP') viaMap++;
    }
    if (p.terms.length > 0) {
      termsRows++;
      if (p.customerId) termsCustomers.add(p.customerId);
      for (const d of p.terms) termsByField[d.field]++;
    }
    if (p.customerId) {
      matched.add(p.customerId);
      rowsOfCustomer.set(p.customerId, [...(rowsOfCustomer.get(p.customerId) ?? []), rowById.get(p.rowId)!]);
      const t = p.status.temix ?? 'NONE';
      if (p.status.customer) byCust.set(`${t}|${p.status.customer}`, (byCust.get(`${t}|${p.status.customer}`) ?? 0) + 1);
      if (p.status.shop) byShop.set(`${t}|${p.status.shop}`, (byShop.get(`${t}|${p.status.shop}`) ?? 0) + 1);
    }
    if (p.holds.includes('CUSTOMER_UNKNOWN') && p.custCodeKey) {
      unknownCodes.add(p.custCodeKey);
      unknownRows++;
    }
  }

  // A customer whose rows in the file do not agree on terms, limit or days:
  // which of them would count is the owner's main-row question.
  // Field by field, over the cells that hold a value: a blank is not a value.
  let disagreeing = 0;
  for (const rows of rowsOfCustomer.values()) {
    const fields: Array<(r: CheckRow) => string | number | null> = [(r) => r.paymentTerms, (r) => r.creditLimit, (r) => r.paymentTermDays];
    if (fields.some((f) => new Set(rows.map(f).filter((v) => v != null)).size > 1)) disagreeing++;
  }

  // Customers no row names: the codes of every row, against both codes.
  const named = new Set(input.rows.map((r) => r.custCodeKey).filter((k): k is string => !!k));
  const missing = customersNotNamed(input.customers, named).filter((c) => !matched.has(c.id));

  const unmatched = new Map<string, { rows: number; shopFound: number }>();
  for (const p of plans)
    if (p.route.kind === 'NOT_MATCHED' && !isCellError(p.route.code)) {
      const u = unmatched.get(p.route.code) ?? { rows: 0, shopFound: 0 };
      u.rows++;
      if (p.routeHold === 'ROUTE_NOT_MATCHED') u.shopFound++;
      unmatched.set(p.route.code, u);
    }

  const held = plans.filter((p) => p.verdict === 'HELD').length;
  const wouldMove = plans.filter((p) => p.verdict === 'WOULD_MOVE').length;
  return {
    rows: plans,
    counts: {
      rows: plans.length,
      held,
      wouldMove,
      noChange: plans.length - held - wouldMove,
      holds: holdCounts,
      routeHolds: routeHoldCounts,
      moves: { shops: moveShops.size, customers: moveCustomers.size, crossRegion, viaMap },
      terms: { rows: termsRows, customers: termsCustomers.size, byField: termsByField, customersWithRowsDisagreeing: disagreeing },
      customersMatched: matched.size,
      unknownCustomers: { codes: unknownCodes.size, rows: unknownRows },
      missing: { customers: missing.length, withoutTemixCode: missing.filter((c) => !c.temixCode).length },
      statusByCustomer: pairs(byCust),
      statusByShop: pairs(byShop),
    },
    missingCustomerIds: missing.map((c) => c.id),
    unmatchedRoutes: [...unmatched].map(([code, u]) => ({ code, ...u })).sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code)),
    mainRow: mainRowOf([]),
  };
}

/**
 * The live, non-test customers that no code in `named` names, by NMWC code or
 * Temix code (both normalised). The Check counts these as missing from the
 * file, and finalize (lib/temix-daily-finalize.ts) opens a spell for each: one
 * rule for both, so the preview's figure is the spells finalize writes.
 */
export function customersNotNamed<C extends Pick<CrmCustomer, 'nmwcCode' | 'temixCode' | 'live' | 'isTest'>>(
  customers: readonly C[],
  named: ReadonlySet<string>
): C[] {
  return customers.filter(
    (c) =>
      c.live &&
      !c.isTest &&
      !named.has(normalizeTemixCode(c.nmwcCode)) &&
      !(c.temixCode && named.has(normalizeTemixCode(c.temixCode)))
  );
}

/**
 * A staged row (lib/temix-daily-file.ts stageDailyRows) as the Check reads it:
 * the same fields loadCheckRows selects from the stored row.
 */
export function checkRowOfStaged(id: string, r: StagedDailyRow): CheckRow {
  return {
    id,
    rowNumber: r.rowNumber,
    custCodeKey: r.custCodeKey,
    branchCodeKey: r.branchCodeKey,
    branchCodeWritten: r.parsed.branchCodeWritten,
    route: r.parsed.route,
    paymentTerms: r.parsed.paymentTerms,
    creditLimit: r.parsed.creditLimit,
    paymentTermDays: r.parsed.paymentTermDays,
    status: r.parsed.status,
    notes: sortedNotes(r.notes),
  };
}

// ── The pilot rule ────────────────────────────────────────────────────────

/** A new-customer request waiting at the Accountant (CustomerEdit CREATE, SUBMITTED, pendingRole ACCOUNTANT). */
export type WaitingRequest = { id: string; submittedAt: Date | null };

/**
 * The pilot rule (owner, 2026-10-11): no Temix file is loaded while a
 * new-customer request waits at the Accountant. The Check shows it as a banner;
 * the apply (stage 5) refuses to start or continue while it holds. When the rule
 * ends is the owner's question: nothing here ends it.
 */
export function pilotGate(waiting: readonly WaitingRequest[]): { stopped: boolean; waiting: WaitingRequest[] } {
  return { stopped: waiting.length > 0, waiting: [...waiting] };
}

/**
 * Route codes of staged rows that are not a CRM route and have no live
 * route-map entry, with their row counts (the route-map page). A code two CRM
 * routes share once normalised is not listed: a map entry would not settle it,
 * because an exact code is looked at before the map. A spreadsheet error
 * (isCellError) is not a route code and is not listed: its row is held.
 */
export function unmatchedRouteCodes(
  counts: ReadonlyArray<{ code: string | null; rows: number }>,
  routes: readonly CrmRoute[],
  routeMap: readonly RouteMapEntry[]
): Array<{ code: string; rows: number }> {
  const resolve = routeResolver(routes, routeMap);
  const out = new Map<string, number>();
  for (const c of counts) {
    const r = resolve(c.code);
    if (r.kind === 'NOT_MATCHED' && !isCellError(r.code)) out.set(r.code, (out.get(r.code) ?? 0) + c.rows);
  }
  return [...out].map(([code, rows]) => ({ code, rows })).sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code));
}
