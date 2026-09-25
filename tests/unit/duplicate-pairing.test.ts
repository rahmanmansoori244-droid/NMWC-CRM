/**
 * Duplicate detection's pairing rules (lib/duplicate-pairing.ts), benchmark
 * item 16: until now nothing tested duplicate detection at all.
 *
 * Every assertion compares the exact set of pairs, so an extra pair fails as
 * surely as a missing one. What the rules deliberately do NOT catch yet (a name
 * with a doubled inner space, a customer whose matching branch is not its
 * first) is pinned as today's answer and marked with the open owner question,
 * so changing it is a decision, not an accident.
 */
import { describe, it, expect } from 'vitest';
import {
  pairCandidates,
  parseDismissed,
  pairKey,
  duplicatesSubtitle,
  crKey,
  tripleKey,
  type DupRow,
  type DuplicateCandidate,
} from '@/lib/duplicate-pairing';

function row(id: string, over: Partial<DupRow> = {}): DupRow {
  return {
    id,
    nmwcCode: `N-${id}`,
    legalName: `Shop ${id}`,
    primaryPhone: null,
    primaryPhoneNorm: null,
    crNumber: null,
    crNumberNorm: null,
    completenessScore: 50,
    branchCount: 1,
    firstRegionId: 'r1',
    ...over,
  };
}

/** Pairs as order-free "a|b:REASON" strings, sorted — for exact-set comparison. */
const set = (pairs: DuplicateCandidate[]) =>
  pairs.map((p) => `${pairKey(p.a.id, p.b.id)}:${p.reason}`).sort();

const none = new Set<string>();
const all = (rows: DupRow[], dismissed: ReadonlySet<string> = none) =>
  pairCandidates(rows, dismissed, Number.MAX_SAFE_INTEGER);

const cr = (id: string, value: string, over: Partial<DupRow> = {}) =>
  row(id, { crNumber: value, crNumberNorm: value, ...over });
const shop = (id: string, name: string, phone: string | null, region: string | null) =>
  row(id, { legalName: name, primaryPhone: phone, primaryPhoneNorm: phone, firstRegionId: region });

