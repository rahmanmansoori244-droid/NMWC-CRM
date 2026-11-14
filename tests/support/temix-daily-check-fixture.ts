/**
 * A synthetic daily file and CRM for the Check (lib/temix-daily-check.ts):
 * one row for each thing the Check decides. Every code, figure and id is made
 * up. The expected figures are written out by hand in
 * tests/unit/temix-daily-check.test.ts and the preview's page test.
 *
 * Rows (sheet row numbers):
 *   2  CA1 01   C10    -> no change (already on C10)
 *   3  CA1 02   C10    -> moves C11 -> C10 (exact code)
 *   4  ca1 03   C10    -> held: the shop is archived (small letters read as CA1)
 *   5  CA1 04   C10  I -> held: the customer has no such shop
 *   6  CL3 001  C10    -> held: looks like CL3-01 (only the zeros differ)
 *   7  CB2 CB2-01 D20  -> moves C10 -> D20 (another region); credit limit differs
 *   8  CB2 (blank) D20 -> held: no shop code; credit days differ
 *   9  TX1 01   C10    -> held: found by its Temix code, shops not linked
 *  10  CX9 01          -> held: only an archived customer has the code
 *  11  CD5 01          -> held: one live customer's NMWC code, another's Temix code
 *  12  CNEW1 01        -> held: unknown customer
 *  13  CNEW1 02        -> held: unknown customer
 *  14  CE4 01   C10MA  -> route not matched (no map entry): keeps C11
 *  15  CE4 02   Z99    -> route switched off: keeps C11
 *  16  CE4 03   (blank)-> no route: keeps C10
 *  17  CF6 01  #REF!   -> held: a cell error
 *  18  CG7 01          -> held: CG7-01 is another customer's shop
 *  19  CK1 01          -> held: the same shop twice
 *  20  CK1 01          -> held: the same shop twice
 */
import { reportDailyHeadings, stageDailyRows, type DailySheetRow } from '@/lib/temix-daily-file';
import { checkRowOfStaged, type CheckInput, type CrmBranch, type CrmCustomer, type CrmRoute, type RouteMapEntry } from '@/lib/temix-daily-check';

export const HEAD = ['cust_code', 'branch_code', 'cust_name', 'route', 'payment_terms', 'credit_limit', 'payment_term_days', 'status', 'created_date', 'cr_no', 'phone', 'address'];

