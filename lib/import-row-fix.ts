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

export type NewerUpload = { filename: string; rowNumber: number; state: string; excluded: boolean };

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

/** The cells whose value the Steward actually changed, against the row as it stands. */
export function changedCells(cells: Record<string, string>, now: SheetRow): Record<string, string> {
  return Object.fromEntries(Object.entries(cells).filter(([c, v]) => v !== cellValue(now, c).trim()));
}
