/**
 * Gap 28 (data audit 2026-10-10): the seal chain, pure — the body of a seal, its
 * hash, which ranges the next seal covers, when it may be written, and how a
 * stored chain is checked. lib/seal/seal.ts and lib/seal/verify.ts give it the
 * database's numbers; scripts/ops/verify-seals.ts and the nightly check report
 * what it finds.
 *
 * The coverage rule (the lag and horizon rule). Sequence values are handed out
 * before commit, so a transaction holding a lower key can commit AFTER a seal
 * and land inside a range that seal already covered. So:
 *   - each seal records next[t], the highest key visible in its snapshot, and
 *     its snapshot's xmax;
 *   - seal k covers (to[k-1], next[k-1]] per table: the rows that were visible
 *     to the PREVIOUS seal (a table new to the format starts at (0, 0]);
 *   - and is written only once every transaction in flight at seal k-1 has
 *     ended: the current snapshot's xmin >= xmax[k-1]. Otherwise it is
 *     deferred to the next night;
 *   - a transaction counter that went back (a dump restored into a new
 *     database) is told by the current transaction id being below xmax[k-1]:
 *     then no backend may have a transaction older than seal k-1, and the seal
 *     says horizonReset.
 * The genesis (seq 0) covers nothing and records next and xmax; seal 1, the
 * next night, covers every ledger row that existed at the genesis. Residual
 * risk, stated: the microseconds between a nextval and the transaction id it
 * runs under being assigned.
 *
 * Canonical JSON: keys sorted, no spaces, big integers as decimal strings.
 */
import { createHash } from 'node:crypto';
import { EMPTY_DIGEST, sealedTables } from './canon';

export type SealTableEntry = {
  /** The table. */
  t: string;
  /** The range covered, from (exclusive) to (inclusive), as decimal strings. */
  from: string;
  to: string;
  /** Rows in the range, and the digest of them. */
  n: number;
  digest: string;
  /** The highest key visible to this seal: the next seal's `to`. */
  next: string;
};

export type SealBody = {
  v: number;
  seq: number;
  /** The Oman day of the run, YYYY-MM-DD. */
  day: string;
  sealedAt: string;
  prev: string | null;
  /** pg_snapshot_xmax of the sealing transaction, as a decimal string. */
  xmax: string;
  horizonReset?: true;
  tables: SealTableEntry[];
};

/** A seal as stored (SealRecord), with its big integers as strings. */
export type StoredSeal = {
  seq: number;
  day: string;
  formatVersion: number;
  prevHash: string | null;
  hash: string;
  bodyText: string;
  r2Key: string;
  snapshotXmax: string;
  sealedAt: string;
};

/** JSON with every object's keys sorted, BigInts as decimal strings, undefined left out. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON has no NaN or Infinity');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot hold a ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The bytes that are hashed, and their hash. */
export function sealBodyText(body: SealBody): { bodyText: string; hash: string } {
  const bodyText = canonicalJson(body);
  return { bodyText, hash: sha256Hex(bodyText) };
}

/** Where the off-site copy lives: seals/v<version>/<YYYY>/<day>-<seq, 6 digits>-<hash, 16>.json. */
export function sealObjectKey(version: number, day: string, seq: number, hash: string): string {
  return `seals/v${version}/${day.slice(0, 4)}/${day}-${String(seq).padStart(6, '0')}-${hash.slice(0, 16)}.json`;
}

/** The ranges the next seal covers (see the header). */
export function planRanges(prev: SealBody | null, version: number): Array<{ t: string; from: bigint; to: bigint }> {
  return sealedTables(version).map(({ table }) => {
    const before = prev?.tables.find((x) => x.t === table);
    if (!prev || !before) return { t: table, from: 0n, to: 0n };
    return { t: table, from: BigInt(before.to), to: BigInt(before.next) };
  });
}

export type HorizonInput = {
  /** The last seal's snapshot xmax and when it was made; null before the genesis. */
  prev: { snapshotXmax: bigint; sealedAt: Date } | null;
  /** The current snapshot's xmin, and this transaction's id. */
  xmin: bigint;
  currentXid: bigint;
  /** Backends whose transaction started before the last seal (read only on the restore path). */
  oldBackends: () => Promise<number>;
};

