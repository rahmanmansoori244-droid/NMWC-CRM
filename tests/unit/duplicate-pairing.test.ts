/**
 * Duplicate detection's pairing rules (lib/duplicate-pairing.ts), benchmark
 * item 16, with the rules the owner decided on 2026-09-25:
 *   - the name + phone + region rule matches on ANY shared live-branch region;
 *   - names differing only in whitespace (a doubled space, a no-break space)
 *     are the same name;
 *   - a dismissal lapses when the pair comes to match on something it did not
 *     match on when it was marked distinct, and it can be undone.
 *
 * Every assertion compares the exact set of pairs, so an extra pair fails as
 * surely as a missing one.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  pairCandidates,
  parseDismissals,
  dismissalHides,
  matchSignals,
  signalHash,
  pairKey,
  duplicatesSubtitle,
  crKey,
  namePhoneKey,
  sharesRegion,
  type DupRow,
  type DuplicateCandidate,
  type Dismissal,
  type PairLogRow,
} from '@/lib/duplicate-pairing';
import { nameKey } from '@/lib/name-key';
import { normalizeCR } from '@/lib/cr';

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
    regionIds: ['r1'],
    ...over,
  };
}

/** Pairs as order-free "a|b:REASON" strings, sorted — for exact-set comparison. */
const set = (pairs: DuplicateCandidate[]) =>
  pairs.map((p) => `${pairKey(p.a.id, p.b.id)}:${p.reason}`).sort();

const none: ReadonlyMap<string, Dismissal> = new Map();
const all = (rows: DupRow[], dismissed: ReadonlyMap<string, Dismissal> = none) =>
  pairCandidates(rows, dismissed, Number.MAX_SAFE_INTEGER);

const cr = (id: string, value: string, over: Partial<DupRow> = {}) =>
  row(id, { crNumber: value, crNumberNorm: value, ...over });
const shop = (id: string, name: string, phone: string | null, regions: string[]) =>
  row(id, { legalName: name, primaryPhone: phone, primaryPhoneNorm: phone, regionIds: regions });

const PHONE = '+96899758980';

/** The row "Mark distinct" writes for a and b as they are now. */
const distinct = (a: DupRow, b: DupRow, at?: Date, by?: string): PairLogRow => ({
  entityId: `${a.id}|${b.id}`,
  after: { signals: matchSignals(a, b) },
  at,
  by,
});
const legacy = (entityId: string): PairLogRow => ({ entityId, after: null });
const undo = (entityId: string): PairLogRow => ({ entityId, after: { undo: true } });

