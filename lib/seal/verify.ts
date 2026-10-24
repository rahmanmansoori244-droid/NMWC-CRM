/**
 * Gap 28 (data audit 2026-10-10): check the stored seal chain against the
 * ledgers as they are now — used by the nightly integrity check (the last few
 * seals) and by scripts/ops/verify-seals.ts (all of them).
 *
 *   - every seal: its hash is the SHA-256 of its body, the body says what the
 *     columns say, it links to the one before with no gap, its ranges continue;
 *   - the seals in the window: each range recomputed from the ledger, and the
 *     off-site copy read back;
 *   - per table: the rows at or below the last seal's range now, against the sum
 *     of every seal's count (a deletion anywhere in the chain lowers it; a row
 *     slipped in below a sealed key raises it).
 *
 * Reads only. PURE of lib/db: the client and the store are passed in.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { countUpToSql } from './canon';
import { verifyChain, type Mismatch, type SealBody, type StoredSeal } from './chain';
import { allSeals, measureRange } from './seal';
import type { SealStore } from './store';

type Raw = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>;

export type RecheckOptions = {
  /** Recompute the ranges and read the copies of the last N seals; 'all' for every one. */
  window: number | 'all';
  /** Only seals in [fromSeq, toSeq] are recomputed (the links are always checked over the whole chain). */
  fromSeq?: number;
  toSeq?: number;
  /** The off-site store, or null not to read it. */
  offsite: SealStore | null;
  /** Called before each step, so a caller with a deadline can stop (throws to abort). */
  onStep?: () => void;
};

export type RecheckResult = {
  seals: StoredSeal[];
  /** The seals whose ranges and copies were read. */
  windowSeqs: number[];
  rangesRecomputed: number;
  mismatches: Mismatch[];
};

export async function recheckSeals(db: Raw, opts: RecheckOptions): Promise<RecheckResult> {
  const seals = await allSeals(db);
  const inRange = seals.filter((s) => s.seq >= (opts.fromSeq ?? 0) && s.seq <= (opts.toSeq ?? Number.MAX_SAFE_INTEGER));
  const window = opts.window === 'all' ? inRange : inRange.slice(-opts.window);
  const ranges = new Map<string, { n: number; digest: string }>();
  for (const s of window) {
    let body: SealBody;
    try {
      body = JSON.parse(s.bodyText) as SealBody;
    } catch {
      continue; // verifyChain reports the body
    }
    for (const e of body.tables ?? []) {
      if (BigInt(e.to) <= BigInt(e.from)) {
        ranges.set(`${s.seq}:${e.t}`, { n: 0, digest: e.digest });
        continue;
      }
      opts.onStep?.();
      ranges.set(`${s.seq}:${e.t}`, await measureRange(db, s.formatVersion, e.t, BigInt(e.from), BigInt(e.to)));
    }
  }
  const countsUpTo = new Map<string, number>();
  const last = seals.at(-1);
  if (last) {
    try {
      const body = JSON.parse(last.bodyText) as SealBody;
      for (const e of body.tables ?? []) {
        opts.onStep?.();
        const [r] = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ n: string }>>(
          countUpToSql(last.formatVersion, e.t, BigInt(e.to))
        );
        countsUpTo.set(e.t, Number(r?.n ?? 0));
      }
    } catch {
      // An unreadable last body is reported by verifyChain.
    }
  }
  const offsite = new Map<number, string | null>();
  if (opts.offsite) {
    for (const s of window) {
      opts.onStep?.();
      offsite.set(s.seq, await opts.offsite.get(s.r2Key));
    }
  }
  return {
    seals,
    windowSeqs: window.map((s) => s.seq),
    rangesRecomputed: ranges.size,
    mismatches: verifyChain({ seals, ranges, countsUpTo, offsite: opts.offsite ? offsite : undefined }),
  };
}
