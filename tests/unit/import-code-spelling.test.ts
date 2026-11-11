/**
 * Owner's answers of 2026-11-11 (item A5): how the customer import spells the
 * codes a sheet row carries.
 *  - cust_code is read in capital letters (cct0005 -> CCT0005), and the row
 *    says so; letters outside a-z are left as they are;
 *  - temix_code was already read in capital letters; the row now says so too;
 *  - a branch_code that differs from one of the SAME customer's shops, or from
 *    another of its rows in the sheet, only by leading zeros or by capital and
 *    small letters is HELD BACK, naming both codes, on the branch_code cell;
 *    an identical code never is; a released row is not.
 */
import { describe, it, expect } from 'vitest';
import {
  capitalCode,
  capitalisedNote,
  groupShopLookalike,
  rowShopCode,
  shopCodeKey,
  shopLookalike,
  shopLookalikeMessage,
  SHOP_LOOKALIKE,
} from '@/lib/import-shop-code';
import {
  checkCustomerRow,
  fileCollisions,
  fileShopCodes,
  type RowCheckContext,
  type SheetRow,
} from '@/lib/import-row-check';
import { canReleasePhone, canReleaseShopCode, editableColumns, readCorrections } from '@/lib/import-row-fix';

const ctx = (over: Partial<RowCheckContext> = {}): RowCheckContext => ({
  channelKeys: new Set(['RETAIL']),
  phonesInFile: new Map(),
  crsInFile: new Map(),
  masterPhones: new Map(),
  masterCrs: new Map(),
  ...over,
});

describe('capitalCode — the customer code in capital letters', () => {
  it.each([
    ['cct0005', 'CCT0005'],
    ['  Cct0005 ', 'CCT0005'],
    ['CCT0005', 'CCT0005'],
    ['nmwc-2026-000001', 'NMWC-2026-000001'],
  ])('%s -> %s', (from, to) => expect(capitalCode(from)).toBe(to));

  it('leaves letters outside a-z exactly as they are', () => {
    expect(capitalCode('cé0005')).toBe('Cé0005');
    expect(capitalCode('straße1')).toBe('STRAßE1');
    expect(capitalCode('ع0005a')).toBe('ع0005A');
  });
});

describe('checkCustomerRow — codes in small letters', () => {
  it('reads cust_code in capitals, and notes it on the row', () => {
    const { parsed, issues } = checkCustomerRow({ cust_code: ' cct0005 ', cust_name: 'Al Noor' }, ctx());
    expect(issues).toEqual([]);
    expect(parsed.custCode).toBe('CCT0005');
    expect(parsed.capitalised).toEqual([{ cell: 'cust_code', from: 'cct0005', to: 'CCT0005' }]);
  });

  it('a code already in capitals carries no note (the parsed row keeps its old shape)', () => {
    const { parsed } = checkCustomerRow({ cust_code: 'CCT0005', cust_name: 'Al Noor', temix_code: 'CCT0005' }, ctx());
    expect(parsed.custCode).toBe('CCT0005');
    expect('capitalised' in parsed).toBe(false);
  });

  it('notes a Temix code typed in small letters, which was already read in capitals', () => {
    const { parsed } = checkCustomerRow({ cust_code: 'cct0005', cust_name: 'Al Noor', temix_code: 'cct0005' }, ctx());
    expect(parsed.temixCode).toBe('CCT0005');
    expect(parsed.capitalised).toEqual([
      { cell: 'cust_code', from: 'cct0005', to: 'CCT0005' },
      { cell: 'temix_code', from: 'cct0005', to: 'CCT0005' },
    ]);
  });

  it('two rows differing only by letter case are rows of ONE customer: a shared phone is not an in-file duplicate', () => {
    const rows = [
      { row: { cust_code: 'CCT0005', cust_name: 'A', phone: '99758980', branch_code: '01' } as SheetRow, rowNumber: 2 },
      { row: { cust_code: 'cct0005', cust_name: 'A', phone: '99758980', branch_code: '02' } as SheetRow, rowNumber: 3 },
    ];
    const { phonesInFile, crsInFile } = fileCollisions(rows);
    for (const { row } of rows) {
      expect(checkCustomerRow(row, ctx({ phonesInFile, crsInFile })).issues).toEqual([]);
    }
  });

  it('the phone already on the same customer in capitals is not "on another customer"', () => {
    const masterPhones = new Map([['+96899758980', ['CCT0005']]]);
    const { issues } = checkCustomerRow(
      { cust_code: 'cct0005', cust_name: 'A', phone: '99758980' },
      ctx({ masterPhones })
    );
    expect(issues).toEqual([]);
  });

  it('the note says what was read, and that the sheet is not changed', () => {
    expect(capitalisedNote([{ cell: 'cust_code', from: 'cct0005', to: 'CCT0005' }])).toBe(
      'Small letters changed to capitals: customer code "cct0005" was read as "CCT0005". The sheet is not changed.'
    );
    expect(capitalisedNote([])).toBeNull();
  });
});

