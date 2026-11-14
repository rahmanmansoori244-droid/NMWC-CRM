/**
 * The daily Temix import, stage 6: finalize's plan (lib/temix-daily-finalize.ts),
 * pure, on synthetic codes and names.
 *
 *  - Open spells are written once: a spell opens when the absence starts and
 *    closes when it ends, and the same input planned again writes nothing.
 *  - Customers missing from the file follow the Check's own rule, so the
 *    preview's figure is the spells finalize opens.
 *  - Accountant codes: opened for a CRM-made customer whose typed code no row
 *    carries, closed when it appears or when the code changes.
 *  - Switched-off routes still holding shops: opened, and cleared.
 *  - Names: listed once per customer and Temix value, under a keyed hash;
 *    capitals and spaces are not a difference; no key, no comparison.
 *  - The day's summary counts.
 */
import { describe, expect, it } from 'vitest';
import {
  SPELL_CLOSED_CLEARED,
  SPELL_CLOSED_NOT_EXPECTED,
  SPELL_CLOSED_SEEN,
  SPELL_OPENED,
  accountantCodeOf,
  foldName,
  nameHash,
  nameKey,
  nameKeyId,
  openSpellsOf,
  planFinalize,
  summaryCountsOf,
  type FinalizeCustomer,
  type FinalizeInput,
  type FinalizeRow,
  type Notice,
} from '@/lib/temix-daily-finalize';
import { checkDailyFile } from '@/lib/temix-daily-check';
import { summaryText } from '@/lib/temix-daily-summary';
import { CUSTOMERS, checkInput } from '../support/temix-daily-check-fixture';

const KEY = nameKey('a made up signing secret for the unit tests only')!;

const cust = (id: string, nmwcCode: string, over: Partial<FinalizeCustomer> = {}): FinalizeCustomer => ({
  id,
  nmwcCode,
  temixCode: null,
  live: true,
  isTest: false,
  ...over,
});
const row = (n: number, custCodeKey: string | null, customerId: string | null = null): FinalizeRow => ({ id: `r${n}`, rowNumber: n, custCodeKey, customerId });

function input(over: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    rows: [],
    customers: [],
    open: [],
    inactiveRoutes: [],
    names: { key: KEY, rows: [], crmNames: new Map(), seen: new Set() },
    ...over,
  };
}

/** Writes the plan's notices to an in-memory ledger, as the writer would (ids rise). */
function ledger() {
  const rows: Array<Notice & { id: bigint }> = [];
  let next = 1n;
  return {
    rows,
    write: (ns: Notice[]) => {
      for (const n of ns) rows.push({ ...n, id: next++ });
    },
    open: () => openSpellsOf(rows),
  };
}

