/**
 * The rules of the Data Steward's in-app fix of a held-back or rejected import
 * row (benchmark item 20, owner decisions 2026-09-25). Pure, so they can be
 * tested on their own and shown on the page exactly as the server applies them.
 *
 *  - Edit ONLY the cells a row's problem names. Payment terms, credit limit,
 *    payment term days and the Temix code are never editable: credit standing
 *    comes from Temix or the credit chain, and the Steward is deliberately not
 *    on that chain.
 *  - Release a shared phone only when the phone being on another customer in
 *    the master is the row's ONLY problem.
 *  - "raw" is never rewritten. The check re-runs over the row as uploaded with
 *    the corrections laid over it.
 */
import type { SheetRow } from '@/lib/import-row-check';
import { normalizeCR } from '@/lib/cr';

export type Corrections = {
  /** Sheet column → the value the Steward entered. */
  cells?: Record<string, string>;
  /** The Steward let a shared phone through, with this reason. */
  phoneReleased?: { reason: string };
};

export const NEVER_EDITABLE: ReadonlySet<string> = new Set([
  'payment_terms',
  'credit_limit',
  'payment_term_days',
  'temix_code',
]);

/** Columns an upload issue can name, in the order the edit form shows them. */
const CELL_ORDER = [
  'cust_code',
  'cust_name',
  'branch_code',
  'address',
  'phone',
  'cr_no',
  'contact_person',
  'notes',
  'channel',
  'day_of_visit',
  'customer_status',
] as const;

export const CELL_LABEL: Record<string, string> = {
  cust_code: 'Customer code',
  cust_name: 'Name',
  branch_code: 'Branch code',
  address: 'Address',
  phone: 'Phone',
  cr_no: 'CR number',
  contact_person: 'Contact person',
  notes: 'Notes',
  channel: 'Channel',
  day_of_visit: 'Visit day (SAT–FRI)',
  customer_status: 'Status (ACTIVE / CLOSED / SUSPENDED)',
};

export const MAX_CELL_LENGTH = 200;

type Issue = { field?: unknown; message?: unknown };

function issuesOf(issues: unknown): Issue[] {
  return Array.isArray(issues) ? (issues as Issue[]) : [];
}

/**
 * The cells a row's problem names. An upload issue names its column directly.
 * A promote rejection ('_promote') names one only when its reason points at a
 * cell: the database's address minimum, or a branch code that clashes. A
 * payment-terms or crosswalk rejection names none — re-checking is all that
 * can be done, and it comes back rejected until the master changes.
 */
export function editableColumns(issues: unknown): string[] {
  const out = new Set<string>();
  for (const i of issuesOf(issues)) {
    const field = typeof i.field === 'string' ? i.field : '';
    const message = typeof i.message === 'string' ? i.message : '';
    if (field === '_promote') {
      if (/Branch_address_minlength/.test(message)) out.add('address');
      else if (/branch_?code/i.test(message) && !/temix/i.test(message)) out.add('branch_code');
      continue;
    }
    if (NEVER_EDITABLE.has(field)) continue;
    if ((CELL_ORDER as readonly string[]).includes(field)) out.add(field);
  }
  return CELL_ORDER.filter((c) => out.has(c));
}

const MASTER_PHONE = /^phone already exists in master\b/;

/**
 * A row may have its phone released only when EVERY one of its problems is
 * "phone already exists in master" — the case the owner decided is legitimate
 * (one owner, several shops, one number). A phone that is invalid, or repeated
 * inside the same file, is a different problem and is fixed, not released.
 */
export function canReleasePhone(issues: unknown): boolean {
  const list = issuesOf(issues);
  return (
    list.length > 0 &&
    list.every(
      (i) => i.field === 'phone' && typeof i.message === 'string' && MASTER_PHONE.test(i.message)
    )
  );
}

export function readCorrections(value: unknown): Corrections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const out: Corrections = {};
  if (v.cells && typeof v.cells === 'object' && !Array.isArray(v.cells)) {
    const cells: Record<string, string> = {};
    for (const [k, x] of Object.entries(v.cells as Record<string, unknown>)) {
      if (typeof x === 'string') cells[k] = x;
    }
    out.cells = cells;
  }
  const pr = v.phoneReleased as { reason?: unknown } | undefined;
  if (pr && typeof pr.reason === 'string') out.phoneReleased = { reason: pr.reason };
  return out;
}

/**
 * The row as uploaded with the Steward's cells laid over it. Corrections use
 * the template's column names, which every reader in the check tries FIRST
 * (`row.cust_name ?? row['CUST NAME'] …`), so they win over a legacy heading;
 * and an empty string clears a cell, because `??` falls through only null.
 */
export function correctedRow(raw: unknown, corrections: Corrections): SheetRow {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SheetRow) : {};
  return { ...base, ...(corrections.cells ?? {}) };
}

/**
 * Validates what the Steward sent against what this row may change. Returns
 * the cleaned cells, or a message saying which column was refused.
 */