describe('shop codes — the comparison key', () => {
  it.each([
    ['CCT0005-01', 'CCT5-1'],
    ['cct0005-1', 'CCT5-1'],
    ['Ab', 'AB'],
    ['0', '0'],
    ['00', '0'],
    ['A010B007', 'A10B7'],
  ])('%s -> %s', (code, key) => expect(shopCodeKey(code)).toBe(key));

  it('composes a bare code under the customer, keeping its own letters', () => {
    expect(rowShopCode('CCT0005', '01')).toBe('CCT0005-01');
    expect(rowShopCode('CCT0005', 'ab')).toBe('CCT0005-ab');
    expect(rowShopCode('CCT0005', 'cct0005-ab')).toBe('CCT0005-ab');
    expect(rowShopCode('CCT0005', 'cct0005')).toBe('CCT0005');
  });
});

describe('shopLookalike — a shop code that only looks like another', () => {
  const shops = ['CCT0005-01', 'CCT0005-AB'];

  it.each([
    ['1', 'CCT0005-01', false],
    ['001', 'CCT0005-01', false],
    ['CCT0005-1', 'CCT0005-01', false],
    ['ab', 'CCT0005-AB', true],
    ['Ab', 'CCT0005-AB', true],
    ['cct0005-ab', 'CCT0005-AB', true],
  ])('"%s" looks like the existing shop %s', (code, other, caseOnly) => {
    expect(shopLookalike('CCT0005', code, shops, [])).toEqual({ kind: 'shop', sheetCode: code, other, caseOnly });
  });

  it.each(['01', 'AB', 'CCT0005-01', 'cct0005-01', '02', 'AC', ''])('"%s" is not held back', (code) => {
    expect(shopLookalike('CCT0005', code, shops, [])).toBeNull();
  });

  it('a blank branch code is never compared', () => {
    expect(shopLookalike('CCT0005', null, shops, [])).toBeNull();
  });

  it('looks only at the shops it is given: those of the SAME customer', () => {
    expect(shopLookalike('CCT0006', '1', [], [])).toBeNull();
  });

  it('a sibling row of the same customer in the sheet counts too, with its row number', () => {
    expect(shopLookalike('CCT0009', '1', [], [{ row: 7, code: '01' }])).toEqual({
      kind: 'row',
      sheetCode: '1',
      other: '01',
      row: 7,
      caseOnly: false,
    });
    expect(shopLookalike('CCT0009', 'ab', [], [{ row: 3, code: 'AB' }])).toMatchObject({ kind: 'row', caseOnly: true });
    // The same code twice is the existing "repeated branch_code" rule, not this one.
    expect(shopLookalike('CCT0009', '01', [], [{ row: 7, code: '01' }])).toBeNull();
    // A sibling the Steward released as a different shop is not compared.
    expect(shopLookalike('CCT0009', '1', [], [{ row: 7, code: '01', released: true }])).toBeNull();
  });

  it('a row that IS one of the shops is not held back for a lookalike sibling', () => {
    expect(shopLookalike('CCT0005', '01', shops, [{ row: 7, code: '1' }])).toBeNull();
  });

  it('the reason names both codes and what to do, in the app voice', () => {
    expect(shopLookalikeMessage({ kind: 'shop', sheetCode: '1', other: 'CCT0005-01', caseOnly: false })).toBe(
      'Shop code "1" looks like this customer\'s existing shop "CCT0005-01" (Excel may have dropped a zero). Correct the code if it is the same shop; if it is a different shop, release the row with a reason.'
    );
    expect(shopLookalikeMessage({ kind: 'row', sheetCode: 'ab', other: 'AB', row: 4, caseOnly: true })).toBe(
      'Shop code "ab" looks like shop code "AB" on row 4 of the same customer in this sheet (only capital and small letters differ). Correct the code: shop codes are kept in capital letters, so if it is the same shop write it as that shop\'s code, and if it is a different shop give it a different code.'
    );
    expect(SHOP_LOOKALIKE.test(shopLookalikeMessage({ kind: 'shop', sheetCode: '1', other: 'X', caseOnly: false }))).toBe(true);
  });

  it('groupShopLookalike: the first row of a customer that looks like a shop or a sibling', () => {
    expect(
      groupShopLookalike('CCT0005', [{ branchCode: '02', rowNumber: 2 }, { branchCode: '1', rowNumber: 3 }], ['CCT0005-01'])
    ).toMatchObject({ kind: 'shop', sheetCode: '1' });
    expect(
      groupShopLookalike('CCT0009', [{ branchCode: '01', rowNumber: 2 }, { branchCode: '1', rowNumber: 3 }], [])
    ).toMatchObject({ kind: 'row', sheetCode: '01', row: 3 });
    expect(
      groupShopLookalike(
        'CCT0009',
        [{ branchCode: '01', rowNumber: 2, shopCodeReleased: true }, { branchCode: '1', rowNumber: 3 }],
        []
      )
    ).toBeNull();
    // A released row is still compared for capital letters alone: that would load as one shop.
    expect(
      groupShopLookalike('CCT0005', [{ branchCode: 'ab', rowNumber: 2, shopCodeReleased: true }], ['CCT0005-AB'])
    ).toMatchObject({ kind: 'shop', caseOnly: true });
    expect(groupShopLookalike('CCT0005', [{ branchCode: '01', rowNumber: 2 }], ['CCT0005-01'])).toBeNull();
  });
});

