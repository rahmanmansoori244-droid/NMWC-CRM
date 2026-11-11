/**
 * What a customer import will do with a customer's rows, decided without the
 * database (code review 2026-11-10, finding 1).
 *
 * The promote (services/imports.ts) chose a customer's "lane" in the middle of a
 * 1,800-line transaction, from two accidents nobody could see from outside:
 * whether the customer had a Temix code on record, and whether the row carried
 * one. The decisions are here now, as pure functions, for two reasons:
 *
 *  - they can be tested on their own, case by case (tests/unit/import-plan.test.ts);
 *  - the "Before you promote" summary (lib/import-promote-summary.ts) runs the
 *    SAME functions over the staged rows, so what the Steward is told before
 *    Promote is what Promote then does. A parity test drives both over the same
 *    scenarios (tests/unit/customer-import-service.test.ts).
 *
 * The lanes, unchanged by this file:
 *   refresh — the customer's first plain row carries the Temix code ALREADY on
 *             record: Temix-owned fields only (code, cash/credit, credit limit,
 *             credit days); no shop is created or changed by a plain row.
 *   backup  — a customer created in the app and sent to Temix, with no code yet:
 *             the row records its first Temix code and nothing else.
 *   fixed   — a row the Data Steward fixed in the app, for a customer linked to
 *             Temix: its own shop only.
 *   full    — every other row: creates the customer and its shops; for one that
 *             exists, fills blank CRM fields (lib/import-crm-rule.ts).
 *
 * On every lane, a shop that already exists keeps its route (owner's answer of
 * 2026-11-11, "A1 stop"; lib/import-shop-route.ts): a row naming another route
 * is loaded otherwise as its lane says, and its route is NOT applied.
 */
import type { ImportLane } from './change-context';
import { subChannelClearedByChannelChange } from './channel-pair';
import { APP_CUSTOMER_CODE, formatBranchCode } from './codes';
import { normalizeCR } from './cr';
import {
  ADDRESS_PLACEHOLDER,
  branchCrmRule,
  customerCrmRule,
  type CrmOutcome,
  type StoredBranchCrm,
  type StoredCustomerCrm,
} from './import-crm-rule';
import { differingCells, sameStoredValue } from './import-lineage';
import { composeBranchCode } from './import-row-fix';
import { normalizeTemixCode } from './temix-code';
import { ROUTE_NOT_APPLIED } from './import-shop-notice';
import { existingShopWrite, holdShopRoute, type RouteById } from './import-shop-route';
import { groupShopLookalike } from './import-shop-code';

// ── What a row gives a shop ─────────────────────────────────────────────────

/** A sheet row's shop, resolved against the routes (services/imports.ts builds it). */
export type LaneBranch = {
  sheetCode: string | null;
  branchCode: string;
  branchName: string;
  regionId: string;
  routeId: string;
  address: string;
  dayOfVisit: string | null;
  status: string | null;
  nameGiven: boolean;
  routeResolved: boolean;
  sheetAddress: string | null;
  fixedInApp: boolean;
};

/**
 * What a row would change on the stored branch: the cells it gives (a blank
 * cell gives nothing, item 20) that the branch does not already hold. The
 * refresh lane names them when it does not apply them; the full lane leaves a
 * branch they are empty for unwritten, so its version and updatedAt stay as
 * they were (F21, auditor recheck 2026-09-27).
 *
 * The region is not a cell: the row's region is its resolved route's region
 * now. The B-19 trigger refuses a Branch write whose region is not its route's,
 * but nothing fires when the ACCOUNT import moves a route to another region, so
 * the branches on that route keep the old one until something writes their
 * route again. The full lane passes the stored region, so a branch whose
 * region is not its route's is written, which puts it back in line — as the
 * unconditional upsert did on every re-import before F21 skipped unchanged
 * branches (post-merge review of phase 2, finding 6). The ~3,300 pilot-seeded
 * customers carry no Temix code and always take that lane. The refresh lane
 * passes none: a plain row there changes no branch, and its note lists only
 * what the row itself states.
 *
 * Moved here from services/imports.ts unchanged, so the summary compares a row
 * with a shop exactly as the promote does.
 */
export function differingBranchCells(
  r: Pick<
    LaneBranch,
    'nameGiven' | 'branchName' | 'sheetAddress' | 'routeResolved' | 'routeId' | 'regionId' | 'dayOfVisit' | 'status'
  >,
  stored: {
    branchName: string;
    routeId: string;
    /** The full lane's owner read only; see above. */
    regionId?: string;
    address: string;
    dayOfVisit: string | null;
    status: string;
  }
): string[] {
  const differs: string[] = [];
  if (r.nameGiven && r.branchName !== stored.branchName) differs.push('branch name');
  if (r.sheetAddress && r.sheetAddress !== stored.address) differs.push('address');
  if (r.routeResolved && r.routeId !== stored.routeId) differs.push('route');
  if (r.routeResolved && stored.regionId !== undefined && r.regionId !== stored.regionId) {
    differs.push('region');
  }
  if (r.dayOfVisit && r.dayOfVisit !== stored.dayOfVisit) differs.push('visit day');
  if (r.status && r.status !== stored.status) differs.push('status');
  return differs;
}

// ── A shop the row did not change (code review 2026-11-10, finding 28) ──────

// What the Steward is told when a row's route was not applied: ROUTE_NOT_APPLIED
// (lib/import-shop-notice.ts, also used by the batch page's end-of-load notice).

/**
 * The note on a row of a customer linked to Temix that the import loaded
 * without changing its shop (refresh lane, plain row). `differs` are the labels
 * of differingBranchCells. The route is said first, and plainly: it was NOT
 * changed. The other fields can be changed by an edit on the customer page
 * (BRANCH_EDIT_FIELDS: name, address, visit day, status).
 */
