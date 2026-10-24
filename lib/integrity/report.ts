/**
 * Gap 29: what /status/integrity shows the Data Steward — the latest run of the
 * nightly checks, each check's last fourteen runs, the last ten seals and the
 * last thirty days of purge summaries. Reads only; ids and counts only.
 *
 * PURE of lib/db: the page passes its client.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { SealBody } from '../seal/chain';

type Db = Pick<PrismaClient, '$queryRaw' | 'integrityCheckResult' | 'purgeSummary' | 'branch' | 'customer'>;

export type ResultRow = {
  runAt: Date;
  checkId: string;
  status: string;
  count: number | null;
  sampleIds: string[];
  detail: Record<string, unknown> | null;
};

export type SealRow = { seq: number; day: string; hash: string; r2Key: string; rows: number; tables: number };

export type PurgeGroup = { rule: string; tableName: string; batches: number; rows: number; oldestAt: Date | null; newestAt: Date | null; lastAt: Date };

export type IntegrityReport = {
  latestRunAt: Date | null;
  latest: ResultRow[];
  /** Per check, its last fourteen statuses, oldest first. */
  trend: Map<string, string[]>;
  seals: SealRow[];
  purges: PurgeGroup[];
  /** A sample id that is a customer or a shop, as the customer to link to. */
  customerOf: Map<string, { id: string; code: string }>;
};

/**
 * The ids a result lists as information, not failure (its detail's `info`: the
 * migrated Temix codes with a space inside, the active customers whose open shops
 * are all suspended). At most ten; ids only.
 */
export function infoIds(r: Pick<ResultRow, 'detail'>): string[] {
  const v = r.detail?.info;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
}

/** Checks whose samples are customer ids, and those whose samples are shop ids. */
export const CUSTOMER_SAMPLES = new Set(['customer-status-follows-shops', 'temix-code-shared', 'temix-code-shape']);
export const SHOP_SAMPLES = new Set(['shop-region-matches-route']);

export async function loadIntegrityReport(db: Db, now: Date = new Date()): Promise<IntegrityReport> {
  const last = await db.integrityCheckResult.findFirst({ orderBy: { runAt: 'desc' }, select: { runAt: true } });
  const latest = last
    ? ((await db.integrityCheckResult.findMany({
        where: { runAt: last.runAt },
        orderBy: { id: 'asc' },
        select: { runAt: true, checkId: true, status: true, count: true, sampleIds: true, detail: true },
      })) as ResultRow[])
    : [];
  const runs = await db.$queryRaw<Array<{ runAt: Date }>>(
    Prisma.sql`SELECT DISTINCT "runAt" FROM "IntegrityCheckResult" ORDER BY "runAt" DESC LIMIT 14`
  );
  const trendRows = runs.length
    ? await db.integrityCheckResult.findMany({
        where: { runAt: { gte: runs.at(-1)!.runAt } },
        orderBy: { runAt: 'asc' },
        select: { checkId: true, status: true },
      })
    : [];
  const trend = new Map<string, string[]>();
  for (const r of trendRows) trend.set(r.checkId, [...(trend.get(r.checkId) ?? []), r.status]);

  const sealRows = await db.$queryRaw<Array<{ seq: number; day: string; hash: string; r2Key: string; bodyText: string }>>(
    Prisma.sql`SELECT "seq", "day"::text AS day, "hash", "r2Key", "bodyText" FROM "SealRecord" ORDER BY "seq" DESC LIMIT 10`
  );
  const seals = sealRows.map((s) => {
    let rows = 0;
    let tables = 0;
    try {
      const b = JSON.parse(s.bodyText) as SealBody;
      tables = b.tables.length;
      rows = b.tables.reduce((a, t) => a + t.n, 0);
    } catch {
      // An unreadable body is the chain check's to report.
    }
    return { seq: s.seq, day: s.day, hash: s.hash, r2Key: s.r2Key, rows, tables };
  });

  const purgeRows = await db.purgeSummary.groupBy({
    by: ['rule', 'tableName'],
    where: { at: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    _count: { _all: true },
    _sum: { rows: true },
    _min: { oldestAt: true },
    _max: { newestAt: true, at: true },
    orderBy: { rule: 'asc' },
  });
  const purges = purgeRows.map((p) => ({
    rule: p.rule,
    tableName: p.tableName,
    batches: p._count._all,
    rows: p._sum.rows ?? 0,
    oldestAt: p._min.oldestAt,
    newestAt: p._max.newestAt,
    lastAt: p._max.at!,
  }));

  // The customers behind the samples the page links, and behind the ones listed as information.
  const customerIds = latest.filter((r) => CUSTOMER_SAMPLES.has(r.checkId)).flatMap((r) => [...r.sampleIds, ...infoIds(r)]);
  const shopIds = latest.filter((r) => SHOP_SAMPLES.has(r.checkId)).flatMap((r) => r.sampleIds);
  const customerOf = new Map<string, { id: string; code: string }>();
  if (customerIds.length) {
    for (const c of await db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, nmwcCode: true } })) {
      customerOf.set(c.id, { id: c.id, code: c.nmwcCode });
    }
  }
  if (shopIds.length) {
    for (const b of await db.branch.findMany({
      where: { id: { in: shopIds } },
      select: { id: true, branchCode: true, customer: { select: { id: true } } },
    })) {
      customerOf.set(b.id, { id: b.customer.id, code: b.branchCode });
    }
  }
  return { latestRunAt: last?.runAt ?? null, latest, trend, seals, purges, customerOf };
}
