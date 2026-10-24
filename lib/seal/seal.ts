/**
 * Gap 28 (data audit 2026-10-10): write the day's seal (lib/seal/chain.ts has
 * the rules, lib/seal/canon.ts what is covered).
 *
 * One REPEATABLE READ transaction, under an advisory lock and the job's change
 * context:
 *   1. the last seal; if it is today's, nothing to do ('already');
 *   2. the horizon: every transaction open at the last seal must have ended
 *      ('deferred' otherwise: tried again the next night);
 *   3. per sealed table, the count and digest of the range the last seal saw,
 *      and the highest key visible now;
 *   4. the body, its hash and the row. The database's link guard checks the
 *      hash, the seq and the previous hash again, and UNIQUE(seq) settles two
 *      writers at once.
 * The off-site copy is written after the commit (lib/seal/store.ts), by the
 * caller, so a slow R2 never holds the transaction.
 *
 * PURE of lib/db: the client is passed in.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { src, withChangeContext } from '../change-context';
import { omanDateISO } from '../tz';
import { SEAL_FORMAT_VERSION, maxKeySql, rangeDigestSql } from './canon';
import {
  buildSealBody,
  horizonDecision,
  planRanges,
  sealBodyText,
  sealObjectKey,
  type HorizonDecision,
  type SealBody,
  type StoredSeal,
} from './chain';

type Tx = Prisma.TransactionClient;
type Raw = Pick<PrismaClient, '$queryRaw'> | Pick<Tx, '$queryRaw'>;

export type SealOutcome =
  | { status: 'genesis' | 'sealed' | 'already'; seal: StoredSeal }
  | { status: 'deferred'; reason: string; lastSeq: number | null };

/** The transaction ids the horizon rule reads, and the restore check. */
export type HorizonReader = (
  tx: Tx,
  prevSealedAt: Date | null
) => Promise<{ xmin: bigint; xmax: bigint; currentXid: bigint; oldBackends: () => Promise<number> }>;