export function shopNotChangedNote(branchCode: string, differs: readonly string[]): string {
  const route = differs.includes('route');
  const others = differs.filter((d) => d !== 'route' && d !== 'region');
  const parts = [`branch ${branchCode}: loaded, shop NOT changed — a row that carries the customer's Temix code never changes an existing shop.`];
  if (route) {
    parts.push(ROUTE_NOT_APPLIED);
  }
  if (others.length > 0) {
    const one = others.length === 1;
    parts.push(
      `The ${others.join(', ')} in this row ${one ? 'differs' : 'differ'} from the CRM and ${one ? 'was' : 'were'} not applied${route ? ' either' : ''}; ${one ? 'it' : 'they'} can be changed by an edit on the customer page.`
    );
  }
  return parts.join(' ');
}

// ── The lane ────────────────────────────────────────────────────────────────

export type LaneExisting = {
  /** deletedAt is set. The promote refuses such a customer before any lane. */
  archived: boolean;
  /** The Temix code as stored (any spelling), or null. */
  temixCode: string | null;
  /** The same code as the sheet's is spelt (lib/temix-code.ts normalizeTemixCode). */
  recordedCode: string | null;
  temixSyncState: string | null;
  lastTemixUploadAt: Date | null;
};

export type LaneRow = { temixCode?: string | null; fixedInApp?: boolean };

export type LaneDecision = {
  /** The customer exists, is live and has a Temix code on record. */
  linked: boolean;
  /** Per row: fixed in the app, for a linked customer — its own shop only. */
  isFixed: boolean[];
  /** The rows that are not `isFixed`. */
  plainIdx: number[];
  /** The row every customer-level decision reads: the first plain row, else the first row. */
  leadIdx: number;
  /** The lead row carries the Temix code already on record. */
  isRefresh: boolean;
  /** The lead row carries a Temix code OTHER than the one on record: refused. */
  crosswalkChange: boolean;
  /**
   * Owner decision 2026-10-08, the backup match, as far as the rows and the
   * customer say: live, no Temix code yet, a customer code the app mints, sent
   * to Temix, a row carrying a code, and no row fixed in the app. The promote
   * still has to find the CREATE audit row its finalize wrote, and check nobody
   * else holds the code.
   */
  backupCandidate: boolean;
  /** The lanes once the backup match is settled (`firstTemixCode`). */
  lanes: (firstTemixCode: boolean) => {
    refreshLane: boolean;
    fullLane: boolean;
    laneOf: (i: number) => ImportLane;
  };
};

/**
 * The lane of each of a customer's rows. These are the booleans the promote
 * computed inline, moved here verbatim: nothing about the rule changed.
 *
 * A refresh is an inbound update from the ERP for a customer the CRM ALREADY
 * KNOWS BY A TEMIX CODE, and the code must MATCH: a customer the CRM has never
 * crosswalked (the ~3,300 seeded ones) takes the full lane whatever the row
 * carries, and a Steward cannot unlock the credit fields by typing a code into a
 * sheet (services/imports.ts keeps the history of both decisions).
 */
export function decideLane(input: {
  custCode: string;
  existing: LaneExisting | null;
  rows: readonly LaneRow[];
}): LaneDecision {
  const { custCode, existing, rows } = input;
  const live = !!existing && !existing.archived;
  const linked = live && !!existing!.temixCode;
  const isFixed = rows.map((p) => linked && p.fixedInApp === true);
  const plainIdx = rows.map((_, i) => i).filter((i) => !isFixed[i]);
  const leadIdx = plainIdx.length > 0 ? plainIdx[0]! : 0;
  const leadCode = rows[leadIdx]?.temixCode || null;
  const recordedCode = existing?.recordedCode || null;
  const isRefresh = live && !!leadCode && !!recordedCode && recordedCode === leadCode;
  const crosswalkChange = live && !!leadCode && !!recordedCode && recordedCode !== leadCode;
  const backupCandidate =
    !isRefresh &&
    live &&
    !existing!.temixCode &&
    !!leadCode &&
    plainIdx.length > 0 &&
    rows.every((p) => p.fixedInApp !== true) &&
    APP_CUSTOMER_CODE.test(custCode) &&
    (existing!.lastTemixUploadAt != null ||
      existing!.temixSyncState === 'UPLOADED' ||
      existing!.temixSyncState === 'SYNCED');
  return {
    linked,
    isFixed,
    plainIdx,
    leadIdx,
    isRefresh,
    crosswalkChange,
    backupCandidate,
    lanes: (firstTemixCode) => ({
      // The plain rows' lane: the refresh lane when their first row carries the
      // customer's own Temix code (or its first one), else the full lane. With no
      // plain row, nothing about the customer is written.
      refreshLane: (isRefresh || firstTemixCode) && plainIdx.length > 0,
      fullLane: plainIdx.length > 0 && !isRefresh && !firstTemixCode,
      laneOf: (i) => (isFixed[i] ? 'fixed' : firstTemixCode ? 'backup' : isRefresh ? 'refresh' : 'full'),
    }),
  };
}

// ── Credit cells that are not applied ───────────────────────────────────────

export type CreditReason =
  | 'NO_CODE_ON_RECORD'
  | 'ROW_CODE_BLANK'
  | 'CUSTOMER_IS_CASH'
  | 'NEW_NOT_CREDIT'
  | 'FIRST_CODE_ONLY'
  | 'FIXED_ROW'
  | 'NOT_FIRST_ROW';

export const CREDIT_REASONS: readonly CreditReason[] = [
  'NO_CODE_ON_RECORD',
  'ROW_CODE_BLANK',
  'CUSTOMER_IS_CASH',
  'NEW_NOT_CREDIT',
  'FIRST_CODE_ONLY',
  'FIXED_ROW',
  'NOT_FIRST_ROW',
];

type CreditCells = { creditLimit?: number | null; paymentTermDays?: number | null };

const given = (v: unknown): boolean => v !== null && v !== undefined;
const hasCredit = (c: CreditCells): boolean => given(c.creditLimit) || given(c.paymentTermDays);

