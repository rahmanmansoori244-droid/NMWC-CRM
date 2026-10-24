// @vitest-environment node
/**
 * Gap 28 (data audit 2026-10-10): the daily seal chain (lib/seal/*), on fakes.
 *
 *  - The body is canonical and its hash deterministic.
 *  - The genesis covers nothing; seal 1 covers (0, next0]; every seal k covers
 *    (to[k-1], next[k-1]] — the rows the previous seal could see.
 *  - A seal is deferred while a transaction open at the last seal is still
 *    open; a restored database (the counter went back) seals with horizonReset
 *    once no older transaction is left.
 *  - verifyChain finds the first mismatch and names it: body edited, link
 *    broken, seq gap, rows changed, deleted, or slipped into a sealed range,
 *    off-site copy missing or different. The earliest seal wins.
 *  - The nightly recheck reads the last seven seals; a missing copy is
 *    re-uploaded only while the seal is at most two days old.
 *
 * The fake ledger rows are opaque strings; the digest is the same algorithm the
 * database runs (lib/seal/canon.ts), recomputed here in JavaScript.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildSealBody,
  canonicalJson,
  horizonDecision,
  offsiteRetryable,
  planRanges,
  sealBodyText,
  sealObjectKey,
  sha256Hex,
  verifyChain,
  type SealBody,
  type StoredSeal,
} from '@/lib/seal/chain';
import { EMPTY_DIGEST, SEAL_FORMAT_VERSION, sealedTables } from '@/lib/seal/canon';
import { writeSeal, type HorizonReader } from '@/lib/seal/seal';
import { recheckSeals } from '@/lib/seal/verify';
import { ensureOffsite, type SealStore } from '@/lib/seal/store';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const TABLES = sealedTables(SEAL_FORMAT_VERSION).map((t) => t.table);

// ── A fake database: ledgers of opaque rows by key, and the SealRecord table ──

type Fake = {
  rows: Map<string, Map<bigint, string>>;
  seals: StoredSeal[];
  horizon: { xmin: bigint; xmax: bigint; currentXid: bigint; oldBackends: number };
};

function fakeDb(): Fake & { db: never; tx: Record<string, unknown> } {
  const f: Fake = { rows: new Map(TABLES.map((t) => [t, new Map()])), seals: [], horizon: { xmin: 100n, xmax: 101n, currentXid: 100n, oldBackends: 0 } };
  const digestOf = (t: string, from: bigint, to: bigint) => {
    const keys = [...f.rows.get(t)!.keys()].filter((k) => k > from && k <= to).sort((a, b) => (a < b ? -1 : 1));
    return { n: keys.length, digest: sha(keys.map((k) => sha(f.rows.get(t)!.get(k)!)).join('')) };
  };
  const tableOf = (sql: string) => /FROM "(\w+)" t/.exec(sql)?.[1] ?? '';
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray | { sql: string }, ...values: unknown[]) => {
      const text = Array.isArray(strings) ? (strings as TemplateStringsArray).join('?') : (strings as { sql: string }).sql;
      if (text.includes('INSERT INTO "SealRecord"')) {
        const [seq, day, formatVersion, prevHash, hash, bodyText, r2Key, xmax, sealedAt] = values as [
          number, string, number, string | null, string, string, string, string, string,
        ];
        // The database's link guard, restated.
        expect(sha(bodyText)).toBe(hash);
        const last = f.seals.at(-1);
        expect(seq).toBe(last ? last.seq + 1 : 0);
        expect(prevHash).toBe(last ? last.hash : null);
        f.seals.push({ seq, day, formatVersion, prevHash, hash, bodyText, r2Key, snapshotXmax: xmax, sealedAt });
      }
      return 1;
    },
    $queryRaw: async (q: { sql: string; values: unknown[] }) => {
      if (q.sql.includes('FROM "SealRecord"') && q.sql.includes('DESC LIMIT 1')) {
        const s = f.seals.at(-1);
        return s ? [{ ...s, sealedAt: new Date(s.sealedAt) }] : [];
      }
      if (q.sql.includes('FROM "SealRecord"')) return f.seals.map((s) => ({ ...s, sealedAt: new Date(s.sealedAt) }));
      if (q.sql.includes('string_agg')) {
        const [from, to] = q.values.map((v) => BigInt(v as string)) as [bigint, bigint];
        return [digestOf(tableOf(q.sql), from, to)];
      }
      if (q.sql.includes('COALESCE(max(')) {
        const keys = [...f.rows.get(tableOf(q.sql))!.keys()];
        return [{ next: (keys.length ? keys.reduce((a, b) => (a > b ? a : b)) : 0n).toString() }];
      }
      if (q.sql.includes('count(*)::text AS n')) {
        const to = BigInt(q.values[0] as string);
        return [{ n: String([...f.rows.get(tableOf(q.sql))!.keys()].filter((k) => k <= to).length) }];
      }
      throw new Error(`unexpected query ${q.sql.slice(0, 60)}`);
    },
  };
  const db = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
  return Object.assign(f, { db: db as never, tx });
}

const injected = (f: Fake): HorizonReader => async () => ({
  xmin: f.horizon.xmin,
  xmax: f.horizon.xmax,
  currentXid: f.horizon.currentXid,
  oldBackends: async () => f.horizon.oldBackends,
});

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 2, 30)); // 06:30 Oman on 2026-10-d
const add = (f: Fake, t: string, key: bigint, row = `${t}#${key}`) => f.rows.get(t)!.set(key, row);
const bodyOf = (s: StoredSeal) => JSON.parse(s.bodyText) as SealBody;
const entry = (s: StoredSeal, t: string) => bodyOf(s).tables.find((e) => e.t === t)!;
const seal = (f: Fake & { db: never }, d: number) => writeSeal(f.db, { now: day(d), job: 'integrity-watch', horizon: injected(f) });

describe('the body and its hash', () => {
  it('canonical JSON: sorted keys, no spaces, BigInts as strings, undefined left out', () => {
    expect(canonicalJson({ b: 1, a: [2n, 'x'], c: undefined, d: { z: null, y: true } })).toBe('{"a":["2","x"],"b":1,"d":{"y":true,"z":null}}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });

  it('the same seal always gives the same text and hash', () => {
    const input = {
      version: 1,
      seq: 3,
      day: '2026-10-24',
      sealedAt: new Date('2026-10-24T02:30:00.000Z'),
      prevHash: 'a'.repeat(64),
      xmax: 12345n,
      horizonReset: false,
      tables: [{ t: 'AuditLog', from: 10n, to: 20n, n: 10, digest: 'd'.repeat(64), next: 25n }],
    };
    const a = sealBodyText(buildSealBody(input));
    const b = sealBodyText(buildSealBody({ ...input }));
    expect(a).toEqual(b);
    expect(a.hash).toBe(sha256Hex(a.bodyText));
    expect(a.bodyText).toBe(
      '{"day":"2026-10-24","prev":"' + 'a'.repeat(64) + '","sealedAt":"2026-10-24T02:30:00.000Z","seq":3,"tables":[{"digest":"' +
        'd'.repeat(64) + '","from":"10","n":10,"next":"25","t":"AuditLog","to":"20"}],"v":1,"xmax":"12345"}'
    );
    // An empty range carries the digest of nothing.
    expect(buildSealBody({ ...input, tables: [{ ...input.tables[0]!, n: 0, digest: '' }] }).tables[0]!.digest).toBe(EMPTY_DIGEST);
    expect(EMPTY_DIGEST).toBe(sha(''));
    expect(sealObjectKey(1, '2026-10-24', 3, a.hash)).toBe(`seals/v1/2026/2026-10-24-000003-${a.hash.slice(0, 16)}.json`);
  });
});

describe('what each seal covers', () => {
  it('the genesis covers nothing; seal 1 every row the genesis saw; seal k what seal k-1 saw', async () => {
    const f = fakeDb();
    add(f, 'AuditLog', 1n);
    add(f, 'AuditLog', 2n);
    add(f, 'CustomerHistory', 7n);
    const g = await seal(f, 20);
    expect(g.status).toBe('genesis');
    const s0 = f.seals[0]!;
    expect(entry(s0, 'AuditLog')).toMatchObject({ from: '0', to: '0', n: 0, next: '2' });
    expect(entry(s0, 'CustomerHistory')).toMatchObject({ from: '0', to: '0', n: 0, next: '7' });

    add(f, 'AuditLog', 3n); // arrives after the genesis: sealed by seal 2, not 1
    f.horizon = { xmin: 200n, xmax: 205n, currentXid: 201n, oldBackends: 0 };
    expect((await seal(f, 21)).status).toBe('sealed');
    const s1 = f.seals[1]!;
    expect(entry(s1, 'AuditLog')).toMatchObject({ from: '0', to: '2', n: 2, next: '3' });
    expect(entry(s1, 'CustomerHistory')).toMatchObject({ from: '0', to: '7', n: 1, next: '7' });
    expect(s1.prevHash).toBe(s0.hash);

    f.horizon = { xmin: 300n, xmax: 300n, currentXid: 300n, oldBackends: 0 };
    await seal(f, 22);
    expect(entry(f.seals[2]!, 'AuditLog')).toMatchObject({ from: '2', to: '3', n: 1, next: '3' });
    expect(entry(f.seals[2]!, 'CustomerHistory')).toMatchObject({ from: '7', to: '7', n: 0, digest: EMPTY_DIGEST });
    // And the chain verifies clean.
    const r = await recheckSeals(f.tx as never, { window: 'all', offsite: null });
    expect(r.mismatches).toEqual([]);
  });

  it('a second run the same Oman day does nothing', async () => {
    const f = fakeDb();
    await seal(f, 20);
    const again = await writeSeal(f.db, { now: new Date(day(20).getTime() + 3 * 3600_000), job: 'integrity-watch', horizon: injected(f) });
    expect(again.status).toBe('already');
    expect(f.seals).toHaveLength(1);
  });

  it('a range never goes backwards: the newest row deleted between seals leaves an empty range, and the totals say so', async () => {
    const f = fakeDb();
    for (const k of [1n, 2n, 3n]) add(f, 'AuditLog', k);
    await seal(f, 20); // genesis: next 3
    f.horizon = { xmin: 500n, xmax: 500n, currentXid: 500n, oldBackends: 0 };
    await seal(f, 21); // (0, 3]
    f.rows.get('AuditLog')!.delete(3n); // the newest row goes: the highest key is now 2
    f.horizon = { xmin: 600n, xmax: 600n, currentXid: 600n, oldBackends: 0 };
    await seal(f, 22); // (3, 3], next 2
    f.horizon = { xmin: 700n, xmax: 700n, currentXid: 700n, oldBackends: 0 };
    await seal(f, 23);
    expect(entry(f.seals[3]!, 'AuditLog')).toMatchObject({ from: '3', to: '3', n: 0 });
    const ms = (await recheckSeals(f.tx as never, { window: 'all', offsite: null })).mismatches;
    expect(ms.filter((m) => m.kind === 'chain-broken')).toEqual([]);
    expect(ms[0]).toMatchObject({ kind: 'rows-deleted', seq: 1, table: 'AuditLog' });
  });

  it('a table new to the format starts at (0, 0]', () => {
    const prev = { v: 1, seq: 0, day: 'x', sealedAt: 'x', prev: null, xmax: '1', tables: [{ t: 'AuditLog', from: '0', to: '0', n: 0, digest: EMPTY_DIGEST, next: '9' }] };
    const plan = planRanges(prev, 1);
    expect(plan.find((p) => p.t === 'AuditLog')).toEqual({ t: 'AuditLog', from: 0n, to: 9n });
    expect(plan.find((p) => p.t === 'PurgeSummary')).toEqual({ t: 'PurgeSummary', from: 0n, to: 0n });
  });
});

describe('the horizon', () => {
  const prev = { snapshotXmax: 500n, sealedAt: new Date('2026-10-20T02:30:00Z') };
  it('deferred while a transaction open at the last seal is still open; written once it has ended', async () => {
    expect(await horizonDecision({ prev, xmin: 499n, currentXid: 600n, oldBackends: async () => 0 })).toMatchObject({ kind: 'deferred' });
    expect(await horizonDecision({ prev, xmin: 500n, currentXid: 600n, oldBackends: async () => 0 })).toEqual({ kind: 'ok' });
    expect(await horizonDecision({ prev: null, xmin: 1n, currentXid: 1n, oldBackends: async () => 9 })).toEqual({ kind: 'ok' });
  });

  it('a restored database (the counter went back): reset once nothing older than the last seal is open', async () => {
    expect(await horizonDecision({ prev, xmin: 3n, currentXid: 4n, oldBackends: async () => 2 })).toMatchObject({ kind: 'deferred' });
    expect(await horizonDecision({ prev, xmin: 3n, currentXid: 4n, oldBackends: async () => 0 })).toEqual({ kind: 'reset' });
  });

  it('writeSeal defers and writes nothing; a reset seal says so in its body', async () => {
    const f = fakeDb();
    f.horizon = { xmin: 100n, xmax: 150n, currentXid: 100n, oldBackends: 0 };
    await seal(f, 20);
    f.horizon = { xmin: 120n, xmax: 160n, currentXid: 160n, oldBackends: 0 };
    const d = await seal(f, 21);
    expect(d).toMatchObject({ status: 'deferred', lastSeq: 0 });
    expect(f.seals).toHaveLength(1);
    f.horizon = { xmin: 5n, xmax: 6n, currentXid: 5n, oldBackends: 0 };
    await seal(f, 22);
    expect(bodyOf(f.seals[1]!).horizonReset).toBe(true);
  });
});

describe('verifyChain names the first mismatch', () => {
  async function chain() {
    const f = fakeDb();
    for (let k = 1n; k <= 5n; k++) add(f, 'AuditLog', k);
    add(f, 'BranchHistory', 1n);
    await seal(f, 20);
    for (const [i, d] of [21, 22, 23].entries()) {
      f.horizon = { xmin: 1000n * BigInt(i + 1), xmax: 1000n * BigInt(i + 1), currentXid: 1000n * BigInt(i + 1), oldBackends: 0 };
      add(f, 'AuditLog', 6n + BigInt(i));
      await seal(f, d);
    }
    return f;
  }
  const kinds = async (f: Fake & { tx: Record<string, unknown> }, offsite: SealStore | null = null) =>
    (await recheckSeals(f.tx as never, { window: 'all', offsite })).mismatches;

  it('a clean chain has none', async () => {
    expect(await kinds(await chain())).toEqual([]);
  });

  it('a ledger row changed (same count): rows changed, at the seal that covered it', async () => {
    const f = await chain();
    f.rows.get('AuditLog')!.set(3n, 'tampered');
    const [first] = await kinds(f);
    expect(first).toMatchObject({ kind: 'rows-changed', seq: 1, table: 'AuditLog' });
  });

  it('a ledger row deleted: rows deleted, in its range and in the totals', async () => {
    const f = await chain();
    f.rows.get('AuditLog')!.delete(2n);
    const all = await kinds(f);
    expect(all[0]).toMatchObject({ kind: 'rows-deleted', seq: 1, table: 'AuditLog', detail: '5 sealed, 4 now' });
    expect(all.at(-1)).toMatchObject({ kind: 'rows-deleted', seq: 3, table: 'AuditLog' });
  });

  it('a row slipped in below a sealed key: rows added', async () => {
    // Keys 1 and 3 are sealed; key 2 (an id handed out and never committed, say)
    // appears afterwards inside the sealed range.
    const g = fakeDb();
    add(g, 'AuditLog', 1n);
    add(g, 'AuditLog', 3n);
    await seal(g, 20);
    g.horizon = { xmin: 900n, xmax: 900n, currentXid: 900n, oldBackends: 0 };
    await seal(g, 21);
    add(g, 'AuditLog', 2n, 'slipped in');
    const [first] = await kinds(g);
    expect(first).toMatchObject({ kind: 'rows-added', seq: 1, table: 'AuditLog', detail: '2 sealed, 3 now' });
  });

  it('a seal’s body edited: body edited; a link broken; a seq gap', async () => {
    const f = await chain();
    const edited = structuredClone(f.seals);
    edited[2]!.bodyText = edited[2]!.bodyText.replace('"n":1', '"n":2');
    expect(verifyChain({ seals: edited })[0]).toMatchObject({ kind: 'body-edited', seq: 2 });

    // A body rewritten with its hash recomputed still breaks the next seal's link.
    const rehashed = structuredClone(f.seals);
    rehashed[1]!.bodyText = rehashed[1]!.bodyText.replace('"n":5', '"n":4');
    rehashed[1]!.hash = sha256Hex(rehashed[1]!.bodyText);
    expect(verifyChain({ seals: rehashed })[0]).toMatchObject({ kind: 'chain-broken', seq: 2 });

    const gap = structuredClone(f.seals).filter((s) => s.seq !== 2);
    expect(verifyChain({ seals: gap })[0]).toMatchObject({ kind: 'chain-broken', seq: 3, detail: 'seq 3 where 2 was expected' });
  });

  it('the earliest mismatch wins', async () => {
    const f = await chain();
    f.rows.get('AuditLog')!.set(7n, 'tampered late'); // seal 3's range
    f.rows.get('BranchHistory')!.set(1n, 'tampered early'); // seal 1's range
    const [first, second] = await kinds(f);
    expect(first).toMatchObject({ seq: 1, table: 'BranchHistory', kind: 'rows-changed' });
    expect(second).toMatchObject({ seq: 3, table: 'AuditLog', kind: 'rows-changed' });
  });

  it('the off-site copy: missing, different, or the same', async () => {
    const f = await chain();
    const copies = new Map(f.seals.map((s) => [s.r2Key, s.bodyText] as const));
    copies.delete(f.seals[1]!.r2Key);
    copies.set(f.seals[2]!.r2Key, f.seals[2]!.bodyText + ' ');
    const store: SealStore = { get: async (k) => copies.get(k) ?? null, put: async () => undefined };
    const found = await kinds(f, store);
    expect(found.map((m) => [m.seq, m.kind])).toEqual([
      [1, 'offsite-missing'],
      [2, 'offsite-differs'],
    ]);
  });
});

describe('the nightly recheck window and the off-site copy', () => {
  it('recomputes the last seven seals only, but checks every link', async () => {
    const f = fakeDb();
    add(f, 'AuditLog', 1n);
    for (let d = 1; d <= 10; d++) {
      f.horizon = { xmin: BigInt(d * 10), xmax: BigInt(d * 10), currentXid: BigInt(d * 10), oldBackends: 0 };
      add(f, 'AuditLog', BigInt(d + 1));
      await seal(f, d);
    }
    const r = await recheckSeals(f.tx as never, { window: 7, offsite: null });
    expect(r.windowSeqs).toEqual([3, 4, 5, 6, 7, 8, 9]);
    // A change in seal 1's range is outside the window for the ranges...
    f.rows.get('AuditLog')!.set(1n, 'tampered');
    expect((await recheckSeals(f.tx as never, { window: 7, offsite: null })).mismatches).toEqual([]);
    // ...but a deletion there still shows in the totals.
    f.rows.get('AuditLog')!.delete(1n);
    expect((await recheckSeals(f.tx as never, { window: 7, offsite: null })).mismatches[0]).toMatchObject({ kind: 'rows-deleted', seq: 9 });
  });

  it('ensureOffsite puts an absent copy, accepts the same one, and reports a different one', async () => {
    const store = new Map<string, string>();
    const s: SealStore = { get: async (k) => store.get(k) ?? null, put: async (k, b) => void store.set(k, b) };
    const one = { r2Key: 'seals/v1/2026/x.json', bodyText: '{"a":1}', hash: sha('{"a":1}') };
    expect(await ensureOffsite(s, one)).toBe('stored');
    expect(await ensureOffsite(s, one)).toBe('present');
    store.set(one.r2Key, '{"a":2}');
    expect(await ensureOffsite(s, one)).toBe('differs');
  });

  it('a missing copy is uploaded again only while the seal is at most two days old', () => {
    const now = new Date('2026-10-24T02:30:00Z');
    expect(offsiteRetryable({ sealedAt: '2026-10-23T02:30:00.000Z' }, now)).toBe(true);
    expect(offsiteRetryable({ sealedAt: '2026-10-22T02:30:00.000Z' }, now)).toBe(true);
    expect(offsiteRetryable({ sealedAt: '2026-10-22T02:29:00.000Z' }, now)).toBe(false);
  });
});
