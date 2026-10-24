/**
 * Gap 28 (data audit 2026-10-10): check the stored seal chain against the
 * ledgers as they are now — used by the nightly integrity check (the last few
 * seals and a rotating slice of the older ones) and by scripts/ops/verify-seals.ts
 * (all of them).
 *
 *   - every seal: its hash is the SHA-256 of its body, the body says what the
 *     columns say, it links to the one before with no gap, its ranges continue,
 *     and it sealed at least the rows the seal before saw of its range;
 *   - the seals in the window, and the rotating slice: each range recomputed
 *     from the ledger (the off-site copy read back when a store is given, at the
 *     key the chain gives it, and the whole of seals/ listed);
 *   - per table: the rows at or below the last seal's range now, against the sum
 *     of every seal's count (a deletion anywhere in the chain lowers it; a row
 *     slipped in below a sealed key raises it).
 *
 * The rotation: each night the window (the last seals) and, after the counts, a
 * slice of the older seals continuing from where the last night stopped, so that
 * every sealed range is re-digested at least once every `nights` nights while the
 * run's budget holds (an edit to an old row is found then, not only by
 * verify-seals). A slice that runs out of time stops between seals; the cursor
 * says where the next night goes on.
 *
 * Reads only. PURE of lib/db: the client and the store are passed in.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { countUpToSql } from './canon';
import { SEAL_KEY_PREFIX, expectedSealKey, verifyChain, type Mismatch, type SealBody, type StoredSeal } from './chain';
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
  /**
   * Also recompute a slice of the seals older than the window: as many as cover
   * them all in `nights` nights, continuing after seal `cursor` (the oldest after
   * the last one). `stop` is asked before each seal of the slice; true ends the
   * slice there, without an error.
   */
  rotation?: { cursor: number | null; nights: number; stop?: () => boolean };
};

export type RecheckResult = {
  seals: StoredSeal[];
  /** The seals whose ranges (and copies, with a store) were read. */
  windowSeqs: number[];
  /** The older seals recomputed tonight by the rotation. */
  rotatedSeqs: number[];
  /** Where the next night's rotation goes on (the last seal it recomputed). */
  rotationCursor: number | null;
  /** How many seals are older than the window. */
  olderSeals: number;
  rangesRecomputed: number;
  mismatches: Mismatch[];
};

/**
 * The older seals to recompute tonight: `count` of them (each once), in seq
 * order, starting after `cursor` and going round to the oldest.
 */
export function rotationSlice(older: readonly number[], cursor: number | null, count: number): number[] {
  if (older.length === 0 || count <= 0) return [];
  const sorted = [...older].sort((a, b) => a - b);
  let start = cursor === null ? 0 : sorted.findIndex((s) => s > cursor);
  if (start < 0) start = 0;
  return Array.from({ length: Math.min(count, sorted.length) }, (_, i) => sorted[(start + i) % sorted.length]!);
}

/** How many older seals a night recomputes so that all of them are covered in `nights` nights. */
export function rotationCount(older: number, nights: number): number {
  return older === 0 ? 0 : Math.ceil(older / Math.max(1, nights));
}

async function measureSeal(
  db: Raw,
  s: StoredSeal,
  ranges: Map<string, { n: number; digest: string }>,
  onStep?: () => void
): Promise<void> {
  let body: SealBody;
  try {
    body = JSON.parse(s.bodyText) as SealBody;
  } catch {
    return; // verifyChain reports the body
  }
  for (const e of body.tables ?? []) {
    if (BigInt(e.to) <= BigInt(e.from)) {
      ranges.set(`${s.seq}:${e.t}`, { n: 0, digest: e.digest });
      continue;
    }
    onStep?.();
    ranges.set(`${s.seq}:${e.t}`, await measureRange(db, s.formatVersion, e.t, BigInt(e.from), BigInt(e.to)));
  }
}

export async function recheckSeals(db: Raw, opts: RecheckOptions): Promise<RecheckResult> {
  const seals = await allSeals(db);
  const inRange = seals.filter((s) => s.seq >= (opts.fromSeq ?? 0) && s.seq <= (opts.toSeq ?? Number.MAX_SAFE_INTEGER));
  const window = opts.window === 'all' ? inRange : inRange.slice(-opts.window);
  const ranges = new Map<string, { n: number; digest: string }>();
  for (const s of window) await measureSeal(db, s, ranges, opts.onStep);

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

  // The rotation, after the counts, so a long slice never starves them.
  const inWindow = new Set(window.map((s) => s.seq));
  const older = inRange.filter((s) => !inWindow.has(s.seq)).map((s) => s.seq);
  const rotatedSeqs: number[] = [];
  if (opts.rotation) {
    const slice = rotationSlice(older, opts.rotation.cursor, rotationCount(older.length, opts.rotation.nights));
    for (const seq of slice) {
      if (opts.rotation.stop?.()) break;
      await measureSeal(db, seals.find((s) => s.seq === seq)!, ranges, opts.onStep);
      rotatedSeqs.push(seq);
    }
  }

  const offsite = new Map<number, string | null>();
  let listing: string[] | undefined;
  if (opts.offsite) {
    for (const s of window) {
      opts.onStep?.();
      offsite.set(s.seq, await opts.offsite.get(expectedSealKey(seals, s)));
    }
    opts.onStep?.();
    listing = await opts.offsite.list(SEAL_KEY_PREFIX);
  }
  return {
    seals,
    windowSeqs: window.map((s) => s.seq),
    rotatedSeqs,
    rotationCursor: rotatedSeqs.at(-1) ?? opts.rotation?.cursor ?? null,
    olderSeals: older.length,
    rangesRecomputed: ranges.size,
    mismatches: verifyChain({ seals, ranges, countsUpTo, offsite: opts.offsite ? offsite : undefined, listing }),
  };
}
