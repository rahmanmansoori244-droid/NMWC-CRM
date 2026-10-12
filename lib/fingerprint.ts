/**
 * Fingerprints for the records that are kept for ever (lossless paths, data audit
 * 2026-10-10 gaps 7, 12 and 14; docs/HISTORY.md).
 *
 * A ledger that can never be erased must not hold a personal value
 * (PDPL-ASSESSMENT Q4). Where it must still be able to say "this was the same
 * value as that" — a new-customer request's name, CR number or phone in one round
 * against the next (EditRevision), a cell the Data Steward corrected on an import
 * row — it keeps a SHA-256 of the value instead.
 *
 * Honest limits, recorded in lib/compliance/pii-classification.ts too: the digest
 * is unkeyed, so a value from a small space (an 8-digit phone, a short CR number)
 * can be recovered by trying every candidate. It is a fingerprint for comparison,
 * not anonymisation. The field name is mixed in, so the same text in two fields
 * gives two different fingerprints.
 *
 * PURE: node:crypto only, so scripts and tests can use it.
 */
import { createHash } from 'node:crypto';

/** Bumped if the input layout ever changes; old and new fingerprints then never compare equal. */
export const FINGERPRINT_SCHEME = 'nmwc-fp-v1';

/** SHA-256 (hex) of any bytes or text. */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The fingerprint of one field's value: SHA-256 (hex) of the scheme, the field
 * name and the value as text. Null for no value (null or undefined), so "it had
 * none" stays visible. Dates are taken as their ISO instant, numbers and booleans
 * as their text, anything else as its JSON.
 */
export function fingerprint(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : JSON.stringify(value);
  return sha256Hex(`${FINGERPRINT_SCHEME}\u0000${field}\u0000${text}`);
}

/**
 * JSON with every object's keys in sorted order, so the same content always gives
 * the same text, and so the same SHA-256 (EditRevision.payloadSha256).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  // A Date, a Prisma Decimal: what JSON.stringify would write for it.
  if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return sortKeys((value as { toJSON(): unknown }).toJSON());
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