/**
 * Why the lead row's credit_limit / payment_term_days are NOT applied to the
 * customer, or null when they are (or the row carries none, or they only
 * restate what is on record).
 *
 * The import writes credit figures in two places only: on a NEW customer whose
 * row says CREDIT, and on the refresh lane while the customer is (or becomes)
 * CREDIT. Everywhere else the cells were dropped and nothing said so.
 */
export function creditReason(input: {
  lane: ImportLane;
  existing: {
    recordedCode: string | null;
    paymentTerms: string;
    creditLimit: unknown;
    paymentTermDays: unknown;
  } | null;
  lead: CreditCells & { paymentTerms: string; paymentTermsPresent?: boolean };
}): CreditReason | null {
  const { lane, existing, lead } = input;
  if (!hasCredit(lead)) return null;
  if (!existing) return lead.paymentTerms === 'CREDIT' ? null : 'NEW_NOT_CREDIT';
  // A figure that is already the stored one asks for nothing.
  const restates =
    (!given(lead.creditLimit) || sameStoredValue(lead.creditLimit, existing.creditLimit)) &&
    (!given(lead.paymentTermDays) || sameStoredValue(lead.paymentTermDays, existing.paymentTermDays));
  if (restates) return null;
  if (lane === 'fixed') return 'FIXED_ROW';
  if (lane === 'backup') return 'FIRST_CODE_ONLY';
  if (lane === 'refresh') {
    const effective = lead.paymentTermsPresent === true ? lead.paymentTerms : existing.paymentTerms;
    return effective === 'CREDIT' ? null : 'CUSTOMER_IS_CASH';
  }
  return existing.recordedCode ? 'ROW_CODE_BLANK' : 'NO_CODE_ON_RECORD';
}

/**
 * The reason for ONE row. The lead row has the group's reason. Another row of
 * the same customer either repeats the lead row's figures — then what happened
 * to the lead's happened to its — or carries its own, which are never read: the
 * customer's credit figures come from its first row (a fixed row loads only its
 * shop).
 */
export function rowCreditReason(input: {
  row: CreditCells;
  lead: CreditCells;
  isLead: boolean;
  /** This row is fixed in the app for a customer linked to Temix. */
  fixed: boolean;
  groupReason: CreditReason | null;
}): CreditReason | null {
  const { row, lead, isLead, fixed, groupReason } = input;
  if (isLead) return groupReason;
  if (!hasCredit(row)) return null;
  const own =
    (given(row.creditLimit) && row.creditLimit !== (lead.creditLimit ?? null)) ||
    (given(row.paymentTermDays) && row.paymentTermDays !== (lead.paymentTermDays ?? null));
  if (own) return fixed ? 'FIXED_ROW' : 'NOT_FIRST_ROW';
  return groupReason;
}

/** Each reason as the row's note and the summary word it (after "— "). */
export function creditReasonText(reason: CreditReason, leadRowNumber?: number | string): string {
  switch (reason) {
    case 'NO_CODE_ON_RECORD':
      return 'this customer has no Temix code on record, and credit figures are taken only from a row carrying the Temix code already recorded for the customer';
    case 'ROW_CODE_BLANK':
      return "the row's temix_code is blank; fill it with the customer's Temix code to refresh its credit figures";
    case 'CUSTOMER_IS_CASH':
      return 'the customer is CASH, and a credit limit and credit days apply only to a CREDIT customer';
    case 'NEW_NOT_CREDIT':
      return "the row's payment_terms is not CREDIT";
    case 'FIRST_CODE_ONLY':
      return "this row recorded the customer's first Temix code and nothing else; the next refresh applies the figures";
    case 'FIXED_ROW':
      return 'a row fixed in the app loads only its shop';
    case 'NOT_FIRST_ROW':
      return `a customer's credit figures are read from its first row in the file${leadRowNumber === undefined ? '' : ` (row ${leadRowNumber})`}`;
  }
}

/** The row's '_credit' note, or null. Names the cells the row gave, never their values. */
export function rowCreditNote(input: {
  row: CreditCells;
  lead: CreditCells;
  isLead: boolean;
  fixed: boolean;
  leadRowNumber: number | string;
  groupReason: CreditReason | null;
}): string | null {
  const reason = rowCreditReason(input);
  if (!reason) return null;
  const cells = [
    ...(given(input.row.creditLimit) ? ['credit_limit'] : []),
    ...(given(input.row.paymentTermDays) ? ['payment_term_days'] : []),
  ];
  const one = cells.length === 1;
  return `the ${cells.join(' and ')} in this row ${one ? 'was' : 'were'} not applied — ${creditReasonText(reason, input.leadRowNumber)}`;
}

// ── The "Before you promote" summary ────────────────────────────────────────
//
// Everything below runs the decisions above over a customer's staged rows and
// the records as they are NOW, and says what Promote would do. It writes
// nothing. It mirrors services/imports.ts in three places that file cannot
// share (a 'use server' module exports only actions): how a row's shop is
// resolved (summaryBranchOf), what the refresh lane writes (refreshWrite) and
// what the full lane writes on the customer (customerWrite). The parity cases in
// tests/unit/customer-import-service.test.ts run the real promote and this plan
// over the same scenarios and fail when they disagree.

/** The shortest address the database stores for a shop (services/imports.ts BRANCH_ADDRESS_MIN). */
export const SUMMARY_ADDRESS_MIN = 3;

const usableAddress = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length >= SUMMARY_ADDRESS_MIN ? s : null;
};

/** A staged row as the promote reads it (ImportRow.parsed). */
export type PlanRow = {
  custCode: string;
  custName: string;
  branchCode: string | null;
  branchName: string | null;
  regionCode: string | null;
  routeCode: string | null;
  address: string | null;
  phone: string | null;
  contactPerson: string | null;
  crNumber: string | null;
  paymentTerms: string;
  paymentTermsPresent?: boolean;
  temixCode?: string | null;
  creditLimit?: number | null;
  paymentTermDays?: number | null;
  channelKey?: string | null;
  dayOfVisit?: string | null;
  customerStatus?: string | null;
  fixedInApp?: boolean;
  /** Owner's answer 2026-11-11 (A5): released as a different shop by the Steward. */
  shopCodeReleased?: boolean;
};

