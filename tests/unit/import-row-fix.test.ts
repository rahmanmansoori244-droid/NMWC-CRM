/**
 * lib/import-row-fix.ts — what the Data Steward may change on a held-back or
 * rejected import row (benchmark item 20, owner decisions 2026-09-25).
 */
import { describe, it, expect } from 'vitest';
import {
  acceptCells,
  branchOnlyNote,
  canReleasePhone,
  cellValue,
  changedCells,
  composeBranchCode,
  correctedRow,
  editableColumns,
  fixWindowClosed,
  fixWindowMessage,
  IMPORT_PAYLOAD_DAYS,
  newerUploadMessage,
  readCorrections,
  supersededFixMessage,
  supersedingUpload,
  unwrittenCustomerCells,
  type NewerCandidate,
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

describe('pre-merge review: the refresh-lane rejections name branch_code, so the cell is offered', () => {
  it('a fixed row the refresh lane cannot apply comes back rejected with branch_code editable', () => {
    const p = (message: string) => editableColumns([{ field: '_promote', message }]);
    expect(
      p('a row fixed in the app has no branch_code — the import cannot tell which branch it is; add branch_code (a code this customer does not use yet creates a new branch); steward review')
    ).toEqual(['branch_code']);
    expect(p('branch_code X-09 already belongs to Y — steward review')).toEqual(['branch_code']);
    expect(p('branch_code X-02 is archived and is not revived — use another branch_code; steward review')).toEqual(['branch_code']);
  });
});

describe('newerUploadMessage — what to do depends on what the newer row is', () => {
  const n = (state: string, excluded = false) => ({ filename: 'later.xlsx', rowNumber: 9, state, excluded });
  it('held back there: fix it there', () => {
    expect(newerUploadMessage('C1', n('QUARANTINED'))).toMatch(/still held back there\. Fix it in that upload instead/);
    expect(newerUploadMessage('C1', n('REJECTED'))).toMatch(/Fix it in that upload instead/);
  });
  it('excluded there: include it there, or exclude this one', () => {
    expect(newerUploadMessage('C1', n('QUARANTINED', true))).toMatch(/where it was excluded\. Include it again there/);
  });
  it('loaded there (a later file, an inbound Temix refresh): nothing to fix there — exclude this older row', () => {
    expect(newerUploadMessage('C1', n('PROMOTED'))).toBe(
      'Customer C1 was loaded again from a newer upload, "later.xlsx" (row 9). This older row can no longer be fixed — exclude it.'
    );
    expect(newerUploadMessage('C1', n('CLEAN'))).toBe(
      'Customer C1 is also in a newer upload, "later.xlsx" (row 9), ready to load there. This older row can no longer be fixed — exclude it.'
    );
  });
});

describe('the fix window and changed cells', () => {
  it('closes after the retention sweep period, so the newest-upload check never runs blind', () => {
    const now = new Date('2026-12-30T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    expect(IMPORT_PAYLOAD_DAYS).toBe(90);
    expect(fixWindowClosed(new Date(now.getTime() - 89 * day), now)).toBe(false);
    expect(fixWindowClosed(new Date(now.getTime() - 91 * day), now)).toBe(true);
  });

  it('records only what the Steward changed, against the row as it stands', () => {
    const now = correctedRow({ phone: '9999', day_of_visit: 'XYZ' }, { cells: { day_of_visit: 'SUN' } });
    expect(changedCells({ phone: '9999', day_of_visit: 'SUN' }, now)).toEqual({});
    expect(changedCells({ phone: '99758980', day_of_visit: 'SUN' }, now)).toEqual({ phone: '99758980' });
    // Putting a cell back to its uploaded value is a change too.
    expect(changedCells({ day_of_visit: 'XYZ' }, now)).toEqual({ day_of_visit: 'XYZ' });
  });
});

describe('the fix window message (post-merge review)', () => {
  it('is the sentence the page shows and the server refuses with', () => {
    expect(fixWindowMessage(7)).toBe(
      'Row 7 was uploaded more than 90 days ago, past the window in which a newer upload of the same customer can still be seen. Exclude it, or upload the corrected row again.'
    );
  });
});

describe('composeBranchCode — promote\'s own naming (QA P-01)', () => {
  it('composes a bare suffix, passes a composed code or the customer code through', () => {
    expect(composeBranchCode('c100', '01')).toBe('C100-01');
    expect(composeBranchCode('C100', 'c100-02')).toBe('C100-02');
    expect(composeBranchCode('C100', ' C100 ')).toBe('C100');
    expect(composeBranchCode('C100', 'C1000-01')).toBe('C100-C1000-01');
  });
});

describe('supersedingUpload — which newer row rules a fix out (post-merge review)', () => {
  const c = (over: Partial<NewerCandidate>): NewerCandidate => ({
    filename: 'later.xlsx',
    rowNumber: 5,
    state: 'PROMOTED',
    excluded: false,
    branch: 'X-02',
    fixedInApp: false,
    refreshRow: false,
    ...over,
  });

  it('a customer not linked to Temix: the newest row, whatever it is', () => {
    const newest = c({ branch: 'X-09', refreshRow: true, rowNumber: 1 });
    expect(supersedingUpload({ branch: 'X-02' }, false, [newest, c({})])).toMatchObject({ rowNumber: 1 });
    expect(supersedingUpload({ branch: 'X-02' }, false, [])).toBeNull();
  });

  it('linked: a plain refresh row loads no branch, so it never rules a fix out', () => {
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({ refreshRow: true })])).toBeNull();
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({ refreshRow: true, state: 'CLEAN' })])).toBeNull();
  });

  it('linked: a newer row that wrote or may write the same branch does', () => {
    // Fixed in the app there: it wrote the branch.
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({ refreshRow: true, fixedInApp: true })])).not.toBeNull();
    // A full-lane row (no Temix code of the customer's): it wrote the branch.
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({})])).not.toBeNull();
    // Held back there: fix that one instead.
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({ refreshRow: true, state: 'QUARANTINED' })])).not.toBeNull();
    // Excluded there: the Steward decides which copy.
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({ refreshRow: true, excluded: true })])).not.toBeNull();
  });

  it('linked: a newer row about another branch, or with no branch_code, does not', () => {
    expect(supersedingUpload({ branch: 'X-02' }, true, [c({ branch: 'X-03' }), c({ branch: null })])).toBeNull();
    // A row with no branch_code of its own is rejected at promote until it has one.
    expect(supersedingUpload({ branch: null }, true, [c({})])).toBeNull();
  });

  it('linked: the newest matching row answers', () => {
    const hit = supersedingUpload({ branch: 'X-02' }, true, [
      c({ refreshRow: true, rowNumber: 1 }),
      c({ state: 'QUARANTINED', rowNumber: 2 }),
      c({ rowNumber: 3 }),
    ]);
    expect(hit).toEqual({ filename: 'later.xlsx', rowNumber: 2, state: 'QUARANTINED', excluded: false });
  });
});