describe('rule 1 — the same CR number', () => {
  it('pairs two customers sharing a CR, whatever their regions', () => {
    const r = all([cr('a', '123', { firstRegionId: 'r1' }), cr('b', '123', { firstRegionId: 'r2' }), cr('c', '999')]);
    expect(set(r.pairs)).toEqual(['a|b:CR']);
    expect(r.total).toBe(1);
  });

  it('never groups a missing or empty CR', () => {
    const r = all([row('a'), row('b'), row('c', { crNumberNorm: '' }), row('d', { crNumberNorm: '' })]);
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('a group of three is three pairs and a group of four is six — never a customer with itself', () => {
    const three = all(['a', 'b', 'c'].map((id) => cr(id, '7')));
    expect(set(three.pairs)).toEqual(['a|b:CR', 'a|c:CR', 'b|c:CR']);
    const four = all(['a', 'b', 'c', 'd'].map((id) => cr(id, '7')));
    expect(set(four.pairs)).toEqual(['a|b:CR', 'a|c:CR', 'a|d:CR', 'b|c:CR', 'b|d:CR', 'c|d:CR']);
    expect(four.total).toBe(6);
  });

  it('compares the stored normalized CR, not the CR as typed', () => {
    const r = all([
      row('a', { crNumber: '12 34', crNumberNorm: '1234' }),
      row('b', { crNumber: '1234', crNumberNorm: '1234' }),
      row('c', { crNumber: '1234', crNumberNorm: '1234X' }),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:CR']);
  });
});

describe('rule 2 — the same name, phone and region', () => {
  it('ignores case and outer spaces in the name', () => {
    const r = all([
      shop('a', 'Al Noor Shop', '96899758980', 'r1'),
      shop('b', '  AL NOOR SHOP ', '96899758980', 'r1'),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE']);
    expect(r.total).toBe(1);
  });

  it('does not pair a different region, a missing phone, a customer with no live branch, or a different name', () => {
    const phone = '96899758980';
    expect(all([shop('a', 'X', phone, 'r1'), shop('b', 'X', phone, 'r2')]).pairs).toEqual([]);
    expect(all([shop('a', 'X', null, 'r1'), shop('b', 'X', null, 'r1')]).pairs).toEqual([]);
    expect(all([shop('a', 'X', phone, null), shop('b', 'X', phone, null)]).pairs).toEqual([]);
    // A phone alone is not a signal: one owner often runs many shops on one number.
    expect(all([shop('a', 'X', phone, 'r1'), shop('b', 'Y', phone, 'r1')]).pairs).toEqual([]);
  });

  it('compares the stored normalized phone, not the phone as typed', () => {
    const r = all([
      row('a', { legalName: 'X', primaryPhone: '9975 8980', primaryPhoneNorm: '96899758980' }),
      row('b', { legalName: 'X', primaryPhone: '+968 99758980', primaryPhoneNorm: '96899758980' }),
      row('c', { legalName: 'X', primaryPhone: '9975 8980', primaryPhoneNorm: '96899758981' }),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE']);
  });

  it('OPEN (owner, item 16 Q-name): a doubled inner space is still a different name today', () => {
    const r = all([
      shop('a', 'Al Noor  Shop', '96899758980', 'r1'),
      shop('b', 'Al Noor Shop', '96899758980', 'r1'),
    ]);
    expect(r.pairs).toEqual([]);
  });

  it('OPEN (owner, item 16 Q-region): only the first live branch region counts today', () => {
    // A has branches in r2 (first by code) and r1; B has one in r1. The create
    // guard would call them the same shop (any shared region); the detector,
    // as built, does not.
    const r = all([shop('a', 'X', '96899758980', 'r2'), shop('b', 'X', '96899758980', 'r1')]);
    expect(r.pairs).toEqual([]);
  });
});

describe('both rules together', () => {
  it('a pair matching both rules is listed once, as CR', () => {
    const r = all([
      cr('a', '5', { legalName: 'X', primaryPhoneNorm: '96899758980' }),
      cr('b', '5', { legalName: 'x', primaryPhoneNorm: '96899758980' }),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:CR']);
    expect(r.total).toBe(1);
  });

  it('CR pairs come first, and the summary carries exactly the display fields', () => {
    const r = all([
      shop('t1', 'X', '96899758980', 'r1'),
      shop('t2', 'X', '96899758980', 'r1'),
      cr('c1', '9', { branchCount: 3, completenessScore: 80 }),
      cr('c2', '9'),
    ]);
    expect(r.pairs.map((p) => p.reason)).toEqual(['CR', 'EXACT_TRIPLE']);
    expect(r.pairs[0]).toEqual({
      reason: 'CR',
      similarity: 1,
      a: {
        id: 'c1',
        nmwcCode: 'N-c1',
        legalName: 'Shop c1',
        primaryPhone: null,
        crNumber: '9',
        completenessScore: 80,
        branchCount: 3,
      },
      b: {
        id: 'c2',
        nmwcCode: 'N-c2',
        legalName: 'Shop c2',
        primaryPhone: null,
        crNumber: '9',
        completenessScore: 50,
        branchCount: 1,
      },
    });
  });
});

describe('dismissals — "Mark distinct"', () => {
  const trio = ['a', 'b', 'c'].map((id) => cr(id, '7'));

  it('hide the pair in both orders, and only that pair', () => {
    for (const written of ['a|b', 'b|a']) {
      const r = all(trio, parseDismissed([written]));
      expect(set(r.pairs)).toEqual(['a|c:CR', 'b|c:CR']);
      expect(r.total).toBe(2);
    }
  });

  it('the same pair dismissed twice, in both orders, is subtracted once', () => {
    const r = all(trio, parseDismissed(['a|b', 'b|a', 'a|b']));
    expect(r.total).toBe(2);
    expect(r.pairs).toHaveLength(2);
  });

  it('ignores malformed rows — including one that would hide a pair nobody dismissed', () => {
    const d = parseDismissed(['a', '|b', 'a|', '', 'a|a', 'a|b|c']);
    expect([...d]).toEqual([]);
    const r = all(trio, d);
    expect(r.total).toBe(3);
  });

  it('a dismissal naming a customer no longer live, or a pair no rule matches, changes nothing', () => {
    const r = all(trio, parseDismissed(['a|gone', 'a|zzz']));
    expect(r.total).toBe(3);
    const cross = all([...trio, row('z')], parseDismissed(['a|z']));
    expect(cross.total).toBe(3);
  });

  it('a pair matching both rules, once dismissed, is gone from both', () => {
    const both = [
      cr('a', '5', { legalName: 'X', primaryPhoneNorm: '96899758980' }),
      cr('b', '5', { legalName: 'X', primaryPhoneNorm: '96899758980' }),
    ];
    const r = all(both, parseDismissed(['b|a']));
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('a triple-only pair, once dismissed, leaves the count', () => {
    const r = all(
      [shop('a', 'X', '96899758980', 'r1'), shop('b', 'X', '96899758980', 'r1')],
      parseDismissed(['a|b'])
    );
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('the page limit and the true count', () => {
  it('fills CR-first; the count still includes what did not fit', () => {
    const rows = [
      ...['a', 'b', 'c'].map((id) => cr(id, '7')),
      shop('t1', 'X', '96899758980', 'r1'),
      shop('t2', 'X', '96899758980', 'r1'),
      shop('t3', 'Y', '96899758981', 'r1'),
      shop('t4', 'Y', '96899758981', 'r1'),
    ];
    const r = pairCandidates(rows, none, 4);
    expect(r.pairs.map((p) => p.reason)).toEqual(['CR', 'CR', 'CR', 'EXACT_TRIPLE']);
    expect(r.total).toBe(5);
  });

  it('dismissed pairs do not use up the limit', () => {
    const rows = ['a', 'b', 'c'].map((id) => cr(id, '7'));
    const r = pairCandidates(rows, parseDismissed(['a|b']), 2);
    expect(set(r.pairs)).toEqual(['a|c:CR', 'b|c:CR']);
  });

  it('one placeholder CR shared by 11 customers fills the page and hides every name + phone pair — and the count says so', () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => cr(`p${String(i).padStart(2, '0')}`, '0')),
      shop('t1', 'X', '96899758980', 'r1'),
      shop('t2', 'X', '96899758980', 'r1'),
    ];
    const r = pairCandidates(rows, none, 50);
    expect(r.pairs).toHaveLength(50);
    expect(r.pairs.every((p) => p.reason === 'CR')).toBe(true);
    expect(r.total).toBe(56); // 55 + 1
  });

  it('pairs follow the order of the rows, so a stable read gives a stable page', () => {
    const rows = ['c', 'a', 'b'].map((id) => cr(id, '7'));
    const r = all(rows);
    expect(r.pairs.map((p) => `${p.a.id}${p.b.id}`)).toEqual(['ca', 'cb', 'ab']);
  });
});

describe('cross-check against a brute force over random masters', () => {
  // A small deterministic generator, so a failure reproduces.
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', (seed) => {
    const r = rng(seed);
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(`c${String(i).padStart(2, '0')}`, {
        legalName: pick(r, ['X', 'x ', 'Y', 'Z']),
        primaryPhoneNorm: pick(r, [null, '96811111111', '96822222222']),
        crNumberNorm: pick(r, [null, '', 'A', 'B', 'C']),
        firstRegionId: pick(r, [null, 'r1', 'r2']),
      })
    );
    const ids = rows.map((x) => x.id);
    const dismissedIds = Array.from({ length: 15 }, () => `${pick(r, ids)}|${pick(r, ids)}`);
    const dismissed = parseDismissed(dismissedIds);

    const expected: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [a, b] = [rows[i], rows[j]];
        if (dismissed.has(pairKey(a.id, b.id))) continue;
        const c = crKey(a);
        const t = tripleKey(a);
        if (c && c === crKey(b)) expected.push(`${pairKey(a.id, b.id)}:CR`);
        else if (t && t === tripleKey(b)) expected.push(`${pairKey(a.id, b.id)}:EXACT_TRIPLE`);
      }
    }
    expected.sort();

    const full = all(rows, dismissed);
    expect(set(full.pairs)).toEqual(expected);
    expect(full.total).toBe(expected.length);

    for (const limit of [0, 1, 7, 25]) {
      const page = pairCandidates(rows, dismissed, limit);
      expect(page.total).toBe(expected.length);
      expect(page.pairs).toHaveLength(Math.min(limit, expected.length));
      const reasons = page.pairs.map((p) => p.reason);
      expect(reasons).toEqual([...reasons].sort()); // every CR before every EXACT_TRIPLE
      for (const k of set(page.pairs)) expect(expected).toContain(k);
    }
  });
});

describe('duplicatesSubtitle', () => {
  it('says the real count, and when the page shows only part of it', () => {
    expect(duplicatesSubtitle(0, 0)).toBe('No suspected pairs');
    expect(duplicatesSubtitle(1, 1)).toBe('1 suspected pair');
    expect(duplicatesSubtitle(12, 12)).toBe('12 suspected pairs');
    expect(duplicatesSubtitle(50, 5000)).toBe('5,000 suspected pairs · showing the first 50');
  });
});
