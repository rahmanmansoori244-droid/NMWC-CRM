/**
 * lib/import-row-check.ts — the customer-upload row check, shared by the upload
 * and the Steward's in-app fix (benchmark item 20). Until now no unit test
 * covered the upload's rules at all; this table runs every reason a row can be
 * held back for, and the ones it must NOT be held back for.
 */
import { describe, it, expect } from 'vitest';
import {
  checkCustomerRow,
  fileCollisions,
  heldBackBy,
  isFormulaPayload,
  stripHtml,
  type RowCheckContext,
  type SheetRow,
} from '@/lib/import-row-check';

const ctx = (over: Partial<RowCheckContext> = {}): RowCheckContext => ({
  channelKeys: new Set(['RETAIL']),
  phonesInFile: new Map(),
  crsInFile: new Map(),
  masterPhones: new Map(),
  masterCrs: new Map(),
  ...over,
});
const ok: SheetRow = { cust_code: 'C1', cust_name: 'Al Noor', phone: '99758980', cr_no: '1234567' };
const fields = (row: SheetRow, c = ctx()) => checkCustomerRow(row, c).issues.map((i) => `${i.field}: ${i.message}`);

describe('checkCustomerRow — why a row is held back', () => {
  it('a complete row passes, and parses to canonical values', () => {
    const { issues, parsed } = checkCustomerRow(
      { ...ok, day_of_visit: 'sun', customer_status: 'closed', channel: 'retail', payment_terms: 'credit', credit_limit: '12.3456', payment_term_days: '30', temix_code: ' T1 ' },
      ctx()
    );
    expect(issues).toEqual([]);
    expect(parsed).toMatchObject({
      custCode: 'C1',
      custName: 'Al Noor',
      phone: '+96899758980',
      dayOfVisit: 'SUN',
      customerStatus: 'CLOSED',
      channelKey: 'RETAIL',
      paymentTerms: 'CREDIT',
      paymentTermsPresent: true,
      creditLimit: 12.346,
      paymentTermDays: 30,
      temixCode: 'T1',
    });
  });

  it.each([
    ['missing code', { ...ok, cust_code: '' }, 'cust_code: required'],
    ['missing name', { ...ok, cust_name: '  ' }, 'cust_name: required'],
    ['bad phone', { ...ok, phone: 'not-a-phone' }, 'phone: invalid format'],
    ['bad payment terms', { ...ok, payment_terms: 'Crdit' }, 'payment_terms: expected CASH or CREDIT, got "CRDIT"'],
    ['negative credit', { ...ok, credit_limit: '-5' }, 'credit_limit: expected a non-negative number, got "-5"'],
    ['fractional term days', { ...ok, payment_term_days: '7.5' }, 'payment_term_days: expected whole days 0-365, got "7.5"'],
    ['term days over a year', { ...ok, payment_term_days: '400' }, 'payment_term_days: expected whole days 0-365, got "400"'],
    ['unknown channel', { ...ok, channel: 'wholesale' }, 'channel: unknown channel "WHOLESALE"'],
    ['unknown visit day', { ...ok, day_of_visit: 'XYZ' }, 'day_of_visit: expected SAT/SUN/MON/TUE/WED/THU/FRI, got "XYZ"'],
    ['unknown status', { ...ok, customer_status: 'gone' }, 'customer_status: expected ACTIVE/CLOSED/SUSPENDED, got "GONE"'],
    ['formula in the name', { ...ok, cust_name: '=HYPERLINK("x")' }, 'cust_name: cell starts with a spreadsheet formula trigger; remove it'],
    ['formula in the address', { ...ok, address: '+cmd' }, 'address: cell starts with a spreadsheet formula trigger; remove it'],
  ])('%s', (_label, row, expected) => {
    expect(fields(row as SheetRow)).toEqual([expected]);
  });

  it('a phone or CR shared with ANOTHER customer in the same file, but not with its own branch rows', () => {
    const c = ctx({
      phonesInFile: new Map([['+96899758980', [{ row: 2, code: 'C1' }, { row: 3, code: 'C1' }, { row: 9, code: 'OTHER' }]]]),
      crsInFile: new Map([['1234567', [{ row: 2, code: 'C1' }, { row: 7, code: 'OTHER' }]]]),
    });
    expect(fields(ok, c)).toEqual([
      'phone: duplicate phone in this file (also rows 9)',
      'cr_no: duplicate CR in this file (also rows 7)',
    ]);
    const own = ctx({ phonesInFile: new Map([['+96899758980', [{ row: 3, code: 'C1' }]]]) });
    expect(fields(ok, own)).toEqual([]);
  });

  it('a phone or CR already on another master customer names it; its own customer does not count', () => {
    const c = ctx({
      masterPhones: new Map([['+96899758980', ['C1', 'H9']]]),
      masterCrs: new Map([['1234567', ['H9', 'H8', 'H7', 'H6', 'H6']]]),
    });
    expect(fields(ok, c)).toEqual([
      'phone: phone already exists in master on customer H9',
      'cr_no: CR already exists in master on customers H9, H8, H7 and 1 more',
    ]);
    expect(fields(ok, ctx({ masterPhones: new Map([['+96899758980', ['C1']]]) }))).toEqual([]);
  });

  it('a released phone is let through the master check — and only that check', () => {
    const c = ctx({
      masterPhones: new Map([['+96899758980', ['H9']]]),
      phonesInFile: new Map([['+96899758980', [{ row: 9, code: 'OTHER' }]]]),
    });
    expect(checkCustomerRow(ok, c, { phoneReleased: true }).issues.map((i) => i.message)).toEqual([
      'duplicate phone in this file (also rows 9)',
    ]);
  });

  it('reads the legacy headings, with the template heading winning', () => {
    const { parsed, issues } = checkCustomerRow(
      { 'CUST NAME': 'Legacy', CUSTCODE: 'L1', PHONE: '99758980', ADDRSS: 'Way 1', 'CR NO': '77', cust_name: 'Template' },
      ctx()
    );
    expect(issues).toEqual([]);
    expect([parsed.custCode, parsed.custName, parsed.phone, parsed.address, parsed.crNumber]).toEqual([
      'L1',
      'Template',
      '+96899758980',
      'Way 1',
      '77',
    ]);
  });

  // Code review 2026-11-10, finding 1 (the reviewers' cases, run against the real check).
  it.each(['temix_code', 'TEMIX_CODE', 'Temix_Code', 'Temix code', 'temix code', 'TemixCode'])(
    'a %j heading gives the row its Temix code (five of these gave null, with no issue)',
    (heading) => {
      const { parsed, issues } = checkCustomerRow({ ...ok, [heading]: ' caa0367 ' }, ctx());
      expect(issues).toEqual([]);
      expect(parsed.temixCode).toBe('CAA0367');
    }
  );

  it('every column is read under a differently spelt heading, not only temix_code', () => {
    const { parsed, issues } = checkCustomerRow(
      {
        'Cust Code': 'C7',
        Cust_Name: 'Al Noor',
        'Branch Code': '02',
        'Branch-Name': 'Seeb',
        Sales_Region: 'MCT',
        Route: 'MCT-01',
        Address: 'Way 12, Muscat',
        Phone: '99758980',
        Contact_Person: 'Said',
        'CR No.': '1234567',
        PAYMENT_TERMS: 'credit',
        'Credit Limit': '750',
        'Payment Term Days': '30',
        TEMIX_CODE: 'c7',
        Channel: 'retail',
        'Day Of Visit': 'mon',
        'Customer Status': 'closed',
      },
      ctx()
    );
    expect(issues).toEqual([]);
    expect(parsed).toEqual({
      custCode: 'C7',
      custName: 'Al Noor',
      channelKey: 'RETAIL',
      dayOfVisit: 'MON',
      customerStatus: 'CLOSED',
      branchCode: '02',
      branchName: 'Seeb',
      regionCode: 'MCT',
      routeCode: 'MCT-01',
      address: 'Way 12, Muscat',
      phone: '+96899758980',
      contactPerson: 'Said',
      crNumber: '1234567',
      paymentTerms: 'CREDIT',
      paymentTermsPresent: true,
      temixCode: 'C7',
      creditLimit: 750,
      paymentTermDays: 30,
    });
  });

  it('the daily-Temix-file shape still stages with no Temix code and no credit figures: its headings are not the columns', () => {
    // cust_code, branch_code, cust_name, route, terms, limit, days, status: the
    // upload lists terms, limit, days and status as "not read" and refuses the
    // sheet when it names a customer linked to Temix (services/imports.ts).
    const { parsed, issues } = checkCustomerRow(
      { cust_code: 'C1', branch_code: '01', cust_name: 'Al Noor', route: 'MCT-01', terms: 'CREDIT', limit: 750, days: 30, status: 'ACTIVE' },
      ctx()
    );
    expect(issues).toEqual([]);
    expect([parsed.temixCode, parsed.creditLimit, parsed.paymentTermDays, parsed.paymentTermsPresent, parsed.customerStatus]).toEqual([
      null,
      null,
      null,
      false,
      null,
    ]);
  });

  it('a bad value under a differently spelt heading is held back as under the template one', () => {
    expect(fields({ ...ok, 'Payment Terms': 'Crdit' })).toEqual(['payment_terms: expected CASH or CREDIT, got "CRDIT"']);
    expect(fields({ ...ok, Credit_Limit: '-5' })).toEqual(['credit_limit: expected a non-negative number, got "-5"']);
    expect(fields({ cust_code: 'C1', cust_name: 'Al Noor', Phone: 'not-a-phone' })).toEqual(['phone: invalid format']);
  });

  it.each([
    ['CUST NAME', 'cust_name'],
    ['Cust_Name', 'cust_name'],
    ['ADDRSS', 'address'],
    ['Address', 'address'],
    ['CONTACT PERSON', 'contact_person'],
    ['Notes', 'notes'],
  ])('a formula under the heading %j is held back, as under the template heading', (heading, field) => {
    const row: SheetRow = { cust_code: 'C1', cust_name: 'Al Noor', [heading]: '=HYPERLINK("x")' };
    if (field === 'cust_name') delete row.cust_name;
    expect(fields(row)).toEqual([`${field}: cell starts with a spreadsheet formula trigger; remove it`]);
  });

  it('a blank payment_terms is CASH but not "present" — the refresh lane must keep the stored terms', () => {
    const { parsed } = checkCustomerRow(ok, ctx());
    expect([parsed.paymentTerms, parsed.paymentTermsPresent]).toEqual(['CASH', false]);
  });

  // Owner decision 2026-10-08 (review): the Accountant's typed Temix code is
  // stored upper case and compared without regard to case; the import compared a
  // sheet's temix_code with exact case, so a lower-case cell missed its customer.
  it.each([
    [' caa0367 ', 'CAA0367'],
    ['‏tx٩٠٠', 'TX900'],
    ['  ', null],
  ])('temix_code %j is folded as the Accountant\'s code is: %j', (cell, folded) => {
    expect(checkCustomerRow({ ...ok, temix_code: cell }, ctx()).parsed.temixCode).toBe(folded);
  });
});