/**
 * A row's shop, as the promote resolves it: its code composed under the
 * customer (or numbered by its position among the customer's rows), its route
 * when the code names one, and the address the row gives, made storable.
 */
export function summaryBranchOf(
  custCode: string,
  p: PlanRow,
  index: number,
  routeByCode: ReadonlyMap<string, { id: string; regionId: string }>
): LaneBranch {
  const route = p.routeCode ? (routeByCode.get(p.routeCode.toUpperCase()) ?? null) : null;
  const raw = p.branchCode ? p.branchCode.trim().toUpperCase() : null;
  const joined = usableAddress([p.address, p.branchName, p.regionCode].filter(Boolean).join(', '));
  return {
    sheetCode: raw,
    branchCode: raw ? composeBranchCode(custCode, raw) : formatBranchCode(custCode, index + 1),
    branchName: p.branchName ?? 'Main',
    // An unresolved route is never compared or counted: the promote parks a NEW
    // shop in UNASSIGNED and leaves an existing one where it is.
    regionId: route ? route.regionId : '',
    routeId: route ? route.id : '',
    address: usableAddress(p.address) ?? joined ?? ADDRESS_PLACEHOLDER,
    dayOfVisit: p.dayOfVisit ?? null,
    status: p.customerStatus ?? null,
    nameGiven: !!p.branchName,
    routeResolved: !!route,
    sheetAddress: p.address ? (usableAddress(p.address) ?? joined) : null,
    fixedInApp: p.fixedInApp === true,
  };
}

export type PlanCustomer = StoredCustomerCrm & {
  id: string;
  deletedAt: Date | null;
  temixCode: string | null;
  /** The code as a sheet spells it (lib/temix-code.ts normalizeTemixCode). */
  recordedCode: string | null;
  temixSyncState: string | null;
  lastTemixUploadAt: Date | null;
  paymentTerms: string;
  creditLimit: unknown;
  paymentTermDays: unknown;
  status: string;
  subChannelId?: string | null;
  /** The channel its stored sub-channel belongs to (F16). */
  subChannelChannelId?: string | null;
  /** How many live shops it has now. */
  liveBranches: number;
};

export type PlanShop = StoredBranchCrm & {
  customerId: string;
  deletedAt: Date | null;
  routeId: string;
  regionId: string;
};

/** Why a customer's rows are expected to be REJECTED at Promote. */
export const REJECT_REASONS = {
  ARCHIVED: 'the customer is archived in the CRM',
  OTHER_CODE: 'a different Temix code than the one on record',
  TERMS: 'payment terms that differ from the record',
  NEW_CREDIT: 'a new CREDIT customer with no temix_code',
  NO_BRANCH_CODE: 'no branch_code, for a customer that already has shops',
  REPEATED_CODE: 'a branch_code repeated in the file',
  FOREIGN_CODE: 'a branch_code that belongs to another customer',
  ARCHIVED_SHOP: 'a row fixed in the app that names an archived shop',
  // Code review 2026-11-10, finding 7.
  HELD_CODE: "a new customer code that is already another live customer's Temix code",
  // Owner's answer 2026-11-11 (A5).
  LOOKALIKE_CODE: "a branch_code that only looks like one of the customer's shops or rows (01 / 1, Ab / AB)",
} as const;
export type RejectReason = (typeof REJECT_REASONS)[keyof typeof REJECT_REASONS];

export type GroupPlan = {
  rows: number;
  /** Set: the whole customer is expected to be rejected, and nothing else below counts. */
  rejected: RejectReason | null;
  newCustomer: boolean;
  shopsCreated: number;
  /** A customer that is not ACTIVE gets a new open shop: it becomes ACTIVE (owner decision 7). */
  reopensCustomer: boolean;
  onRefresh: boolean;
  /** The refresh would change the Temix code, cash/credit, credit limit or credit days. */
  temixChanged: boolean;
  /**
   * Owner's answer 2026-11-11 ("A1 stop"): full-lane and fixed rows that name a
   * route other than their existing shop's. The route is NOT applied; the rest
   * of the row is, as its lane says. (A refresh-lane plain row that does is in
   * linkedRouteNotMoved instead: it changes nothing on the shop.)
   */
  routeNotApplied: number;
  customerFilled: boolean;
  shopsFilled: number;
  /** A CRM value on record differs from the sheet: kept, or replaced with the option on. */
  customerDiffers: boolean;
  shopsDiffer: number;
  shopsWouldReopen: number;
  shopsWouldClose: number;
  /** One label per differing field, customer and shops together (for the "name 120, phone 80" list). */
  fields: string[];
  /** Refresh-lane plain rows: shops that differ and are not changed, and shops not added. */
  linkedShops: number;
  linkedRouteNotMoved: number;
  linkedNotAdded: number;
  /** One reason per row whose credit cells are not applied. */
  credit: CreditReason[];
  /** The customer exists and the sheet says nothing the record does not. */
  unchanged: boolean;
  /** What Promote would write, for the parity cases: field names, never values. */
  writes: {
    customer: string[];
    shops: Array<{ branchCode: string; kind: 'create' | 'update'; fields: string[] }>;
  };
};

const emptyPlan = (rows: number): GroupPlan => ({
  rows,
  rejected: null,
  newCustomer: false,
  shopsCreated: 0,
  reopensCustomer: false,
  onRefresh: false,
  temixChanged: false,
  routeNotApplied: 0,
  customerFilled: false,
  shopsFilled: 0,
  customerDiffers: false,
  shopsDiffer: 0,
  shopsWouldReopen: 0,
  shopsWouldClose: 0,
  fields: [],
  linkedShops: 0,
  linkedRouteNotMoved: 0,
  linkedNotAdded: 0,
  credit: [],
  unchanged: false,
  writes: { customer: [], shops: [] },
});

