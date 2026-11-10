/**
 * Which heading of a customer-master sheet is which column (code review
 * 2026-11-10, finding 1).
 *
 * The row check read each column by a short list of EXACT spellings
 * (`row.temix_code ?? row.temixcode ?? row['TEMIX CODE'] ?? row['Temix Code']`),
 * and nothing ever looked at the headings the sheet actually had. So a sheet
 * headed `TEMIX_CODE` or `Temix code` staged every row CLEAN with no Temix code:
 * at Promote every customer took the lane that writes CRM fields from the sheet,
 * the credit columns were not applied, and nothing said so.
 *
 * Now a heading is matched after FOLDING it — Unicode-normalised, lower case,
 * everything but letters and digits dropped — so `TEMIX_CODE`, `Temix code`,
 * `TemixCode` and `temix-code` are all temix_code, and the same holds for every
 * column and every legacy spelling. The exact spellings are still tried first, in
 * the order they always were, so a sheet that loaded yesterday reads to the same
 * values today. The upload reports every heading that is NOT read.
 *
 * Pure: no database. Shared by the row check (lib/import-row-check.ts), the
 * correction form (lib/import-row-fix.ts), the upload (services/imports.ts) and
 * the batch page.
 */

/** The 17 columns of the customer-master template, in template order. */
export const CUSTOMER_COLUMNS = [
  'cust_code',
  'cust_name',
  'branch_code',
  'branch_name',
  'sales_region',
  'route',
  'address',
  'phone',
  'contact_person',
  'cr_no',
  'payment_terms',
  'credit_limit',
  'payment_term_days',
  'temix_code',
  'channel',
  'day_of_visit',
  'customer_status',
] as const;

export type CustomerColumn = (typeof CUSTOMER_COLUMNS)[number];

/**
 * The exact spellings each column has always been read under, in the order the
 * row check tried them. `CUST BRANCH` is both the branch code and the branch
 * name of the legacy sheet.
 */
export const READ_ORDER: Record<CustomerColumn, readonly string[]> = {
  cust_code: ['cust_code', 'custcode', 'CUSTCODE', 'code', 'Code'],
  cust_name: ['cust_name', 'CUST NAME', 'name'],
  branch_code: ['branch_code', 'CUST BRANCH'],
  branch_name: ['branch_name', 'CUST BRANCH', 'branch'],
  sales_region: ['sales_region', 'SALES REGION', 'region'],
  route: ['route', 'ROUTE'],
  address: ['address', 'ADDRSS', 'ADDRESS'],
  phone: ['phone', 'PHONE', 'Primary Phone'],
  contact_person: ['contact_person', 'CONTACT PERSON'],
  cr_no: ['cr_no', 'CR NO'],
  payment_terms: ['payment_terms', 'PAYMENT TERMS'],
  credit_limit: ['credit_limit', 'CREDIT LIMIT'],
  payment_term_days: ['payment_term_days', 'PAYMENT TERM DAYS'],
  temix_code: ['temix_code', 'temixcode', 'TEMIX CODE', 'Temix Code'],
  channel: ['channel', 'CHANNEL'],
  day_of_visit: ['day_of_visit', 'DAY OF VISIT'],
  customer_status: ['customer_status', 'CUSTOMER STATUS'],
};

type Row = Record<string, unknown>;

// A sheet has a few dozen distinct headings and the check reads them for every
// row of up to 50,000: fold each spelling once.
const folded = new Map<string, string>();

/** A heading as it is compared: NFKC, lower case, letters and digits only. */
export function foldHeading(heading: unknown): string {
  const key = String(heading ?? '');
  const known = folded.get(key);
  if (known !== undefined) return known;
  const f = key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  if (folded.size > 5000) folded.clear();
  folded.set(key, f);
  return f;
}

/** Each column's distinct folds, in READ_ORDER order. */
const FOLDS: Record<CustomerColumn, string[]> = Object.fromEntries(
  CUSTOMER_COLUMNS.map((c) => [c, [...new Set(READ_ORDER[c].map((s) => foldHeading(s)))]])
) as Record<CustomerColumn, string[]>;

const COLUMNS_OF_FOLD = new Map<string, CustomerColumn[]>();
for (const c of CUSTOMER_COLUMNS) {
  for (const f of FOLDS[c]) COLUMNS_OF_FOLD.set(f, [...(COLUMNS_OF_FOLD.get(f) ?? []), c]);
}

/** The column(s) a heading is read as; none when the import does not read it. */
export function columnsOfHeading(heading: unknown): CustomerColumn[] {
  const f = foldHeading(heading);
  return f ? (COLUMNS_OF_FOLD.get(f) ?? []) : [];
}

/**
 * A column's cell as the check reads it.
 *
 * First the exact spellings, in the order they were always tried: the first one
 * holding a value wins, and an empty string counts as a value (a Steward's
 * correction to '' clears the cell; the parser stores a blank cell as null).
 * Then any other heading of the row that folds to the column.
 */
