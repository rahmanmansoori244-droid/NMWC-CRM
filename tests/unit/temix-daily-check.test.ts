/**
 * The daily Temix import, stage 4: the Check (lib/temix-daily-check.ts), on
 * the synthetic file of tests/support/temix-daily-check-fixture.ts, staged
 * through the real upload rules (stageDailyRows). Every figure the preview
 * shows is asserted here, by hand, row by row; then the route rule alone
 * (C10 beside C10MA, with and without a route-map entry), the main-row stub,
 * the pilot rule and the route-map form's rules.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CHECK_HOLDS,
  CHECK_HOLD_LABEL,
  checkDailyFile,
  mainRowOf,
  pilotGate,
  routeResolver,
  unmatchedRouteCodes,
  type CheckRow,
  type RowPlan,
} from '@/lib/temix-daily-check';
import { routeMapEntryRefusal, routeMapReasonRefusal } from '@/lib/temix-daily-route-map';
import { TEMIX_DAILY_UPLOAD_NOTES } from '@/lib/temix-daily-file';
import { BRANCHES, CUSTOMERS, ROUTES, checkInput, stagedCheckRows } from '../support/temix-daily-check-fixture';

const byRow = (rows: RowPlan[]) => new Map(rows.map((r) => [r.rowNumber, r]));

describe('the Check of the synthetic file, with the route map empty', () => {
  const plan = checkDailyFile(checkInput());
  const r = byRow(plan.rows);

  it('decides each row as the plan says', () => {
    const want: Record<number, { verdict: RowPlan['verdict']; holds?: string[]; routeHold?: string | null }> = {
      2: { verdict: 'NO_CHANGE', holds: [], routeHold: null },
      3: { verdict: 'WOULD_MOVE', holds: [] },
      4: { verdict: 'HELD', holds: ['SHOP_ARCHIVED'] },
      5: { verdict: 'HELD', holds: ['SHOP_UNKNOWN'] },
      6: { verdict: 'HELD', holds: ['SHOP_CODE_LOOKALIKE'] },
      7: { verdict: 'WOULD_MOVE', holds: [] },
      8: { verdict: 'HELD', holds: ['BRANCH_CODE_BLANK'] },
      9: { verdict: 'HELD', holds: ['SHOP_NOT_LINKED'] },
      10: { verdict: 'HELD', holds: ['CUSTOMER_ARCHIVED'] },
      11: { verdict: 'HELD', holds: ['DUPLICATE_SUSPECT'] },
      12: { verdict: 'HELD', holds: ['CUSTOMER_UNKNOWN'] },
      13: { verdict: 'HELD', holds: ['CUSTOMER_UNKNOWN'] },
      14: { verdict: 'NO_CHANGE', holds: [], routeHold: 'ROUTE_NOT_MATCHED' },
      15: { verdict: 'NO_CHANGE', holds: [], routeHold: 'ROUTE_SWITCHED_OFF' },
      16: { verdict: 'NO_CHANGE', holds: [], routeHold: 'ROUTE_MISSING' },
      17: { verdict: 'HELD', holds: ['CELL_ERROR'] },
      18: { verdict: 'HELD', holds: ['SHOP_OF_ANOTHER_CUSTOMER'] },
      19: { verdict: 'HELD', holds: ['DUPLICATE_ROW'] },
      20: { verdict: 'HELD', holds: ['DUPLICATE_ROW'] },
    };
    expect(plan.rows.map((p) => p.rowNumber)).toEqual(Object.keys(want).map(Number));
    for (const [row, w] of Object.entries(want)) {
      const p = r.get(Number(row))!;
      expect(p.verdict, `row ${row}`).toBe(w.verdict);
      if (w.holds) expect(p.holds, `row ${row}`).toEqual(w.holds);
      if (w.routeHold !== undefined) expect(p.routeHold, `row ${row}`).toBe(w.routeHold);
    }
  });

  it('matches customers by either code, and shops by the code composed under the customer', () => {
    expect(r.get(2)).toMatchObject({ customerId: 'cA', matchedBy: 'BOTH', branchId: 'bA1' });
    expect(r.get(4)).toMatchObject({ customerId: 'cA', custCodeKey: 'CA1', branchId: null });
    expect(r.get(7)).toMatchObject({ customerId: 'cB', matchedBy: 'NMWC_CODE', branchId: 'bB1' });
    expect(r.get(9)).toMatchObject({ customerId: 'cN', matchedBy: 'TEMIX_CODE', branchId: null });
    for (const row of [10, 11, 12, 13]) expect(r.get(row)!.customerId, `row ${row}`).toBeNull();
    // A held row with a matched shop still names it (the drill-down), but moves nothing.
    expect(r.get(17)).toMatchObject({ customerId: 'cF', branchId: 'bF1', move: null });
  });

  it('the two moves: from the shop\'s route to the exact route, one into another region', () => {
    expect(r.get(3)!.move).toEqual({ branchId: 'bA2', fromRouteId: 'rt-c11', toRouteId: 'rt-c10', fromRegionId: 'rg-1', toRegionId: 'rg-1', via: 'EXACT' });
    expect(r.get(7)!.move).toEqual({ branchId: 'bB1', fromRouteId: 'rt-c10', toRouteId: 'rt-d20', fromRegionId: 'rg-1', toRegionId: 'rg-2', via: 'EXACT' });
    expect(plan.rows.filter((p) => p.move).map((p) => p.rowNumber)).toEqual([3, 7]);
  });

  it('the summary figures', () => {
    expect(plan.counts).toMatchObject({
      rows: 19,
      held: 13,
      wouldMove: 2,
      noChange: 4,
      customersMatched: 8,
      unknownCustomers: { codes: 1, rows: 2 },
      moves: { shops: 2, customers: 2, crossRegion: 1, viaMap: 0 },
    });
    expect(plan.counts.holds).toEqual({
      SHOP_ARCHIVED: 1,
      SHOP_UNKNOWN: 1,
      SHOP_CODE_LOOKALIKE: 1,
      BRANCH_CODE_BLANK: 1,
      SHOP_NOT_LINKED: 1,
      CUSTOMER_ARCHIVED: 1,
      DUPLICATE_SUSPECT: 1,
      CUSTOMER_UNKNOWN: 2,
      CELL_ERROR: 1,
      SHOP_OF_ANOTHER_CUSTOMER: 1,
      DUPLICATE_ROW: 2,
    });
    expect(plan.counts.routeHolds).toEqual({ ROUTE_NOT_MATCHED: 1, ROUTE_SWITCHED_OFF: 1, ROUTE_MISSING: 1 });
    expect(plan.unmatchedRoutes).toEqual([{ code: 'C10MA', rows: 1, shopFound: 1 }]);
  });

  it('credit and terms: listed as written, per row, for the customer found, and never applied', () => {
    expect(r.get(7)!.terms).toEqual([{ field: 'creditLimit', crm: '1500', file: '2000' }]);
    expect(r.get(8)!.terms).toEqual([{ field: 'paymentTermDays', crm: '30', file: '45' }]);
    expect(plan.rows.filter((p) => p.terms.length > 0).map((p) => p.rowNumber)).toEqual([7, 8]);
    expect(plan.counts.terms).toEqual({
      rows: 2,
      customers: 1,
      byField: { paymentTerms: 0, creditLimit: 1, paymentTermDays: 1 },
      customersWithRowsDisagreeing: 1,
    });
    // A difference in terms never makes a row change: only a move does.
    expect(r.get(8)!.verdict).toBe('HELD');
    expect(plan.mainRow).toEqual({ decided: false, why: 'MAIN_ROW_UNDECIDED' });
  });

  it('status: each pair counted beside the customer and beside the shop, none called a difference', () => {
    expect(plan.counts.statusByCustomer).toEqual([
      { temix: 'A', crm: 'ACTIVE', rows: 11 },
      { temix: 'A', crm: 'CLOSED', rows: 3 },
      { temix: 'I', crm: 'ACTIVE', rows: 1 },
    ]);
    expect(plan.counts.statusByShop).toEqual([
      { temix: 'A', crm: 'ACTIVE', rows: 8 },
      { temix: 'A', crm: 'CLOSED', rows: 1 },
    ]);
    // Temix I on an ACTIVE customer (row 5) is held for its shop, not for its status.
    expect(r.get(5)!.holds).toEqual(['SHOP_UNKNOWN']);
  });

  it('customers not in the file: live, not test, named by no row by either code', () => {
    expect(plan.missingCustomerIds.sort()).toEqual(['cH', 'cM', 'cP']);
    expect(plan.counts.missing).toEqual({ customers: 3, withoutTemixCode: 2 });
  });
});

// A row built by hand, for the cases the synthetic file does not hold.
const row = (id: string, over: Partial<CheckRow>): CheckRow => ({
  id,
  rowNumber: Number(id.replace(/\D/g, '')) || 2,
  custCodeKey: 'CQ1',
  branchCodeKey: null,
  branchCodeWritten: null,
  route: 'C10',
  paymentTerms: null,
  creditLimit: null,
  paymentTermDays: null,
  status: 'A',
  notes: [],
  ...over,
});
const CQ = { ...CUSTOMERS[0]!, id: 'cQ', nmwcCode: 'CQ1', temixCode: null, paymentTerms: 'CREDIT' as const, creditLimit: 500, paymentTermDays: 30 };
const shopOfCQ = (id: string, branchCode: string) => ({ id, customerId: 'cQ', branchCode, routeId: 'rt-c11', regionId: 'rg-1', live: true, status: 'ACTIVE' as const });
const only = (rows: CheckRow[], branches = [shopOfCQ('bQ1', 'CQ1-01'), shopOfCQ('bQ2', 'CQ1-02')]) =>
  checkDailyFile({ rows, customers: [CQ], branches, routes: ROUTES, routeMap: [] });

describe('cases beside the synthetic file', () => {
  it('a main row with terms beside shop rows left blank: no row disagrees', () => {
    const plan = only([
      row('r2', { branchCodeWritten: null, paymentTerms: 'CREDIT', creditLimit: 500, paymentTermDays: 30 }),
      row('r3', { branchCodeWritten: '01', branchCodeKey: '01' }),
      row('r4', { branchCodeWritten: '02', branchCodeKey: '02' }),
    ]);
    expect(plan.counts.terms).toEqual({ rows: 0, customers: 0, byField: { paymentTerms: 0, creditLimit: 0, paymentTermDays: 0 }, customersWithRowsDisagreeing: 0 });
    // Two values of one field do disagree, blanks or not.
    const two = only([row('r2', { creditLimit: 500 }), row('r3', { branchCodeWritten: '01', creditLimit: 900 }), row('r4', { branchCodeWritten: '02' })]);
    expect(two.counts.terms.customersWithRowsDisagreeing).toBe(1);
  });

  it("a shop code that is the customer's own code is held until the owner says how the main row is marked", () => {
    const plan = only([row('r2', { branchCodeWritten: 'cq1', branchCodeKey: 'CQ1' }), row('r3', { branchCodeWritten: 'CQ1', branchCodeKey: 'CQ1' })], [shopOfCQ('bQ0', 'CQ1')]);
    for (const p of plan.rows) expect(p, p.rowId).toMatchObject({ verdict: 'HELD', holds: ['BRANCH_CODE_IS_CUSTOMER_CODE'], move: null, branchId: null });
    expect(plan.counts.wouldMove).toBe(0);
    // "CQ1-01" is not the customer's own code: it still moves.
    expect(only([row('r2', { branchCodeWritten: 'CQ1-01' })]).rows[0]!.verdict).toBe('WOULD_MOVE');
  });

  it('a row keeps its shop code as written, for the Steward to correct in Temix', () => {
    const plan = only([row('r2', { branchCodeWritten: 'ma', branchCodeKey: 'MA' })], [shopOfCQ('bQ1', 'CQ1-MA')]);
    expect(plan.rows[0]).toMatchObject({ branchCodeWritten: 'ma', branchCodeKey: 'MA', verdict: 'HELD', holds: ['SHOP_CODE_LOOKALIKE'] });
  });

  it('route codes not matched are counted over every row, and apart over the rows of a shop found', () => {
    const plan = only([row('r2', { branchCodeWritten: '09', route: 'C10MA' }), row('r3', { branchCodeWritten: '01', route: 'C10MA' })]);
    expect(plan.rows.map((p) => p.verdict)).toEqual(['HELD', 'NO_CHANGE']);
    expect(plan.counts.routeHolds).toEqual({ ROUTE_NOT_MATCHED: 1 });
    expect(plan.unmatchedRoutes).toEqual([{ code: 'C10MA', rows: 2, shopFound: 1 }]);
  });

  it('a spreadsheet error in a code cell is not a code: no unknown customer, no route code waiting', () => {
    const plan = only([
      row('r2', { custCodeKey: '#ERROR:#N/A', notes: ['CELL_ERROR'] }),
      row('r3', { custCodeKey: '#N/A', notes: ['CELL_ERROR'] }),
      row('r4', { branchCodeWritten: '01', route: '#ERROR:#N/A', notes: ['CELL_ERROR'] }),
      row('r5', { custCodeKey: '#ERROR:#N/A', route: '#REF!', notes: ['CELL_ERROR'] }),
    ]);
    for (const p of plan.rows) expect(p, p.rowId).toMatchObject({ verdict: 'HELD', holds: ['CELL_ERROR'], move: null });
    // Only the row whose customer code is real names its customer.
    expect(plan.rows.map((p) => p.customerId)).toEqual([null, null, 'cQ', null]);
    expect(plan.counts.unknownCustomers).toEqual({ codes: 0, rows: 0 });
    expect(plan.counts.holds).toEqual({ CELL_ERROR: 4 });
    expect(plan.unmatchedRoutes).toEqual([]);
  });
});

describe('route codes: C10 beside C10MA', () => {
  const route = (code: string) => routeResolver(ROUTES, [])(code);
  it('the exact code only, with the map empty: C10MA is not C10', () => {
    expect(route('C10')).toEqual({ kind: 'EXACT', routeId: 'rt-c10', code: 'C10' });
    expect(route(' c10 ')).toEqual({ kind: 'EXACT', routeId: 'rt-c10', code: 'C10' });
    expect(route('C10MA')).toEqual({ kind: 'NOT_MATCHED', code: 'C10MA' });
    expect(route('C1')).toEqual({ kind: 'NOT_MATCHED', code: 'C1' });
    expect(route('')).toEqual({ kind: 'MISSING' });
  });

  it('with an entry C10MA -> C10, row 14 moves through the map, and nothing else changes', () => {
    const plan = checkDailyFile(checkInput([{ id: '1', temixRouteCode: 'C10MA', routeId: 'rt-c10' }]));
    const r = byRow(plan.rows);
    expect(r.get(14)!.route).toEqual({ kind: 'MAP', routeId: 'rt-c10', code: 'C10MA', entryId: '1' });
    expect(r.get(14)!.move).toEqual({ branchId: 'bE1', fromRouteId: 'rt-c11', toRouteId: 'rt-c10', fromRegionId: 'rg-1', toRegionId: 'rg-1', via: 'MAP' });
    expect(plan.counts).toMatchObject({ wouldMove: 3, noChange: 3, held: 13, moves: { shops: 3, customers: 3, crossRegion: 1, viaMap: 1 } });
    expect(plan.counts.routeHolds).toEqual({ ROUTE_SWITCHED_OFF: 1, ROUTE_MISSING: 1 });
    expect(plan.unmatchedRoutes).toEqual([]);
  });

  it('an entry to a switched-off route holds the move; an entry for an exact code is never used', () => {
    const off = byRow(checkDailyFile(checkInput([{ id: '2', temixRouteCode: 'C10MA', routeId: 'rt-z99' }])).rows);
    expect(off.get(14)).toMatchObject({ move: null, routeHold: 'ROUTE_SWITCHED_OFF', verdict: 'NO_CHANGE' });
    const shadow = byRow(checkDailyFile(checkInput([{ id: '3', temixRouteCode: 'C10', routeId: 'rt-d20' }])).rows);
    expect(shadow.get(2)).toMatchObject({ verdict: 'NO_CHANGE', move: null, route: { kind: 'EXACT', routeId: 'rt-c10' } });
  });

  it('two CRM routes with one code once normalised: nothing is chosen, and the shop keeps its route', () => {
    const routes = [...ROUTES, { id: 'rt-c10b', code: 'c10', regionId: 'rg-2', isActive: true }];
    expect(routeResolver(routes, [])('C10')).toEqual({ kind: 'AMBIGUOUS', code: 'C10' });
    const plan = checkDailyFile({ ...checkInput(), routes });
    expect(byRow(plan.rows).get(3)).toMatchObject({ move: null, routeHold: 'ROUTE_AMBIGUOUS', verdict: 'NO_CHANGE' });
  });

  it('the route-map page lists codes nothing matches, with their rows, most rows first', () => {
    const counts = [
      { code: 'C10', rows: 9 },
      { code: 'C10MA', rows: 2 },
      { code: 'c10ma', rows: 1 },
      { code: 'X1', rows: 5 },
      { code: null, rows: 4 },
    ];
    expect(unmatchedRouteCodes(counts, ROUTES, [])).toEqual([
      { code: 'X1', rows: 5 },
      { code: 'C10MA', rows: 3 },
    ]);
    expect(unmatchedRouteCodes(counts, ROUTES, [{ id: '1', temixRouteCode: 'C10MA', routeId: 'rt-c10' }])).toEqual([{ code: 'X1', rows: 5 }]);
  });

  it('the route-map page does not offer a spreadsheet error as a route code', () => {
    const counts = [
      { code: '#ERROR:#N/A', rows: 1 },
      { code: '#N/A', rows: 2 },
      { code: '#ref!', rows: 1 },
      { code: 'X1', rows: 5 },
    ];
    expect(unmatchedRouteCodes(counts, ROUTES, [])).toEqual([{ code: 'X1', rows: 5 }]);
  });
});

describe('what waits for the owner stays undecided', () => {
  it('the main row is undecided for every customer, whatever its rows', () => {
    const rows = stagedCheckRows();
    expect(mainRowOf(rows)).toEqual({ decided: false, why: 'MAIN_ROW_UNDECIDED' });
    expect(mainRowOf(rows.filter((x: CheckRow) => x.custCodeKey === 'CB2'))).toEqual({ decided: false, why: 'MAIN_ROW_UNDECIDED' });
    expect(mainRowOf([])).toEqual({ decided: false, why: 'MAIN_ROW_UNDECIDED' });
  });

  it('no customer is created, no status is compared, no credit is applied: only route moves change anything', () => {
    const plan = checkDailyFile(checkInput());
    expect(new Set(plan.rows.map((p) => p.verdict))).toEqual(new Set(['HELD', 'WOULD_MOVE', 'NO_CHANGE']));
    for (const p of plan.rows) expect(p.verdict === 'WOULD_MOVE', `row ${p.rowNumber}`).toBe(p.move !== null);
  });

  it('the Check module reads nothing but its arguments', () => {
    const code = readFileSync('lib/temix-daily-check.ts', 'utf8');
    const imports = [...code.matchAll(/^import [^;]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./import-shop-code', './temix-code', './temix-daily-file']);
  });

  it('every hold has words, and hold codes are code words the row table accepts', () => {
    for (const h of CHECK_HOLDS) {
      expect(CHECK_HOLD_LABEL[h]).toBeTruthy();
      expect(h).toMatch(/^[A-Z][A-Z0-9_]{0,59}$/);
    }
    // The upload notes that hold a row are notes the upload writes.
    for (const h of ['CUST_CODE_MISSING', 'DUPLICATE_ROW', 'SHOP_CODE_LOOKALIKE', 'CELL_ERROR'])
      expect(TEMIX_DAILY_UPLOAD_NOTES as readonly string[]).toContain(h);
  });

  it('the fixture is what it says: one archived customer, one test customer, one archived shop', () => {
    expect(CUSTOMERS.filter((c) => !c.live).map((c) => c.id)).toEqual(['cX']);
    expect(CUSTOMERS.filter((c) => c.isTest).map((c) => c.id)).toEqual(['cT']);
    expect(BRANCHES.filter((b) => !b.live).map((b) => b.id)).toEqual(['bA3']);
  });
});

describe('the pilot rule', () => {
  it('stops while a new-customer request waits at the Accountant, and lists each', () => {
    expect(pilotGate([])).toEqual({ stopped: false, waiting: [] });
    const w = [{ id: 'e1', submittedAt: new Date('2026-11-10T05:00:00Z') }, { id: 'e2', submittedAt: null }];
    expect(pilotGate(w)).toEqual({ stopped: true, waiting: w });
  });
});

describe('the route-map form', () => {
  const routes = ROUTES.map((r) => ({ id: r.id, code: r.code }));
  it('takes a new code for a CRM route, with a reason', () => {
    expect(routeMapEntryRefusal({ code: 'C10MA', routeId: 'rt-c10', routes, hasLiveEntry: false })).toBeNull();
    expect(routeMapEntryRefusal({ code: 'C10MA', routeId: 'rt-z99', routes, hasLiveEntry: false })).toBeNull();
    expect(routeMapReasonRefusal('Route master of 2026-11-01')).toBeNull();
  });
  it('refuses an empty code, an exact CRM code, an unknown route, a second live entry, and no reason', () => {
    expect(routeMapEntryRefusal({ code: '', routeId: 'rt-c10', routes, hasLiveEntry: false })).toHaveProperty('code');
    expect(routeMapEntryRefusal({ code: 'C10', routeId: 'rt-d20', routes, hasLiveEntry: false })!.code).toMatch(/already a CRM route's code/);
    expect(routeMapEntryRefusal({ code: 'c10', routeId: 'rt-d20', routes, hasLiveEntry: false })!.code).toMatch(/not normalised/);
    expect(routeMapEntryRefusal({ code: 'C10MA', routeId: 'rt-nope', routes, hasLiveEntry: false })).toHaveProperty('routeId');
    expect(routeMapEntryRefusal({ code: 'C10MA', routeId: 'rt-c10', routes, hasLiveEntry: true })!.code).toMatch(/Retire it first/);
    expect(routeMapEntryRefusal({ code: 'X'.repeat(41), routeId: 'rt-c10', routes, hasLiveEntry: false })).toHaveProperty('code');
    for (const code of ['#ERROR:#N/A', '#N/A', '#REF!'])
      expect(routeMapEntryRefusal({ code, routeId: 'rt-c10', routes, hasLiveEntry: false })!.code, code).toMatch(/spreadsheet error/);
    expect(routeMapReasonRefusal('  ')).toMatch(/Give a reason/);
    expect(routeMapReasonRefusal('x'.repeat(301))).toMatch(/300/);
  });
});