describe('customers missing from the file: one spell, opened once, closed once', () => {
  const customers = [cust('c1', 'C1'), cust('c2', 'C2', { temixCode: 'T2' }), cust('c3', 'C3'), cust('cT', 'CT', { isTest: true }), cust('cA', 'CA', { live: false })];

  it('opens a spell for each live, non-test customer no row names, by either code', () => {
    const p = planFinalize(input({ rows: [row(2, 'C1'), row(3, 'T2')], customers }));
    expect(p.notices).toEqual([{ kind: 'MISSING_FROM_FILE', customerId: 'c3', rowId: null, field: null, toValue: null, detailCode: SPELL_OPENED }]);
  });

  it('the same file again, or the next with the customer still absent, writes nothing', () => {
    const L = ledger();
    L.write(planFinalize(input({ rows: [row(2, 'C1'), row(3, 'T2')], customers })).notices);
    expect(planFinalize(input({ rows: [row(2, 'C1'), row(3, 'T2')], customers, open: L.open() })).notices).toEqual([]);
    expect(planFinalize(input({ rows: [row(2, 'C1')], customers, open: L.open() })).notices).toEqual([
      { kind: 'MISSING_FROM_FILE', customerId: 'c2', rowId: null, field: null, toValue: null, detailCode: SPELL_OPENED },
    ]);
  });

  it('closes when the customer is in a file again (pointing at its row), or is no longer expected', () => {
    const L = ledger();
    L.write(planFinalize(input({ rows: [], customers })).notices);
    expect(L.open().map((s) => s.customerId).sort()).toEqual(['c1', 'c2', 'c3']);
    const back = planFinalize(input({ rows: [row(5, 'T2'), row(4, 'C1')], customers: customers.map((c) => (c.id === 'c3' ? { ...c, live: false } : c)), open: L.open() }));
    expect(back.notices).toEqual([
      { kind: 'MISSING_FROM_FILE', customerId: 'c1', rowId: 'r4', field: null, toValue: null, detailCode: SPELL_CLOSED_SEEN },
      { kind: 'MISSING_FROM_FILE', customerId: 'c2', rowId: 'r5', field: null, toValue: null, detailCode: SPELL_CLOSED_SEEN },
      { kind: 'MISSING_FROM_FILE', customerId: 'c3', rowId: null, field: null, toValue: null, detailCode: SPELL_CLOSED_NOT_EXPECTED },
    ]);
    L.write(back.notices);
    expect(L.open()).toEqual([]);
    // Missing again later: a new spell.
    expect(planFinalize(input({ rows: [row(2, 'C1')], customers, open: L.open() })).notices.map((n) => [n.customerId, n.detailCode])).toEqual([
      ['c2', SPELL_OPENED],
      ['c3', SPELL_OPENED],
    ]);
  });

  it('opens exactly the customers the Check counts as missing (one rule for both)', () => {
    const ci = checkInput();
    const plan = checkDailyFile(ci);
    const p = planFinalize(input({ rows: ci.rows.map((r) => row(r.rowNumber, r.custCodeKey)), customers: CUSTOMERS }));
    const opened = p.notices.filter((n) => n.kind === 'MISSING_FROM_FILE').map((n) => n.customerId);
    expect(opened.sort()).toEqual([...plan.missingCustomerIds].sort());
    expect(opened.sort()).toEqual(['cH', 'cM', 'cP']);
  });
});

describe("the Accountant's Temix codes", () => {
  const made = cust('cN', 'NMWC-2026-000001', { temixCode: ' tx1 ' });

  it('only a customer made in the CRM, live and not a test, with a typed code', () => {
    expect(accountantCodeOf(made)).toBe('TX1');
    expect(accountantCodeOf(cust('c1', 'C1', { temixCode: 'TX1' }))).toBeNull();
    expect(accountantCodeOf(cust('cP', 'NMWC-2026-000003'))).toBeNull();
    expect(accountantCodeOf({ ...made, isTest: true })).toBeNull();
    expect(accountantCodeOf({ ...made, live: false })).toBeNull();
  });

  it('opens when no row carries the code, closes when one does, and once each', () => {
    const L = ledger();
    const first = planFinalize(input({ rows: [row(2, 'NMWC-2026-000001')], customers: [made] }));
    expect(first.notices).toEqual([{ kind: 'ACCOUNTANT_CODE_NOT_SEEN', customerId: 'cN', rowId: null, field: 'temixCode', toValue: 'TX1', detailCode: SPELL_OPENED }]);
    L.write(first.notices);
    expect(planFinalize(input({ rows: [row(2, 'NMWC-2026-000001')], customers: [made], open: L.open() })).notices).toEqual([]);
    const seen = planFinalize(input({ rows: [row(7, 'TX1')], customers: [made], open: L.open() }));
    expect(seen.notices).toEqual([{ kind: 'ACCOUNTANT_CODE_NOT_SEEN', customerId: 'cN', rowId: 'r7', field: 'temixCode', toValue: 'TX1', detailCode: SPELL_CLOSED_SEEN }]);
    L.write(seen.notices);
    expect(L.open()).toEqual([]);
  });

  it('a code changed meanwhile: the old spell ends as not expected, a new one opens', () => {
    const L = ledger();
    L.write(planFinalize(input({ rows: [row(2, 'X')], customers: [made] })).notices);
    const changed = { ...made, temixCode: 'TX2' };
    const p = planFinalize(input({ rows: [row(2, 'NMWC-2026-000001')], customers: [changed], open: L.open() }));
    expect(p.notices.map((n) => [n.kind, n.toValue, n.detailCode])).toEqual([
      // It was missing too (no row named it by either code); now its NMWC code is in the file.
      ['MISSING_FROM_FILE', null, SPELL_CLOSED_SEEN],
      ['ACCOUNTANT_CODE_NOT_SEEN', 'TX2', SPELL_OPENED],
      ['ACCOUNTANT_CODE_NOT_SEEN', 'TX1', SPELL_CLOSED_NOT_EXPECTED],
    ]);
  });
});