export const readHorizon: HorizonReader = async (tx, prevSealedAt) => {
  const [row] = await tx.$queryRaw<Array<{ xmin: string; xmax: string; cur: string }>>(
    Prisma.sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
                      pg_snapshot_xmax(pg_current_snapshot())::text AS xmax,
                      pg_current_xact_id()::text AS cur`
  );
  return {
    xmin: BigInt(row!.xmin),
    xmax: BigInt(row!.xmax),
    currentXid: BigInt(row!.cur),
    oldBackends: async () => {
      if (!prevSealedAt) return 0;
      const [r] = await tx.$queryRaw<Array<{ n: number }>>(
        Prisma.sql`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
                    WHERE pid <> pg_backend_pid() AND xact_start IS NOT NULL
                      AND xact_start < (${prevSealedAt.toISOString()}::timestamptz)`
      );
      return r?.n ?? 0;
    },
  };
};

type SealRow = {
  seq: number;
  day: string;
  formatVersion: number;
  prevHash: string | null;
  hash: string;
  bodyText: string;
  r2Key: string;
  snapshotXmax: string;
  sealedAt: Date;
};

const toStored = (r: SealRow): StoredSeal => ({ ...r, sealedAt: r.sealedAt.toISOString() });

const SEAL_COLUMNS = Prisma.sql`"seq", "day"::text AS "day", "formatVersion", "prevHash", "hash", "bodyText", "r2Key", "snapshotXmax"::text AS "snapshotXmax", "sealedAt"`;

/** The last seal, or null before the genesis. */
export async function lastSeal(db: Raw): Promise<StoredSeal | null> {
  const rows = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<SealRow[]>(
    Prisma.sql`SELECT ${SEAL_COLUMNS} FROM "SealRecord" ORDER BY "seq" DESC LIMIT 1`
  );
  return rows[0] ? toStored(rows[0]) : null;
}

/** Every seal, oldest first (a seal is a few hundred bytes: a year is well under a megabyte). */
export async function allSeals(db: Raw, range: { fromSeq?: number; toSeq?: number } = {}): Promise<StoredSeal[]> {
  const rows = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<SealRow[]>(
    Prisma.sql`SELECT ${SEAL_COLUMNS} FROM "SealRecord"
                WHERE "seq" >= ${range.fromSeq ?? 0} AND "seq" <= ${range.toSeq ?? 2_147_483_647}
                ORDER BY "seq"`
  );
  return rows.map(toStored);
}

/** The count and digest of one range, from the database. */
export async function measureRange(db: Raw, version: number, table: string, from: bigint, to: bigint): Promise<{ n: number; digest: string }> {
  const [r] = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ n: number; digest: string }>>(
    rangeDigestSql(version, table, from, to)
  );
  return { n: Number(r?.n ?? 0), digest: r?.digest ?? '' };
}

export type WriteSealOptions = {
  now?: Date;
  /** The scheduled job that writes it: the seal is written under src.cron(job). */
  job: string;
  horizon?: HorizonReader;
  /** Transaction limit; the nightly route keeps it inside its own budget. */
  timeoutMs?: number;
};

/** Write today's seal (see the header). */
export async function writeSeal(db: Pick<PrismaClient, '$transaction'>, opts: WriteSealOptions): Promise<SealOutcome> {
  const now = opts.now ?? new Date();
  const day = omanDateISO(now);
  const horizon = opts.horizon ?? readHorizon;
  return withChangeContext(
    db,
    { actorId: null, source: src.cron(opts.job) },
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('nmwc:seal', 42))`;
      const last = await lastSeal(tx);
      if (last && last.day === day) return { status: 'already', seal: last } as const;
      const prevBody = last ? (JSON.parse(last.bodyText) as SealBody) : null;
      const h = await horizon(tx, last ? new Date(last.sealedAt) : null);
      const decision: HorizonDecision = await horizonDecision({
        prev: last ? { snapshotXmax: BigInt(last.snapshotXmax), sealedAt: new Date(last.sealedAt) } : null,
        xmin: h.xmin,
        currentXid: h.currentXid,
        oldBackends: h.oldBackends,
      });
      if (decision.kind === 'deferred') return { status: 'deferred', reason: decision.reason, lastSeq: last?.seq ?? null } as const;

      const version = SEAL_FORMAT_VERSION;
      const tables: Array<{ t: string; from: bigint; to: bigint; n: number; digest: string; next: bigint }> = [];
      for (const r of planRanges(prevBody, version)) {
        const measured = r.to > r.from ? await measureRange(tx, version, r.t, r.from, r.to) : { n: 0, digest: '' };
        const [m] = await tx.$queryRaw<Array<{ next: string }>>(maxKeySql(version, r.t));
        tables.push({ ...r, ...measured, next: BigInt(m?.next ?? '0') });
      }
      const seq = last ? last.seq + 1 : 0;
      const body = buildSealBody({
        version,
        seq,
        day,
        sealedAt: now,
        prevHash: last?.hash ?? null,
        xmax: h.xmax,
        horizonReset: decision.kind === 'reset',
        tables,
      });
      const { bodyText, hash } = sealBodyText(body);
      const r2Key = sealObjectKey(version, day, seq, hash);
      await tx.$executeRaw`
        INSERT INTO "SealRecord" ("seq", "day", "formatVersion", "prevHash", "hash", "bodyText", "r2Key", "snapshotXmax", "sealedAt")
        VALUES (${seq}, ${day}::date, ${version}, ${last?.hash ?? null}::text, ${hash}, ${bodyText}, ${r2Key},
                ${h.xmax.toString()}::bigint, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`;
      const seal: StoredSeal = {
        seq,
        day,
        formatVersion: version,
        prevHash: last?.hash ?? null,
        hash,
        bodyText,
        r2Key,
        snapshotXmax: h.xmax.toString(),
        sealedAt: now.toISOString(),
      };
      return { status: seq === 0 ? 'genesis' : 'sealed', seal } as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: opts.timeoutMs ?? 40_000, maxWait: 10_000 }
  );
}
