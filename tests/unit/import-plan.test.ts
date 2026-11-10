/**
 * lib/import-plan.ts — the decisions of a customer import, without the database
 * (code review 2026-11-10, finding 1).
 *
 * The lane a customer's rows take used to be decided in the middle of the
 * promote's transaction and could only be tested through it. It hangs on two
 * things nobody could see: whether the customer has a Temix code ON RECORD, and
 * whether the row carries one.
 */
import { describe, it, expect } from 'vitest';
import {
  creditReason,
  creditReasonText,
  decideLane,
  differingBranchCells,
  rowCreditNote,
  rowCreditReason,
  type LaneExisting,
} from '@/lib/import-plan';

const existing = (over: Partial<LaneExisting> = {}): LaneExisting => ({
  archived: false,
  temixCode: null,
  recordedCode: null,
  temixSyncState: 'SYNCED',
  lastTemixUploadAt: null,
  ...over,
});
const linked = (code = 'CAA0367') => existing({ temixCode: code, recordedCode: code });
const lanesOf = (d: ReturnType<typeof decideLane>, first = false) => {
  const l = d.lanes(first);
  return { refreshLane: l.refreshLane, fullLane: l.fullLane, each: d.isFixed.map((_, i) => l.laneOf(i)) };
};

describe('decideLane', () => {
  it('a NEW customer: the full lane, whatever the row carries', () => {
    for (const temixCode of [null, 'CAA0367']) {
      const d = decideLane({ custCode: 'CAA0367', existing: null, rows: [{ temixCode }] });
      expect(d).toMatchObject({ linked: false, isRefresh: false, crosswalkChange: false, backupCandidate: false, leadIdx: 0 });
      expect(lanesOf(d)).toEqual({ refreshLane: false, fullLane: true, each: ['full'] });
    }
  });

  it('a seeded customer (no Temix code on record) takes the full lane even when the row carries a code', () => {
    // The ~3,300 pilot-seeded customers: this is the lane that used to replace
    // CRM fields from the sheet.
    const d = decideLane({ custCode: 'CAA0367', existing: existing(), rows: [{ temixCode: 'CAA0367' }, { temixCode: 'CAA0367' }] });
    expect(d).toMatchObject({ linked: false, isRefresh: false, crosswalkChange: false, backupCandidate: false });
    expect(lanesOf(d)).toEqual({ refreshLane: false, fullLane: true, each: ['full', 'full'] });
  });

  it('a linked customer whose row carries the code on record: the refresh lane', () => {
    const d = decideLane({ custCode: 'C1', existing: linked(), rows: [{ temixCode: 'CAA0367' }, { temixCode: null }] });
    expect(d).toMatchObject({ linked: true, isRefresh: true, crosswalkChange: false, plainIdx: [0, 1] });
    expect(lanesOf(d)).toEqual({ refreshLane: true, fullLane: false, each: ['refresh', 'refresh'] });
  });

  it('a linked customer whose row carries ANOTHER code: a crosswalk change, which the promote refuses', () => {
    const d = decideLane({ custCode: 'C1', existing: linked(), rows: [{ temixCode: 'OTHER' }] });
    expect(d).toMatchObject({ isRefresh: false, crosswalkChange: true });
  });

  it('a linked customer whose temix_code cell is blank — or whose sheet has no such column — takes the full lane', () => {
    for (const temixCode of [null, undefined, '']) {
      const d = decideLane({ custCode: 'C1', existing: linked(), rows: [{ temixCode }] });
      expect(d).toMatchObject({ linked: true, isRefresh: false, crosswalkChange: false });
      expect(lanesOf(d)).toEqual({ refreshLane: false, fullLane: true, each: ['full'] });
    }
  });

  it('the code on record is compared as the sheet spells it (recordedCode), not as stored', () => {
    const d = decideLane({
      custCode: 'C1',
      existing: existing({ temixCode: 'caa0367', recordedCode: 'CAA0367' }),
      rows: [{ temixCode: 'CAA0367' }],
    });
    expect(d.isRefresh).toBe(true);
  });

  it('the lane is the FIRST plain row’s: a blank first cell is the full lane for every plain row', () => {
    const d = decideLane({ custCode: 'C1', existing: linked(), rows: [{ temixCode: null }, { temixCode: 'CAA0367' }] });
    expect(lanesOf(d)).toEqual({ refreshLane: false, fullLane: true, each: ['full', 'full'] });
  });

  it('a row fixed in the app, for a linked customer, is its own lane; the plain rows keep theirs', () => {
    const d = decideLane({
      custCode: 'C1',
      existing: linked(),
      rows: [{ temixCode: null, fixedInApp: true }, { temixCode: 'CAA0367' }, { temixCode: 'CAA0367', fixedInApp: true }],
    });
    expect(d).toMatchObject({ isFixed: [true, false, true], plainIdx: [1], leadIdx: 1, isRefresh: true });
    expect(lanesOf(d)).toEqual({ refreshLane: true, fullLane: false, each: ['fixed', 'refresh', 'fixed'] });
  });

  it('every row fixed: no plain row, so neither the refresh nor the full lane — the customer is not written', () => {
    const d = decideLane({ custCode: 'C1', existing: linked(), rows: [{ fixedInApp: true }, { fixedInApp: true }] });
    expect(d).toMatchObject({ plainIdx: [], leadIdx: 0 });
    expect(lanesOf(d)).toEqual({ refreshLane: false, fullLane: false, each: ['fixed', 'fixed'] });
  });

  it('a fixed row of a customer NOT linked to Temix is a plain row', () => {
    const d = decideLane({ custCode: 'C1', existing: existing(), rows: [{ fixedInApp: true }] });
    expect(d).toMatchObject({ isFixed: [false], plainIdx: [0] });
    expect(lanesOf(d).each).toEqual(['full']);
  });

  describe('the backup match (owner decision 2026-10-08): the first Temix code of a customer created in the app', () => {
    const APP = 'NMWC-2026-000077';
    const sent = existing({ temixSyncState: 'UPLOADED', lastTemixUploadAt: new Date('2026-10-01T06:00:00Z') });
    const base = { custCode: APP, existing: sent, rows: [{ temixCode: 'TX900' }] };

    it('a candidate: live, no code yet, an app-minted customer code, sent to Temix, a row carrying a code', () => {
      const d = decideLane(base);
      expect(d.backupCandidate).toBe(true);
      // Until the promote has found its finalize's CREATE row: the full lane.
      expect(lanesOf(d, false)).toEqual({ refreshLane: false, fullLane: true, each: ['full'] });
      expect(lanesOf(d, true)).toEqual({ refreshLane: true, fullLane: false, each: ['backup'] });
    });

    it.each([
      ['a customer code the app did not mint', { ...base, custCode: 'CAA0367' }],
      ['a customer never sent to Temix', { ...base, existing: existing({ temixSyncState: 'PENDING_UPLOAD', lastTemixUploadAt: null }) }],
      ['a row with no temix_code', { ...base, rows: [{ temixCode: null }] }],
      ['a group with a row fixed in the app', { ...base, rows: [{ temixCode: 'TX900' }, { temixCode: 'TX900', fixedInApp: true }] }],
      ['a customer that already has a code', { ...base, existing: { ...sent, temixCode: 'TX1', recordedCode: 'TX1' } }],
      ['an archived customer', { ...base, existing: { ...sent, archived: true } }],
      ['a new customer', { ...base, existing: null }],
    ])('not a candidate: %s', (_label, input) => {
      expect(decideLane(input).backupCandidate).toBe(false);
    });

    it.each([
      ['in a batch and queued again', { temixSyncState: 'PENDING_UPLOAD', lastTemixUploadAt: new Date() }],
      ['UPLOADED', { temixSyncState: 'UPLOADED', lastTemixUploadAt: null }],
      ['SYNCED', { temixSyncState: 'SYNCED', lastTemixUploadAt: null }],
    ])('"sent to Temix" is any of: %s', (_label, state) => {
      expect(decideLane({ ...base, existing: existing(state) }).backupCandidate).toBe(true);
    });
  });
});