export type HorizonDecision = { kind: 'ok' } | { kind: 'reset' } | { kind: 'deferred'; reason: string };

/** Whether the next seal may be written now (see the header). */
export async function horizonDecision(h: HorizonInput): Promise<HorizonDecision> {
  if (!h.prev) return { kind: 'ok' };
  if (h.currentXid < h.prev.snapshotXmax) {
    // The counter went back: a restore. Every transaction older than the last
    // seal must be gone, or one could still commit into a sealed range.
    const old = await h.oldBackends();
    return old > 0
      ? { kind: 'deferred', reason: `transaction counter reset, ${old} transaction(s) older than the last seal still open` }
      : { kind: 'reset' };
  }
  if (h.xmin < h.prev.snapshotXmax) {
    return { kind: 'deferred', reason: 'a transaction that was open at the last seal is still open' };
  }
  return { kind: 'ok' };
}

/** The body of the next seal from the measured ranges. */
export function buildSealBody(input: {
  version: number;
  seq: number;
  day: string;
  sealedAt: Date;
  prevHash: string | null;
  xmax: bigint;
  horizonReset: boolean;
  tables: Array<{ t: string; from: bigint; to: bigint; n: number; digest: string; next: bigint }>;
}): SealBody {
  return {
    v: input.version,
    seq: input.seq,
    day: input.day,
    sealedAt: input.sealedAt.toISOString(),
    prev: input.prevHash,
    xmax: input.xmax.toString(),
    ...(input.horizonReset ? { horizonReset: true as const } : {}),
    tables: input.tables.map((t) => ({
      t: t.t,
      from: t.from.toString(),
      to: t.to.toString(),
      n: t.n,
      digest: t.n === 0 ? EMPTY_DIGEST : t.digest,
      next: t.next.toString(),
    })),
  };
}

// ── Checking a stored chain ─────────────────────────────────────────────────

export type MismatchKind =
  | 'body-edited'
  | 'chain-broken'
  | 'rows-deleted'
  | 'rows-added'
  | 'rows-changed'
  | 'offsite-missing'
  | 'offsite-differs';

export const MISMATCH_LABEL: Record<MismatchKind, string> = {
  'body-edited': 'body edited',
  'chain-broken': 'chain link broken',
  'rows-deleted': 'rows deleted (count lower)',
  'rows-added': 'rows added into a sealed range',
  'rows-changed': 'rows changed (same count, digest differs)',
  'offsite-missing': 'off-site copy missing',
  'offsite-differs': 'off-site copy differs',
};

export type Mismatch = {
  kind: MismatchKind;
  seq: number;
  day: string;
  table?: string;
  /** Counts and short hash prefixes only: never row content. */
  detail?: string;
};

export type ChainCheckInput = {
  seals: StoredSeal[];
  /** Recomputed ranges, by `${seq}:${table}`; seals not in it are not recomputed. */
  ranges?: Map<string, { n: number; digest: string }>;
  /**
   * Per table, how many rows now have a key at or below the last seal's `to`:
   * every row the chain covers. Compared with the sum of the seals' counts.
   */
  countsUpTo?: Map<string, number>;
  /** The off-site copy by seq: its text, null when it is missing; absent = not checked. */
  offsite?: Map<number, string | null>;
};

function parseBody(text: string): SealBody | null {
  try {
    const b = JSON.parse(text) as SealBody;
    return b && typeof b === 'object' && Array.isArray(b.tables) ? b : null;
  } catch {
    return null;
  }
}

const short = (h: string | null | undefined) => (h ? h.slice(0, 12) : 'none');

/**
 * Every mismatch in a stored chain, earliest seal first (within a seal: its
 * body, its link, its ranges, its off-site copy). The first one is where the
 * chain stops being trustworthy.
 */
