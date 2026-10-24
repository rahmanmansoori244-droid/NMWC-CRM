/**
 * REL-06: telling "the database was unavailable" apart from "this data is bad".
 *
 * This lived inside `services/imports.ts`, where it was learned the hard way:
 * transient engine faults were being recorded as permanent row REJECTIONS, so
 * infrastructure noise silently dropped good customers while the import batch
 * still finished green. The same distinction matters everywhere — a server
 * action that hits a pool timeout should tell the user to try again, not
 * present a generic failure — so it lives here, importing nothing but the pure
 * lib/db-rules.ts (gap 31), and both `lib/errors.ts` and `services/imports.ts` use it.
 */
import { DB_RULE_BY_NAME, type DbRule } from './db-rules';

/**
 * Prisma codes that mean "the database was unavailable or slow", not "this data
 * is bad": unreachable, timed out, connection closed, no pool connection, and
 * the interactive-transaction timeout.
 */
export const TRANSIENT_DB_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1011',
  'P1017',
  'P2024',
  'P2028',
]);

/**
 * Postgres aborted the transaction to break a deadlock (40P01) or a serialization
 * failure (40001). Prisma reports it as P2034 from a model query, and as P2010
 * carrying the SQLSTATE from a raw one (the row locks in lib/locks.ts are raw);
 * an engine error it does not map has no code, only Postgres's own words.
 * The aborted transaction rolled back whole and the same request run again
 * normally succeeds: not the data's fault, and not a programmer error.
 */
export function isDbConflict(err: unknown, code: string): boolean {
  if (code === 'P2034') return true;
  const msg = err instanceof Error ? err.message : '';
  if (code === 'P2010') {
    const sqlState = (err as { meta?: { code?: unknown } } | null)?.meta?.code;
    if (sqlState === '40P01' || sqlState === '40001') return true;
    return /Code: `(40P01|40001)`/.test(msg);
  }
  // No Prisma code at all — whatever placeholder the caller passed for it ('',
  // 'UNKNOWN' in the customer promote) — leaves only Postgres's own words.
  return !/^P\d{4}$/.test(code) && /deadlock detected|could not serialize access/i.test(msg);
}

export function isTransientDbError(err: unknown, code: string): boolean {
  if (TRANSIENT_DB_CODES.has(code)) return true;
  // A deadlock or serialization abort is not bad data either: an import row it
  // hits is retried, not rejected for good.
  if (isDbConflict(err, code)) return true;
  // Engine-level faults arrive as plain Errors with no Prisma code at all — the
  // empty-response one is what a killed or restarted query engine produces.
  const msg = err instanceof Error ? err.message : '';
  return /Response from the Engine was empty|Server has closed the connection|Timed out fetching a new connection|Can't reach database server/i.test(
    msg
  );
}

/**
 * Of those, the faults that can come AFTER the commit: the connection or the
 * engine died mid-request, or gave up waiting on a statement the database may
 * still have finished. What was written is unknown, so nothing may promise that
 * nothing was saved (item 22). The rest — unreachable, no pool connection, an
 * interactive transaction that closed (and so rolled back) — failed before any
 * write could stand.
 */
export function mayHaveCommitted(err: unknown, code: string): boolean {
  if (code === 'P1017' || code === 'P1008') return true;
  const msg = err instanceof Error ? err.message : '';
  return /Response from the Engine was empty|Server has closed the connection/i.test(msg);
}

/**
 * Gap 31: which database rule (lib/db-rules.ts) refused a save, or null when the
 * error is not one of them. A rule added NOT VALID refuses every later save of an
 * older row that breaks it, by any path; without this the person saw a generic
 * failure (a 500) and nobody could tell which rule, or which record, was at fault.
 *
 * Matched by the constraint's NAME, wherever the driver put it: a foreign key as
 * P2003 (meta.field_name "<name> (index)"), a CHECK as P2004 or, from a raw
 * query, P2010 (Postgres's own words in the message or meta), and an engine
 * error Prisma did not map (no code) that quotes `violates check constraint
 * "<name>"` or `violates foreign key constraint "<name>"`. A name is matched
 * whole, so one rule's name inside another's never matches.
 */
export function dbRuleViolated(err: unknown): DbRule | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '');
  let meta = '';
  try {
    meta = JSON.stringify((err as { meta?: unknown }).meta ?? '');
  } catch {
    meta = '';
  }
  const text = `${message} ${meta}`;
  const constraintError =
    code === 'P2003' ||
    code === 'P2004' ||
    (code === 'P2010' && /23514|23503|check constraint|foreign key constraint/i.test(text)) ||
    ((code === undefined || code === null || code === '') && /violates (check|foreign key) constraint/i.test(text));
  if (!constraintError) return null;
  for (const [name, rule] of DB_RULE_BY_NAME) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text)) return rule;
  }
  return null;
}

/**
 * Owner decision 2026-10-25 (migration 20261025120000_temix_code_unique): one live
 * customer per Temix code, compared upper case with the ends trimmed. A partial
 * index on an expression, so Prisma cannot describe it (schema.prisma) and CI's
 * drift gate allows it by name.
 */
export const TEMIX_CODE_UNIQUE_INDEX = 'Customer_temixCode_live_unique';

/** The index's key, with the quotes taken out, as Postgres and Prisma quote it. */
const TEMIX_CODE_INDEX_KEY = /upper\(btrim\(temixCode(::text)?\)\)/i;

/**
 * Whether a refused save broke TEMIX_CODE_UNIQUE_INDEX, the way dbRuleViolated
 * reads a rule: wherever the driver put it. Postgres does not name the index in
 * the detail of a unique violation, only its key, so the key counts too (seen on
 * Postgres 17 with Prisma 6.19, 2026-10-25):
 *   - a model write: P2002, meta.target ["upper(btrim(temixCode))"];
 *   - a raw write: P2010, meta.code "23505", the message `Key
 *     (upper(btrim("temixCode")))=(…) already exists.`;
 *   - an engine error Prisma did not map (no code) that quotes `duplicate key
 *     value violates unique constraint "Customer_temixCode_live_unique"`.
 * The index's name is matched whole; any other unique violation is not this one.
 */
export function temixCodeIndexViolated(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '');
  let meta = '';
  try {
    meta = JSON.stringify((err as { meta?: unknown }).meta ?? '');
  } catch {
    meta = '';
  }
  const text = `${message} ${meta}`;
  const uniqueError =
    code === 'P2002' ||
    (code === 'P2010' && /23505|duplicate key value|already exists/i.test(text)) ||
    ((code === undefined || code === null || code === '') && /duplicate key value violates unique constraint/i.test(text));
  if (!uniqueError) return false;
  if (new RegExp(`(^|[^A-Za-z0-9_])${TEMIX_CODE_UNIQUE_INDEX}([^A-Za-z0-9_]|$)`).test(text)) return true;
  return TEMIX_CODE_INDEX_KEY.test(text.replace(/\\?"/g, ''));
}
