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
 * The lag means a row is hashed for good only by the seal of the night after
 * next (24 to 48 hours after it is written). So that the rows waiting for it are
 * not unwatched in between, every seal after the genesis also records `pn` and
 * `pdigest`: the count and digest of the range the NEXT seal will cover, as this
 * seal sees it. Late commits may only ADD rows to that range, so the next seal
 * must find at least `pn` rows there, and exactly `pdigest` when it finds `pn`
 * (verifyChain step 3b). What is left unwatched is a row's first hours: from its
 * write to the first seal after it (at most a day). An edit or deletion before
 * then leaves no trace (docs/HISTORY.md section 11).
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
  /**
   * The rows of the next seal's range (nextRange of this entry) as THIS seal saw
   * them: their count and digest. Absent on the genesis, which does not hash the
   * rows that exist before it.
   */
  pn?: number;
  pdigest?: string;
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

/** Every off-site copy lives under this prefix, and nothing else does. */
export const SEAL_KEY_PREFIX = 'seals/';
/** The key layout (not the body's format version: one layout holds every format). */
const SEAL_KEY_LAYOUT = 'v1';
const SEAL_KEY_RE = /^seals\/v1\/([0-9a-f]{16})\/(\d{8})\.json$/;

/**
 * Where the off-site copy of seal `seq` of a chain lives:
 * seals/v1/<the genesis seal's hash, 16>/<seq, 8 digits>.json.
 *
 * Fixed by the chain and the seq alone, never by the seal's own hash or day: a
 * second body for the same seq lands on the SAME key, so a write-once lock on
 * seals/ refuses it and the nightly check reads back the original ('differs'). A
 * chain started again from a new genesis (a restore without the seal table) gets
 * its own folder, and the old chain's copies stay where they are.
 */
export function sealObjectKey(genesisHash: string, seq: number): string {
  if (!/^[0-9a-f]{16,64}$/.test(genesisHash)) throw new Error('a seal key needs the genesis seal’s hash');
  if (!Number.isInteger(seq) || seq < 0 || seq > 99_999_999) throw new Error(`no seal key for seq ${seq}`);
  return `${SEAL_KEY_PREFIX}${SEAL_KEY_LAYOUT}/${genesisHash.slice(0, 16)}/${String(seq).padStart(8, '0')}.json`;
}

/** The chain and seq a key names, or null when it is not a seal key of this layout. */
export function parseSealObjectKey(key: string): { chain: string; seq: number } | null {
  const m = SEAL_KEY_RE.exec(key);
  return m ? { chain: m[1]!, seq: Number(m[2]) } : null;
}

/**
 * The key a stored seal's copy must have: computed from the chain's genesis, never
 * read from the seal's own r2Key column (which nothing hashes). Without a genesis
 * the chain is already broken (verifyChain says so), and the column is all there is.
 */
export function expectedSealKey(
  seals: ReadonlyArray<Pick<StoredSeal, 'seq' | 'hash'>>,
  seal: Pick<StoredSeal, 'seq' | 'hash' | 'r2Key'>
): string {
  const genesis = seal.seq === 0 ? seal : seals.find((s) => s.seq === 0);
  return genesis && /^[0-9a-f]{64}$/.test(genesis.hash) ? sealObjectKey(genesis.hash, seal.seq) : seal.r2Key;
}

/**
 * The range a seal covers after `before`: from its `to` up to the highest key it
 * saw. Never backwards: if the highest key went DOWN since (the newest rows were
 * deleted in a maintenance window), the range is empty. Those rows were seen by
 * the seal before (its `pn` counted them), so the deletion shows as rows deleted
 * before they were sealed (verifyChain step 3b) — not in the totals of step 5,
 * which count only what a seal hashed.
 */
export function nextRange(before: Pick<SealTableEntry, 'to' | 'next'>): { from: bigint; to: bigint } {
  const from = BigInt(before.to);
  const next = BigInt(before.next);
  return { from, to: next > from ? next : from };
}