describe('switched-off routes still holding shops', () => {
  it('opened once while it holds shops, cleared when it holds none or is switched on', () => {
    const L = ledger();
    const p = planFinalize(input({ inactiveRoutes: [{ id: 'rt-z99', shops: 3 }, { id: 'rt-empty', shops: 0 }] }));
    expect(p.notices).toEqual([{ kind: 'ROUTE_INACTIVE', customerId: null, rowId: null, field: 'routeId', toValue: 'rt-z99', detailCode: SPELL_OPENED }]);
    L.write(p.notices);
    expect(planFinalize(input({ inactiveRoutes: [{ id: 'rt-z99', shops: 2 }], open: L.open() })).notices).toEqual([]);
    const cleared = planFinalize(input({ inactiveRoutes: [], open: L.open() }));
    expect(cleared.notices).toEqual([{ kind: 'ROUTE_INACTIVE', customerId: null, rowId: null, field: 'routeId', toValue: 'rt-z99', detailCode: SPELL_CLOSED_CLEARED }]);
  });
});

describe('names listed once', () => {
  const crmNames = new Map([
    ['c1', 'Customer One Trading'],
    ['c2', 'Customer Two'],
  ]);
  const names = (rows: FinalizeInput['names']['rows'], seen = new Set<string>(), key: Buffer | null = KEY) => ({ key, rows, crmNames, seen });

  it('capitals, spaces and invisible characters are not a difference', () => {
    expect(foldName('  customer  one​ trading ')).toBe('CUSTOMER ONE TRADING');
    const p = planFinalize(input({ names: names([{ rowId: 'r2', rowNumber: 2, customerId: 'c1', name: 'CUSTOMER ONE  trading' }]) }));
    expect(p.notices).toEqual([]);
    expect(p.namesChecked).toBe(true);
  });

  it('a difference is listed once per customer and Temix value, with a keyed hash and no name', () => {
    const p = planFinalize(
      input({
        names: names([
          { rowId: 'r3', rowNumber: 3, customerId: 'c2', name: 'Customer 2 LLC' },
          { rowId: 'r2', rowNumber: 2, customerId: 'c2', name: 'customer 2 llc' },
          { rowId: 'r4', rowNumber: 4, customerId: 'c1', name: 'Someone Else' },
          { rowId: 'r5', rowNumber: 5, customerId: 'c1', name: '' },
          { rowId: 'r6', rowNumber: 6, customerId: 'gone', name: 'Anything' },
          { rowId: 'r7', rowNumber: 7, customerId: 'c1', name: ' #n/a ' },
        ]),
      })
    );
    expect(p.notices).toEqual([
      { kind: 'NAME_DIFFERS', customerId: 'c2', rowId: 'r2', field: 'legalName', toValue: null, detailCode: null },
      { kind: 'NAME_DIFFERS', customerId: 'c1', rowId: 'r4', field: 'legalName', toValue: null, detailCode: null },
    ]);
    expect(p.seen).toEqual([
      { customerId: 'c2', valueHash: nameHash(KEY, 'CUSTOMER 2 LLC') },
      { customerId: 'c1', valueHash: nameHash(KEY, 'SOMEONE ELSE') },
    ]);
    expect(p.seen[0]!.valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toMatch(/Customer 2|Someone/i);
    // Listed already: nothing; another name from Temix: listed.
    const seen = new Set(p.seen.map((s) => `${s.customerId}|${s.valueHash}`));
    expect(planFinalize(input({ names: names([{ rowId: 'r9', rowNumber: 9, customerId: 'c2', name: 'Customer 2 LLC' }], seen) })).notices).toEqual([]);
    expect(planFinalize(input({ names: names([{ rowId: 'r9', rowNumber: 9, customerId: 'c2', name: 'Customer 2 SAOC' }], seen) })).notices).toHaveLength(1);
  });

  it('the hash is keyed: another secret gives another hash and key id; no secret, no comparison', () => {
    const other = nameKey('another made up signing secret for the tests')!;
    expect(nameHash(other, 'X')).not.toBe(nameHash(KEY, 'X'));
    expect(nameKeyId(other)).not.toBe(nameKeyId(KEY));
    expect(nameKey('')).toBeNull();
    const p = planFinalize(input({ names: names([{ rowId: 'r4', rowNumber: 4, customerId: 'c1', name: 'Someone Else' }], new Set(), null) }));
    expect(p).toEqual({ notices: [], seen: [], namesChecked: false });
  });
});

describe('open spells, read back from the ledger', () => {
  it('the newest row of a kind and key decides; other kinds and details are not spells', () => {
    expect(
      openSpellsOf([
        { id: 1n, kind: 'MISSING_FROM_FILE', customerId: 'c1', toValue: null, detailCode: SPELL_OPENED },
        { id: 3n, kind: 'MISSING_FROM_FILE', customerId: 'c1', toValue: null, detailCode: SPELL_CLOSED_SEEN },
        { id: 2n, kind: 'MISSING_FROM_FILE', customerId: 'c2', toValue: null, detailCode: SPELL_OPENED },
        { id: 4n, kind: 'ROUTE_MOVE', customerId: 'c3', toValue: 'rt', detailCode: 'VIA_EXACT_CODE' },
        { id: 5n, kind: 'ROUTE_INACTIVE', customerId: null, toValue: 'rt-z', detailCode: SPELL_OPENED },
        { id: 6n, kind: 'NAME_DIFFERS', customerId: 'c4', toValue: null, detailCode: null },
      ])
    ).toEqual([
      { kind: 'MISSING_FROM_FILE', customerId: 'c2', value: null },
      { kind: 'ROUTE_INACTIVE', customerId: null, value: 'rt-z' },
    ]);
  });
});

describe("the day's summary", () => {
  it('counts applied changes, spells that started and ended, names and held rows; never a value', () => {
    const counts = summaryCountsOf(
      [
        { kind: 'ROUTE_MOVE', applied: true, detailCode: 'VIA_EXACT_CODE', n: 2 },
        { kind: 'MISSING_FROM_FILE', applied: false, detailCode: SPELL_OPENED, n: 3 },
        { kind: 'MISSING_FROM_FILE', applied: false, detailCode: SPELL_CLOSED_SEEN },
        { kind: 'MISSING_FROM_FILE', applied: false, detailCode: SPELL_CLOSED_NOT_EXPECTED },
        { kind: 'ACCOUNTANT_CODE_NOT_SEEN', applied: false, detailCode: SPELL_CLOSED_SEEN },
        { kind: 'ACCOUNTANT_CODE_NOT_SEEN', applied: false, detailCode: SPELL_CLOSED_NOT_EXPECTED },
        { kind: 'ROUTE_INACTIVE', applied: false, detailCode: SPELL_OPENED },
        { kind: 'NAME_DIFFERS', applied: false, detailCode: null },
      ],
      4
    );
    expect(counts).toEqual({ ROUTE_MOVE: 2, MISSING_FROM_FILE: 3, MISSING_FROM_FILE_ENDED: 2, ACCOUNTANT_CODE_SEEN: 1, ROUTE_INACTIVE: 1, NAME_DIFFERS: 1, HELD_ROWS: 4 });
    expect(summaryText('2026-11-14', counts).body).toBe(
      "2 shops moved to another route; 1 name difference; 1 switched-off route still holding shops; 3 customers newly missing from the file; 2 customers no longer missing from the file; 1 Accountant's Temix code now in the file; 4 rows held back. Open the Temix daily file page for the details."
    );
  });
});