export function readCell(row: Row, column: CustomerColumn): unknown {
  for (const spelling of READ_ORDER[column]) {
    const v = row[spelling];
    if (v != null) return v;
  }
  for (const fold of FOLDS[column]) {
    for (const key of Object.keys(row)) {
      if (foldHeading(key) !== fold) continue;
      const v = row[key];
      if (v != null) return v;
    }
  }
  return undefined;
}

/**
 * A cell that is not one of the 17 columns (`notes`, which the import only
 * screens for a formula): its exact heading, then any heading that folds to it.
 */
export function readLooseCell(row: Row, name: string): unknown {
  const exact = row[name];
  if (exact != null) return exact;
  const fold = foldHeading(name);
  for (const key of Object.keys(row)) {
    if (key === name || foldHeading(key) !== fold) continue;
    const v = row[key];
    if (v != null) return v;
  }
  return undefined;
}

export type HeadingReport = {
  /** Column → the sheet's headings read as it. */
  read: Partial<Record<CustomerColumn, string[]>>;
  /** Headings the import does not read, in sheet order. */
  unrecognised: string[];
  /** One column under two spellings in the same sheet (`Temix code` and `temix_code`). */
  clashes: Array<{ columns: CustomerColumn[]; headings: string[] }>;
  hasTemixCode: boolean;
};

/** What the import makes of a sheet's headings. */
export function reportHeadings(headers: readonly string[]): HeadingReport {
  const read: Partial<Record<CustomerColumn, string[]>> = {};
  const unrecognised: string[] = [];
  const byFold = new Map<string, { columns: CustomerColumn[]; headings: string[] }>();
  for (const h of headers) {
    const columns = columnsOfHeading(h);
    if (columns.length === 0) {
      unrecognised.push(h);
      continue;
    }
    for (const c of columns) read[c] = [...(read[c] ?? []), h];
    const fold = foldHeading(h);
    const seen = byFold.get(fold) ?? { columns, headings: [] };
    seen.headings.push(h);
    byFold.set(fold, seen);
  }
  return {
    read,
    unrecognised,
    clashes: [...byFold.values()].filter((g) => g.headings.length > 1),
    hasTemixCode: (read.temix_code?.length ?? 0) > 0,
  };
}

const quoted = (list: readonly string[]) =>
  list.length === 1
    ? `"${list[0]}"`
    : `${list
        .slice(0, -1)
        .map((h) => `"${h}"`)
        .join(', ')} and "${list[list.length - 1]}"`;

/** The refusal for a sheet that has one column under two spellings, or null. */
export function headingClashIssue(sheetName: string, report: HeadingReport): string | null {
  const c = report.clashes[0];
  if (!c) return null;
  const all = c.headings.length === 2 ? 'both' : 'all';
  const columns = c.columns.join(' and ');
  return `Sheet "${sheetName}": the headings ${quoted(c.headings)} are ${all} read as the ${columns} column${c.columns.length === 1 ? '' : 's'}. Keep one, or rename the other.`;
}

const NOT_READ_SHOWN = 20;

/** The note listing the headings the import did not read, or null when it read them all. */
export function notReadNote(unrecognised: readonly string[]): string | null {
  const n = unrecognised.length;
  if (n === 0) return null;
  const shown = unrecognised.slice(0, NOT_READ_SHOWN).join(', ');
  const more = n > NOT_READ_SHOWN ? ` and ${n - NOT_READ_SHOWN} more` : '';
  const one = n === 1;
  return `Not read: ${n.toLocaleString('en-US')} column${one ? '' : 's'} in this sheet ${one ? 'is' : 'are'} not used by the import and ${one ? 'was' : 'were'} ignored — ${shown}${more}. If ${one ? 'it' : 'one of them'} should have been read, check its spelling against the template.`;
}

/**
 * The refusal for a sheet with no temix_code column that names customers
 * already linked to Temix. Without the column no row can be a Temix refresh, so
 * every one of them would be treated as a plain re-load and its credit limit and
 * credit days would be ignored.
 */
export function missingTemixColumnIssue(count: number, examples: readonly string[]): string {
  const one = count === 1;
  const eg = examples.length > 0 ? ` (for example ${examples.slice(0, 3).join(', ')})` : '';
  return `This sheet has no temix_code column, and ${count.toLocaleString('en-US')} of its customers already ${one ? 'has' : 'have'} a Temix code in the CRM${eg}. Nothing was uploaded. Without that column the import cannot tell which rows are a Temix refresh, and their credit limit and credit days would be ignored. Add a column headed temix_code holding each customer's Temix code (it is on the customer page; leave the cell blank for a customer not yet in Temix) and upload again. A Temix extract is not loaded through this screen.`;
}