/** What Promote would do with one customer's clean rows, given the records as they are now. */
export function planGroup(input: {
  custCode: string;
  overwrite: boolean;
  rows: readonly PlanRow[];
  existing: PlanCustomer | null;
  /** Shops by branch code: every composed code of the rows, and every code as the sheet gave it. */
  shopByCode: ReadonlyMap<string, PlanShop>;
  routeByCode: ReadonlyMap<string, { id: string; regionId: string }>;
  channelIdByKey: ReadonlyMap<string, string>;
  /**
   * Code review 2026-11-10, finding 7: the codes (as normalizeTemixCode spells
   * them) that are a live customer's Temix code. A NEW customer is not created
   * under one: the promote rejects it.
   */
  liveTemixCodes?: ReadonlySet<string>;
  /**
   * Owner's answer 2026-11-11 (A5): the codes of every shop the customer has
   * (archived ones too). A row whose branch_code only looks like one of them,
   * or like another of its rows, is rejected by the promote.
   */
  customerShops?: readonly string[];
}): GroupPlan {
  const { custCode, overwrite, rows, existing, shopByCode, routeByCode, channelIdByKey } = input;
  const plan = emptyPlan(rows.length);
  const reject = (reason: RejectReason): GroupPlan => ({ ...emptyPlan(rows.length), rejected: reason });
  if (rows.length === 0) return plan;

  const shops = rows.map((p, i) => summaryBranchOf(custCode, p, i, routeByCode));
  if (new Set(shops.map((s) => s.branchCode)).size !== shops.length) return reject(REJECT_REASONS.REPEATED_CODE);
  if (existing?.deletedAt) return reject(REJECT_REASONS.ARCHIVED);
  // As the promote, under the customer's lock (lib/import-shop-code.ts).
  if (
    groupShopLookalike(
      custCode,
      rows.map((p, i) => ({ branchCode: p.branchCode, shopCodeReleased: p.shopCodeReleased === true, rowNumber: i })),
      existing ? (input.customerShops ?? []) : []
    )
  ) {
    return reject(REJECT_REASONS.LOOKALIKE_CODE);
  }

  const lane = decideLane({
    custCode,
    existing: existing
      ? {
          archived: false,
          temixCode: existing.temixCode,
          recordedCode: existing.recordedCode,
          temixSyncState: existing.temixSyncState,
          lastTemixUploadAt: existing.lastTemixUploadAt,
        }
      : null,
    rows,
  });
  if (lane.crosswalkChange) return reject(REJECT_REASONS.OTHER_CODE);
  if (!existing && input.liveTemixCodes?.has(normalizeTemixCode(custCode))) return reject(REJECT_REASONS.HELD_CODE);
  const lead = rows[lane.leadIdx]!;
  const pt = lead.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH';
  // A backup-match candidate is counted as taking it: whether its finalize wrote
  // a CREATE audit row is not read here (the summary reads no audit log).
  const firstTemixCode = lane.backupCandidate;
  const { refreshLane, fullLane, laneOf } = lane.lanes(firstTemixCode);
  const fullIdx = fullLane ? lane.plainIdx : [];
  const laneIdx = rows.map((_, i) => i).filter((i) => !fullIdx.includes(i));
  const mine = (shop: PlanShop | undefined) => !!shop && !!existing && shop.customerId === existing.id;
  const crmFields = (c: CrmOutcome) => (overwrite ? c.replaced : c.kept);
  const countShop = (c: ReturnType<typeof branchCrmRule>) => {
    if (c.filled.length > 0) plan.shopsFilled += 1;
    if (crmFields(c).length > 0) {
      plan.shopsDiffer += 1;
      plan.fields.push(...crmFields(c));
    }
    if (c.statusChange?.to === 'ACTIVE') plan.shopsWouldReopen += 1;
    if (c.statusChange?.to === 'CLOSED') plan.shopsWouldClose += 1;
  };
  const newShop = (shop: LaneBranch) => {
    plan.shopsCreated += 1;
    plan.writes.shops.push({ branchCode: shop.branchCode, kind: 'create', fields: [] });
    if (existing && existing.status !== 'ACTIVE' && (shop.status ?? 'ACTIVE') === 'ACTIVE') plan.reopensCustomer = true;
  };
  // What Promote writes on a shop that exists: never a route (lib/import-shop-route.ts).
  const branchWrite = (r: LaneBranch): Record<string, unknown> => existingShopWrite(r);
  // Every route by its id, for the route a shop that exists keeps.
  const routeById: RouteById = new Map([...routeByCode.values()].map((r) => [r.id, r] as const));

  // In the promote's own order: a row with no branch_code on a customer that has
  // shops is refused before the lane writes anything.
  if (fullLane && existing && existing.liveBranches > 0 && fullIdx.some((i) => !shops[i]!.sheetCode)) {
    return reject(REJECT_REASONS.NO_BRANCH_CODE);
  }
  if (refreshLane) {
    plan.onRefresh = true;
    const ptPresent = lead.paymentTermsPresent === true;
    const effective = ptPresent ? pt : existing!.paymentTerms;
    const refreshWrite: Record<string, unknown> = firstTemixCode
      ? { temixCode: lead.temixCode }
      : {
          temixCode: lead.temixCode,
          paymentTerms: ptPresent ? pt : undefined,
          creditLimit: effective === 'CREDIT' ? (lead.creditLimit ?? undefined) : ptPresent ? null : undefined,
          paymentTermDays:
            effective === 'CREDIT' ? (lead.paymentTermDays ?? undefined) : ptPresent ? null : undefined,
        };
    plan.writes.customer = differingCells(refreshWrite, existing as unknown as Record<string, unknown>);
    plan.temixChanged = plan.writes.customer.length > 0;
  } else if (fullLane) {
    if (existing && lead.paymentTermsPresent && pt !== existing.paymentTerms) return reject(REJECT_REASONS.TERMS);
    if (!existing && pt === 'CREDIT' && !lead.temixCode) return reject(REJECT_REASONS.NEW_CREDIT);
    const groupChannelId = lead.channelKey ? (channelIdByKey.get(lead.channelKey.toUpperCase()) ?? null) : null;
    const crm = customerCrmRule(
      overwrite,
      {
        custName: lead.custName,
        phone: lead.phone ?? null,
        contactPerson: lead.contactPerson ?? null,
        crNumber: lead.crNumber ?? null,
        channelId: groupChannelId,
      },
      existing
    );
    if (!existing) {
      plan.newCustomer = true;
      plan.writes.customer = ['<create>'];
    } else {
      const fullRows = fullIdx.map((i) => rows[i]!);
      const sheetStatus = fullRows.some((p) => p.customerStatus === 'ACTIVE')
        ? 'ACTIVE'
        : (fullRows.find((p) => p.customerStatus)?.customerStatus ?? null);
      const statedStatus = overwrite ? sheetStatus : null;
      const customerWrite: Record<string, unknown> = {
        legalName: crm.sheet.custName,
        primaryPhone: crm.sheet.phone ?? undefined,
        primaryPhoneNorm: crm.sheet.phone ?? undefined,
        contactPerson: crm.sheet.contactPerson ?? undefined,
        crNumber: crm.sheet.crNumber ?? undefined,
        crNumberNorm: crm.sheet.crNumber ? normalizeCR(crm.sheet.crNumber) : undefined,
        channelId: crm.sheet.channelId ?? undefined,
        // F16: a channel change clears a sub-channel of the old channel.
        subChannelId: subChannelClearedByChannelChange(
          {
            channelId: existing.channelId ?? null,
            subChannelId: existing.subChannelId ?? null,
            subChannelChannelId: existing.subChannelChannelId ?? null,
          },
          crm.sheet.channelId
        )
          ? null
          : undefined,
        status: statedStatus === 'ACTIVE' ? 'ACTIVE' : undefined,
      };
      plan.writes.customer = differingCells(customerWrite, existing as unknown as Record<string, unknown>).filter(
        (f) => f !== 'status'
      );
      plan.customerFilled = crm.filled.length > 0;
      const labels = [...crmFields(crm)];
      // The customer's own status, when no shop row of the file carries the difference.
      const shopStatus = fullIdx.some((i) => {
        const stored = shopByCode.get(shops[i]!.branchCode);
        return !!stored && !!shops[i]!.status && shops[i]!.status !== stored.status;
      });
      const opensNew = fullIdx.some((i) => !shopByCode.get(shops[i]!.branchCode) && (shops[i]!.status ?? 'ACTIVE') === 'ACTIVE');
      if (sheetStatus && sheetStatus !== existing.status && !shopStatus && !(opensNew && existing.status !== 'ACTIVE')) {
        labels.push('status');
      }
      plan.customerDiffers = labels.length > 0;
      plan.fields.push(...labels);
    }
    for (const i of fullIdx) {
      const shop = shops[i]!;
      const stored = shopByCode.get(shop.branchCode);
      if (stored && !mine(stored)) return reject(REJECT_REASONS.FOREIGN_CODE);
      if (shop.sheetCode && shop.sheetCode !== shop.branchCode) {
        const raw = shopByCode.get(shop.sheetCode);
        if (raw && !mine(raw)) return reject(REJECT_REASONS.FOREIGN_CODE);
      }
      if (!stored) {
        newShop(shop);
        continue;
      }
      // As the promote: the shop keeps its route; one the row names that differs is counted.
      const held = holdShopRoute(shop, stored, routeById);
      if (held.notApplied) plan.routeNotApplied += 1;
      const rule = branchCrmRule(overwrite, held.row, stored);
      countShop(rule);
      const differs = differingBranchCells(rule.row, stored);
      if (differs.length > 0) {
        plan.writes.shops.push({
          branchCode: shop.branchCode,
          kind: 'update',
          fields: differingCells(branchWrite(rule.row), stored as unknown as Record<string, unknown>),
        });
      }
    }
  }

  // The fixed rows, and the plain rows of the refresh lane: their own shop only.
  for (const i of laneIdx) {
    const shop = shops[i]!;
    const fixed = shop.fixedInApp;
    if (!shop.sheetCode) {
      if (fixed) return reject(REJECT_REASONS.NO_BRANCH_CODE);
      continue;
    }
    if (fixed && shop.sheetCode !== shop.branchCode) {
      const raw = shopByCode.get(shop.sheetCode);
      if (raw && !mine(raw)) return reject(REJECT_REASONS.FOREIGN_CODE);
    }
    const stored = shopByCode.get(shop.branchCode);
    if (!stored) {
      if (fixed) newShop(shop);
      else plan.linkedNotAdded += 1;
      continue;
    }
    if (!mine(stored)) {
      if (fixed) return reject(REJECT_REASONS.FOREIGN_CODE);
      continue;
    }
    if (stored.deletedAt) {
      if (fixed) return reject(REJECT_REASONS.ARCHIVED_SHOP);
      continue;
    }
    const differs = differingBranchCells(shop, { ...stored, regionId: undefined });
    if (differs.length === 0) continue;
    if (!fixed) {
      plan.linkedShops += 1;
      if (differs.includes('route')) plan.linkedRouteNotMoved += 1;
      continue;
    }
    // As the promote's fixed lane: the shop keeps its route (lib/import-shop-route.ts).
    const held = holdShopRoute(shop, stored, routeById);
    if (held.notApplied) plan.routeNotApplied += 1;
    if (differingBranchCells(held.row, { ...stored, regionId: undefined }).length === 0) continue;
    const rule = branchCrmRule(overwrite, held.row, stored);
    countShop(rule);
    const written = differingBranchCells(rule.row, { ...stored, regionId: undefined });
    if (written.length > 0) {
      plan.writes.shops.push({
        branchCode: shop.branchCode,
        kind: 'update',
        fields: differingCells(branchWrite(rule.row), stored as unknown as Record<string, unknown>),
      });
    }
  }

  const groupReason = creditReason({
    lane: laneOf(lane.leadIdx),
    existing: existing
      ? {
          recordedCode: existing.recordedCode,
          paymentTerms: existing.paymentTerms,
          creditLimit: existing.creditLimit,
          paymentTermDays: existing.paymentTermDays,
        }
      : null,
    lead,
  });
  rows.forEach((p, i) => {
    const reason = rowCreditReason({
      row: p,
      lead,
      isLead: i === lane.leadIdx,
      fixed: lane.isFixed[i] === true,
      groupReason,
    });
    if (reason) plan.credit.push(reason);
  });

  plan.unchanged =
    !!existing &&
    plan.writes.customer.length === 0 &&
    plan.writes.shops.length === 0 &&
    !plan.customerDiffers &&
    plan.shopsDiffer === 0 &&
    plan.linkedShops === 0 &&
    plan.linkedNotAdded === 0 &&
    plan.routeNotApplied === 0 &&
    plan.credit.length === 0;
  return plan;
}