export function acceptCells(
  issues: unknown,
  sent: Record<string, unknown>
): { ok: true; cells: Record<string, string> } | { ok: false; message: string } {
  const allowed = new Set(editableColumns(issues));
  const cells: Record<string, string> = {};
  for (const [k, v] of Object.entries(sent)) {
    if (NEVER_EDITABLE.has(k)) {
      return {
        ok: false,
        message: `${k} cannot be changed in the app — credit terms come from Temix or the credit chain.`,
      };
    }
    if (!allowed.has(k))
      return { ok: false, message: `${k} is not one of the cells this row's problem names.` };
    if (typeof v !== 'string') return { ok: false, message: `${k} must be text.` };
    const t = v.trim();
    if (t.length > MAX_CELL_LENGTH)
      return { ok: false, message: `${k} is longer than ${MAX_CELL_LENGTH} characters.` };
    cells[k] = t;
  }
  if (Object.keys(cells).length === 0) return { ok: false, message: 'Nothing to correct.' };
  return { ok: true, cells };
}

/** Legacy headings each template column may have arrived under, in the order the check reads them. */
const LEGACY: Record<string, string[]> = {
  cust_code: ['custcode', 'CUSTCODE', 'code', 'Code'],
  cust_name: ['CUST NAME', 'name'],
  branch_code: ['CUST BRANCH'],
  address: ['ADDRSS', 'ADDRESS'],
  phone: ['PHONE', 'Primary Phone'],
  cr_no: ['CR NO'],
  contact_person: ['CONTACT PERSON'],
  channel: ['CHANNEL'],
  day_of_visit: ['DAY OF VISIT'],
  customer_status: ['CUSTOMER STATUS'],
};

/** A cell's value as the check would read it, for pre-filling the correction form. */
export function cellValue(row: SheetRow, column: string): string {
  for (const key of [column, ...(LEGACY[column] ?? [])]) {
    const v = row[key];
    if (v !== undefined && v !== null) return String(v);
  }
  return '';
}

/**
 * How long an import row keeps its data: the retention sweep empties a
 * finished row's payload after this many days (app/api/cron/retention-sweep).
 * A fix is refused past it too. The newest-upload check reads the newer
 * batches' payloads, and once the sweep has emptied them it would no longer
 * see that a newer upload carries the same customer — so an older row could
 * be loaded over newer data (pre-merge review).
 */
export const IMPORT_PAYLOAD_DAYS = 90;