describe('checkCustomerRow — a lookalike shop code is held back on the branch_code cell', () => {
  const masterShops = new Map([['CCT0005', ['CCT0005-01']]]);

  it('against the customer\'s existing shop (and the customer code in small letters still finds it)', () => {
    const { issues, parsed } = checkCustomerRow(
      { cust_code: 'cct0005', cust_name: 'A', branch_code: '1' },
      ctx({ masterShops })
    );
    expect(issues).toEqual([
      {
        field: 'branch_code',
        message:
          'Shop code "1" looks like this customer\'s existing shop "CCT0005-01" (Excel may have dropped a zero). Correct the code if it is the same shop; if it is a different shop, release the row with a reason.',
      },
    ]);
    expect(parsed.branchCode).toBe('1');
    // The cell can be corrected with the existing fix flow, and the row released.
    expect(editableColumns(issues)).toEqual(['branch_code']);
    expect(canReleaseShopCode(issues)).toBe(true);
    expect(canReleasePhone(issues)).toBe(false);
  });

  it('an identical code is never held back, nor is a code of another customer\'s shop', () => {
    expect(checkCustomerRow({ cust_code: 'CCT0005', cust_name: 'A', branch_code: '01' }, ctx({ masterShops })).issues).toEqual([]);
    expect(checkCustomerRow({ cust_code: 'CCT0006', cust_name: 'A', branch_code: '1' }, ctx({ masterShops })).issues).toEqual([]);
  });

  it('against a sibling row of the same customer in the sheet: both rows are held back', () => {
    const rows = [
      { row: { cust_code: 'CCT0009', cust_name: 'A', branch_code: '01' } as SheetRow, rowNumber: 2 },
      { row: { cust_code: 'cct0009', cust_name: 'A', branch_code: '1' } as SheetRow, rowNumber: 3 },
      { row: { cust_code: 'CCT0010', cust_name: 'B', branch_code: '1' } as SheetRow, rowNumber: 4 },
    ];
    const shopsInFile = fileShopCodes(rows);
    const c = ctx({ shopsInFile });
    expect(checkCustomerRow(rows[0].row, c).issues[0]?.message).toMatch(/^Shop code "01" looks like shop code "1" on row 3 /);
    expect(checkCustomerRow(rows[1].row, c).issues[0]?.message).toMatch(/^Shop code "1" looks like shop code "01" on row 2 /);
    expect(checkCustomerRow(rows[2].row, c).issues).toEqual([]);
  });

  it('a row released as a different shop is not held back, and says so in its parsed row', () => {
    const { issues, parsed } = checkCustomerRow(
      { cust_code: 'CCT0005', cust_name: 'A', branch_code: '1' },
      ctx({ masterShops }),
      { shopCodeReleased: true }
    );
    expect(issues).toEqual([]);
    expect(parsed.shopCodeReleased).toBe(true);
  });

  it('a code that differs ONLY in capital letters cannot be released: it would load as the same shop', () => {
    const shops = new Map([['CCT0005', ['CCT0005-AB']]]);
    const held = checkCustomerRow({ cust_code: 'CCT0005', cust_name: 'A', branch_code: 'ab' }, ctx({ masterShops: shops }));
    expect(held.issues).toHaveLength(1);
    expect(editableColumns(held.issues)).toEqual(['branch_code']);
    expect(canReleaseShopCode(held.issues)).toBe(false);
    // Even a row released earlier for its zeros is held back for this.
    const still = checkCustomerRow(
      { cust_code: 'CCT0005', cust_name: 'A', branch_code: 'ab' },
      ctx({ masterShops: shops }),
      { shopCodeReleased: true }
    );
    expect(still.issues[0]?.message).toContain('(only capital and small letters differ)');
  });

  it('the release is kept in the corrections', () => {
    expect(readCorrections({ shopCodeReleased: { reason: 'two shops in one mall' } })).toEqual({
      shopCodeReleased: { reason: 'two shops in one mall' },
    });
  });

  it('a row held back for a lookalike code AND a shared phone can be released for the code first', () => {
    const issues = [
      { field: 'phone', message: 'phone already exists in master on customer X1' },
      { field: 'branch_code', message: 'Shop code "1" looks like this customer\'s existing shop "C-01" (Excel may have dropped a zero).' },
    ];
    expect(canReleaseShopCode(issues)).toBe(true);
    expect(canReleasePhone(issues)).toBe(false);
    expect(canReleaseShopCode([{ field: 'phone', message: 'invalid format' }])).toBe(false);
    expect(canReleaseShopCode([issues[1], { field: 'cust_name', message: 'required' }])).toBe(false);
  });
});