/** What the Steward is shown before Promote: counts only, no names and no values. */
export type PromoteSummary = {
  rows: number;
  customers: number;
  created: { customers: number; shops: number; shopsOnExisting: number; closedCustomersReopened: number };
  temix: { customersOnRefresh: number; customersChanged: number };
  /** Owner's answer 2026-11-11: rows naming another route for a shop that exists (GroupPlan.routeNotApplied). */
  routeNotApplied: number;
  /** Owner's answer 2026-11-11 (A5): clean rows whose customer or Temix code was read in capital letters. */
  codesCapitalised: number;
  crm: {
    customersFilled: number;
    shopsFilled: number;
    /** Full lane and fixed rows: kept by default, replaced with the option on. */
    customersDiffer: number;
    shopsDiffer: number;
    shopsWouldReopen: number;
    shopsWouldClose: number;
    byField: Array<{ field: string; count: number }>;
    /** Refresh lane: never changed by a sheet, with the option on or off. */
    linkedCustomers: number;
    linkedShops: number;
    linkedRouteNotMoved: number;
    linkedNotAdded: number;
  };
  credit: { rows: number; reasons: Array<{ reason: CreditReason; rows: number }> };
  expectRejected: { customers: number; rows: number; reasons: Array<{ reason: string; customers: number }> };
  unchangedCustomers: number;
};

