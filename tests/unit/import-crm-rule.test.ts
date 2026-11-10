/**
 * lib/import-crm-rule.ts — what a customer import may write on a customer or
 * shop that already exists (code review 2026-11-10, finding 1).
 *
 * What was wrong: for every customer with no Temix code on record (and for all of
 * them when the sheet's temix_code column was missing or misspelt) a re-import
 * replaced the name, phone, CR number, contact person, channel, shop name,
 * address, visit day and status with whatever an older sheet still held — it
 * reopened a shop an approved request had closed — and the row read PROMOTED.
 *
 * The rule: fill a blank, never replace a value on record, never change an
 * open/closed status; the batch's overwrite option restores the old behaviour.
 */
import { describe, it, expect } from 'vitest';
import {
  ADDRESS_PLACEHOLDER,
  OVERWRITE_OPTION,
  branchCrmRule,
  customerCrmRule,
  keptNote,
  type SheetBranchCrm,
  type SheetCustomerCrm,
  type StoredCustomerCrm,
} from '@/lib/import-crm-rule';

const sheet = (over: Partial<SheetCustomerCrm> = {}): SheetCustomerCrm => ({
  custName: 'Name From Sheet',
  phone: '+96891111111',
  contactPerson: 'Sheet Contact',
  crNumber: '12 34',
  channelId: 'ch-sheet',
  ...over,
});
const stored = (over: Partial<StoredCustomerCrm> = {}): StoredCustomerCrm => ({
  legalName: 'Name On Record',
  primaryPhone: '99 999 999',
  primaryPhoneNorm: '+96899999999',
  contactPerson: 'Record Contact',
  crNumber: '9999',
  crNumberNorm: '9999',
  channelId: 'ch-record',
  ...over,
});
const NOTHING: SheetCustomerCrm = { custName: undefined, phone: null, contactPerson: null, crNumber: null, channelId: null };

describe('customerCrmRule', () => {
  it('a NEW customer is not narrowed, with the option on or off', () => {
    for (const overwrite of [false, true]) {
      const out = customerCrmRule(overwrite, sheet(), null);
      expect(out.sheet).toEqual(sheet());
      expect([out.kept, out.filled, out.replaced]).toEqual([[], [], []]);
    }
  });

  it('fill-only: every value that differs from one on record is taken out of the row, and named', () => {
    const out = customerCrmRule(false, sheet(), stored());
    expect(out.sheet).toEqual(NOTHING);
    expect(out.kept).toEqual(['name', 'phone', 'contact person', 'CR number', 'channel']);
    expect(out.filled).toEqual([]);
    expect(out.replaced).toEqual([]);
  });

  it('fill-only: a blank on record is filled, field by field', () => {
    const blank = stored({ primaryPhone: null, primaryPhoneNorm: null, contactPerson: '  ', crNumber: null, crNumberNorm: null, channelId: null });
    const out = customerCrmRule(false, sheet(), blank);
    expect(out.sheet).toEqual({ ...sheet(), custName: undefined });
    expect(out.filled).toEqual(['phone', 'contact person', 'CR number', 'channel']);
    expect(out.kept).toEqual(['name']);
  });

  it.each([
    ['name', { custName: 'Name On Record ' }],
    ['phone, compared normalised (the raw value on record is spelt differently)', { phone: '+96899999999' }],
    ['contact person', { contactPerson: ' Record Contact' }],
    ['CR number, compared normalised', { crNumber: ' 99 99 ' }],
    ['channel', { channelId: 'ch-record' }],
  ])('fill-only: a %s that only restates the record is neither kept nor written', (_label, over) => {
    const out = customerCrmRule(false, { ...NOTHING, ...over }, stored());
    expect(out.sheet).toEqual(NOTHING);
    expect([out.kept, out.filled, out.replaced]).toEqual([[], [], []]);
  });

  it('fill-only: a blank cell asks for nothing', () => {
    const out = customerCrmRule(false, NOTHING, stored());
    expect([out.sheet, out.kept, out.filled]).toEqual([NOTHING, [], []]);
  });

  it('a phone on record that could not be normalised is still a phone on record: not filled over', () => {
    const out = customerCrmRule(false, sheet(), stored({ primaryPhone: 'call the shop', primaryPhoneNorm: null }));
    expect(out.sheet.phone).toBeNull();
    expect(out.kept).toContain('phone');
  });

  it('a CR number on record with no normalised form is compared as text, and kept when it differs', () => {
    const noNorm = stored({ crNumber: 'pending', crNumberNorm: null });
    expect(customerCrmRule(false, sheet({ crNumber: 'pending' }), noNorm).kept).not.toContain('CR number');
    expect(customerCrmRule(false, sheet({ crNumber: '1234' }), noNorm).kept).toContain('CR number');
  });

  it('the option on: the row passes through untouched, and what it replaces is named', () => {
    const out = customerCrmRule(true, sheet(), stored({ contactPerson: null }));
    expect(out.sheet).toEqual(sheet());
    expect(out.replaced).toEqual(['name', 'phone', 'CR number', 'channel']);
    expect(out.filled).toEqual(['contact person']);
    expect(out.kept).toEqual([]);
  });
});

type Row = SheetBranchCrm & { routeId: string; routeResolved: boolean; address: string };
const row = (over: Partial<Row> = {}): Row => ({
  nameGiven: true,
  branchName: 'Sheet shop',
  sheetAddress: 'Sheet address 1',
  address: 'Sheet address 1',
  dayOfVisit: 'MON',
  status: 'ACTIVE',
  routeId: 'rt-sheet',
  routeResolved: true,
  ...over,
});
const shop = (over: Partial<{ branchName: string; address: string; dayOfVisit: string | null; status: string }> = {}) => ({
  branchName: 'Record shop',
  address: 'Approved address 9',
  dayOfVisit: 'SUN' as string | null,
  status: 'ACTIVE',
  ...over,
});