describe('the helpers it is built from', () => {
  it('fileCollisions keys by normalized phone and CR, with row number and owning code', () => {
    const { phonesInFile, crsInFile } = fileCollisions([
      { row: { cust_code: 'A', phone: '+968 9975 8980', cr_no: ' 12 34 ' }, rowNumber: 2 },
      { row: { cust_code: 'B', PHONE: '99758980', 'CR NO': '1234' }, rowNumber: 3 },
    ]);
    expect(phonesInFile.get('+96899758980')).toEqual([
      { row: 2, code: 'A' },
      { row: 3, code: 'B' },
    ]);
    expect(crsInFile.get('1234')).toEqual([
      { row: 2, code: 'A' },
      { row: 3, code: 'B' },
    ]);
  });

  it('stripHtml, isFormulaPayload and heldBackBy', () => {
    expect(stripHtml(' <b>Shop</b> ')).toBe('Shop');
    expect(stripHtml(null)).toBe('');
    // Trimmed first: a leading tab is stripped (as the stored value is), and what follows is judged.
    expect(['=1', '+1', '-1', '@x', '\t=1'].map(isFormulaPayload)).toEqual([true, true, true, true, true]);
    expect(['Shop', '', '1-2'].map(isFormulaPayload)).toEqual([false, false, false]);
    expect(heldBackBy(['X', 'X'])).toBe('customer X');
    expect(heldBackBy(['X', 'Y'])).toBe('customers X, Y');
  });
});
