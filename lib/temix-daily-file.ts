/**
 * The daily Temix import, stage 3: what an uploaded daily file's headings and
 * rows are read as, before anything is staged. Nothing here decides what the
 * file does to a customer: matching, holds, routes and the apply come in later
 * stages, and every rule the owner has not given is left out (see below).
 *
 * HEADINGS. The agreed columns of the daily export (the plan's file handling):
 *   required  cust_code, branch_code, cust_name, route, payment_terms,
 *             credit_limit, payment_term_days, status, created_date
 *   optional  cr_no, phone, address
 * A heading is matched after folding it as the Import screen does
 * (lib/import-headings.ts foldHeading: capitals, spaces and underscores do not
 * matter). A missing required heading refuses the file, naming it. A column
 * under two spellings refuses it (the import could not say which it read).
 * Headings that are not agreed are listed, not read: their names are kept on
 * the file, their cells are not kept anywhere. A heading only the
 * customer master has (channel, day_of_visit, customer_status, temix_code,
 * sales_region) refuses the file: that is a customer master, and it is loaded
 * on the Import screen, never here.
 *
 * ROWS. Each row is kept as sent (raw: the cells of the agreed columns only)
 * and as read (parsed):
 *  - cust_code: folded like a Temix code (lib/temix-code.ts normalizeTemixCode:
 *    ASCII digits, invisible characters removed, trimmed, capitals) into the
 *    row's custCodeKey; a code typed in small letters is noted as such.
 *  - branch_code: the same fold into branchCodeKey, blank when blank. Which row
 *    is the customer's main account is NOT decided here (isMainRow stays null:
 *    the owner has not said how the file marks it). The Import screen's
 *    look-alike rule (lib/import-shop-code.ts shopLookalike) is reused on the
 *    codes AS WRITTEN among the customer's rows in this file: two codes that
 *    differ only in their zeros or only in capital and small letters are noted.
 *    Two rows naming one shop are found by the shop code each names composed
 *    under its customer (rowShopCode) in capitals, so "01" and "C1-01" name the
 *    same shop. Written apart only in capitals ("C1-01" and "c1-01", "C1" and
 *    "c1") they are a case-only SHOP_CODE_LOOKALIKE, held as the Import screen
 *    holds one; otherwise (the same code twice, two blanks, "01" beside
 *    "C1-01") a DUPLICATE_ROW.
 *    The comparison with the customer's shops in the CRM is the Check's job.
 *  - route: folded the same way; it is not looked up here.
 *  - payment_terms: kept as written, trimmed and in capitals. It is NOT checked
 *    against a list: the owner has not said which words Temix writes.
 *  - credit_limit, payment_term_days: read by the Import screen's number rules
 *    (lib/import-row-check.ts): a non-negative number up to 99,999,999,999,
 *    kept to 3 decimals; whole days 0 to 365. Nothing is applied from them.
 *  - status: A or I. What A or I means in the CRM is NOT decided here.
 *  - created_date: kept in parsed only, as a day when it is an ISO date
 *    (YYYY-MM-DD) or a date cell; other spellings are noted, never guessed
 *    (03/04 is March or April).
 *  - cr_no, phone, address: kept as written, trimmed.
 *
 * NOTES. What is wrong with a row on its face is noted with a code word
 * (TEMIX_DAILY_UPLOAD_NOTES), stored as the row's holdReasons while its outcome
 * stays PENDING. A note is not a decision: the Check stage reads them with the
 * CRM and decides each row's outcome.
 *
 * PURE: no database; scripts and tests use it as is.
 */
import { foldHeading } from './import-headings';
import { rowShopCode, shopLookalike, type SiblingShop } from './import-shop-code';
import { INVISIBLE_FORMAT, asciiDigits } from './digits';
import { normalizeTemixCode } from './temix-code';

/** The headings a daily file must have. */
export const TEMIX_DAILY_REQUIRED = [
  'cust_code',
  'branch_code',
  'cust_name',
  'route',
  'payment_terms',
  'credit_limit',
  'payment_term_days',
  'status',
  'created_date',
] as const;