describe('differingBranchCells (moved from services/imports.ts unchanged)', () => {
  const r = { nameGiven: true, branchName: 'A', sheetAddress: 'Way 1', routeResolved: true, routeId: 'rt1', regionId: 'rg1', dayOfVisit: 'MON', status: 'ACTIVE' };
  const stored = { branchName: 'A', routeId: 'rt1', regionId: 'rg1', address: 'Way 1', dayOfVisit: 'MON', status: 'ACTIVE' };
  it('nothing differs; each cell the row gives is compared; a blank cell gives nothing', () => {
    expect(differingBranchCells(r, stored)).toEqual([]);
    expect(
      differingBranchCells(r, { branchName: 'B', routeId: 'rt2', regionId: 'rg2', address: 'Way 2', dayOfVisit: 'SUN', status: 'CLOSED' })
    ).toEqual(['branch name', 'address', 'route', 'region', 'visit day', 'status']);
    expect(
      differingBranchCells(
        { ...r, nameGiven: false, sheetAddress: null, routeResolved: false, dayOfVisit: null, status: null },
        { branchName: 'B', routeId: 'rt2', regionId: 'rg2', address: 'Way 2', dayOfVisit: 'SUN', status: 'CLOSED' }
      )
    ).toEqual([]);
  });
  it('the region is compared only when the stored one is passed (the full lane)', () => {
    expect(differingBranchCells(r, { ...stored, regionId: 'rgOLD' })).toEqual(['region']);
    expect(differingBranchCells(r, { ...stored, regionId: undefined })).toEqual([]);
  });
});

