/**
 * P3.2 — Approximate count for the Customer list page.
 *
 * The /customers page header used to call `prisma.customer.count({ where })`
 * unconditionally to render "{N} customers". When `where` is just
 * `deletedAt: null` (the always-on scope), Postgres has to scan the index
 * to count exactly — at ~3,300 customers today and growing it's fine, but
 * once the table reaches 50k+ rows the count becomes the bottleneck on the
 * unfiltered list page.
 *
 * `customerCountFast(where)` returns the exact count when ANY filter
 * besides `deletedAt: null` is present, and a `pg_class.reltuples`
 * estimate (O(1) — read straight from system catalog) when the caller is
 * unfiltered. The shape `{ total, isApprox }` lets the page render
 * "~3,300 customers" in the unfiltered case and "{N} customers" otherwise.
 *
 * Caveats / behaviour:
 *   - reltuples is updated by ANALYZE / autovacuum. On a freshly imported
 *     batch the estimate may lag by minutes-to-hours; we mark `isApprox`
 *     so the UI can communicate that.
 *   - reltuples is `float4` in pg_class. We round to the nearest integer.
 *   - If reltuples < 0 (Postgres returns -1 when stats haven't been
 *     gathered yet) we fall back to the exact count to avoid showing a
 *     bogus "~-1 customers".
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './db';

export type CustomerCountResult = { total: number; isApprox: boolean };

/**
 * Returns true when the caller has narrowed the query beyond the always-on
 * `deletedAt: null` scope. Used to decide between the exact count and the
 * pg_class estimate.
 */
function hasUserFilter(where: Prisma.CustomerWhereInput): boolean {
  // Strip deletedAt: null and consider any remaining keys as a user filter.
  const keys = Object.keys(where).filter(
    (k) => k !== 'deletedAt'
  );
  if (keys.length > 0) return true;
  // deletedAt may be exactly `null` (the always-on scope) — that's not a
  // user filter. Anything else (e.g. { lt: someDate }) IS a filter.
  const dd = where.deletedAt;
  if (dd === null) return false;
  if (dd === undefined) return false;
  // Any other shape ({ not: null }, { lt: ... }, etc.) is a user filter.
  return true;
}

export async function customerCountFast(
  where: Prisma.CustomerWhereInput
): Promise<CustomerCountResult> {
  if (hasUserFilter(where)) {
    const total = await prisma.customer.count({ where });
    return { total, isApprox: false };
  }
  // Unfiltered (or filtered only by `deletedAt: null`). Read pg_class.reltuples
  // for an O(1) estimate. reltuples is float4; round to the nearest int.
  try {
    const rows = (await prisma.$queryRawUnsafe<{ reltuples: number }[]>(
      `SELECT reltuples::float8 AS reltuples FROM pg_class WHERE oid = '"Customer"'::regclass`
    )) ?? [];
    const raw = rows[0]?.reltuples;
    if (raw === undefined || raw === null || raw < 0) {
      // Stats not gathered yet: fall back to the exact count.
      const total = await prisma.customer.count({ where });
      return { total, isApprox: false };
    }
    return { total: Math.max(0, Math.round(raw)), isApprox: true };
  } catch {
    // pg_class read failed (permissions, weird search_path, etc.).
    // Always fall back to the exact count — correctness over speed.
    const total = await prisma.customer.count({ where });
    return { total, isApprox: false };
  }
}