/** The headings a daily file may have. */
export const TEMIX_DAILY_OPTIONAL = ['cr_no', 'phone', 'address'] as const;

export const TEMIX_DAILY_COLUMNS = [...TEMIX_DAILY_REQUIRED, ...TEMIX_DAILY_OPTIONAL] as const;
export type TemixDailyColumn = (typeof TEMIX_DAILY_COLUMNS)[number];

/**
 * Headings only the customer master has (lib/import-headings.ts CUSTOMER_COLUMNS):
 * a file carrying one is a customer master and belongs on the Import screen.
 */
export const CUSTOMER_MASTER_ONLY_HEADINGS = [
  'channel',
  'day_of_visit',
  'customer_status',
  'temix_code',
  'sales_region',
] as const;

/**
 * What a row may be noted with at upload (stored in TemixDailyRow.holdReasons,
 * code words only: TemixDailyRow_hold_reasons_check). Not a decision: the Check
 * stage decides each row's outcome.
 */
export const TEMIX_DAILY_UPLOAD_NOTES = [
  // No customer code: nothing can be matched.
  'CUST_CODE_MISSING',
  // The same customer and shop code (or two blank shop codes) on more than one row.
  'DUPLICATE_ROW',
  // The shop code looks like another of the customer's rows' (zeros or capitals differ).
  'SHOP_CODE_LOOKALIKE',
  // The route cell is blank.
  'ROUTE_MISSING',
  // The status is not A or I (or is blank).
  'STATUS_NOT_A_OR_I',
  // credit_limit is not a non-negative number.
  'CREDIT_LIMIT_NOT_A_NUMBER',
  // payment_term_days is not whole days 0 to 365.
  'CREDIT_DAYS_NOT_WHOLE_DAYS',
  // created_date is written in a way that is not read as a day.
  'CREATED_DATE_UNREADABLE',
  // A cell holds a spreadsheet error (#N/A, #REF! ...).
  'CELL_ERROR',
] as const;
export type TemixDailyUploadNote = (typeof TEMIX_DAILY_UPLOAD_NOTES)[number];

/** The note's meaning, for the Steward. */
export const TEMIX_DAILY_NOTE_LABEL: Record<TemixDailyUploadNote, string> = {
  CUST_CODE_MISSING: 'no customer code',
  DUPLICATE_ROW: 'the same customer and shop code on more than one row',
  SHOP_CODE_LOOKALIKE: 'a shop code that looks like another of the same customer (zeros or capitals differ)',
  ROUTE_MISSING: 'no route',
  STATUS_NOT_A_OR_I: 'status is not A or I',
  CREDIT_LIMIT_NOT_A_NUMBER: 'credit limit is not a number',
  CREDIT_DAYS_NOT_WHOLE_DAYS: 'credit days are not whole days 0 to 365',
  CREATED_DATE_UNREADABLE: 'created date is not a date the CRM reads (YYYY-MM-DD)',
  CELL_ERROR: 'a cell holds a spreadsheet error',
};

// ── Headings ──────────────────────────────────────────────────────────────

const COLUMN_OF_FOLD = new Map<string, TemixDailyColumn>(TEMIX_DAILY_COLUMNS.map((c) => [foldHeading(c), c]));
const MASTER_FOLDS = new Set<string>(CUSTOMER_MASTER_ONLY_HEADINGS.map((c) => foldHeading(c)));

export type DailyHeadingReport = {
  /** Column -> the file's heading read as it. */
  read: Partial<Record<TemixDailyColumn, string>>;
  /** Required columns with no heading. */
  missing: TemixDailyColumn[];
  /** Headings only a customer master has. */
  master: string[];
  /** Headings that are not read, in file order. */
  notRead: string[];
  /** One column under two spellings. */
  clashes: Array<{ column: TemixDailyColumn; headings: string[] }>;
};