describe('creditReason — why a credit cell is not applied', () => {
  const figures = { creditLimit: 750, paymentTermDays: 30 };
  const cash = { recordedCode: null, paymentTerms: 'CASH', creditLimit: null, paymentTermDays: null };
  const credit = { recordedCode: 'T1', paymentTerms: 'CREDIT', creditLimit: 500, paymentTermDays: 30 };

  it('a row with no credit cell has nothing to say, on any lane', () => {
    for (const lane of ['full', 'refresh', 'backup', 'fixed'] as const) {
      expect(creditReason({ lane, existing: cash, lead: { paymentTerms: 'CASH' } })).toBeNull();
    }
  });

  it('a NEW customer: applied when the row says CREDIT, not otherwise', () => {
    expect(creditReason({ lane: 'full', existing: null, lead: { ...figures, paymentTerms: 'CREDIT', paymentTermsPresent: true } })).toBeNull();
    expect(creditReason({ lane: 'full', existing: null, lead: { ...figures, paymentTerms: 'CASH' } })).toBe('NEW_NOT_CREDIT');
  });

  it('the full lane never writes credit on a customer that exists', () => {
    // No code on record: the seeded customers, whatever the row's own code cell.
    expect(creditReason({ lane: 'full', existing: cash, lead: { ...figures, paymentTerms: 'CASH' } })).toBe('NO_CODE_ON_RECORD');
    // A code on record, and the row's cell blank (or the column missing).
    expect(creditReason({ lane: 'full', existing: credit, lead: { ...figures, paymentTerms: 'CREDIT' } })).toBe('ROW_CODE_BLANK');
  });

  it('figures that only restate what is on record ask for nothing', () => {
    expect(creditReason({ lane: 'full', existing: credit, lead: { creditLimit: 500, paymentTermDays: 30, paymentTerms: 'CREDIT' } })).toBeNull();
    expect(creditReason({ lane: 'full', existing: credit, lead: { creditLimit: 500, paymentTerms: 'CREDIT' } })).toBeNull();
    // One of the two differs: said.
    expect(creditReason({ lane: 'full', existing: credit, lead: { creditLimit: 500, paymentTermDays: 45, paymentTerms: 'CREDIT' } })).toBe('ROW_CODE_BLANK');
  });

  it('the refresh lane applies them to a CREDIT customer, and drops them for a CASH one', () => {
    expect(creditReason({ lane: 'refresh', existing: credit, lead: { ...figures, paymentTerms: 'CASH', paymentTermsPresent: false } })).toBeNull();
    expect(creditReason({ lane: 'refresh', existing: { ...cash, recordedCode: 'T1' }, lead: { ...figures, paymentTerms: 'CASH', paymentTermsPresent: false } })).toBe('CUSTOMER_IS_CASH');
    // The row itself says CASH: the customer becomes CASH and the figures are cleared.
    expect(creditReason({ lane: 'refresh', existing: credit, lead: { ...figures, paymentTerms: 'CASH', paymentTermsPresent: true } })).toBe('CUSTOMER_IS_CASH');
    // The row says CREDIT for a CASH customer: it becomes CREDIT and takes them.
    expect(creditReason({ lane: 'refresh', existing: { ...cash, recordedCode: 'T1' }, lead: { ...figures, paymentTerms: 'CREDIT', paymentTermsPresent: true } })).toBeNull();
  });

  it('a first Temix code writes the code only; a group of fixed rows writes shops only', () => {
    expect(creditReason({ lane: 'backup', existing: cash, lead: { ...figures, paymentTerms: 'CREDIT', paymentTermsPresent: true } })).toBe('FIRST_CODE_ONLY');
    expect(creditReason({ lane: 'fixed', existing: credit, lead: { ...figures, paymentTerms: 'CREDIT' } })).toBe('FIXED_ROW');
  });
});

