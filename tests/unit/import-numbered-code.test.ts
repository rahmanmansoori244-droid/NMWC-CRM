/**
 * Bug hunt round 1, finding 1: a row with a blank branch_code is numbered by its
 * place among the customer's rows (-01, -02, …). When that number is exactly the
 * code another row of the same customer gives (the head office with no code, and
 * the customer's own shop 01), nothing in the file is repeated, and the reasons
 * used to say "a branch_code repeated in the file" / "duplicate branch_code
 * X-01". They now say what happened and name both rows. The numbering itself is
 * unchanged (an open owner question).
 *
 * And the silent-loss variant: when the coded row was held back, the blank row
 * loaded as X-01; correcting the coded row then updated that shop instead of
 * creating its own. The re-check now holds it back (numberedShops).
 */
import { describe, it, expect } from 'vitest';
import {
  REJECT_REASONS,
  addGroup,
  branchCodeClash,
  branchCodeClashMessage,
  emptySummary,
  planGroup,
  summaryLines,
  type PlanRow,
} from '@/lib/import-plan';
import { checkCustomerRow, type RowCheckContext } from '@/lib/import-row-check';

const prow = (over: Partial<PlanRow> = {}): PlanRow => ({
  custCode: 'C1',
  custName: 'Sheet Name',
  branchCode: '01',
  branchName: null,
  regionCode: null,
  routeCode: null,
  address: 'Sheet address 1',
  phone: null,
  contactPerson: null,
  crNumber: null,
  paymentTerms: 'CASH',
  ...over,
});
const plan = (rows: PlanRow[]) =>
  planGroup({
    custCode: 'C1',
    overwrite: false,
    rows,
    existing: null,
    shopByCode: new Map(),
    routeByCode: new Map(),
    channelIdByKey: new Map(),
  });

describe('a blank branch_code numbered like another row', () => {
  it('branchCodeClash tells a numbered clash from a repeated code, by row number', () => {
    expect(
      branchCodeClash(
        [
          { sheetCode: null, branchCode: 'C1-01' },
          { sheetCode: '01', branchCode: 'C1-01' },
        ],
        [2, 3]
      )
    ).toEqual({ kind: 'numbered', code: 'C1-01', sheetCode: '01', blankRow: 2, codedRow: 3 });
    // The coded row first, the blank row second (numbered -02 by its place).
    expect(
      branchCodeClash(
        [
          { sheetCode: '02', branchCode: 'C1-02' },
          { sheetCode: null, branchCode: 'C1-02' },
        ],
        [7, 9]
      )
    ).toEqual({ kind: 'numbered', code: 'C1-02', sheetCode: '02', blankRow: 9, codedRow: 7 });
    expect(
      branchCodeClash(
        [
          { sheetCode: '01', branchCode: 'C1-01' },
          { sheetCode: 'C1-01', branchCode: 'C1-01' },
        ],
        [2, 3]
      )
    ).toEqual({ kind: 'repeated', code: 'C1-01' });
    expect(branchCodeClash([{ sheetCode: null, branchCode: 'C1-01' }, { sheetCode: '02', branchCode: 'C1-02' }], [2, 3])).toBeNull();
  });

  it('a code really repeated by two coded rows wins over a blank row numbered like them', () => {
    // Review of the hunt fixes: [blank -> C1-01, "01", "01"] used to say
    // "No code is repeated in the file", which is untrue.
    expect(
      branchCodeClash(
        [
          { sheetCode: null, branchCode: 'C1-01' },
          { sheetCode: '01', branchCode: 'C1-01' },
          { sheetCode: '01', branchCode: 'C1-01' },
        ],
        [2, 3, 4]
      )
    ).toEqual({ kind: 'repeated', code: 'C1-01' });
    const p = plan([
      prow({ branchCode: null, rowNumber: 2 }),
      prow({ branchCode: '01', rowNumber: 3 }),
      prow({ branchCode: '01', rowNumber: 4 }),
    ]);
    expect(p.rejected).toBe(REJECT_REASONS.REPEATED_CODE);
    expect(p.numberedClash).toBeUndefined();
  });

  it('the promote’s reason names both rows and says nothing is repeated', () => {
    expect(branchCodeClashMessage({ kind: 'numbered', code: 'C1-01', sheetCode: '01', blankRow: 2, codedRow: 3 })).toBe(
      'The branch_code on row 2 is blank, so it is numbered "C1-01" by its place among this customer\'s rows, and that is the code row 3 gives ("01"). No code is repeated in the file: the two rows would be loaded as one shop. Give row 2 a branch_code.'
    );
    // A real repeat keeps its words.
    expect(branchCodeClashMessage({ kind: 'repeated', code: 'C1-01' })).toBe('duplicate branch_code C1-01 within this customer');
  });

  it('"Before you promote" gives its own reason and names the rows; a real repeat is unchanged', () => {
    const numbered = plan([prow({ branchCode: null, rowNumber: 2 }), prow({ branchCode: '01', rowNumber: 3 })]);
    expect(numbered.rejected).toBe(REJECT_REASONS.NUMBERED_CODE);
    expect(numbered.numberedClash).toEqual({ blankRow: 2, codedRow: 3 });
    expect(plan([prow({ rowNumber: 2 }), prow({ rowNumber: 3 })]).rejected).toBe(REJECT_REASONS.REPEATED_CODE);

    const s = emptySummary();
    addGroup(s, numbered);
    for (let i = 0; i < 4; i++) {
      addGroup(s, plan([prow({ branchCode: null, rowNumber: 10 + 2 * i }), prow({ branchCode: '01', rowNumber: 11 + 2 * i })]));
    }
    expect(s.expectRejected.reasons).toEqual([{ reason: REJECT_REASONS.NUMBERED_CODE, customers: 5 }]);
    const line = summaryLines(s, false).find((l) => l.text.startsWith('Blank shop code numbered like another row'));
    expect(line).toEqual({
      tone: 'warn',
      text: 'Blank shop code numbered like another row: on 5 customer(s) a row with no branch_code is numbered by its place (-01, -02, …), and that number is exactly the code another row of the same customer gives: row 2 (blank) and row 3; row 10 (blank) and row 11; row 12 (blank) and row 13 and 2 more. No code is repeated in the file, but the two rows would be one shop, so Promote rejects these customers. Give the blank row a branch_code.',
    });
    expect(summaryLines(s, false).some((l) => /a branch_code repeated in the file/.test(l.text))).toBe(false);
  });
});

