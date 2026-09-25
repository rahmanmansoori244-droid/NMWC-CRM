/**
 * lib/import-rows-view.ts (benchmark item 20): which rows each view of the
 * import batch page lists, how it pages, and how a row reads — as uploaded,
 * with its issues in words.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  issueLines,
  lastPage,
  pageRange,
  parsePage,
  parseRowView,
  rowSummary,
  rowViewWhere,
  uploadedValues,
  viewCounts,
} from '@/lib/import-rows-view';

describe('views', () => {
  it('an unknown or missing view falls back to the rows that need attention', () => {
    expect(parseRowView(undefined)).toBe('problems');
    expect(parseRowView('nonsense')).toBe('problems');
    expect(parseRowView('rejected')).toBe('rejected');
    expect(parseRowView('warnings')).toBe('warnings');
  });

  it('each view selects its rows, always inside the batch', () => {
    // "Needs attention" leaves out what the Steward accepted as excluded (item 20).
    expect(rowViewWhere('b1', 'problems')).toEqual({
      batchId: 'b1',
      state: { in: ['REJECTED', 'QUARANTINED'] },
      excludedAt: null,
    });
    expect(rowViewWhere('b1', 'excluded')).toEqual({ batchId: 'b1', excludedAt: { not: null } });
    expect(rowViewWhere('b1', 'rejected')).toEqual({ batchId: 'b1', state: 'REJECTED' });
    expect(rowViewWhere('b1', 'quarantined')).toEqual({ batchId: 'b1', state: 'QUARANTINED' });
    expect(rowViewWhere('b1', 'warnings')).toEqual({
      batchId: 'b1',
      state: 'PROMOTED',
      issues: { not: Prisma.DbNull },
    });
    expect(rowViewWhere('b1', 'all')).toEqual({ batchId: 'b1' });
  });

  it('counts each view from the per-state totals', () => {
    expect(viewCounts({ CLEAN: 3, PROMOTED: 20, QUARANTINED: 4, REJECTED: 1833 }, 7, 30)).toEqual({
      problems: 1807,
      rejected: 1833,
      quarantined: 4,
      warnings: 7,
      excluded: 30,
      all: 1860,
    });
    expect(viewCounts({}, 0)).toEqual({ problems: 0, rejected: 0, quarantined: 0, warnings: 0, excluded: 0, all: 0 });
  });
});

describe('paging', () => {
  it('reads a page number defensively', () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-3')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage('19')).toBe(19);
  });

  it('every one of 1,833 rows falls on some page, and no page is empty', () => {
    expect(lastPage(1833)).toBe(19);
    expect(lastPage(1800)).toBe(18);
    expect(lastPage(0)).toBe(1);
    expect(pageRange(1, 1833)).toBe('Rows 1–100 of 1,833');
    expect(pageRange(19, 1833)).toBe('Rows 1,801–1,833 of 1,833');
    expect(pageRange(20, 1833)).toBeNull();
    expect(pageRange(1, 0)).toBeNull();
  });
});

describe('a row, in words', () => {
  it('customer issues get a readable label and keep their message', () => {
    expect(
      issueLines([
        { field: 'payment_terms', message: 'expected CASH or CREDIT, got "Crdit"' },
        { field: '_promote', message: 'duplicate branch_code X-01 within this customer' },
        { field: '_lane', message: 'branch X-01 is not in the master and was not added' },
        { field: 'something_new', message: 'kept as is' },
      ])
    ).toEqual([
      { label: 'Payment terms', message: 'expected CASH or CREDIT, got "Crdit"' },
      { label: 'Not loaded', message: 'duplicate branch_code X-01 within this customer' },
      { label: 'Branch not updated', message: 'branch X-01 is not in the master and was not added' },
      { label: 'something_new', message: 'kept as is' },
    ]);
  });

  it('account-master issues name the sheet and row; anything else is shown, not dropped', () => {
    expect(issueLines([{ sheet: 'Users', row: 5, message: 'new user needs a password' }])).toEqual([
      { label: 'Users sheet, row 5', message: 'new user needs a password' },
    ]);
    expect(issueLines([{ odd: true }])).toEqual([{ label: 'Issue', message: '{"odd":true}' }]);
    expect(issueLines(null)).toEqual([]);
    expect(issueLines({ not: 'an array' })).toEqual([]);
  });

  it('who a row is about: parsed codes first, then the sheet columns, then legacy headings', () => {
    expect(
      rowSummary(
        { cust_code: 'x1', cust_name: 'raw name' },
        { custCode: 'X1', custName: 'Parsed Name', branchCode: 'X1-01', routeCode: 'C4', dayOfVisit: 'SUN' }
      )
    ).toEqual({ code: 'X1', name: 'Parsed Name', branch: 'X1-01', route: 'C4', day: 'SUN' });
    expect(rowSummary({ 'CUST CODE': 'L1', 'CUST NAME': 'Legacy', ROUTE: 'R9' }, null)).toEqual({
      code: 'L1',
      name: 'Legacy',
      branch: null,
      route: 'R9',
      day: null,
    });
    expect(rowSummary(null, null)).toEqual({ code: null, name: null, branch: null, route: null, day: null });
  });

  it('shows the row as uploaded — the value that caused the problem, not the parser fallback', () => {
    // A quarantined "Crdit" is parsed as CASH; the page must show "Crdit".
    expect(uploadedValues({ cust_code: 'X1', payment_terms: 'Crdit', address: '  ', phone: null, credit_limit: 0 })).toEqual([
      ['cust_code', 'X1'],
      ['payment_terms', 'Crdit'],
      ['credit_limit', '0'],
    ]);
    expect(uploadedValues(null)).toEqual([]);
    expect(uploadedValues(['a'])).toEqual([]);
  });
});