describe('rowCreditReason / rowCreditNote — row by row', () => {
  const lead = { creditLimit: 750, paymentTermDays: 30 };

  it('the lead row has the group’s reason', () => {
    expect(rowCreditReason({ row: lead, lead, isLead: true, fixed: false, groupReason: 'NO_CODE_ON_RECORD' })).toBe('NO_CODE_ON_RECORD');
    expect(rowCreditReason({ row: lead, lead, isLead: true, fixed: false, groupReason: null })).toBeNull();
  });

  it('another row that repeats the lead’s figures shares its fate', () => {
    expect(rowCreditReason({ row: { ...lead }, lead, isLead: false, fixed: false, groupReason: 'CUSTOMER_IS_CASH' })).toBe('CUSTOMER_IS_CASH');
    expect(rowCreditReason({ row: { ...lead }, lead, isLead: false, fixed: false, groupReason: null })).toBeNull();
    expect(rowCreditReason({ row: { creditLimit: 750 }, lead, isLead: false, fixed: false, groupReason: null })).toBeNull();
  });

  it('another row with figures of its own is never read', () => {
    expect(rowCreditReason({ row: { creditLimit: 900 }, lead, isLead: false, fixed: false, groupReason: null })).toBe('NOT_FIRST_ROW');
    expect(rowCreditReason({ row: { paymentTermDays: 60 }, lead: { creditLimit: 750 }, isLead: false, fixed: false, groupReason: null })).toBe('NOT_FIRST_ROW');
    expect(rowCreditReason({ row: { creditLimit: 900 }, lead, isLead: false, fixed: true, groupReason: null })).toBe('FIXED_ROW');
  });

  it('a row with no credit cell has no note', () => {
    expect(rowCreditReason({ row: {}, lead, isLead: false, fixed: false, groupReason: 'NO_CODE_ON_RECORD' })).toBeNull();
  });

  it('the note names the cells the row gave and the reason, never a value', () => {
    expect(rowCreditNote({ row: lead, lead, isLead: true, fixed: false, leadRowNumber: 2, groupReason: 'NO_CODE_ON_RECORD' })).toBe(
      'the credit_limit and payment_term_days in this row were not applied — this customer has no Temix code on record, and credit figures are taken only from a row carrying the Temix code already recorded for the customer'
    );
    expect(rowCreditNote({ row: { creditLimit: 900 }, lead, isLead: false, fixed: false, leadRowNumber: 2, groupReason: null })).toBe(
      "the credit_limit in this row was not applied — a customer's credit figures are read from its first row in the file (row 2)"
    );
    expect(rowCreditNote({ row: { paymentTermDays: 30 }, lead: { paymentTermDays: 30 }, isLead: true, fixed: false, leadRowNumber: 2, groupReason: 'ROW_CODE_BLANK' })).toBe(
      "the payment_term_days in this row was not applied — the row's temix_code is blank; fill it with the customer's Temix code to refresh its credit figures"
    );
    expect(rowCreditNote({ row: lead, lead, isLead: true, fixed: false, leadRowNumber: 2, groupReason: null })).toBeNull();
  });

  it('every reason has its words', () => {
    expect(creditReasonText('CUSTOMER_IS_CASH')).toBe('the customer is CASH, and a credit limit and credit days apply only to a CREDIT customer');
    expect(creditReasonText('NEW_NOT_CREDIT')).toBe("the row's payment_terms is not CREDIT");
    expect(creditReasonText('FIRST_CODE_ONLY')).toBe("this row recorded the customer's first Temix code and nothing else; the next refresh applies the figures");
    expect(creditReasonText('FIXED_ROW')).toBe('a row fixed in the app loads only its shop');
    expect(creditReasonText('NOT_FIRST_ROW')).toBe("a customer's credit figures are read from its first row in the file");
  });
});