// Review of A5 (2026-11-11): a NEW customer's row with a blank branch_code is
// numbered by its place only at promote (formatBranchCode); the promote and the
// summary compare that number with the codes of its sibling rows.
describe('groupShopLookalike — a blank branch_code numbered by its place', () => {
  it('holds a blank row numbered C1-01 beside a row coded "1", naming the blank cell', () => {
    const hit = groupShopLookalike(
      'C1',
      [
        { branchCode: null, rowNumber: 2, numberedAs: 'C1-01' },
        { branchCode: '1', rowNumber: 3, numberedAs: 'C1-02' },
      ],
      []
    );
    expect(hit).toMatchObject({ kind: 'row', sheetCode: 'C1-01', other: '1', row: 3, numbered: true });
    const msg = shopLookalikeMessage(hit!);
    expect(msg).toBe(
      `This row's branch_code is blank, so it would be numbered "C1-01", which looks like shop code "1" on row 3 of the same customer in this sheet (only the zeros differ). Give this row a branch_code: the same code if it is the same shop, a different one if it is a different shop.`
    );
    // Nothing to release: there is no code to keep.
    expect(canReleaseShopCode([{ field: 'branch_code', message: msg }])).toBe(false);
  });

  it('a coded row first names the blank row it looks like', () => {
    const hit = groupShopLookalike(
      'C1',
      [
        { branchCode: '2', rowNumber: 2, numberedAs: 'C1-01' },
        { branchCode: '', rowNumber: 3, numberedAs: 'C1-02' },
      ],
      []
    );
    const msg = shopLookalikeMessage(hit!);
    expect(msg).toBe(
      'Shop code "2" looks like "C1-02", the number the blank branch_code on row 3 of the same customer in this sheet would be given (only the zeros differ). Give that row a branch_code, or correct this one: the same code if it is the same shop, a different one if it is a different shop.'
    );
    expect(canReleaseShopCode([{ field: 'branch_code', message: msg }])).toBe(false);
    // The promote's rejection names the cell, so the batch page offers it to correct.
    expect(editableColumns([{ field: '_promote', message: `branch_code: ${msg}` }])).toEqual(['branch_code']);
  });

  it('without a number (a customer the CRM already has) a blank code is compared with nothing, as before', () => {
    expect(
      groupShopLookalike('C1', [{ branchCode: null, rowNumber: 2 }, { branchCode: '1', rowNumber: 3 }], [])
    ).toBeNull();
    expect(
      groupShopLookalike(
        'C1',
        [
          { branchCode: null, rowNumber: 2, numberedAs: 'C1-01' },
          { branchCode: '02', rowNumber: 3, numberedAs: 'C1-02' },
        ],
        []
      )
    ).toBeNull();
  });
});
