/**
 * lib/import-headings.ts — which heading of a customer sheet is which column
 * (code review 2026-11-10, finding 1).
 *
 * What was wrong: the row check read exact spellings only, so `TEMIX_CODE`,
 * `Temix code` and `TemixCode` were read as nothing, every row staged CLEAN with
 * no Temix code, and nothing listed the headings the import had not read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_COLUMNS,
  READ_ORDER,
  columnsOfHeading,
  foldHeading,
  headingClashIssue,
  missingTemixColumnIssue,
  notReadNote,
  readCell,
  readLooseCell,
  reportHeadings,
} from '@/lib/import-headings';
import { parseWorkbook } from '@/lib/excel';
import { CUSTOMER_MASTER_COLUMNS } from '@/lib/customer-master-rows';

describe('foldHeading', () => {
  it('drops case, spaces, underscores, dashes and width, and nothing else', () => {
    expect(['TEMIX_CODE', 'Temix code', ' temix-code ', 'TemixCode', 'ＴＥＭＩＸ　ＣＯＤＥ'].map(foldHeading)).toEqual(
      Array(5).fill('temixcode')
    );
    expect(foldHeading('CR NO.')).toBe('crno');
    expect(foldHeading('  ')).toBe('');
    expect(foldHeading(null)).toBe('');
    // A different word stays a different word.
    expect(foldHeading('temix_codes')).not.toBe('temixcode');
  });
});

describe('columnsOfHeading', () => {
  it('every template column is itself', () => {
    for (const c of CUSTOMER_COLUMNS) expect(columnsOfHeading(c), c).toEqual([c]);
  });

  it('every legacy spelling the check has always read is still read as its column', () => {
    for (const c of CUSTOMER_COLUMNS) {
      for (const spelling of READ_ORDER[c]) expect(columnsOfHeading(spelling), `${c} ← ${spelling}`).toContain(c);
    }
  });

  it.each(['TEMIX_CODE', 'Temix_Code', 'Temix code', 'temix code', 'TemixCode', 'temix-code', 'TEMIX CODE '])(
    '%j is the temix_code column',
    (h) => {
      expect(columnsOfHeading(h)).toEqual(['temix_code']);
    }
  );

  it.each([
    ['Route', 'route'],
    ['Phone', 'phone'],
    ['Credit Limit', 'credit_limit'],
    ['Payment_Term_Days', 'payment_term_days'],
    ['PAYMENT_TERMS', 'payment_terms'],
    ['Customer Status', 'customer_status'],
    ['Day of visit', 'day_of_visit'],
    ['Cust Code', 'cust_code'],
    ['CR No.', 'cr_no'],
  ])('%j is read as %s', (h, column) => {
    expect(columnsOfHeading(h)).toEqual([column]);
  });

  it('CUST BRANCH is both the branch code and the branch name, as it always was', () => {
    expect(columnsOfHeading('CUST BRANCH')).toEqual(['branch_code', 'branch_name']);
    expect(columnsOfHeading('cust_branch')).toEqual(['branch_code', 'branch_name']);
  });

  it.each(['terms', 'limit', 'days', 'status', 'notes', 'alt_phone', 'branch_status', 'region_code', 'temix', ''])(
    '%j is not a column the import reads',
    (h) => {
      expect(columnsOfHeading(h)).toEqual([]);
    }
  );
});

describe('readCell', () => {
  it('reads a heading in any spelling', () => {
    for (const h of ['TEMIX_CODE', 'Temix_Code', 'Temix code', 'temix code', 'TemixCode']) {
      expect(readCell({ [h]: 'CAA0367' }, 'temix_code'), h).toBe('CAA0367');
    }
    expect(readCell({ 'Credit Limit': 750 }, 'credit_limit')).toBe(750);
  });

  it('keeps the old order: the template heading first, then the legacy ones as they were listed', () => {
    expect(readCell({ 'CUST NAME': 'Legacy', name: 'Short', cust_name: 'Template' }, 'cust_name')).toBe('Template');
    expect(readCell({ 'CUST NAME': 'Legacy', name: 'Short' }, 'cust_name')).toBe('Legacy');
    expect(readCell({ ADDRESS: 'B', ADDRSS: 'A' }, 'address')).toBe('A');
    expect(readCell({ Code: 'c', code: 'b', CUSTCODE: 'a' }, 'cust_code')).toBe('a');
  });

  it('a blank (null) cell under the first spelling falls through to the next, as `??` did', () => {
    expect(readCell({ cust_name: null, 'CUST NAME': 'Legacy' }, 'cust_name')).toBe('Legacy');
    expect(readCell({ phone: null, Phone: '99758980' }, 'phone')).toBe('99758980');
  });

  it("an empty string stops the chain: a Steward's correction to '' clears the cell", () => {
    expect(readCell({ cust_name: '', 'CUST NAME': 'Legacy' }, 'cust_name')).toBe('');
    expect(readCell({ address: '', Address: 'Way 1' }, 'address')).toBe('');
  });

  it('an exact spelling wins over a variant of it, whatever the key order', () => {
    expect(readCell({ 'Temix Code ': 'VARIANT', temix_code: 'EXACT' }, 'temix_code')).toBe('EXACT');
  });

  it('nothing under any spelling is undefined', () => {
    expect(readCell({ other: 'x' }, 'temix_code')).toBeUndefined();
    expect(readCell({ temix_code: null }, 'temix_code')).toBeUndefined();
  });

  it('readLooseCell reads a column outside the 17 the same way (notes)', () => {
    expect(readLooseCell({ notes: 'a' }, 'notes')).toBe('a');
    expect(readLooseCell({ Notes: 'b' }, 'notes')).toBe('b');
    expect(readLooseCell({ notes: null, NOTES: 'c' }, 'notes')).toBe('c');
    expect(readLooseCell({ note: 'd' }, 'notes')).toBeUndefined();
  });
});

describe('reportHeadings', () => {
  it('says which headings are read as which column, and which are not read at all', () => {
    const r = reportHeadings(['Cust Code', 'cust_name', 'Temix code', 'Limit', 'CUST BRANCH', 'status', 'Helper col']);
    expect(r.read).toEqual({
      cust_code: ['Cust Code'],
      cust_name: ['cust_name'],
      temix_code: ['Temix code'],
      branch_code: ['CUST BRANCH'],
      branch_name: ['CUST BRANCH'],
    });
    expect(r.unrecognised).toEqual(['Limit', 'status', 'Helper col']);
    expect(r.hasTemixCode).toBe(true);
    expect(r.clashes).toEqual([]);
  });

  it('the daily-file shape (no temix_code) has no temix_code column', () => {
    const r = reportHeadings(['cust_code', 'branch_code', 'cust_name', 'route', 'terms', 'limit', 'days', 'status']);
    expect(r.hasTemixCode).toBe(false);
    expect(r.unrecognised).toEqual(['terms', 'limit', 'days', 'status']);
  });

  it('one column under two spellings is a clash; two legacy headings of one column are not', () => {
    const clash = reportHeadings(['cust_code', 'Temix code', 'temix_code']);
    expect(clash.clashes).toEqual([{ columns: ['temix_code'], headings: ['Temix code', 'temix_code'] }]);
    expect(headingClashIssue('Customers', clash)).toBe(
      'Sheet "Customers": the headings "Temix code" and "temix_code" are both read as the temix_code column. Keep one, or rename the other.'
    );
    // `phone` and `Primary Phone` have always been two columns read in a fixed order.
    const legacy = reportHeadings(['cust_code', 'phone', 'Primary Phone', 'code']);
    expect(legacy.clashes).toEqual([]);
    expect(headingClashIssue('Customers', legacy)).toBeNull();
    const three = reportHeadings(['ROUTE ', 'Route', 'route']);
    expect(headingClashIssue('S', three)).toBe(
      'Sheet "S": the headings "ROUTE ", "Route" and "route" are all read as the route column. Keep one, or rename the other.'
    );
    const two = reportHeadings(['CUST BRANCH', 'cust_branch']);
    expect(headingClashIssue('S', two)).toContain('are both read as the branch_code and branch_name columns.');
  });

  it("the generated template's headings are all read, each as itself", async () => {
    const sheets = await parseWorkbook(
      readFileSync(path.join('docs', 'import-templates', 'customer-master-template.xlsx'))
    );
    const r = reportHeadings(sheets[0]!.headers);
    expect(r.unrecognised).toEqual([]);
    expect(r.clashes).toEqual([]);
    expect(Object.keys(r.read).sort()).toEqual([...CUSTOMER_COLUMNS].sort());
  });

  it('the /import help lists exactly the columns the import reads', () => {
    const page = readFileSync('app/(app)/import/page.tsx', 'utf8');
    const help = page.slice(page.indexOf('<code>cust_code</code>'), page.indexOf('Legacy uppercase headings'));
    const listed = [...help.matchAll(/<code>([a-z_]+)<\/code>/g)].map((m) => m[1]);
    expect(listed).toEqual([...CUSTOMER_COLUMNS]);
  });

  it("the app's own /export workbook has no temix_code column, and most of its columns are not read", () => {
    // Recorded here because a round trip of that file is refused at upload once it
    // names a customer linked to Temix (services/imports.ts).
    const r = reportHeadings(CUSTOMER_MASTER_COLUMNS);
    expect(r.hasTemixCode).toBe(false);
    expect(r.clashes).toEqual([]);
    expect(r.unrecognised).toEqual([
      'cr_photo',
      'region_code',
      'area_description',
      'alt_phone',
      'contact_role',
      'sub_channel',
      'opening_hours',
      'delivery_window',
      'gps_lat',
      'gps_lng',
      'gps_captured_at',
      'coolers',
      'stands',
      'empty_bottles',
      'shop_photo',
      'signboard_photo',
      'branch_status',
      'completeness_pct',
      'last_edited_at',
    ]);
  });
});

describe('the messages', () => {
  it('notReadNote counts, lists and caps the headings', () => {
    expect(notReadNote([])).toBeNull();
    expect(notReadNote(['Limit'])).toBe(
      'Not read: 1 column in this sheet is not used by the import and was ignored — Limit. If it should have been read, check its spelling against the template.'
    );
    expect(notReadNote(['Limit', 'status'])).toBe(
      'Not read: 2 columns in this sheet are not used by the import and were ignored — Limit, status. If one of them should have been read, check its spelling against the template.'
    );
    const many = Array.from({ length: 23 }, (_, i) => `h${i + 1}`);
    const note = notReadNote(many)!;
    expect(note).toContain('Not read: 23 columns');
    expect(note).toContain('h20 and 3 more.');
    expect(note).not.toContain('h21');
  });

  it('missingTemixColumnIssue names the column, the count and up to three customers', () => {
    expect(missingTemixColumnIssue(2, ['CAA0001', 'CAA0002'])).toBe(
      "This sheet has no temix_code column, and 2 of its customers already have a Temix code in the CRM (for example CAA0001, CAA0002). Nothing was uploaded. Without that column the import cannot tell which rows are a Temix refresh, and their credit limit and credit days would be ignored. Add a column headed temix_code holding each customer's Temix code (it is on the customer page; leave the cell blank for a customer not yet in Temix) and upload again. A Temix extract is not loaded through this screen."
    );
    const one = missingTemixColumnIssue(1, ['A', 'B', 'C', 'D']);
    expect(one).toContain('1 of its customers already has a Temix code in the CRM (for example A, B, C).');
    expect(missingTemixColumnIssue(1200, [])).toContain('and 1,200 of its customers already have a Temix code in the CRM. Nothing');
  });
});