export function emptySummary(): PromoteSummary {
  return {
    rows: 0,
    customers: 0,
    created: { customers: 0, shops: 0, shopsOnExisting: 0, closedCustomersReopened: 0 },
    temix: { customersOnRefresh: 0, customersChanged: 0 },
    routeNotApplied: 0,
    codesCapitalised: 0,
    crm: {
      customersFilled: 0,
      shopsFilled: 0,
      customersDiffer: 0,
      shopsDiffer: 0,
      shopsWouldReopen: 0,
      shopsWouldClose: 0,
      byField: [],
      linkedCustomers: 0,
      linkedShops: 0,
      linkedRouteNotMoved: 0,
      linkedNotAdded: 0,
    },
    credit: { rows: 0, reasons: [] },
    expectRejected: { customers: 0, rows: 0, reasons: [] },
    unchangedCustomers: 0,
  };
}

function tally<T extends { [k: string]: string | number }>(list: T[], isIt: (x: T) => boolean, fresh: T, count: keyof T) {
  const hit = list.find(isIt);
  if (hit) (hit[count] as number) += 1;
  else list.push(fresh);
}

/** Add one customer's plan to the running summary (mutates and returns it). */
export function addGroup(s: PromoteSummary, plan: GroupPlan): PromoteSummary {
  s.rows += plan.rows;
  s.customers += 1;
  if (plan.rejected) {
    s.expectRejected.customers += 1;
    s.expectRejected.rows += plan.rows;
    const reason = plan.rejected;
    tally(s.expectRejected.reasons, (x) => x.reason === reason, { reason, customers: 1 }, 'customers');
    return s;
  }
  if (plan.newCustomer) s.created.customers += 1;
  s.created.shops += plan.shopsCreated;
  if (!plan.newCustomer) s.created.shopsOnExisting += plan.shopsCreated;
  if (plan.reopensCustomer) s.created.closedCustomersReopened += 1;
  if (plan.onRefresh) s.temix.customersOnRefresh += 1;
  if (plan.temixChanged) s.temix.customersChanged += 1;
  s.routeNotApplied += plan.routeNotApplied;
  if (plan.customerFilled) s.crm.customersFilled += 1;
  s.crm.shopsFilled += plan.shopsFilled;
  if (plan.customerDiffers) s.crm.customersDiffer += 1;
  s.crm.shopsDiffer += plan.shopsDiffer;
  s.crm.shopsWouldReopen += plan.shopsWouldReopen;
  s.crm.shopsWouldClose += plan.shopsWouldClose;
  for (const field of plan.fields) tally(s.crm.byField, (x) => x.field === field, { field, count: 1 }, 'count');
  if (plan.linkedShops > 0 || plan.linkedNotAdded > 0) s.crm.linkedCustomers += 1;
  s.crm.linkedShops += plan.linkedShops;
  s.crm.linkedRouteNotMoved += plan.linkedRouteNotMoved;
  s.crm.linkedNotAdded += plan.linkedNotAdded;
  s.credit.rows += plan.credit.length;
  for (const reason of plan.credit) tally(s.credit.reasons, (x) => x.reason === reason, { reason, rows: 1 }, 'rows');
  if (plan.unchanged) s.unchangedCustomers += 1;
  return s;
}

export type SummaryLine = { tone: 'plain' | 'warn' | 'danger'; text: string };