/** What the daily import makes of a file's headings. */
export function reportDailyHeadings(headers: readonly string[]): DailyHeadingReport {
  const seen = new Map<TemixDailyColumn, string[]>();
  const master: string[] = [];
  const notRead: string[] = [];
  for (const h of headers) {
    const f = foldHeading(h);
    const column = f ? COLUMN_OF_FOLD.get(f) : undefined;
    if (column) {
      seen.set(column, [...(seen.get(column) ?? []), h]);
      continue;
    }
    if (f && MASTER_FOLDS.has(f)) master.push(h);
    else notRead.push(h);
  }
  const read: DailyHeadingReport['read'] = {};
  for (const [c, hs] of seen) read[c] = hs[0];
  return {
    read,
    missing: TEMIX_DAILY_REQUIRED.filter((c) => !seen.has(c)),
    master,
    notRead,
    clashes: [...seen].filter(([, hs]) => hs.length > 1).map(([column, headings]) => ({ column, headings })),
  };
}

const quoted = (list: readonly string[]) => list.map((h) => `"${h}"`).join(', ');

/** Why the file is refused for its headings, or null when it may be staged. */
export function dailyHeadingRefusal(report: DailyHeadingReport): string | null {
  if (report.master.length > 0) {
    return `This is a customer master, not the Temix daily file: it has the column${report.master.length === 1 ? '' : 's'} ${quoted(report.master)}, which only the customer master has. Load a customer master on the Import screen. Nothing was uploaded.`;
  }
  const clash = report.clashes[0];
  if (clash) {
    return `The headings ${quoted(clash.headings)} are all read as the ${clash.column} column. Keep one, or rename the other. Nothing was uploaded.`;
  }
  if (report.missing.length > 0) {
    const one = report.missing.length === 1;
    return `The file has no ${report.missing.join(', ')} column${one ? '' : 's'}. The Temix daily file has the columns ${TEMIX_DAILY_REQUIRED.join(', ')} (and may have ${TEMIX_DAILY_OPTIONAL.join(', ')}). Nothing was uploaded.`;
  }
  return null;
}

// ── Rows ──────────────────────────────────────────────────────────────────

export type DailyCell = string | number | null;
export type DailySheetRow = Record<string, DailyCell>;

/** A row as staged: the codes it is found by, what it reads as, and its notes. */
export type StagedDailyRow = {
  rowNumber: number;
  raw: DailySheetRow;
  parsed: DailyParsed;
  custCodeKey: string | null;
  branchCodeKey: string | null;
  notes: TemixDailyUploadNote[];
};

export type DailyParsed = {
  custCode: string | null;
  /** The shop code as written (ASCII digits, trimmed; its letters kept). */
  branchCodeWritten: string | null;
  branchCode: string | null;
  custName: string | null;
  route: string | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  paymentTermDays: number | null;
  status: 'A' | 'I' | null;
  createdDate: { written: string; day: string | null } | null;
  crNo: string | null;
  phone: string | null;
  address: string | null;
  /** Codes whose small letters were read as capitals. */
  capitalised: Array<{ cell: 'cust_code' | 'branch_code' | 'route'; from: string; to: string }>;
  /** The other row whose shop code this one looks like. */
  shopLookalike?: { other: string; row: number; caseOnly: boolean };
};

const text = (v: DailyCell | undefined): string => (v == null ? '' : String(v));

/** A code cell as written, with ASCII digits and no invisible characters; its letters kept. */
export function writtenCode(v: DailyCell | undefined): string {
  return asciiDigits(text(v)).replace(INVISIBLE_FORMAT, '').trim();
}

/** A code cell as the daily import compares it (normalizeTemixCode); null when blank. */
export function codeKey(v: DailyCell | undefined): string | null {
  return normalizeTemixCode(text(v)) || null;
}

const MONEY_MAX = 99_999_999_999;

/** credit_limit by the Import screen's rule; undefined when it is not a number. */
export function readCreditLimit(v: DailyCell | undefined): number | null | undefined {
  const s = text(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > MONEY_MAX) return undefined;
  return Math.round(n * 1000) / 1000;
}

/** payment_term_days by the Import screen's rule; undefined when it is not whole days 0-365. */
export function readCreditDays(v: DailyCell | undefined): number | null | undefined {
  const s = text(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 365) return undefined;
  return n;
}