describe('rule 1 — the same CR number', () => {
  it('pairs two customers sharing a CR, whatever their regions', () => {
    const r = all([cr('a', '123', { regionIds: ['r1'] }), cr('b', '123', { regionIds: ['r2'] }), cr('c', '999')]);
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

  it('an Arabic-Indic, a Persian and a zero-width CR, stored through normalizeCR, pair with their ASCII twin', () => {
    const stored = (id: string, typed: string) => row(id, { crNumber: typed, crNumberNorm: normalizeCR(typed) });
    const r = all([
      stored('ascii', '1234567'),
      stored('arabic', '\u0661\u0662\u0663\u0664\u0665\u0666\u0667'),
      stored('persian', '\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7'),
      stored('zw', '123\u200B4567'),
      stored('other', '1234568'),
    ]);
    expect(set(r.pairs)).toEqual([
      'arabic|ascii:CR',
      'arabic|persian:CR',
      'arabic|zw:CR',
      'ascii|persian:CR',
      'ascii|zw:CR',
      'persian|zw:CR',
    ]);
    expect(r.total).toBe(6);
  });
});

describe('rule 2 — the same name and phone, with a region in common', () => {
  it('ignores case and outer spaces in the name', () => {
    const r = all([shop('a', 'Al Noor Shop', PHONE, ['r1']), shop('b', '  AL NOOR SHOP ', PHONE, ['r1'])]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE']);
    expect(r.total).toBe(1);
  });

  it('a doubled inner space, a no-break space or a tab is the same name (owner decision)', () => {
    const r = all([
      shop('a', 'Al Noor Shop', PHONE, ['r1']),
      shop('b', 'Al Noor  Shop', PHONE, ['r1']),
      shop('c', 'Al\u00A0Noor Shop', PHONE, ['r1']),
      shop('d', 'al noor\tshop', PHONE, ['r1']),
      shop('e', 'Al Noor Shops', PHONE, ['r1']),
      shop('f', 'AlNoor Shop', PHONE, ['r1']),
    ]);
    expect(set(r.pairs)).toEqual([
      'a|b:EXACT_TRIPLE',
      'a|c:EXACT_TRIPLE',
      'a|d:EXACT_TRIPLE',
      'b|c:EXACT_TRIPLE',
      'b|d:EXACT_TRIPLE',
      'c|d:EXACT_TRIPLE',
    ]);
    expect(r.total).toBe(6);
  });

  it('the name part of the key is lib/name-key.ts nameKey — the one the create block uses', () => {
    const r = shop('a', ' Al\u00A0Noor  SHOP ', PHONE, ['r1']);
    expect(namePhoneKey(r)).toBe(`${nameKey(r.legalName)}|${PHONE}`);
    expect(namePhoneKey(r)).toBe(`al noor shop|${PHONE}`);
    expect(namePhoneKey({ legalName: '   ', primaryPhoneNorm: PHONE })).toBeNull();
    expect(namePhoneKey({ legalName: 'X', primaryPhoneNorm: null })).toBeNull();
  });

  it('a multi-branch twin is found in its SECOND region (owner decision: any shared region)', () => {
    // a has branches in r2 and r1; b has one in r1. The create guard always
    // called them the same shop; the detector now agrees.
    const r = all([shop('a', 'X', PHONE, ['r2', 'r1']), shop('b', 'X', PHONE, ['r1']), shop('c', 'X', PHONE, ['r3'])]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE']);
    expect(r.total).toBe(1);
  });

  it('two customers sharing several regions are one pair', () => {
    const r = all([shop('a', 'X', PHONE, ['r1', 'r2', 'r3']), shop('b', 'X', PHONE, ['r3', 'r2', 'r1'])]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE']);
    expect(r.total).toBe(1);
  });

  it('sharesRegion is any overlap, and never true for a customer with no live branch', () => {
    expect(sharesRegion({ regionIds: ['r1', 'r2'] }, { regionIds: ['r2'] })).toBe(true);
    expect(sharesRegion({ regionIds: ['r1'] }, { regionIds: ['r2', 'r3'] })).toBe(false);
    expect(sharesRegion({ regionIds: [] }, { regionIds: ['r1'] })).toBe(false);
    expect(sharesRegion({ regionIds: [] }, { regionIds: [] })).toBe(false);
  });

  it('does not pair no shared region, a missing phone, a customer with no live branch, or a different name', () => {
    expect(all([shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r2'])]).pairs).toEqual([]);
    expect(all([shop('a', 'X', null, ['r1']), shop('b', 'X', null, ['r1'])]).pairs).toEqual([]);
    expect(all([shop('a', 'X', PHONE, []), shop('b', 'X', PHONE, [])]).pairs).toEqual([]);
    expect(all([shop('a', 'X', PHONE, []), shop('b', 'X', PHONE, ['r1'])]).pairs).toEqual([]);
    // A phone alone is not a signal: one owner often runs many shops on one number.
    expect(all([shop('a', 'X', PHONE, ['r1']), shop('b', 'Y', PHONE, ['r1'])]).pairs).toEqual([]);
  });

  it('compares the stored normalized phone, not the phone as typed', () => {
    const r = all([
      row('a', { legalName: 'X', primaryPhone: '9975 8980', primaryPhoneNorm: PHONE }),
      row('b', { legalName: 'X', primaryPhone: '+968 99758980', primaryPhoneNorm: PHONE }),
      row('c', { legalName: 'X', primaryPhone: '9975 8980', primaryPhoneNorm: '+96899758981' }),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE']);
  });

  it('within one name + phone group, only the pairs sharing a region are pairs', () => {
    // a–b share r1, b–c share r2, a–c share nothing.
    const r = all([shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r1', 'r2']), shop('c', 'X', PHONE, ['r2'])]);
    expect(set(r.pairs)).toEqual(['a|b:EXACT_TRIPLE', 'b|c:EXACT_TRIPLE']);
    expect(r.total).toBe(2);
  });
});

describe('both rules together', () => {
  it('a pair matching both rules is listed once, as CR', () => {
    const r = all([
      cr('a', '5', { legalName: 'X', primaryPhoneNorm: PHONE }),
      cr('b', '5', { legalName: 'x', primaryPhoneNorm: PHONE }),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:CR']);
    expect(r.total).toBe(1);
  });

  it('in a name + phone group, a pair sharing a CR is a CR pair and the others are triple pairs', () => {
    const r = all([
      cr('a', '5', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
      cr('b', '5', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
      cr('c', '6', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
    ]);
    expect(set(r.pairs)).toEqual(['a|b:CR', 'a|c:EXACT_TRIPLE', 'b|c:EXACT_TRIPLE']);
    expect(r.total).toBe(3);
  });

  it('CR pairs come first, and the summary carries exactly the display fields', () => {
    const r = all([
      shop('t1', 'X', PHONE, ['r1']),
      shop('t2', 'X', PHONE, ['r1']),
      cr('c1', '9', { branchCount: 3, completenessScore: 80 }),
      cr('c2', '9'),
    ]);
    expect(r.pairs.map((p) => p.reason)).toEqual(['CR', 'EXACT_TRIPLE']);
    expect(r.pairs[0]).toStrictEqual({
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

describe('match signals — what "Mark distinct" stores', () => {
  const digest = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

  it('one per rule the pair matches now: the CR, and the name key + phone', () => {
    const a = cr('a', 'CR-9', { legalName: 'Al Noor', primaryPhoneNorm: PHONE, regionIds: ['r1'] });
    const b = cr('b', 'CR-9', { legalName: 'AL  NOOR', primaryPhoneNorm: PHONE, regionIds: ['r2', 'r1'] });
    expect(matchSignals(a, b)).toEqual([`cr:${digest('CR-9')}`, `triple:${digest(`al noor|${PHONE}`)}`]);
    expect(signalHash('CR-9')).toBe(digest('CR-9'));
  });

  it('digests, never values: no CR, phone or name appears in them', () => {
    const a = cr('a', '7654321', { legalName: 'Al Noor', primaryPhoneNorm: PHONE });
    const b = cr('b', '7654321', { legalName: 'Al Noor', primaryPhoneNorm: PHONE });
    const signals = matchSignals(a, b);
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s).toMatch(/^(cr|triple):[0-9a-f]{16}$/);
      expect(s).not.toContain('7654321');
      expect(s).not.toContain('99758980');
      expect(s.toLowerCase()).not.toContain('noor');
    }
  });

  it('region is not part of the triple signal — but the triple signal needs a shared region', () => {
    const inR1 = matchSignals(shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r1']));
    const inR2 = matchSignals(shop('a', 'X', PHONE, ['r2']), shop('b', 'X', PHONE, ['r2', 'r9']));
    expect(inR1).toEqual(inR2);
    expect(matchSignals(shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r2']))).toEqual([]);
  });

  it('no signal for a pair no rule matches', () => {
    expect(matchSignals(row('a'), row('b'))).toEqual([]);
    expect(matchSignals(cr('a', '1'), cr('b', '2'))).toEqual([]);
  });
});

describe('dismissals — "Mark distinct"', () => {
  const trio = ['a', 'b', 'c'].map((id) => cr(id, '7'));
  const [A, B] = trio;

  it('hide the pair in both orders, and only that pair', () => {
    for (const entityId of ['a|b', 'b|a']) {
      const r = all(trio, parseDismissals([{ ...distinct(A, B), entityId }]));
      expect(set(r.pairs)).toEqual(['a|c:CR', 'b|c:CR']);
      expect(r.total).toBe(2);
    }
  });

  it('the same pair dismissed twice, in both orders, is one dismissal', () => {
    const d = parseDismissals([distinct(A, B), { ...distinct(A, B), entityId: 'b|a' }, distinct(A, B)]);
    expect(d.size).toBe(1);
    const r = all(trio, d);
    expect(r.total).toBe(2);
    expect(r.pairs).toHaveLength(2);
  });

  it('ignores malformed rows — including one that would hide a pair nobody dismissed', () => {
    const good = { signals: matchSignals(A, B) };
    const d = parseDismissals([
      ...['a', '|b', 'a|', '', 'a|a', 'a|b|c'].map((entityId) => ({ entityId, after: good })),
      ...[
        { signals: 'cr:0123456789abcdef' },
        { signals: [] },
        { signals: ['cr:zz'] },
        { signals: ['cr:0123456789ABCDEF'] },
        { signals: ['phone:0123456789abcdef'] },
        { signals: ['cr:0123456789abcdef', 42] },
        { undo: 'yes' },
        { undo: true, signals: good.signals },
        { signals: good.signals, undo: false },
        {},
        42,
        'a|b',
        [],
        true,
      ].map((after) => ({ entityId: 'a|b', after })),
    ]);
    expect([...d.keys()]).toEqual([]);
    expect(all(trio, d).total).toBe(3);
  });

  it('a malformed row after a dismissal neither undoes it nor replaces it', () => {
    const at = new Date('2026-09-01T00:00:00Z');
    const signals = matchSignals(A, B);
    const d = parseDismissals([
      distinct(A, B, at, 'Aisha'),
      { entityId: 'a|b', after: { undo: 'yes' } },
      // Both an undo and a dismissal at once: which was meant cannot be told.
      { entityId: 'b|a', after: { undo: true, signals } },
      { entityId: 'a|b', after: { signals, undo: false } },
      { entityId: 'a|b', after: { signals: [] } },
      { entityId: 'b|a', after: 7 },
    ]);
    expect(d.get('a|b')).toEqual({ at, by: 'Aisha', signals: new Set(signals) });
    const r = all(trio, d);
    expect(r.total).toBe(2);
    expect(r.markedDistinct.map((m) => [pairKey(m.a.id, m.b.id), m.at, m.by])).toEqual([['a|b', at, 'Aisha']]);
  });

  it('marking a lapsed pair distinct again hides it on its new match — the latest dismissal wins', () => {
    const first = new Date('2026-09-01T00:00:00Z');
    const second = new Date('2026-09-10T00:00:00Z');
    const before = [cr('a', '7'), cr('b', '7')];
    const after = [cr('a', '8'), cr('b', '8')];
    const log = [distinct(before[0], before[1], first, 'Aisha')];
    expect(all(after, parseDismissals(log)).total).toBe(1); // lapsed: back on the list
    const again = parseDismissals([...log, distinct(after[0], after[1], second, 'Salim')]);
    const r = all(after, again);
    expect(r.total).toBe(0);
    expect(r.markedDistinct.map((m) => [m.at, m.by])).toEqual([[second, 'Salim']]);
  });

  it('a dismissal naming a customer no longer live, or a pair no rule matches, changes nothing', () => {
    const r = all(trio, parseDismissals([legacy('a|gone'), legacy('a|zzz')]));
    expect(r.total).toBe(3);
    expect(r.markedDistinct).toEqual([]);
    const cross = all([...trio, row('z')], parseDismissals([legacy('a|z')]));
    expect(cross.total).toBe(3);
    expect(cross.markedDistinct).toEqual([]);
  });

  it('a pair matching both rules, once dismissed, is gone from both', () => {
    const both = [
      cr('a', '5', { legalName: 'X', primaryPhoneNorm: PHONE }),
      cr('b', '5', { legalName: 'X', primaryPhoneNorm: PHONE }),
    ];
    const r = all(both, parseDismissals([{ ...distinct(both[0], both[1]), entityId: 'b|a' }]));
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('a triple-only pair, once dismissed, leaves the count', () => {
    const pair = [shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r1'])];
    const r = all(pair, parseDismissals([distinct(pair[0], pair[1])]));
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('dismissals lapse when the match changes (owner decision 2026-09-25)', () => {
  const at = new Date('2026-09-20T08:00:00Z');

  it('a CR pair comes back when the CR changes to ANOTHER shared value, and says it was marked distinct', () => {
    const before = [cr('a', '7'), cr('b', '7')];
    const log = [distinct(before[0], before[1], at, 'Aisha')];
    expect(all(before, parseDismissals(log)).total).toBe(0);

    const after = [cr('a', '8'), cr('b', '8')];
    const r = all(after, parseDismissals(log));
    expect(set(r.pairs)).toEqual(['a|b:CR']);
    expect(r.total).toBe(1);
    expect(r.pairs[0].markedDistinctBefore).toEqual({ at, by: 'Aisha' });
    expect(r.markedDistinct).toEqual([]);
  });

  it('a CR pair comes back when it NEWLY matches the name + phone + region rule too', () => {
    const before = [
      cr('a', '7', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
      cr('b', '7', { legalName: 'Y', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
    ];
    const log = [distinct(before[0], before[1])];
    const after = [before[0], { ...before[1], legalName: 'x' }];
    const r = all(after, parseDismissals(log));
    expect(set(r.pairs)).toEqual(['a|b:CR']);
    expect(r.total).toBe(1);
  });

  it('a CR pair with the same name and phone in two regions comes back when the two come to share a region', () => {
    // Same name and phone, no region in common: not a triple, but a CR pair.
    const before = [
      cr('a', '7', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
      cr('b', '7', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r2'] }),
    ];
    const log = [distinct(before[0], before[1])];
    // b opens a branch in r1: the triple rule matches for the first time.
    const after = [before[0], { ...before[1], regionIds: ['r2', 'r1'] }];
    expect(set(all(after, parseDismissals(log)).pairs)).toEqual(['a|b:CR']);
  });

  it('a triple-only pair comes back when the two come to share a CR', () => {
    const before = [shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r1'])];
    const log = [distinct(before[0], before[1])];
    const after = before.map((r) => ({ ...r, crNumber: '5', crNumberNorm: '5' }));
    const r = all(after, parseDismissals(log));
    expect(set(r.pairs)).toEqual(['a|b:CR']);
    expect(r.total).toBe(1);
  });

  it('a triple pair comes back when both are renamed to another shared name, or re-numbered to another shared phone', () => {
    const before = [shop('a', 'X', PHONE, ['r1']), shop('b', 'X', PHONE, ['r1'])];
    const log = parseDismissals([distinct(before[0], before[1])]);
    const renamed = before.map((r) => ({ ...r, legalName: 'Y' }));
    expect(set(all(renamed, log).pairs)).toEqual(['a|b:EXACT_TRIPLE']);
    const renumbered = before.map((r) => ({ ...r, primaryPhoneNorm: '+96891111111' }));
    expect(set(all(renumbered, log).pairs)).toEqual(['a|b:EXACT_TRIPLE']);
  });

  it('stays hidden when only an unrelated field changes', () => {
    const before = [
      cr('a', '7', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
      cr('b', '7', { legalName: 'X', primaryPhoneNorm: PHONE, regionIds: ['r1'] }),
    ];
    const log = parseDismissals([distinct(before[0], before[1], at, 'Aisha')]);
    const after = [
      {
        ...before[0],
        completenessScore: 99,
        branchCount: 4,
        nmwcCode: 'N-new',
        primaryPhone: '9975 8980', // the phone as typed; the norm is unchanged
        crNumber: ' 7 ', // the CR as typed; the norm is unchanged
        legalName: '  x ', // spacing and case only: the same name key
        regionIds: ['r2', 'r1', 'r3'], // regions moved, still one in common
      },
      { ...before[1], regionIds: ['r3'] },
    ];
    const r = all(after, log);
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.markedDistinct.map((m) => pairKey(m.a.id, m.b.id))).toEqual(['a|b']);
  });

  it('a pair dismissed on both rules stays hidden when it now matches on only one of them', () => {
    const before = [
      cr('a', '7', { legalName: 'X', primaryPhoneNorm: PHONE }),
      cr('b', '7', { legalName: 'X', primaryPhoneNorm: PHONE }),
    ];
    const log = parseDismissals([distinct(before[0], before[1])]);
    const crOnly = [before[0], { ...before[1], legalName: 'Z' }];
    expect(all(crOnly, log).total).toBe(0);
    const tripleOnly = [before[0], { ...before[1], crNumberNorm: '8' }];
    expect(all(tripleOnly, log).total).toBe(0);
  });

  it('a row written before signals were stored hides the pair whatever it matches', () => {
    const before = [cr('a', '7'), cr('b', '7')];
    const log = parseDismissals([legacy('b|a')]);
    expect(all(before, log).total).toBe(0);
    const after = [
      cr('a', '8', { legalName: 'X', primaryPhoneNorm: PHONE }),
      cr('b', '8', { legalName: 'X', primaryPhoneNorm: PHONE }),
    ];
    const r = all(after, log);
    expect(r.pairs).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.markedDistinct).toHaveLength(1);
  });

  it('dismissalHides: needs a dismissal and a current match; legacy covers anything; stored must cover every signal', () => {
    const d = (signals: string[] | null): Dismissal => ({ at: null, by: null, signals: signals && new Set(signals) });
    expect(dismissalHides(undefined, ['cr:0000000000000000'])).toBe(false);
    expect(dismissalHides(d(null), [])).toBe(false);
    expect(dismissalHides(d(null), ['cr:0000000000000000'])).toBe(true);
    expect(dismissalHides(d(['cr:0000000000000000']), [])).toBe(false);
    expect(dismissalHides(d(['cr:0000000000000000']), ['cr:0000000000000000'])).toBe(true);
    expect(dismissalHides(d(['cr:0000000000000000']), ['cr:1111111111111111'])).toBe(false);
    expect(
      dismissalHides(d(['cr:0000000000000000']), ['cr:0000000000000000', 'triple:2222222222222222'])
    ).toBe(false);
    expect(
      dismissalHides(d(['cr:0000000000000000', 'triple:2222222222222222']), ['triple:2222222222222222'])
    ).toBe(true);
  });
});

describe('undo — the latest row for a pair wins', () => {
  const pair = [cr('a', '7'), cr('b', '7')];
  const [A, B] = pair;

  it('an undo after a dismissal brings the pair back; a dismissal after the undo hides it again', () => {
    expect(all(pair, parseDismissals([distinct(A, B), undo('b|a')])).total).toBe(1);
    expect(all(pair, parseDismissals([distinct(A, B), undo('a|b'), distinct(A, B)])).total).toBe(0);
    expect(all(pair, parseDismissals([legacy('a|b'), undo('a|b')])).total).toBe(1);
  });

  it('an undo with no dismissal before it changes nothing, and does not pre-empt a later one', () => {
    expect(all(pair, parseDismissals([undo('a|b')])).total).toBe(1);
    expect(all(pair, parseDismissals([undo('a|b'), distinct(A, B)])).total).toBe(0);
  });

  it('an undone pair carries no "marked distinct before" note — the Steward put it back', () => {
    const r = all(pair, parseDismissals([distinct(A, B), undo('a|b')]));
    expect(r.pairs[0].markedDistinctBefore).toBeUndefined();
  });
});

describe('the "Marked distinct" list', () => {
  const t = (d: number) => new Date(Date.UTC(2026, 8, d));

  it('lists the pairs a dismissal hides now, latest first, with when and by whom — and nothing lapsed, gone or unmatched', () => {
    const rows = [
      cr('a', '1'), cr('b', '1'), // dismissed, still matching: listed
      cr('c', '2'), cr('d', '2'), // dismissed, then the CR changed to another shared value: lapsed
      cr('e', '3'), cr('f', '3'), // dismissed then undone
      cr('g', '4'), // dismissed with a customer that is gone
      row('h'), row('i'), // dismissed (legacy) but matching nothing now
      shop('j', 'X', PHONE, ['r1']), shop('k', 'X', PHONE, ['r1']), // dismissed later: listed first
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const log: PairLogRow[] = [
      distinct(byId.get('a')!, byId.get('b')!, t(1), 'Aisha'),
      { ...distinct(cr('c', '9'), cr('d', '9'), t(2), 'Aisha') },
      distinct(byId.get('e')!, byId.get('f')!, t(3), 'Aisha'),
      { ...undo('e|f'), at: t(4) },
      { ...legacy('g|gone'), at: t(5) },
      { ...legacy('h|i'), at: t(6) },
      distinct(byId.get('j')!, byId.get('k')!, t(7), 'Salim'),
    ];
    const r = all(rows, parseDismissals(log));
    expect(r.markedDistinct.map((m) => [pairKey(m.a.id, m.b.id), m.at, m.by])).toEqual([
      ['j|k', t(7), 'Salim'],
      ['a|b', t(1), 'Aisha'],
    ]);
    expect(r.markedDistinct[1].a).toStrictEqual({
      id: 'a',
      nmwcCode: 'N-a',
      legalName: 'Shop a',
      primaryPhone: null,
      crNumber: '1',
      completenessScore: 50,
      branchCount: 1,
    });
    // The lapsed pair is back on the list with its note; the undone one without.
    expect(set(r.pairs)).toEqual(['c|d:CR', 'e|f:CR']);
    const back = r.pairs.find((p) => p.a.id === 'c')!;
    expect(back.markedDistinctBefore).toEqual({ at: t(2), by: 'Aisha' });
    expect(r.total).toBe(2);
  });

  it('the list is not cut by the page limit', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => cr(id, '7'));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const log = [
      distinct(byId.get('a')!, byId.get('b')!),
      distinct(byId.get('c')!, byId.get('d')!),
      distinct(byId.get('a')!, byId.get('c')!),
    ];
    const r = pairCandidates(rows, parseDismissals(log), 1);
    expect(r.pairs).toHaveLength(1);
    expect(r.total).toBe(3);
    expect(r.markedDistinct).toHaveLength(3);
  });
});

describe('the page limit and the true count', () => {
  it('fills CR-first; the count still includes what did not fit', () => {
    const rows = [
      ...['a', 'b', 'c'].map((id) => cr(id, '7')),
      shop('t1', 'X', PHONE, ['r1']),
      shop('t2', 'X', PHONE, ['r1']),
      shop('t3', 'Y', '+96899758981', ['r1']),
      shop('t4', 'Y', '+96899758981', ['r1']),
    ];
    const r = pairCandidates(rows, none, 4);
    expect(r.pairs.map((p) => p.reason)).toEqual(['CR', 'CR', 'CR', 'EXACT_TRIPLE']);
    expect(r.total).toBe(5);
  });

  it('dismissed pairs do not use up the limit', () => {
    const rows = ['a', 'b', 'c'].map((id) => cr(id, '7'));
    const r = pairCandidates(rows, parseDismissals([distinct(rows[0], rows[1])]), 2);
    expect(set(r.pairs)).toEqual(['a|c:CR', 'b|c:CR']);
  });

  it('one placeholder CR shared by 11 customers fills the page and hides every name + phone pair — and the count says so', () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => cr(`p${String(i).padStart(2, '0')}`, '0')),
      shop('t1', 'X', PHONE, ['r1']),
      shop('t2', 'X', PHONE, ['r1']),
    ];
    const r = pairCandidates(rows, none, 50);
    expect(r.pairs).toHaveLength(50);
    expect(r.pairs.every((p) => p.reason === 'CR')).toBe(true);
    expect(r.total).toBe(56); // 55 + 1
  });

  it('a placeholder CR shared by 2,000 customers is counted, not enumerated', () => {
    // 1,999,000 pairs. Every customer's id is read through a counter: counting
    // arithmetically reads each id a handful of times, while walking the pairs to
    // count them reads millions. A timer could not tell — vitest cannot stop a
    // synchronous test, and a fast machine walks two million pairs in time.
    let reads = 0;
    const rows = Array.from({ length: 2000 }, (_, i) => {
      const r = cr(`p${String(i).padStart(4, '0')}`, 'N/A');
      const id = r.id;
      Object.defineProperty(r, 'id', {
        enumerable: true,
        get: () => {
          reads += 1;
          return id;
        },
      });
      return r;
    });
    const r = pairCandidates(rows, none, 50);
    expect(r.total).toBe(1_999_000);
    expect(r.pairs).toHaveLength(50);
    expect(reads).toBeLessThan(10 * rows.length);
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

  const NAMES = ['X Y', 'x  y', ' X\u00A0Y', 'X Y ', 'XY', 'Z', 'z'];
  const PHONES = [null, '+96811111111', '+96822222222'];
  const CRS = [null, '', 'A', 'B', 'C'];
  const REGIONS = ['r1', 'r2', 'r3'];
  // Every signal a random master can produce, so random dismissals cover some
  // pairs and not others, as real ones do after the data has moved.
  const UNIVERSE = [
    ...['A', 'B', 'C'].map((c) => `cr:${signalHash(c)}`),
    ...['x y', 'xy', 'z'].flatMap((n) => PHONES.filter(Boolean).map((p) => `triple:${signalHash(`${n}|${p}`)}`)),
  ];

  /** The rules, written out pair by pair from their definitions. */
  function rulesMatch(a: DupRow, b: DupRow): 'CR' | 'EXACT_TRIPLE' | null {
    if (a.crNumberNorm && a.crNumberNorm === b.crNumberNorm) return 'CR';
    const sameName = a.legalName.replace(/\s+/g, ' ').trim().toLowerCase() === b.legalName.replace(/\s+/g, ' ').trim().toLowerCase();
    const samePhone = !!a.primaryPhoneNorm && a.primaryPhoneNorm === b.primaryPhoneNorm;
    const region = a.regionIds.some((x) => b.regionIds.includes(x));
    return sameName && samePhone && region ? 'EXACT_TRIPLE' : null;
  }

  /**
   * Forty customers and forty pair-history rows: dismissals whose stored signals
   * are a random subset of every signal the master can produce (so some cover
   * the pair now and some have lapsed), legacy rows, undos and malformed rows.
   */
  function master(seed: number): { rows: DupRow[]; log: PairLogRow[] } {
    const r = rng(seed);
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(`c${String(i).padStart(2, '0')}`, {
        legalName: pick(r, NAMES),
        primaryPhoneNorm: pick(r, PHONES),
        crNumberNorm: pick(r, CRS),
        regionIds: REGIONS.filter(() => r() < 0.4),
      })
    );
    const ids = rows.map((x) => x.id);
    const log: PairLogRow[] = Array.from({ length: 40 }, () => {
      const entityId = `${pick(r, ids)}|${pick(r, ids)}`;
      const kind = r();
      if (kind < 0.15) return legacy(entityId);
      if (kind < 0.3) return undo(entityId);
      if (kind < 0.35) return { entityId, after: { signals: 'bad' } };
      const signals = UNIVERSE.filter(() => r() < 0.3);
      return { entityId, after: { signals: signals.length ? signals : [pick(r, UNIVERSE)] } };
    });
    return { rows, log };
  }
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it.each(SEEDS)('seed %i', (seed) => {
    const { rows, log } = master(seed);
    const dismissals = parseDismissals(log);

    const expected: string[] = [];
    const hidden: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [a, b] = [rows[i], rows[j]];
        const reason = rulesMatch(a, b);
        if (!reason) continue;
        const key = pairKey(a.id, b.id);
        if (dismissalHides(dismissals.get(key), matchSignals(a, b))) hidden.push(key);
        else expected.push(`${key}:${reason}`);
      }
    }
    expected.sort();
    hidden.sort();

    const full = all(rows, dismissals);
    expect(set(full.pairs)).toEqual(expected);
    expect(full.total).toBe(expected.length);
    expect(full.markedDistinct.map((m) => pairKey(m.a.id, m.b.id)).sort()).toEqual(hidden);

    for (const limit of [0, 1, 7, 25]) {
      const page = pairCandidates(rows, dismissals, limit);
      expect(page.total).toBe(expected.length);
      expect(page.pairs).toHaveLength(Math.min(limit, expected.length));
      const reasons = page.pairs.map((p) => p.reason);
      expect(reasons).toEqual([...reasons].sort()); // every CR before every EXACT_TRIPLE
      for (const k of set(page.pairs)) expect(expected).toContain(k);
    }
  });

  it('the generator really exercises every branch: pairs, hidden pairs and lapsed ones', () => {
    // A cross-check whose random data never produced a hidden or a lapsed pair
    // would pass while proving nothing about dismissals.
    let hiddenSeen = 0;
    let lapsedSeen = 0;
    let tripleSeen = 0;
    for (const seed of SEEDS) {
      const { rows, log } = master(seed);
      const scan = all(rows, parseDismissals(log));
      hiddenSeen += scan.markedDistinct.length;
      lapsedSeen += scan.pairs.filter((p) => p.markedDistinctBefore).length;
      tripleSeen += scan.pairs.filter((p) => p.reason === 'EXACT_TRIPLE').length;
    }
    expect(hiddenSeen).toBeGreaterThan(0);
    expect(lapsedSeen).toBeGreaterThan(0);
    expect(tripleSeen).toBeGreaterThan(0);
  });
});

describe('crKey', () => {
  it('is the stored norm, and no key for a blank one', () => {
    expect(crKey({ crNumberNorm: 'CR-1' })).toBe('CR-1');
    expect(crKey({ crNumberNorm: '' })).toBeNull();
    expect(crKey({ crNumberNorm: null })).toBeNull();
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
