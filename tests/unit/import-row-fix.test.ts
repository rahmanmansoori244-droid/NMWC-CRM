/**
 * lib/import-row-fix.ts — what the Data Steward may change on a held-back or
 * rejected import row (benchmark item 20, owner decisions 2026-09-25).
 */
import { describe, it, expect } from 'vitest';
import {
  acceptCells,
  canReleasePhone,
  cellValue,
  correctedRow,
  editableColumns,
  readCorrections,
} from '@/lib/import-row-fix';

describe('editableColumns — only the cells the problem names', () => {
  it('upload issues name their column', () => {
    expect(
      editableColumns([
        { field: 'day_of_visit', message: 'x' },
        { field: 'phone', message: 'invalid format' },
        { field: 'cust_name', message: 'required' },
      ])
    ).toEqual(['cust_name', 'phone', 'day_of_visit']);
  });

  it('payment terms, credit and term days are never editable', () => {
    expect(
      editableColumns([
        { field: 'payment_terms', message: 'expected CASH or CREDIT' },
        { field: 'credit_limit', message: 'x' },
        { field: 'payment_term_days', message: 'x' },
      ])
    ).toEqual([]);
  });

  it('a promote rejection names a cell only when its reason points at one', () => {
    const p = (message: string) => editableColumns([{ field: '_promote', message }]);
    expect(p('the database refused this row: Branch_address_minlength — steward review')).toEqual(['address']);
    expect(p('duplicate branch_code X-01 within this customer')).toEqual(['branch_code']);
    expect(p('branch_code X-01 already belongs to Y — steward review')).toEqual(['branch_code']);
    expect(p('duplicate branchCode')).toEqual(['branch_code']);
    expect(p('payment_terms disagrees with the terms already recorded for this customer')).toEqual([]);
    expect(p('this customer is already crosswalked to a different Temix code — changing it is a deliberate re-crosswalk')).toEqual([]);
    expect(p('promote failed (UNKNOWN)')).toEqual([]);
  });

  it('warnings on a loaded row, and junk, name nothing', () => {
    expect(editableColumns([{ field: '_resolve', message: 'x' }, { field: '_lane', message: 'y' }])).toEqual([]);
    expect(editableColumns(null)).toEqual([]);
    expect(editableColumns('nonsense')).toEqual([]);
  });
});

describe('canReleasePhone — a shared phone as the ONLY problem', () => {
  const master = { field: 'phone', message: 'phone already exists in master on customer H9' };
  it('yes when every problem is the master phone', () => {
    expect(canReleasePhone([master])).toBe(true);
  });
  it('no when anything else is wrong too, or the phone is bad or repeated in the file', () => {
    expect(canReleasePhone([master, { field: 'cust_name', message: 'required' }])).toBe(false);
    expect(canReleasePhone([{ field: 'phone', message: 'invalid format' }])).toBe(false);
    expect(canReleasePhone([{ field: 'phone', message: 'duplicate phone in this file (also rows 4)' }])).toBe(false);
    expect(canReleasePhone([])).toBe(false);
    expect(canReleasePhone(null)).toBe(false);
  });
});

describe('acceptCells — what the server takes from the edit form', () => {
  const issues = [{ field: 'day_of_visit', message: 'x' }];
  it('takes a named cell, trimmed', () => {
    expect(acceptCells(issues, { day_of_visit: '  sun ' })).toEqual({ ok: true, cells: { day_of_visit: 'sun' } });
  });
  it('refuses credit with a reason, a cell the problem does not name, non-text, over-long, and nothing at all', () => {
    const r = (sent: Record<string, unknown>) => acceptCells(issues, sent);
    expect(r({ payment_terms: 'CREDIT' })).toMatchObject({ ok: false, message: expect.stringMatching(/cannot be changed in the app/) });
    expect(r({ temix_code: 'T' })).toMatchObject({ ok: false });
    expect(r({ cust_name: 'X' })).toMatchObject({ ok: false, message: expect.stringMatching(/not one of the cells/) });
    expect(r({ day_of_visit: 5 })).toMatchObject({ ok: false });
    expect(r({ day_of_visit: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(r({})).toMatchObject({ ok: false });
  });
});

describe('the row as uploaded, with the corrections laid over it', () => {
  it('a correction wins over a legacy heading, and an empty one clears the cell; raw is not changed', () => {
    const raw = { 'CUST NAME': 'Old', PHONE: '123', cust_code: 'C1' };
    const row = correctedRow(raw, { cells: { cust_name: 'New', phone: '' } });
    expect(cellValue(row, 'cust_name')).toBe('New');
    expect(cellValue(row, 'phone')).toBe('');
    expect(cellValue(row, 'cust_code')).toBe('C1');
    expect(raw).toEqual({ 'CUST NAME': 'Old', PHONE: '123', cust_code: 'C1' });
  });

  it('a correction wins over the SAME template column in the row — the usual case', () => {
    const row = correctedRow({ day_of_visit: 'XYZ', cust_code: 'C1' }, { cells: { day_of_visit: 'SUN' } });
    expect(row).toEqual({ day_of_visit: 'SUN', cust_code: 'C1' });
  });

  it('cellValue falls back through the legacy headings the check reads', () => {
    expect(cellValue({ ADDRSS: 'Way 1' }, 'address')).toBe('Way 1');
    expect(cellValue({ 'DAY OF VISIT': 'SUN' }, 'day_of_visit')).toBe('SUN');
    expect(cellValue({}, 'address')).toBe('');
  });

  it('readCorrections keeps only what it understands', () => {
    expect(readCorrections({ cells: { a: 'x', b: 5 }, phoneReleased: { reason: 'r' }, junk: 1 })).toEqual({
      cells: { a: 'x' },
      phoneReleased: { reason: 'r' },
    });
    expect(readCorrections(null)).toEqual({});
    expect(readCorrections([1])).toEqual({});
  });
});