/** status: 'A' or 'I' (any capitals, trimmed); undefined for anything else, blank included. */
export function readStatus(v: DailyCell | undefined): 'A' | 'I' | undefined {
  const s = text(v).trim().toUpperCase();
  return s === 'A' || s === 'I' ? s : undefined;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * created_date as a day 'YYYY-MM-DD', or null when it is written another way.
 * A date cell reaches here as an ISO instant (lib/excel.ts), a typed date as its
 * text; only the ISO form is read, so 03/04/2026 is never guessed.
 */
export function readCreatedDay(v: DailyCell | undefined): string | null {
  const m = ISO_DAY.exec(text(v).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * The words a spreadsheet writes for a formula's error. The workbook reader
 * marks an error cell '#ERROR:<word>' (lib/excel.ts); a CSV saved from a
 * spreadsheet carries the bare word, so both are read as a cell error.
 */
export const SHEET_ERROR_WORDS = ['#N/A', '#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!', '#SPILL!', '#CALC!', '#GETTING_DATA'] as const;
const SHEET_ERRORS = new Set<string>(SHEET_ERROR_WORDS);

export const isCellError = (v: DailyCell | undefined) =>
  typeof v === 'string' && (v.startsWith('#ERROR:') || SHEET_ERRORS.has(v.trim().toUpperCase()));

const plain = (v: DailyCell | undefined): string | null => {
  const s = text(v).trim();
  return s ? s : null;
};

/**
 * Every row of the sheet as it is staged. `report` must be a report with no
 * refusal (dailyHeadingRefusal null). Rows keep the sheet's own numbers.
 */
export function stageDailyRows(
  sheet: { rows: readonly DailySheetRow[]; rowNumbers: readonly number[] },
  report: DailyHeadingReport
): StagedDailyRow[] {
  const cell = (row: DailySheetRow, c: TemixDailyColumn): DailyCell | undefined => {
    const h = report.read[c];
    return h === undefined ? undefined : row[h];
  };
  // The file's headings of the agreed columns: only their cells are kept.
  const readHeadings = Object.values(report.read).filter((h): h is string => h !== undefined);
  const staged: StagedDailyRow[] = sheet.rows.map((row, i) => {
    const raw: DailySheetRow = {};
    for (const h of readHeadings) raw[h] = row[h] ?? null;
    const notes = new Set<TemixDailyUploadNote>();
    const capitalised: DailyParsed['capitalised'] = [];
    const custWritten = writtenCode(cell(row, 'cust_code'));
    const custCodeKey = codeKey(cell(row, 'cust_code'));
    if (!custCodeKey) notes.add('CUST_CODE_MISSING');
    else if (custWritten !== custCodeKey) capitalised.push({ cell: 'cust_code', from: custWritten, to: custCodeKey });
    const branchWritten = writtenCode(cell(row, 'branch_code'));
    const branchCodeKey = codeKey(cell(row, 'branch_code'));
    if (branchCodeKey && branchWritten !== branchCodeKey)
      capitalised.push({ cell: 'branch_code', from: branchWritten, to: branchCodeKey });
    const routeWritten = writtenCode(cell(row, 'route'));
    const route = codeKey(cell(row, 'route'));
    if (!route) notes.add('ROUTE_MISSING');
    else if (routeWritten !== route) capitalised.push({ cell: 'route', from: routeWritten, to: route });
    const creditLimit = readCreditLimit(cell(row, 'credit_limit'));
    if (creditLimit === undefined) notes.add('CREDIT_LIMIT_NOT_A_NUMBER');
    const paymentTermDays = readCreditDays(cell(row, 'payment_term_days'));
    if (paymentTermDays === undefined) notes.add('CREDIT_DAYS_NOT_WHOLE_DAYS');
    const status = readStatus(cell(row, 'status'));
    if (status === undefined) notes.add('STATUS_NOT_A_OR_I');
    const createdWritten = plain(cell(row, 'created_date'));
    const createdDay = createdWritten ? readCreatedDay(createdWritten) : null;
    if (createdWritten && !createdDay) notes.add('CREATED_DATE_UNREADABLE');
    if (Object.values(raw).some(isCellError)) notes.add('CELL_ERROR');
    const terms = plain(cell(row, 'payment_terms'));
    return {
      rowNumber: sheet.rowNumbers[i]!,
      raw,
      custCodeKey,
      branchCodeKey,
      notes: [...notes],
      parsed: {
        custCode: custCodeKey,
        branchCodeWritten: branchWritten || null,
        branchCode: branchCodeKey,
        custName: plain(cell(row, 'cust_name')),
        route,
        paymentTerms: terms ? terms.toUpperCase() : null,
        creditLimit: creditLimit ?? null,
        paymentTermDays: paymentTermDays ?? null,
        status: status ?? null,
        createdDate: createdWritten ? { written: createdWritten, day: createdDay } : null,
        crNo: plain(cell(row, 'cr_no')),
        phone: plain(cell(row, 'phone')),
        address: plain(cell(row, 'address')),
        capitalised,
      },
    };
  });

  // Among each customer's rows in this file: the same shop twice, or a shop code
  // that only looks like another's (the Import screen's rule, codes as written).
  const byCustomer = new Map<string, StagedDailyRow[]>();
  for (const r of staged) {
    if (!r.custCodeKey) continue;
    byCustomer.set(r.custCodeKey, [...(byCustomer.get(r.custCodeKey) ?? []), r]);
  }
  for (const [cust, rows] of byCustomer) {
    if (rows.length < 2) continue;
    // The shop a row names: its code composed under the customer as the promote
    // composes it, letters kept ('' for a blank code). Two rows whose composed
    // codes are equal in capitals name one shop.
    const shopOf = (r: StagedDailyRow) => (r.parsed.branchCodeWritten ? rowShopCode(cust, r.parsed.branchCodeWritten) : '');
    const byShop = new Map<string, StagedDailyRow[]>();
    for (const r of rows) {
      const k = shopOf(r).toUpperCase();
      byShop.set(k, [...(byShop.get(k) ?? []), r]);
    }
    const written = (r: StagedDailyRow) => r.parsed.branchCodeWritten ?? '';
    // Two codes of one shop written apart ONLY in capitals ("C1-01" and "c1-01",
    // "C1" and "c1"). Every other pair naming one shop (the same code twice, two
    // blanks, "01" beside "C1-01") is a duplicate row.
    const caseOnlyPair = (a: StagedDailyRow, b: StagedDailyRow) =>
      written(a) !== written(b) && written(a).toUpperCase() === written(b).toUpperCase();
    for (const r of rows) {
      const mine = r.parsed.branchCodeWritten;
      const mates = byShop.get(shopOf(r).toUpperCase())!.filter((o) => o !== r);
      if (mates.some((o) => !caseOnlyPair(r, o))) addNote(r, 'DUPLICATE_ROW');
      if (!mine) continue;
      const siblings: SiblingShop[] = rows
        .filter((o) => o !== r && o.parsed.branchCodeWritten)
        .map((o) => ({ row: o.rowNumber, code: o.parsed.branchCodeWritten! }));
      const hit = shopLookalike(cust, mine, [], siblings);
      if (hit && hit.kind === 'row') {
        addNote(r, 'SHOP_CODE_LOOKALIKE');
        r.parsed.shopLookalike = { other: hit.other, row: Number(hit.row), caseOnly: hit.caseOnly };
        continue;
      }
      // The same shop written apart only in capitals: shopLookalike passes it,
      // as rowShopCode puts the customer's prefix in capitals and both compose
      // to one code; it is held as a case-only look-alike.
      const caseMate = mates.find((o) => caseOnlyPair(r, o));
      if (caseMate) {
        addNote(r, 'SHOP_CODE_LOOKALIKE');
        r.parsed.shopLookalike = { other: caseMate.parsed.branchCodeWritten!, row: caseMate.rowNumber, caseOnly: true };
      }
    }
  }
  return staged;
}

function addNote(r: StagedDailyRow, note: TemixDailyUploadNote) {
  if (!r.notes.includes(note)) r.notes.push(note);
}

/** The order the notes are stored in (TEMIX_DAILY_UPLOAD_NOTES order). */
export function sortedNotes(notes: readonly TemixDailyUploadNote[]): TemixDailyUploadNote[] {
  return TEMIX_DAILY_UPLOAD_NOTES.filter((n) => notes.includes(n));
}