describe('the silent-loss variant: a corrected row whose code a blank row of the file was numbered', () => {
  const ctx = (over: Partial<RowCheckContext> = {}): RowCheckContext => ({
    channelKeys: new Set(),
    phonesInFile: new Map(),
    crsInFile: new Map(),
    masterPhones: new Map(),
    masterCrs: new Map(),
    ...over,
  });
  const numberedShops = new Map([['C1', [{ code: 'C1-01', row: 2 }]]]);

  it('is held back on its branch_code cell, naming the row', () => {
    const { issues } = checkCustomerRow({ cust_code: 'C1', cust_name: 'Al Noor', branch_code: '01' }, ctx({ numberedShops }));
    expect(issues).toEqual([
      {
        field: 'branch_code',
        message:
          'Shop code "01" is "C1-01", the code row 2 was given by its place when it loaded (its branch_code was blank). This is another row of the same file, so loading it would change row 2\'s shop instead of creating its own. Give this row a branch_code this customer does not have yet, or exclude the row.',
      },
    ]);
    // Written out in full, the same.
    expect(checkCustomerRow({ cust_code: 'C1', cust_name: 'Al Noor', branch_code: 'c1-01' }, ctx({ numberedShops })).issues).toHaveLength(1);
  });

  it('another code, another customer, or no such shop: not held back', () => {
    expect(checkCustomerRow({ cust_code: 'C1', cust_name: 'Al Noor', branch_code: '02' }, ctx({ numberedShops })).issues).toEqual([]);
    expect(checkCustomerRow({ cust_code: 'C2', cust_name: 'Al Noor', branch_code: '01' }, ctx({ numberedShops })).issues).toEqual([]);
    expect(checkCustomerRow({ cust_code: 'C1', cust_name: 'Al Noor', branch_code: '01' }, ctx()).issues).toEqual([]);
  });
});