export function verifyChain(input: ChainCheckInput): Mismatch[] {
  const out: Mismatch[] = [];
  const seals = [...input.seals].sort((a, b) => a.seq - b.seq);
  let prev: { seal: StoredSeal; body: SealBody | null } | null = null;
  const sums = new Map<string, number>();
  for (const [i, s] of seals.entries()) {
    const at = { seq: s.seq, day: s.day };
    const body = parseBody(s.bodyText);
    // 1. The body is what was hashed, and says what its columns say.
    if (sha256Hex(s.bodyText) !== s.hash) {
      out.push({ ...at, kind: 'body-edited', detail: `hash ${short(s.hash)} is not the SHA-256 of the body (${short(sha256Hex(s.bodyText))})` });
    } else if (
      !body ||
      body.seq !== s.seq ||
      body.day !== s.day ||
      body.prev !== s.prevHash ||
      body.v !== s.formatVersion ||
      body.xmax !== s.snapshotXmax ||
      canonicalJson(body) !== s.bodyText
    ) {
      out.push({ ...at, kind: 'body-edited', detail: 'the body disagrees with the seal’s own columns' });
    }
    // 2. It links to the one before, with no gap.
    const expectedSeq = i === 0 ? 0 : prev!.seal.seq + 1;
    if (s.seq !== expectedSeq) {
      out.push({ ...at, kind: 'chain-broken', detail: `seq ${s.seq} where ${expectedSeq} was expected` });
    } else if (i === 0 ? s.prevHash !== null : s.prevHash !== prev!.seal.hash) {
      out.push({ ...at, kind: 'chain-broken', detail: `previous hash ${short(s.prevHash)}, the seal before is ${short(prev?.seal.hash)}` });
    }
    // Its ranges continue the last ones (a table new to the format starts at 0).
    if (body && prev?.body) {
      for (const e of body.tables) {
        const before = prev.body.tables.find((x) => x.t === e.t);
        const expectedFrom = before ? before.to : '0';
        const expectedTo = before ? before.next : '0';
        if (e.from !== expectedFrom || e.to !== expectedTo) {
          out.push({ ...at, table: e.t, kind: 'chain-broken', detail: `range (${e.from}, ${e.to}] where (${expectedFrom}, ${expectedTo}] was due` });
        }
      }
    }
    // 3. Its ranges still hold the rows it sealed.
    for (const e of body?.tables ?? []) {
      sums.set(e.t, (sums.get(e.t) ?? 0) + e.n);
      const now = input.ranges?.get(`${s.seq}:${e.t}`);
      if (!now) continue;
      if (now.n < e.n) out.push({ ...at, table: e.t, kind: 'rows-deleted', detail: `${e.n} sealed, ${now.n} now` });
      else if (now.n > e.n) out.push({ ...at, table: e.t, kind: 'rows-added', detail: `${e.n} sealed, ${now.n} now` });
      else if (now.digest !== e.digest) {
        out.push({ ...at, table: e.t, kind: 'rows-changed', detail: `${e.n} rows, digest ${short(e.digest)} sealed, ${short(now.digest)} now` });
      }
    }
    // 4. The off-site copy is the same text.
    if (input.offsite?.has(s.seq)) {
      const copy = input.offsite.get(s.seq);
      if (copy === null || copy === undefined) out.push({ ...at, kind: 'offsite-missing', detail: s.r2Key });
      else if (copy !== s.bodyText) out.push({ ...at, kind: 'offsite-differs', detail: `copy ${short(sha256Hex(copy))}, seal ${short(s.hash)}` });
    }
    prev = { seal: s, body };
  }
  // 5. Every covered row is still there, and no row was slipped in below the last range.
  const last = seals.at(-1);
  if (last && input.countsUpTo) {
    for (const [t, now] of input.countsUpTo) {
      const sealed = sums.get(t) ?? 0;
      if (now < sealed) out.push({ seq: last.seq, day: last.day, table: t, kind: 'rows-deleted', detail: `${sealed} sealed in all, ${now} now` });
      else if (now > sealed) out.push({ seq: last.seq, day: last.day, table: t, kind: 'rows-added', detail: `${sealed} sealed in all, ${now} now` });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Whether a missing off-site copy is young enough to be written again (a failed upload), not a failure. */
export function offsiteRetryable(seal: Pick<StoredSeal, 'sealedAt'>, now: Date, maxAgeDays = 2): boolean {
  return now.getTime() - new Date(seal.sealedAt).getTime() <= maxAgeDays * 24 * 60 * 60 * 1000;
}