describe('supersededFixMessage — a fix a newer upload overtook while it waited', () => {
  const n = (state: string, excluded = false) => ({ filename: 'later.xlsx', rowNumber: 9, state, excluded });
  it('says promote rejects it, and what to do', () => {
    expect(supersededFixMessage('C1', n('PROMOTED'))).toBe(
      'Customer C1 is also in a newer upload, "later.xlsx" (row 9), so this fix will not load: promote rejects it rather than load older data over that upload. Withdraw this fix, then exclude the row.'
    );
    expect(supersededFixMessage('C1', n('QUARANTINED'))).toMatch(/Withdraw this fix and fix the row in that upload instead\.$/);
    expect(supersededFixMessage('C1', n('QUARANTINED', true))).toMatch(/Withdraw this fix, then exclude the row\.$/);
  });
});

describe('unwrittenCustomerCells / branchOnlyNote — what a branch-only fix did not write', () => {
  const stored = {
    legalName: 'Al Noor Trading',
    primaryPhoneNorm: null,
    crNumberNorm: '1234567',
    contactPerson: 'Ali',
    channelKey: 'GT',
  };
  const row = { custName: 'Al Noor Trading', phone: '99758980', crNumber: '١٢٣٤٥٦٧', contactPerson: 'ali', channelKey: 'MT' };

  it('a released phone the customer does not have is named', () => {
    expect(unwrittenCustomerCells({ phoneReleased: { reason: 'same owner' } }, row, stored)).toEqual(['phone']);
  });

  it('only cells the Steward corrected, and only where they differ from the customer', () => {
    // The CR folds to the stored norm and the contact differs only in case: nothing lost.
    expect(unwrittenCustomerCells({ cells: { cr_no: '١٢٣٤٥٦٧', contact_person: 'ali' } }, row, stored)).toEqual([]);
    expect(unwrittenCustomerCells({ cells: { channel: 'MT', cust_name: 'Al Noor Trading' } }, row, stored)).toEqual(['channel']);
    // A visit day is the branch's own: never named.
    expect(unwrittenCustomerCells({ cells: { day_of_visit: 'SAT' } }, row, stored)).toEqual([]);
    // Nothing corrected: nothing to say.
    expect(unwrittenCustomerCells({}, row, stored)).toEqual([]);
  });

  it('a value cleared to blank asks for nothing', () => {
    expect(unwrittenCustomerCells({ cells: { phone: '' } }, { ...row, phone: null }, stored)).toEqual([]);
  });

  it('the note', () => {
    expect(branchOnlyNote([])).toBeNull();
    expect(branchOnlyNote(['phone'])).toBe(
      'the phone in this row was not written — for a customer linked to Temix a row fixed in the app loads only its branch; change it on the customer page'
    );
    expect(branchOnlyNote(['name', 'phone', 'channel'])).toMatch(/^the name, phone and channel in this row were not written — .*change them on the customer page$/);
  });
});
