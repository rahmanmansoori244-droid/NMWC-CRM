/**
 * REL-06: telling "the database was unavailable" apart from "this data is bad".
 *
 * This lived inside `services/imports.ts`, where it was learned the hard way:
 * transient engine faults were being recorded as permanent row REJECTIONS, so
 * infrastructure noise silently dropped good customers while the import batch
 * still finished green. The same distinction matters everywhere — a server
 * action that hits a pool timeout should tell the user to try again, not
 * present a generic failure — so it lives here, importing nothing, and both
 * `lib/errors.ts` and `services/imports.ts` use it.
 */

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