type Cells = [string, string, string, string, string, string, string, string];
const ROWS: Cells[] = [
  // cust, branch, route, terms, limit, days, status, address
  ['CA1', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CA1', '02', 'C10', 'CASH', '', '', 'A', ''],
  ['ca1', '03', 'C10', 'CASH', '', '', 'A', ''],
  ['CA1', '04', 'C10', 'CASH', '', '', 'I', ''],
  ['CL3', '001', 'C10', 'CASH', '', '', 'A', ''],
  ['CB2', 'CB2-01', 'D20', 'CREDIT', '2000', '30', 'A', ''],
  ['CB2', '', 'D20', 'CREDIT', '1500', '45', 'A', ''],
  ['TX1', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CX9', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CD5', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CNEW1', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CNEW1', '02', 'C10', 'CASH', '', '', 'A', ''],
  ['CE4', '01', 'C10MA', 'CASH', '', '', 'A', ''],
  ['CE4', '02', 'Z99', 'CASH', '', '', 'A', ''],
  ['CE4', '03', '', 'CASH', '', '', 'A', ''],
  ['CF6', '01', 'C10', 'CASH', '', '', 'A', '#REF!'],
  ['CG7', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CK1', '01', 'C10', 'CASH', '', '', 'A', ''],
  ['CK1', '01', 'C10', 'CASH', '', '', 'A', ''],
];

/** The sheet rows as a list of cells in HEAD order (for building a real .xlsx or .csv). */
export function sheetCells(): string[][] {
  return ROWS.map(([cust, branch, route, terms, limit, days, status, address], i) => [
    cust,
    branch,
    `Customer ${i + 1}`,
    route,
    terms,
    limit,
    days,
    status,
    '',
    '',
    '',
    address,
  ]);
}

/** The rows as the upload stages them, then as the Check reads them (ids r<rowNumber>). */
export function stagedCheckRows() {
  const rows: DailySheetRow[] = sheetCells().map((cells) => Object.fromEntries(HEAD.map((h, i) => [h, cells[i] ?? ''])));
  const staged = stageDailyRows({ rows, rowNumbers: rows.map((_, i) => i + 2) }, reportDailyHeadings(HEAD));
  return staged.map((s) => checkRowOfStaged(`r${s.rowNumber}`, s));
}

export const ROUTES: CrmRoute[] = [
  { id: 'rt-c10', code: 'C10', regionId: 'rg-1', isActive: true },
  { id: 'rt-c11', code: 'C11', regionId: 'rg-1', isActive: true },
  { id: 'rt-d20', code: 'D20', regionId: 'rg-2', isActive: true },
  { id: 'rt-z99', code: 'Z99', regionId: 'rg-1', isActive: false },
];

const cust = (id: string, nmwcCode: string, over: Partial<CrmCustomer> = {}): CrmCustomer => ({
  id,
  nmwcCode,
  temixCode: null,
  live: true,
  isTest: false,
  status: 'ACTIVE',
  paymentTerms: 'CASH',
  creditLimit: null,
  paymentTermDays: null,
  ...over,
});

export const CUSTOMERS: CrmCustomer[] = [
  cust('cA', 'CA1', { temixCode: 'CA1' }),
  cust('cL', 'CL3'),
  cust('cB', 'CB2', { paymentTerms: 'CREDIT', creditLimit: 1500, paymentTermDays: 30 }),
  cust('cN', 'NMWC-2026-000001', { temixCode: 'TX1' }),
  cust('cX', 'CX9', { live: false }),
  cust('cD1', 'CD5'),
  cust('cD2', 'NMWC-2026-000002', { temixCode: 'CD5' }),
  cust('cE', 'CE4', { status: 'CLOSED' }),
  cust('cF', 'CF6'),
  cust('cG', 'CG7'),
  cust('cH', 'CH1'),
  cust('cK', 'CK1'),
  // Named by no row: missing (cH above too), but not a test customer.
  cust('cM', 'CM7', { temixCode: 'CM7' }),
  cust('cT', 'CT8', { isTest: true }),
  cust('cP', 'NMWC-2026-000003'),
];

const shop = (id: string, customerId: string, branchCode: string, routeId: string, over: Partial<CrmBranch> = {}): CrmBranch => ({
  id,
  customerId,
  branchCode,
  routeId,
  regionId: ROUTES.find((r) => r.id === routeId)!.regionId,
  live: true,
  status: 'ACTIVE',
  ...over,
});

export const BRANCHES: CrmBranch[] = [
  shop('bA1', 'cA', 'CA1-01', 'rt-c10'),
  shop('bA2', 'cA', 'CA1-02', 'rt-c11'),
  shop('bA3', 'cA', 'CA1-03', 'rt-c10', { live: false }),
  shop('bL1', 'cL', 'CL3-01', 'rt-c10'),
  shop('bB1', 'cB', 'CB2-01', 'rt-c10'),
  shop('bN1', 'cN', 'NMWC-2026-000001-01', 'rt-c10'),
  shop('bE1', 'cE', 'CE4-01', 'rt-c11'),
  shop('bE2', 'cE', 'CE4-02', 'rt-c11', { status: 'CLOSED' }),
  shop('bE3', 'cE', 'CE4-03', 'rt-c10'),
  shop('bF1', 'cF', 'CF6-01', 'rt-c10'),
  // A shop of CH1 whose code reads like a shop of CG7.
  shop('bH1', 'cH', 'CG7-01', 'rt-c10'),
  shop('bK1', 'cK', 'CK1-01', 'rt-c10'),
];

export function checkInput(routeMap: RouteMapEntry[] = []): CheckInput {
  return { rows: stagedCheckRows(), customers: CUSTOMERS, branches: BRANCHES, routes: ROUTES, routeMap };
}