describe('branchCrmRule', () => {
  it('a NEW shop is not narrowed, with the option on or off', () => {
    for (const overwrite of [false, true]) {
      const r = row({ status: 'CLOSED' });
      const out = branchCrmRule(overwrite, r, null);
      expect(out.row).toBe(r);
      expect(out.statusChange).toBeNull();
      expect([out.kept, out.filled, out.replaced]).toEqual([[], [], []]);
    }
  });

  it('fill-only: the shop name, address and visit day on record are kept; the route is not this rule’s business', () => {
    const out = branchCrmRule(false, row(), shop());
    expect(out.row).toEqual({
      ...row(),
      nameGiven: false,
      sheetAddress: null,
      dayOfVisit: null,
      status: null,
    });
    expect(out.row.routeId).toBe('rt-sheet');
    expect(out.row.routeResolved).toBe(true);
    expect(out.kept).toEqual(['shop name', 'address', 'visit day']);
    expect(out.statusChange).toBeNull();
  });

  it('fill-only: a blank visit day and a blank address on record are filled', () => {
    const out = branchCrmRule(false, row(), shop({ dayOfVisit: null, address: '  ' }));
    expect(out.row.dayOfVisit).toBe('MON');
    expect(out.row.sheetAddress).toBe('Sheet address 1');
    expect(out.filled).toEqual(['address', 'visit day']);
    expect(out.kept).toEqual(['shop name']);
  });

  it(`the importer's own "${ADDRESS_PLACEHOLDER}" counts as blank; "Main" is a name and is kept`, () => {
    const out = branchCrmRule(false, row(), shop({ address: ADDRESS_PLACEHOLDER, branchName: 'Main' }));
    expect(out.row.sheetAddress).toBe('Sheet address 1');
    expect(out.filled).toContain('address');
    expect(out.row.nameGiven).toBe(false);
    expect(out.kept).toContain('shop name');
  });

  it('a row that gives no name (the "Main" fallback), no address and no day asks for nothing', () => {
    const out = branchCrmRule(false, row({ nameGiven: false, branchName: 'Main', sheetAddress: null, dayOfVisit: null, status: null }), shop());
    expect([out.kept, out.filled, out.replaced]).toEqual([[], [], []]);
    expect(out.statusChange).toBeNull();
  });

  it.each([
    ['reopen a shop an approved request closed', 'CLOSED', 'ACTIVE'],
    ['close an open shop', 'ACTIVE', 'CLOSED'],
    ['lift a hold', 'SUSPENDED', 'ACTIVE'],
  ])('fill-only: the status is NEVER passed through — a sheet does not %s', (_label, onRecord, inSheet) => {
    const same = { nameGiven: false, sheetAddress: null, dayOfVisit: null };
    const out = branchCrmRule(false, row({ ...same, status: inSheet }), shop({ status: onRecord }));
    expect(out.row.status).toBeNull();
    expect(out.kept).toEqual(['status']);
    expect(out.statusChange).toEqual({ from: onRecord, to: inSheet });
  });

  it('fill-only: a status that restates the record is taken out too, and nothing is said', () => {
    const out = branchCrmRule(false, row({ nameGiven: false, sheetAddress: null, dayOfVisit: null, status: 'CLOSED' }), shop({ status: 'CLOSED' }));
    expect(out.row.status).toBeNull();
    expect(out.kept).toEqual([]);
    expect(out.statusChange).toBeNull();
  });

  it('the option on: the row passes through untouched, status included, and what it replaces is named', () => {
    const r = row({ status: 'ACTIVE' });
    const out = branchCrmRule(true, r, shop({ status: 'CLOSED', dayOfVisit: null }));
    expect(out.row).toBe(r);
    expect(out.replaced).toEqual(['shop name', 'address', 'status']);
    expect(out.filled).toEqual(['visit day']);
    expect(out.kept).toEqual([]);
    expect(out.statusChange).toEqual({ from: 'CLOSED', to: 'ACTIVE' });
  });
});

describe('the row note', () => {
  it('names fields, never values, with the grammar of one or several', () => {
    expect(keptNote('customer', [])).toBeNull();
    expect(keptNote('customer', ['name'])).toBe(
      'customer: the name in this row differs from the record and was kept — an import fills blank CRM fields only'
    );
    expect(keptNote('customer', ['name', 'phone'])).toBe(
      'customer: the name and phone in this row differ from the record and were kept — an import fills blank CRM fields only'
    );
    expect(keptNote({ shop: 'C1-01' }, ['shop name', 'address', 'visit day'])).toBe(
      'shop C1-01: the shop name, address and visit day in this row differ from the record and were kept — an import fills blank CRM fields only'
    );
  });

  it('says an import does not open or close, when a status was kept', () => {
    expect(keptNote({ shop: 'C1-01' }, ['address', 'status'])).toBe(
      'shop C1-01: the address and status in this row differ from the record and were kept — an import fills blank CRM fields only, and does not open or close a shop'
    );
    expect(keptNote('customer', ['status'])).toBe(
      'customer: the status in this row differs from the record and was kept — an import fills blank CRM fields only, and does not open or close a customer'
    );
  });

  it('the option has one name everywhere', () => {
    expect(OVERWRITE_OPTION).toBe('Overwrite CRM fields from this sheet');
  });
});
