/**
 * What the import batch page (app/(app)/import/[batchId]/page.tsx) lists, and
 * how it reads a row. Benchmark item 20.
 *
 * The page used to show at most 200 problem rows and 100 others, as raw JSON,
 * with no way past them. One 2026-09-23 load rejected 1,833 rows, so more than
 * 1,600 could not be opened at all, while the Steward guide told the Steward to
 * open every one. It also printed `parsed` in place of the row as uploaded, so a
 * quarantined payment_terms of "Crdit" read "CASH" — the value the parser fell
 * back to, not the one that caused the problem.
 */
import { ImportRowState, Prisma } from '@prisma/client';

export const ROW_VIEWS = ['problems', 'rejected', 'quarantined', 'warnings', 'all'] as const;
export type RowView = (typeof ROW_VIEWS)[number];

export const ROWS_PAGE_SIZE = 100;

export const ROW_VIEW_LABEL: Record<RowView, string> = {
  problems: 'Needs attention',
  rejected: 'Rejected',
  quarantined: 'Quarantined',
  warnings: 'Loaded with a warning',
  all: 'All rows',
};

export function parseRowView(value: string | undefined): RowView {
  return (ROW_VIEWS as readonly string[]).includes(value ?? '') ? (value as RowView) : 'problems';
}

export function parsePage(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * The rows a view lists. "Loaded with a warning" is a PROMOTED row that carries
 * issues: the customer landed, but a route or region was substituted, or the
 * Temix refresh lane left the row's branch data unapplied.
 */
export function rowViewWhere(batchId: string, view: RowView): Prisma.ImportRowWhereInput {
  switch (view) {
    case 'problems':
      return { batchId, state: { in: [ImportRowState.REJECTED, ImportRowState.QUARANTINED] } };
    case 'rejected':
      return { batchId, state: ImportRowState.REJECTED };
    case 'quarantined':
      return { batchId, state: ImportRowState.QUARANTINED };
    case 'warnings':
      return { batchId, state: ImportRowState.PROMOTED, issues: { not: Prisma.DbNull } };
    case 'all':
      return { batchId };
  }
}

/** How many rows each view holds, from a per-state count and the warning count. */
export function viewCounts(
  byState: Partial<Record<ImportRowState, number>>,
  warnings: number
): Record<RowView, number> {
  const n = (s: ImportRowState) => byState[s] ?? 0;
  const all = Object.values(byState).reduce<number>((sum, v) => sum + (v ?? 0), 0);
  return {
    problems: n(ImportRowState.REJECTED) + n(ImportRowState.QUARANTINED),
    rejected: n(ImportRowState.REJECTED),
    quarantined: n(ImportRowState.QUARANTINED),
    warnings,
    all,
  };
}

/** "Rows 101–200 of 1,833", or null when there is nothing to page through. */
export function pageRange(page: number, total: number, size = ROWS_PAGE_SIZE): string | null {
  if (total === 0) return null;
  const from = (page - 1) * size + 1;
  if (from > total) return null;
  const to = Math.min(page * size, total);
  const fmt = (x: number) => x.toLocaleString('en-US');
  return `Rows ${fmt(from)}–${fmt(to)} of ${fmt(total)}`;
}

export function lastPage(total: number, size = ROWS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

const FIELD_LABEL: Record<string, string> = {
  _promote: 'Not loaded',
  _resolve: 'Route or region',
  _lane: 'Branch not updated',
  cust_code: 'Customer code',
  cust_name: 'Name',
  phone: 'Phone',
  cr_no: 'CR number',
  payment_terms: 'Payment terms',
  credit_limit: 'Credit limit',
  payment_term_days: 'Payment term days',
  day_of_visit: 'Visit day',
  channel: 'Channel',
  customer_status: 'Status',
};

export type IssueLine = { label: string; message: string };

/**
 * A row's issues as label + sentence. Customer rows store [{ field, message }];
 * account-master rows store [{ sheet, row, message }]. Anything else is shown as
 * it is rather than dropped: an issue nobody can read is still an issue.
 */
export function issueLines(issues: unknown): IssueLine[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((raw) => {
    const i = (raw ?? {}) as { field?: unknown; message?: unknown; sheet?: unknown; row?: unknown };
    const message = typeof i.message === 'string' ? i.message : JSON.stringify(raw);
    if (typeof i.field === 'string') {
      return { label: FIELD_LABEL[i.field] ?? i.field, message };
    }
    if (typeof i.sheet === 'string') {
      return { label: typeof i.row === 'number' ? `${i.sheet} sheet, row ${i.row}` : `${i.sheet} sheet`, message };
    }
    return { label: 'Issue', message };
  });
}

export type RowSummary = {
  code: string | null;
  name: string | null;
  branch: string | null;
  route: string | null;
  day: string | null;
};

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * Who a row is about. From `parsed` when the upload got that far (canonical
 * codes), else from the sheet's own columns, current or legacy headings.
 */
export function rowSummary(raw: unknown, parsed: unknown): RowSummary {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    code: text(p.custCode) ?? text(r.cust_code) ?? text(r['CUST CODE']),
    name: text(p.custName) ?? text(r.cust_name) ?? text(r['CUST NAME']),
    branch: text(p.branchCode) ?? text(r.branch_code) ?? text(p.branchName) ?? text(r.branch_name),
    route: text(p.routeCode) ?? text(r.route) ?? text(r.ROUTE),
    day: text(p.dayOfVisit) ?? text(r.day_of_visit),
  };
}

/**
 * The row exactly as the sheet gave it, one column per line, blanks left out.
 * This — not `parsed` — is what the Steward has to correct.
 */
export function uploadedValues(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = v !== null && typeof v === 'object' ? JSON.stringify(v) : text(v);
    if (s) out.push([k, s]);
  }
  return out;
}