export function fixWindowClosed(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > IMPORT_PAYLOAD_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The refusal of a row past the fix window, in the words the server uses — the
 * batch page shows it in place of buttons the server would refuse (post-merge
 * review: the page offered Re-check, Correct and Release on such rows).
 */
export function fixWindowMessage(rowNumber: number): string {
  return `Row ${rowNumber} was uploaded more than ${IMPORT_PAYLOAD_DAYS} days ago, past the window in which a newer upload of the same customer can still be seen. Exclude it, or upload the corrected row again.`;
}

/**
 * The branch code a sheet's branch_code resolves to under its customer — the
 * rule promote applies (QA P-01): a bare suffix like '01' is composed under
 * the customer code; a code already composed, or equal to the customer code,
 * passes through.
 */
export function composeBranchCode(custCode: string, sheetCode: string): string {
  const cc = custCode.trim().toUpperCase();
  const raw = sheetCode.trim().toUpperCase();
  return raw === cc || raw.startsWith(`${cc}-`) ? raw : `${cc}-${raw}`;
}

export type NewerUpload = { filename: string; rowNumber: number; state: string; excluded: boolean };

/** A row of a newer customer upload carrying the same customer, newest upload first. */
export type NewerCandidate = NewerUpload & {
  /** Its branch code composed under its customer, or null when the cell is blank. */
  branch: string | null;
  fixedInApp: boolean;
  /**
   * It carries the customer's own Temix code and is not the row that created
   * the customer: it took (or will take) the refresh lane, which writes no branch.
   */
  refreshRow: boolean;
};

/**
 * The newer upload that rules out fixing a row, or null.
 *
 * A fixed row of a customer NOT linked to Temix takes the full lane and writes
 * the customer's own fields, so any newer upload of the customer wins.
 *
 * A fixed row of a customer linked to Temix writes only its own branch (owner
 * decision, "branch only"), so only a newer row about THAT branch rules it out.
 * A plain refresh row writes no branch at all, so it never does. Keyed on the
 * customer alone, the routine inbound Temix refresh blocked every held-back
 * branch row of every customer it carried — while its own note told the
 * Steward to fix exactly that row (post-merge review).
 */
export function supersedingUpload(
  target: { branch: string | null },
  linked: boolean,
  newestFirst: NewerCandidate[]
): NewerUpload | null {
  const pick = (n: NewerCandidate): NewerUpload => ({
    filename: n.filename,
    rowNumber: n.rowNumber,
    state: n.state,
    excluded: n.excluded,
  });
  if (!linked) return newestFirst[0] ? pick(newestFirst[0]) : null;
  if (!target.branch) return null;
  const hit = newestFirst.find((n) => {
    if (n.branch !== target.branch) return false;
    const loadsNoBranch =
      n.refreshRow && !n.fixedInApp && !n.excluded && (n.state === 'PROMOTED' || n.state === 'CLEAN');
    return !loadsNoBranch;
  });
  return hit ? pick(hit) : null;
}

/**
 * Why a row cannot be fixed because a newer upload carries its customer, and
 * what to do instead — which depends on what that newer row is. It used to say
 * "fix the row there" even when the newer row had loaded (an inbound Temix
 * refresh, say), so there was nothing there to fix.
 */
export function newerUploadMessage(code: string, n: NewerUpload): string {
  const where = `a newer upload, "${n.filename}" (row ${n.rowNumber})`;
  if (n.excluded) {
    return `Customer ${code} is also in ${where}, where it was excluded. Include it again there and fix it, or exclude this older row.`;
  }
  if (n.state === 'QUARANTINED' || n.state === 'REJECTED') {
    return `Customer ${code} is also in ${where}, still held back there. Fix it in that upload instead — fixing this older row would load older data over it.`;
  }
  if (n.state === 'PROMOTED') {
    return `Customer ${code} was loaded again from ${where}. This older row can no longer be fixed — exclude it.`;
  }
  return `Customer ${code} is also in ${where}, ready to load there. This older row can no longer be fixed — exclude it.`;
}

/**
 * A fix waiting to promote that a newer upload has since overtaken. Promote
 * rejects it rather than load the older row over the newer upload — the rule
 * used to be checked only when the fix was made, so a fix made first and
 * promoted after a newer upload still loaded (post-merge review).
 */
export function supersededFixMessage(code: string, n: NewerUpload): string {
  const where = `a newer upload, "${n.filename}" (row ${n.rowNumber})`;
  const next =
    !n.excluded && (n.state === 'QUARANTINED' || n.state === 'REJECTED')
      ? 'Withdraw this fix and fix the row in that upload instead.'
      : 'Withdraw this fix, then exclude the row.';
  return `Customer ${code} is also in ${where}, so this fix will not load: promote rejects it rather than load older data over that upload. ${next}`;
}

/** Customer-level cells, which a fix for a customer linked to Temix never writes. */
const CUSTOMER_CELLS: ReadonlyArray<readonly [string, string]> = [
  ['cust_name', 'name'],
  ['phone', 'phone'],
  ['cr_no', 'CR number'],
  ['contact_person', 'contact person'],
  ['channel', 'channel'],
];
export const CUSTOMER_LEVEL_CELLS: ReadonlySet<string> = new Set(CUSTOMER_CELLS.map(([k]) => k));

export type StoredCustomerFields = {
  legalName: string;
  primaryPhoneNorm: string | null;
  crNumberNorm: string | null;
  contactPerson: string | null;
  channelKey: string | null;
};

export type RowCustomerFields = {
  custName: string;
  /** Normalized, as the check parses it. */
  phone: string | null;
  crNumber: string | null;
  contactPerson: string | null;
  channelKey?: string | null;
};

/**
 * The customer-level values the Steward corrected — or, for the phone,
 * released — on a row that promote then loads branch only, and that differ
 * from the customer: none of them is written (owner decision, "branch only").
 * The row used to read PROMOTED with nothing said, so a released phone looked
 * loaded (post-merge review). A blank value asks for nothing.
 */
export function unwrittenCustomerCells(
  c: Corrections,
  row: RowCustomerFields,
  stored: StoredCustomerFields
): string[] {
  const asked = new Set(Object.keys(c.cells ?? {}));
  if (c.phoneReleased) asked.add('phone');
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();
  const differs: Record<string, boolean> = {
    cust_name: !!row.custName && !same(row.custName, stored.legalName),
    phone: !!row.phone && row.phone !== stored.primaryPhoneNorm,
    cr_no: !!row.crNumber && normalizeCR(row.crNumber) !== stored.crNumberNorm,
    contact_person: !!row.contactPerson && !same(row.contactPerson, stored.contactPerson),
    channel: !!row.channelKey && !same(row.channelKey, stored.channelKey),
  };
  return CUSTOMER_CELLS.filter(([k]) => asked.has(k) && differs[k]).map(([, label]) => label);
}

/** The row's note when `unwrittenCustomerCells` found any, else null. */
export function branchOnlyNote(labels: string[]): string | null {
  if (labels.length === 0) return null;
  const one = labels.length === 1;
  const list = one ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `the ${list} in this row ${one ? 'was' : 'were'} not written — for a customer linked to Temix a row fixed in the app loads only its branch; change ${one ? 'it' : 'them'} on the customer page`;
}

/** The cells whose value the Steward actually changed, against the row as it stands. */
export function changedCells(cells: Record<string, string>, now: SheetRow): Record<string, string> {
  return Object.fromEntries(Object.entries(cells).filter(([c, v]) => v !== cellValue(now, c).trim()));
}
