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
 *             exists, fills blank CRM fields and moves a shop to the sheet's route
 *             (lib/import-crm-rule.ts).
 */
import type { ImportLane } from './change-context';
import { APP_CUSTOMER_CODE } from './codes';
import { sameStoredValue } from './import-lineage';

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