const n = (x: number) => x.toLocaleString('en-US');

/**
 * The summary as the dialog shows it, one sentence a line. A line is left out
 * when it has nothing to count, except the first and the last. English only.
 */
export function summaryLines(s: PromoteSummary, overwrite: boolean): SummaryLine[] {
  const lines: SummaryLine[] = [
    {
      tone: 'plain',
      text: `Checked ${n(s.rows)} clean row${s.rows === 1 ? '' : 's'} for ${n(s.customers)} customer${s.customers === 1 ? '' : 's'} against the CRM as it is now.`,
    },
  ];
  if (s.created.customers + s.created.shops > 0) {
    lines.push({
      tone: 'plain',
      text: `New: ${n(s.created.customers)} customer(s) and ${n(s.created.shops)} shop(s) will be created (${n(s.created.shopsOnExisting)} of the shops on customers already in the CRM).`,
    });
  }
  // Owner's answer 2026-11-11 ("A1 stop"): no shop moves to the route in the
  // sheet any more; the line said how many would.
  if (s.temix.customersChanged > 0) {
    lines.push({
      tone: 'plain',
      text: `Temix-owned fields: ${n(s.temix.customersChanged)} customer(s) will have their Temix code, cash/credit, credit limit or credit days refreshed.`,
    });
  }
  if (s.routeNotApplied > 0) {
    lines.push({
      tone: 'warn',
      text: `Route NOT applied: ${n(s.routeNotApplied)} row(s) name a route other than the current route of their shop, which is already in the CRM. The rest of each row loads as the lines here say; the route does not. ${ROUTE_NOT_APPLIED}`,
    });
  }
  if (s.codesCapitalised > 0) {
    lines.push({
      tone: 'plain',
      text: `Codes in capitals: ${n(s.codesCapitalised)} row(s) have a customer code or Temix code typed in small letters. They are read in capital letters (cct0005 is CCT0005), so they load as that customer; each row says so.`,
    });
  }
  if (s.crm.customersFilled + s.crm.shopsFilled > 0) {
    lines.push({
      tone: 'plain',
      text: `Blank CRM fields filled: ${n(s.crm.customersFilled)} customer(s), ${n(s.crm.shopsFilled)} shop(s).`,
    });
  }
  if (s.crm.customersDiffer + s.crm.shopsDiffer > 0) {
    const fields = [...s.crm.byField]
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field))
      .map((f) => `${f.field} ${n(f.count)}`)
      .join(', ');
    const moves = s.crm.shopsWouldReopen + s.crm.shopsWouldClose > 0;
    lines.push(
      overwrite
        ? {
            tone: 'danger',
            text: `CRM fields REPLACED: on ${n(s.crm.customersDiffer)} customer(s) and ${n(s.crm.shopsDiffer)} shop(s) the values on record will be replaced by this sheet's (${fields}).${moves ? ` ${n(s.crm.shopsWouldReopen)} closed shop(s) will be reopened and ${n(s.crm.shopsWouldClose)} open shop(s) closed.` : ''}`,
          }
        : {
            tone: 'warn',
            text: `CRM fields kept: on ${n(s.crm.customersDiffer)} customer(s) and ${n(s.crm.shopsDiffer)} shop(s) the sheet differs from the record. Their values stay as they are on record (${fields}).${moves ? ` The sheet would have reopened ${n(s.crm.shopsWouldReopen)} closed shop(s) and closed ${n(s.crm.shopsWouldClose)} open shop(s); they stay as they are.` : ''}`,
          }
    );
  }
  if (s.crm.linkedShops + s.crm.linkedNotAdded > 0) {
    lines.push({
      tone: 'warn',
      // Code review 2026-11-10, finding 28: the route said plainly, and what
      // happens to a route instead (ROUTE_NOT_APPLIED, second round).
      text: `Loaded, shop NOT changed: ${n(s.crm.linkedShops)} shop(s) of ${n(s.crm.linkedCustomers)} customer(s) differ from the record and are not changed by a row that carries the customer's Temix code (${n(s.crm.linkedRouteNotMoved)} of them a different route, and that route is NOT applied)${s.crm.linkedNotAdded > 0 ? `; ${n(s.crm.linkedNotAdded)} shop(s) in the sheet are not in the CRM and are not added` : ''}.${s.crm.linkedRouteNotMoved > 0 ? ` ${ROUTE_NOT_APPLIED}` : ''}`,
    });
  }
  if (s.credit.rows > 0) {
    const reasons = [...s.credit.reasons]
      .sort((a, b) => b.rows - a.rows || a.reason.localeCompare(b.reason))
      .map((r) => `${n(r.rows)}: ${creditReasonText(r.reason)}`)
      .join('; ');
    lines.push({ tone: 'warn', text: `Credit cells not applied: ${n(s.credit.rows)} row(s) — ${reasons}.` });
  }
  if (s.created.closedCustomersReopened > 0) {
    lines.push({
      tone: 'warn',
      text: `Closed customers reopened by a new open shop: ${n(s.created.closedCustomersReopened)}.`,
    });
  }
  if (s.expectRejected.customers > 0) {
    const reasons = [...s.expectRejected.reasons]
      .sort((a, b) => b.customers - a.customers || a.reason.localeCompare(b.reason))
      .map((r) => `${r.reason}: ${n(r.customers)}`)
      .join('; ');
    lines.push({
      tone: 'warn',
      text: `Expected to be rejected at Promote: ${n(s.expectRejected.rows)} row(s) of ${n(s.expectRejected.customers)} customer(s) (${reasons}). Each row will say why.`,
    });
  }
  if (s.unchangedCustomers > 0) {
    lines.push({
      tone: 'plain',
      text: `No change: ${n(s.unchangedCustomers)} customer(s) are already as the sheet says.`,
    });
  }
  lines.push({
    tone: 'plain',
    text: 'This is a check, not a lock: Promote works from the CRM as it is at that moment.',
  });
  return lines;
}