/** The ranges the next seal covers (see the header). */
export function planRanges(prev: SealBody | null, version: number): Array<{ t: string; from: bigint; to: bigint }> {
  return sealedTables(version).map(({ table }) => {
    const before = prev?.tables.find((x) => x.t === table);
    if (!prev || !before) return { t: table, from: 0n, to: 0n };
    return { t: table, ...nextRange(before) };
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
  tables: Array<{ t: string; from: bigint; to: bigint; n: number; digest: string; next: bigint; pn?: number; pdigest?: string }>;
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
      ...(t.pn === undefined ? {} : { pn: t.pn, pdigest: t.pn === 0 ? EMPTY_DIGEST : (t.pdigest ?? '') }),
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
  | 'rows-deleted-before-seal'
  | 'rows-changed-before-seal'
  | 'offsite-missing'
  | 'offsite-differs'
  | 'offsite-unexpected'
  | 'offsite-key-mismatch';

export const MISMATCH_LABEL: Record<MismatchKind, string> = {
  'body-edited': 'body edited',
  'chain-broken': 'chain link broken',
  'rows-deleted': 'rows deleted (count lower)',
  'rows-added': 'rows added into a sealed range',
  'rows-changed': 'rows changed (same count, digest differs)',
  'rows-deleted-before-seal': 'rows deleted before they were sealed (fewer than the seal before saw)',
  'rows-changed-before-seal': 'rows changed before they were sealed (as many as the seal before saw, digest differs)',
  'offsite-missing': 'off-site copy missing',
  'offsite-differs': 'off-site copy differs',
  'offsite-unexpected': 'an off-site object that is no seal of this chain',
  'offsite-key-mismatch': 'the seal names another off-site key than its own',
};

export type Mismatch = {
  kind: MismatchKind;
  seq: number;
  day: string;
  table?: string;
  /** Counts and short hash prefixes only: never row content. */
  detail?: string;
  /** Step 5's whole-chain count: shown at the last seal, but about no one seal. */
  totals?: true;
  /** For the totals: how many rows more or fewer than the seals counted. */
  delta?: number;
  /** For an off-site finding: the object's key. */
  key?: string;
};

/**
 * A mismatch's identity from one night to the next: its kind, its table, and
 * where — the seal it is in, the object key, or for the totals by how many rows.
 * Never the last seal's seq, which moves every night: a deletion found by the
 * totals is the same event tomorrow, and a second deletion (a new delta) is a new
 * one. Sixteen hex digits of a SHA-256: no row, no value.
 */
export function mismatchSignature(m: Pick<Mismatch, 'kind' | 'seq' | 'table' | 'totals' | 'delta' | 'key'>): string {
  const where = m.totals ? `totals:${m.delta ?? ''}` : m.key ? `key:${m.key}` : `seal:${m.seq}`;
  return sha256Hex(`${m.kind}|${m.table ?? ''}|${where}`).slice(0, 16);
}

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
  /** Every key under seals/ in the off-site store; absent = not listed. */
  listing?: string[];
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
        const due = before ? nextRange(before) : { from: 0n, to: 0n };
        const expectedFrom = due.from.toString();
        const expectedTo = due.to.toString();
        if (e.from !== expectedFrom || e.to !== expectedTo) {
          out.push({ ...at, table: e.t, kind: 'chain-broken', detail: `range (${e.from}, ${e.to}] where (${expectedFrom}, ${expectedTo}] was due` });
        }
      }
    }
    // 3b. What it sealed is at least what the seal before saw of the same range,
    // and the same rows when it is as many: late commits only add.
    if (body && prev?.body) {
      for (const e of body.tables) {
        const before = prev.body.tables.find((x) => x.t === e.t);
        if (!before || before.pn === undefined) continue;
        const due = nextRange(before);
        if (e.from !== due.from.toString() || e.to !== due.to.toString()) continue; // the link check above reports it
        if (e.n < before.pn) {
          out.push({ ...at, table: e.t, kind: 'rows-deleted-before-seal', detail: `${before.pn} seen by seal ${prev.seal.seq}, ${e.n} sealed` });
        } else if (e.n === before.pn && e.digest !== (before.pdigest ?? '')) {
          out.push({
            ...at,
            table: e.t,
            kind: 'rows-changed-before-seal',
            detail: `${e.n} rows, digest ${short(before.pdigest)} seen by seal ${prev.seal.seq}, ${short(e.digest)} sealed`,
          });
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
    // 4. The off-site copy is the same text, at the key the chain gives it.
    if (input.offsite?.has(s.seq)) {
      const key = expectedSealKey(seals, s);
      const copy = input.offsite.get(s.seq);
      if (copy === null || copy === undefined) out.push({ ...at, kind: 'offsite-missing', key, detail: key });
      else if (copy !== s.bodyText) out.push({ ...at, kind: 'offsite-differs', key, detail: `copy ${short(sha256Hex(copy))}, seal ${short(s.hash)}` });
    }
    prev = { seal: s, body };
  }
  // 4b. The listing of seals/: one object per seal at its own key, and nothing else.
  if (input.listing) {
    const checked = new Set(input.offsite?.keys() ?? []);
    for (const f of listingFindings(seals, input.listing, checked)) {
      const s = f.seq === null ? undefined : seals.find((x) => x.seq === f.seq);
      out.push({ kind: f.kind, seq: f.seq ?? -1, day: s?.day ?? '-', key: f.key, detail: f.why ? `${f.key} (${f.why})` : f.key });
    }
  }
  // 5. Every covered row is still there, and no row was slipped in below the last range.
  const last = seals.at(-1);
  if (last && input.countsUpTo) {
    for (const [t, now] of input.countsUpTo) {
      const sealed = sums.get(t) ?? 0;
      const totals = { seq: last.seq, day: last.day, table: t, totals: true as const, delta: Math.abs(now - sealed) };
      if (now < sealed) out.push({ ...totals, kind: 'rows-deleted', detail: `${sealed} sealed in all, ${now} now` });
      else if (now > sealed) out.push({ ...totals, kind: 'rows-added', detail: `${sealed} sealed in all, ${now} now` });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export type ListingFinding = {
  kind: 'offsite-missing' | 'offsite-unexpected' | 'offsite-key-mismatch';
  /** The seal it is about, or the seq an unexpected key names; null when the key names none. */
  seq: number | null;
  key: string;
  why?: string;
};

/**
 * What the listing of seals/ says against the stored chain (each seal's own key
 * is expectedSealKey):
 *   - a seal whose r2Key column is not its key: the database would point a check
 *     elsewhere (offsite-key-mismatch);
 *   - a seal whose key is not listed, unless it is in `checked` (read one by one,
 *     with the young-copy retry, by the caller): offsite-missing;
 *   - an object that is no seal's key: one for a seq after the last seal (the
 *     database's newest seals were removed), one in another chain's folder (the
 *     chain was started again, or rewritten from its genesis), one for a seq the
 *     chain has no seal at, or a key of no seal layout at all.
 * Keys and seqs only.
 */
export function listingFindings(
  seals: ReadonlyArray<Pick<StoredSeal, 'seq' | 'hash' | 'r2Key'>>,
  keys: readonly string[],
  checked: ReadonlySet<number> = new Set()
): ListingFinding[] {
  const out: ListingFinding[] = [];
  const listed = new Set(keys);
  const expected = new Set<string>();
  const genesis = seals.find((s) => s.seq === 0);
  const chain = genesis ? genesis.hash.slice(0, 16) : null;
  const lastSeq = seals.reduce((a, s) => Math.max(a, s.seq), -1);
  for (const s of [...seals].sort((a, b) => a.seq - b.seq)) {
    const key = expectedSealKey(seals, s);
    expected.add(key);
    if (s.r2Key !== key) out.push({ kind: 'offsite-key-mismatch', seq: s.seq, key: s.r2Key, why: `its key is ${key}` });
    if (!checked.has(s.seq) && !listed.has(key)) out.push({ kind: 'offsite-missing', seq: s.seq, key });
  }
  for (const key of [...listed].sort()) {
    if (expected.has(key)) continue;
    const p = parseSealObjectKey(key);
    if (!p) out.push({ kind: 'offsite-unexpected', seq: null, key, why: 'not a seal key' });
    else if (chain !== null && p.chain !== chain) out.push({ kind: 'offsite-unexpected', seq: p.seq, key, why: 'another chain' });
    else if (p.seq > lastSeq) out.push({ kind: 'offsite-unexpected', seq: p.seq, key, why: 'after the last seal' });
    else out.push({ kind: 'offsite-unexpected', seq: p.seq, key, why: 'no seal has this key' });
  }
  return out;
}

/** Whether a missing off-site copy is young enough to be written again (a failed upload), not a failure. */
export function offsiteRetryable(seal: Pick<StoredSeal, 'sealedAt'>, now: Date, maxAgeDays = 2): boolean {
  return now.getTime() - new Date(seal.sealedAt).getTime() <= maxAgeDays * 24 * 60 * 60 * 1000;
}
