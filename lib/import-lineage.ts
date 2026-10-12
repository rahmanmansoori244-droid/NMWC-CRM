/**
 * Gaps 4 and 7 (data audit 2026-10-10, lossless paths): what a customer-master
 * import row changed, said once per customer and shop, and where it came from.
 *
 * The import is the only way a shop moves route, region or visit day, and the
 * Temix refresh the only way a customer's terms change after creation. The dated
 * history (docs/HISTORY.md) records the non-personal values of every such change
 * under the row's source (import:<batch>:<row>:<lane>). This module adds the rest:
 *
 *  - which cells a row would actually change (differingCells): a customer or shop
 *    the row leaves as it is is NOT written — no version, editor or updatedAt bump
 *    — so "last edited by the Steward" and the export's "updated since" stop
 *    claiming changes that never happened;
 *  - the AuditLog CREATE / UPDATE row per created or changed customer and shop,
 *    with the before and after of the changed fields (full values, as an approved
 *    edit's APPROVE row has them) and the lineage: batch, import row, sheet row
 *    and lane.
 *
 * PURE: no database, so it is tested on its own (tests/unit/import-lineage.test.ts).
 */
import { Prisma } from '@prisma/client';
import type { ImportLane } from './change-context';
import { fingerprint } from './fingerprint';

/** The reason of every per-customer and per-shop import audit row starts with this. */
export const IMPORT_AUDIT_REASON_PREFIX = 'import ';

/** 'import <batch> row <n> (<lane>)': the audit row's reason. */
export function importAuditReason(batchId: string, rowNumber: number | string, lane: ImportLane): string {
  return `${IMPORT_AUDIT_REASON_PREFIX}${batchId} row ${rowNumber} (${lane})`;
}

/** Where a value came from: written into every per-entity import audit row's `after`. */
export type ImportLineage = {
  batchId: string;
  importRowId: string;
  rowNumber: number | string;
  lane: ImportLane;
};

const isDecimal = (v: unknown): v is Prisma.Decimal => Prisma.Decimal.isDecimal(v);

/** Equal as stored: null and undefined alike, dates by instant, decimals by value. */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime();
    return ta === tb;
  }
  if (isDecimal(a) || isDecimal(b)) {
    try {
      return new Prisma.Decimal(a as Prisma.Decimal.Value).equals(new Prisma.Decimal(b as Prisma.Decimal.Value));
    } catch {
      return false;
    }
  }
  return a === b;
}

/**
 * The fields a write would change: each key it sets (undefined = "leave as it
 * is") whose value is not already the stored one. In the write's own order.
 */
export function differingCells(
  write: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>
): string[] {
  return Object.keys(write).filter((k) => write[k] !== undefined && !sameStoredValue(write[k], stored[k]));
}

/** The customer half of the import (design name; the rule is the same for any row). */
export const differingCustomerCells = differingCells;

/** A value as an audit row's JSON holds it: decimals as text, dates as ISO instants. */
export function auditValue(v: unknown): Prisma.InputJsonValue | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (isDecimal(v)) return v.toString();
  return v as Prisma.InputJsonValue;
}

/**
 * The before and after of the changed fields, for the audit row: full values,
 * as an approved edit's APPROVE row carries them. `after` also carries the
 * lineage, so the row says which file row set the value long after the import
 * rows themselves were swept.
 */
export function changeAudit(
  fields: readonly string[],
  stored: Readonly<Record<string, unknown>>,
  write: Readonly<Record<string, unknown>>,
  lineage: ImportLineage
): { before: Prisma.InputJsonObject; after: Prisma.InputJsonObject } {
  const before: Record<string, Prisma.InputJsonValue | null> = {};
  const after: Record<string, Prisma.InputJsonValue | null> = {};
  for (const f of fields) {
    before[f] = auditValue(stored[f]);
    after[f] = auditValue(write[f]);
  }
  return {
    before: before as Prisma.InputJsonObject,
    after: { ...after, ...lineageJson(lineage) } as Prisma.InputJsonObject,
  };
}

/** A created record's audit `after`: every value it was created with, and the lineage. */
export function createAudit(values: Readonly<Record<string, unknown>>, lineage: ImportLineage): Prisma.InputJsonObject {
  const after: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) after[k] = auditValue(v);
  return { ...after, ...lineageJson(lineage) } as Prisma.InputJsonObject;
}

function lineageJson(l: ImportLineage): Prisma.InputJsonObject {
  return { batchId: l.batchId, importRowId: l.importRowId, rowNumber: l.rowNumber, lane: l.lane };
}

/**
 * Gap 7: the import-row cells the Data Steward corrected in the app, for the
 * audit row that is kept for ever. Non-personal cells keep their old and new
 * values; personal ones (a name, address, phone, CR number, contact, note) keep
 * only fingerprints (lib/fingerprint.ts), so the ledger can say the value changed
 * without holding it.
 */
export const NON_PERSONAL_IMPORT_CELLS: ReadonlySet<string> = new Set([
  'cust_code',
  'branch_code',
  'channel',
  'day_of_visit',
  'customer_status',
  'region_code',
  'route_code',
  'sales_region',
  'route',
]);

export type CorrectionAudit = Record<
  string,
  { from: string | null; to: string | null } | { fromSha256: string | null; toSha256: string | null }
>;

export function correctionAudit(
  changed: Readonly<Record<string, string>>,
  before: Readonly<Record<string, unknown>>
): CorrectionAudit {
  const out: CorrectionAudit = {};
  for (const col of Object.keys(changed).sort()) {
    const from = before[col] === undefined || before[col] === null || before[col] === '' ? null : String(before[col]);
    const to = changed[col] === '' ? null : changed[col]!;
    out[col] = NON_PERSONAL_IMPORT_CELLS.has(col)
      ? { from, to }
      : { fromSha256: fingerprint(`import:${col}`, from), toSha256: fingerprint(`import:${col}`, to) };
  }
  return out;
}
