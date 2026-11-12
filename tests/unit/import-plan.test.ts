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
import { ROUTE_NOT_APPLIED } from '@/lib/import-shop-notice';
import {
  REJECT_REASONS,
  shopNotChangedNote,
  SUMMARY_ADDRESS_MIN,
  addGroup,
  creditReason,
  creditReasonText,
  decideLane,
  differingBranchCells,
  emptySummary,
  planGroup,
  rowCreditNote,
  rowCreditReason,
  summaryBranchOf,
  summaryLines,
  type LaneExisting,
  type PlanCustomer,
  type PlanRow,
  type PlanShop,
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

// ── The "Before you promote" summary ────────────────────────────────────────

const ROUTES = new Map([
  ['R1', { id: 'rt1', regionId: 'rg1' }],
  ['R2', { id: 'rt2', regionId: 'rg2' }],
]);
const CHANNELS = new Map([
  ['HORECA', 'ch-horeca'],
  ['RETAIL', 'ch-retail'],
]);
const prow = (over: Partial<PlanRow> = {}): PlanRow => ({
  custCode: 'C1',
  custName: 'Sheet Name',
  branchCode: '01',
  branchName: null,
  regionCode: null,
  routeCode: 'R1',
  address: 'Sheet address 1',
  phone: '+96891111111',
  contactPerson: null,
  crNumber: null,
  paymentTerms: 'CASH',
  paymentTermsPresent: false,
  temixCode: null,
  creditLimit: null,
  paymentTermDays: null,
  channelKey: null,
  dayOfVisit: 'MON',
  customerStatus: 'ACTIVE',
  ...over,
});
const customer = (over: Partial<PlanCustomer> = {}): PlanCustomer => ({
  id: 'cust-1',
  deletedAt: null,
  temixCode: null,
  recordedCode: null,
  temixSyncState: 'SYNCED',
  lastTemixUploadAt: null,
  paymentTerms: 'CASH',
  creditLimit: null,
  paymentTermDays: null,
  status: 'ACTIVE',
  legalName: 'Sheet Name',
  primaryPhone: '+96891111111',
  primaryPhoneNorm: '+96891111111',
  contactPerson: null,
  crNumber: null,
  crNumberNorm: null,
  channelId: null,
  subChannelId: null,
  subChannelChannelId: null,
  liveBranches: 1,
  ...over,
});
const pshop = (over: Partial<PlanShop> = {}): PlanShop => ({
  customerId: 'cust-1',
  deletedAt: null,
  branchName: 'Main',
  routeId: 'rt1',
  regionId: 'rg1',
  address: 'Sheet address 1',
  dayOfVisit: 'MON',
  status: 'ACTIVE',
  ...over,
});
const plan = (
  rows: PlanRow[],
  existing: PlanCustomer | null,
  shops: Record<string, PlanShop> = {},
  overwrite = false
) =>
  planGroup({
    custCode: 'C1',
    overwrite,
    rows,
    existing,
    shopByCode: new Map(Object.entries(shops)),
    routeByCode: ROUTES,
    channelIdByKey: CHANNELS,
  });

describe('summaryBranchOf — a row’s shop, as the promote resolves it', () => {
  it('composes a bare code under the customer, passes a composed one through, numbers a row with none', () => {
    expect(summaryBranchOf('C1', prow({ branchCode: '03' }), 0, ROUTES).branchCode).toBe('C1-03');
    expect(summaryBranchOf('C1', prow({ branchCode: 'c1-07' }), 0, ROUTES).branchCode).toBe('C1-07');
    expect(summaryBranchOf('C1', prow({ branchCode: 'C1' }), 0, ROUTES).branchCode).toBe('C1');
    const none = summaryBranchOf('C1', prow({ branchCode: null }), 2, ROUTES);
    expect([none.sheetCode, none.branchCode]).toEqual([null, 'C1-03']);
  });

  it('resolves the route by its code, in any case; an unknown one is not resolved', () => {
    expect(summaryBranchOf('C1', prow({ routeCode: 'r2' }), 0, ROUTES)).toMatchObject({ routeResolved: true, routeId: 'rt2', regionId: 'rg2' });
    expect(summaryBranchOf('C1', prow({ routeCode: 'NOPE' }), 0, ROUTES).routeResolved).toBe(false);
    expect(summaryBranchOf('C1', prow({ routeCode: null }), 0, ROUTES).routeResolved).toBe(false);
  });

  it('an address the database would refuse is qualified or replaced, as at Promote', () => {
    expect(summaryBranchOf('C1', prow({ address: 'X', branchName: 'Seeb', regionCode: 'MCT' }), 0, ROUTES)).toMatchObject({
      address: 'X, Seeb, MCT',
      sheetAddress: 'X, Seeb, MCT',
    });
    expect(summaryBranchOf('C1', prow({ address: null }), 0, ROUTES)).toMatchObject({ address: 'Address pending', sheetAddress: null });
    expect(summaryBranchOf('C1', prow({ address: 'X' }), 0, ROUTES)).toMatchObject({ address: 'Address pending', sheetAddress: null });
    expect(SUMMARY_ADDRESS_MIN).toBe(3);
  });
});

describe('planGroup — what Promote would do with one customer', () => {
  it('a new customer: created, with each of its shops', () => {
    const p = plan([prow(), prow({ branchCode: '02' })], null);
    expect(p).toMatchObject({ rejected: null, newCustomer: true, shopsCreated: 2, unchanged: false });
    expect(p.writes).toEqual({
      customer: ['<create>'],
      shops: [
        { branchCode: 'C1-01', kind: 'create', fields: [] },
        { branchCode: 'C1-02', kind: 'create', fields: [] },
      ],
    });
  });

  it('a customer and shop already as the sheet says: no change, nothing written', () => {
    const p = plan([prow()], customer(), { 'C1-01': pshop() });
    expect(p).toMatchObject({ unchanged: true, customerDiffers: false, shopsDiffer: 0, shopsCreated: 0 });
    expect(p.writes).toEqual({ customer: [], shops: [] });
  });

  it('CRM values that differ are KEPT by default: counted, named, and nothing is written', () => {
    const p = plan(
      [prow({ custName: 'Older Name', phone: '+96892222222', address: 'Older address', dayOfVisit: 'SUN', customerStatus: 'CLOSED' })],
      customer(),
      { 'C1-01': pshop() }
    );
    expect(p).toMatchObject({ customerDiffers: true, shopsDiffer: 1, shopsWouldClose: 1, shopsWouldReopen: 0, unchanged: false });
    expect(p.fields).toEqual(['name', 'phone', 'address', 'visit day', 'status']);
    expect(p.writes).toEqual({ customer: [], shops: [] });
  });

  it('with the option on, the same sheet REPLACES them: the same counts, and the fields it writes', () => {
    const p = plan(
      [prow({ custName: 'Older Name', phone: '+96892222222', address: 'Older address', dayOfVisit: 'SUN', customerStatus: 'CLOSED' })],
      customer(),
      { 'C1-01': pshop() },
      true
    );
    expect(p).toMatchObject({ customerDiffers: true, shopsDiffer: 1, shopsWouldClose: 1 });
    expect(p.fields).toEqual(['name', 'phone', 'address', 'visit day', 'status']);
    expect(p.writes).toEqual({
      customer: ['legalName', 'primaryPhone', 'primaryPhoneNorm'],
      shops: [{ branchCode: 'C1-01', kind: 'update', fields: ['address', 'dayOfVisit', 'status'] }],
    });
  });

  it('blanks are filled, with the option off', () => {
    const p = plan(
      [prow({ contactPerson: 'Said', crNumber: '12 34' })],
      customer(),
      { 'C1-01': pshop({ address: 'Address pending', dayOfVisit: null }) }
    );
    expect(p).toMatchObject({ customerFilled: true, shopsFilled: 1, customerDiffers: false, shopsDiffer: 0 });
    expect(p.writes).toEqual({
      customer: ['contactPerson', 'crNumber', 'crNumberNorm'],
      shops: [{ branchCode: 'C1-01', kind: 'update', fields: ['address', 'dayOfVisit'] }],
    });
  });

  // Owner's answer 2026-11-11 ("A1 stop"): this used to say "a shop moves to the
  // sheet's route" and pinned a write of regionId and routeId. A shop that exists
  // keeps its route on every lane; the row is counted as route NOT applied.
  it('a shop that exists keeps its route: a different one is counted as NOT applied, and nothing is written for it', () => {
    const p = plan([prow({ routeCode: 'R2', address: 'Older address' })], customer(), { 'C1-01': pshop() });
    expect(p).toMatchObject({ routeNotApplied: 1, shopsDiffer: 1, unchanged: false });
    expect(p.writes.shops).toEqual([]);
  });

  it('only the route differs: the row is still not "no change", and nothing is written', () => {
    const p = plan([prow({ routeCode: 'R2' })], customer(), { 'C1-01': pshop() });
    expect(p).toMatchObject({ routeNotApplied: 1, shopsDiffer: 0, shopsFilled: 0, unchanged: false });
    expect(p.writes).toEqual({ customer: [], shops: [] });
  });

  it('with the option on, the route is still NOT applied; the other cells are replaced', () => {
    const p = plan([prow({ routeCode: 'R2', address: 'Older address' })], customer(), { 'C1-01': pshop() }, true);
    expect(p).toMatchObject({ routeNotApplied: 1 });
    expect(p.writes.shops).toEqual([{ branchCode: 'C1-01', kind: 'update', fields: ['address'] }]);
  });

  it('a stale region of the shop’s own route is repaired, which is not a route move', () => {
    const own = plan([prow({ routeCode: 'R1' })], customer(), { 'C1-01': pshop({ regionId: 'rgOld' }) });
    expect(own).toMatchObject({ routeNotApplied: 0 });
    expect(own.writes.shops).toEqual([{ branchCode: 'C1-01', kind: 'update', fields: ['regionId'] }]);
    // Naming another route: the region of the shop's OWN route, and the route counted as not applied.
    const other = plan([prow({ routeCode: 'R2' })], customer(), { 'C1-01': pshop({ regionId: 'rgOld' }) });
    expect(other).toMatchObject({ routeNotApplied: 1 });
    expect(other.writes.shops).toEqual([{ branchCode: 'C1-01', kind: 'update', fields: ['regionId'] }]);
  });

  it('a NEW shop of a customer in the CRM, and a new customer’s shops, are created on the sheet’s route', () => {
    const onExisting = plan([prow({ branchCode: '02', routeCode: 'R2' })], customer(), { 'C1-01': pshop() });
    expect(onExisting).toMatchObject({ shopsCreated: 1, routeNotApplied: 0 });
    const fresh = plan([prow({ routeCode: 'R2' }), prow({ branchCode: '02', routeCode: 'R1' })], null);
    expect(fresh).toMatchObject({ newCustomer: true, shopsCreated: 2, routeNotApplied: 0 });
  });

  it('a sheet’s ACTIVE on a CLOSED shop would reopen it: counted, and kept', () => {
    const p = plan([prow()], customer({ status: 'CLOSED' }), { 'C1-01': pshop({ status: 'CLOSED' }) });
    expect(p).toMatchObject({ shopsWouldReopen: 1, shopsDiffer: 1, customerDiffers: false, reopensCustomer: false });
    expect(p.fields).toEqual(['status']);
    expect(p.writes.shops).toEqual([]);
  });

  it('the customer’s own status counts when no shop row carries the difference (a hold is not lifted)', () => {
    const p = plan([prow()], customer({ status: 'SUSPENDED' }), { 'C1-01': pshop() });
    expect(p).toMatchObject({ customerDiffers: true, shopsDiffer: 0 });
    expect(p.fields).toEqual(['status']);
  });

  it('a new open shop on a customer that is not ACTIVE reopens it (owner decision 7)', () => {
    const p = plan([prow({ branchCode: '02' })], customer({ status: 'CLOSED' }), { 'C1-01': pshop({ status: 'CLOSED' }) });
    expect(p).toMatchObject({ shopsCreated: 1, reopensCustomer: true, customerDiffers: false });
    expect(plan([prow({ branchCode: '02', customerStatus: 'CLOSED' })], customer({ status: 'CLOSED' })).reopensCustomer).toBe(false);
  });

  it('the refresh lane: Temix-owned fields refreshed; a shop that differs is counted as not changed, one not in the CRM as not added', () => {
    const linked = customer({ temixCode: 'T1', recordedCode: 'T1', paymentTerms: 'CREDIT', creditLimit: 500 });
    const p = plan(
      [
        prow({ temixCode: 'T1', paymentTerms: 'CREDIT', paymentTermsPresent: true, creditLimit: 750, routeCode: 'R2', custName: 'ERP Name' }),
        prow({ temixCode: 'T1', branchCode: '02', creditLimit: 750 }),
      ],
      linked,
      { 'C1-01': pshop() }
    );
    expect(p).toMatchObject({
      onRefresh: true,
      temixChanged: true,
      linkedShops: 1,
      linkedRouteNotMoved: 1,
      linkedNotAdded: 1,
      customerDiffers: false,
      shopsCreated: 0,
    });
    expect(p.writes).toEqual({ customer: ['creditLimit'], shops: [] });
    expect(p.credit).toEqual([]);
  });

  it('a refresh that restates the record changes nothing', () => {
    const linked = customer({ temixCode: 'T1', recordedCode: 'T1' });
    expect(plan([prow({ temixCode: 'T1' })], linked, { 'C1-01': pshop() })).toMatchObject({ onRefresh: true, temixChanged: false, unchanged: true });
  });

  it('credit cells that are not applied are counted row by row, with the reason', () => {
    const seeded = plan(
      [prow({ temixCode: 'C1', creditLimit: 750 }), prow({ branchCode: '02', temixCode: 'C1', creditLimit: 750 }), prow({ branchCode: '03', creditLimit: 900 })],
      customer(),
      { 'C1-01': pshop(), 'C1-02': pshop(), 'C1-03': pshop() }
    );
    expect(seeded.credit).toEqual(['NO_CODE_ON_RECORD', 'NO_CODE_ON_RECORD', 'NOT_FIRST_ROW']);
    expect(seeded.unchanged).toBe(false);
    const blank = plan([prow({ creditLimit: 750 })], customer({ temixCode: 'T1', recordedCode: 'T1' }), { 'C1-01': pshop() });
    expect(blank.credit).toEqual(['ROW_CODE_BLANK']);
  });

  it('a row fixed in the app, for a linked customer: its own shop, by the same rule', () => {
    const linked = customer({ temixCode: 'T1', recordedCode: 'T1' });
    const kept = plan([prow({ fixedInApp: true, routeCode: 'R2', address: 'Older address' })], linked, { 'C1-01': pshop() });
    // Owner's answer 2026-11-11 ("A1 stop"): its different route is NOT applied
    // (this used to pin a write of regionId and routeId); the address is kept.
    expect(kept).toMatchObject({ onRefresh: false, routeNotApplied: 1, shopsDiffer: 1, linkedShops: 0 });
    expect(kept.writes.shops).toEqual([]);
    const filled = plan([prow({ fixedInApp: true, routeCode: 'R2', dayOfVisit: 'SUN' })], linked, {
      'C1-01': pshop({ dayOfVisit: null }),
    });
    expect(filled).toMatchObject({ routeNotApplied: 1, shopsFilled: 1 });
    expect(filled.writes.shops).toEqual([{ branchCode: 'C1-01', kind: 'update', fields: ['dayOfVisit'] }]);
    const made = plan([prow({ fixedInApp: true, branchCode: '09' })], linked, { 'C1-01': pshop() });
    expect(made).toMatchObject({ shopsCreated: 1 });
  });

  it.each([
    ['an archived customer', [prow()], customer({ deletedAt: new Date() }), {}, REJECT_REASONS.ARCHIVED],
    ['another Temix code than the one on record', [prow({ temixCode: 'OTHER' })], customer({ temixCode: 'T1', recordedCode: 'T1' }), {}, REJECT_REASONS.OTHER_CODE],
    ['payment terms that differ', [prow({ paymentTerms: 'CREDIT', paymentTermsPresent: true })], customer(), {}, REJECT_REASONS.TERMS],
    ['a new CREDIT customer with no temix_code', [prow({ paymentTerms: 'CREDIT', paymentTermsPresent: true })], null, {}, REJECT_REASONS.NEW_CREDIT],
    ['no branch_code on a customer with shops', [prow({ branchCode: null })], customer(), {}, REJECT_REASONS.NO_BRANCH_CODE],
    ['a branch code repeated in the file', [prow(), prow()], customer(), {}, REJECT_REASONS.REPEATED_CODE],
    ['a branch code of another customer', [prow()], customer(), { 'C1-01': pshop({ customerId: 'someone-else' }) }, REJECT_REASONS.FOREIGN_CODE],
    ['a sheet code that is another customer’s shop', [prow({ branchCode: 'X9-01' })], customer(), { 'X9-01': pshop({ customerId: 'someone-else' }) }, REJECT_REASONS.FOREIGN_CODE],
    ['a new customer naming an existing shop', [prow()], null, { 'C1-01': pshop() }, REJECT_REASONS.FOREIGN_CODE],
  ] as const)('expected to be rejected: %s', (_label, rows, existing, shops, reason) => {
    const p = plan([...rows], existing, shops);
    expect(p.rejected).toBe(reason);
    expect(p).toMatchObject({ newCustomer: false, shopsCreated: 0, customerDiffers: false, credit: [] });
    expect(p.writes).toEqual({ customer: [], shops: [] });
  });

  it('a customer with no shops yet takes a row with no branch_code (numbered by position)', () => {
    expect(plan([prow({ branchCode: null })], customer({ liveBranches: 0 }))).toMatchObject({ rejected: null, shopsCreated: 1 });
  });
});

describe('addGroup and summaryLines — the counts and the words', () => {
  const build = (overwrite: boolean) => {
    const s = emptySummary();
    const older = prow({ custName: 'Older Name', address: 'Older address', customerStatus: 'CLOSED' });
    // Two customers whose CRM values differ, one new, one unchanged, one refreshed, one rejected.
    addGroup(s, plan([older], customer(), { 'C1-01': pshop() }, overwrite));
    addGroup(s, plan([{ ...older, creditLimit: 750 }], customer(), { 'C1-01': pshop() }, overwrite));
    addGroup(s, plan([prow(), prow({ branchCode: '02' })], null, {}, overwrite));
    addGroup(s, plan([prow()], customer(), { 'C1-01': pshop() }, overwrite));
    addGroup(
      s,
      plan(
        [prow({ temixCode: 'T1', paymentTerms: 'CREDIT', paymentTermsPresent: true, creditLimit: 750, routeCode: 'R2' })],
        customer({ temixCode: 'T1', recordedCode: 'T1' }),
        { 'C1-01': pshop() },
        overwrite
      )
    );
    addGroup(s, plan([prow({ paymentTerms: 'CREDIT', paymentTermsPresent: true }), prow({ branchCode: '02' })], customer(), {}, overwrite));
    addGroup(s, plan([prow({ branchCode: '02' })], customer({ status: 'CLOSED' }), {}, overwrite));
    return s;
  };

  it('adds each customer once, and a rejected one only as rejected', () => {
    const s = build(false);
    expect(s).toEqual({
      rows: 9,
      customers: 7,
      created: { customers: 1, shops: 3, shopsOnExisting: 1, closedCustomersReopened: 1 },
      temix: { customersOnRefresh: 1, customersChanged: 1 },
      routeNotApplied: 0,
      // Owner's answer 2026-11-11 (A5): counted by the loader, not by addGroup.
      codesCapitalised: 0,
      crm: {
        customersFilled: 0,
        shopsFilled: 0,
        customersDiffer: 2,
        shopsDiffer: 2,
        shopsWouldReopen: 0,
        shopsWouldClose: 2,
        byField: [
          { field: 'name', count: 2 },
          { field: 'address', count: 2 },
          { field: 'status', count: 2 },
        ],
        linkedCustomers: 1,
        linkedShops: 1,
        linkedRouteNotMoved: 1,
        linkedNotAdded: 0,
      },
      credit: { rows: 1, reasons: [{ reason: 'NO_CODE_ON_RECORD', rows: 1 }] },
      expectRejected: { customers: 1, rows: 2, reasons: [{ reason: 'payment terms that differ from the record', customers: 1 }] },
      unchangedCustomers: 1,
    });
  });

  it('off: the sentences say what is created, refreshed, KEPT, not applied and expected to be rejected', () => {
    expect(summaryLines(build(false), false)).toEqual([
      { tone: 'plain', text: 'Checked 9 clean rows for 7 customers against the CRM as it is now.' },
      { tone: 'plain', text: 'New: 1 customer(s) and 3 shop(s) will be created (1 of the shops on customers already in the CRM).' },
      {
        tone: 'plain',
        // Owner's answer 2026-11-11: no shop moves to the sheet's route any more.
        text: 'Temix-owned fields: 1 customer(s) will have their Temix code, cash/credit, credit limit or credit days refreshed.',
      },
      {
        tone: 'warn',
        text: 'CRM fields kept: on 2 customer(s) and 2 shop(s) the sheet differs from the record. Their values stay as they are on record (address 2, name 2, status 2). The sheet would have reopened 0 closed shop(s) and closed 2 open shop(s); they stay as they are.',
      },
      {
        tone: 'warn',
        text: "Loaded, shop NOT changed: 1 shop(s) of 1 customer(s) differ from the record and are not changed by a row that carries the customer's Temix code (1 of them a different route, and that route is NOT applied). The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.",
      },
      {
        tone: 'warn',
        text: 'Credit cells not applied: 1 row(s) — 1: this customer has no Temix code on record, and credit figures are taken only from a row carrying the Temix code already recorded for the customer.',
      },
      { tone: 'warn', text: 'Closed customers reopened by a new open shop: 1.' },
      {
        tone: 'warn',
        text: 'Expected to be rejected at Promote: 2 row(s) of 1 customer(s) (payment terms that differ from the record: 1). Each row will say why.',
      },
      { tone: 'plain', text: 'No change: 1 customer(s) are already as the sheet says.' },
      { tone: 'plain', text: 'This is a check, not a lock: Promote works from the CRM as it is at that moment.' },
    ]);
  });

  it('on: the same customers and shops are REPLACED, in red, and shops are opened or closed', () => {
    const lines = summaryLines(build(true), true);
    expect(lines.find((l) => l.tone === 'danger')).toEqual({
      tone: 'danger',
      text: "CRM fields REPLACED: on 2 customer(s) and 2 shop(s) the values on record will be replaced by this sheet's (address 2, name 2, status 2). 0 closed shop(s) will be reopened and 2 open shop(s) closed.",
    });
    expect(lines.some((l) => l.text.startsWith('CRM fields kept'))).toBe(false);
    // The refresh lane is the same with the option on: it never writes a CRM field.
    expect(lines.some((l) => l.text.startsWith('Loaded, shop NOT changed: 1 shop(s) of 1 customer(s)'))).toBe(true);
  });

  it('rows naming another route for a shop that exists: one warning line with the count and the sentence', () => {
    const s = emptySummary();
    addGroup(s, plan([prow({ routeCode: 'R2' })], customer(), { 'C1-01': pshop() }));
    addGroup(s, plan([prow({ routeCode: 'R2', fixedInApp: true })], customer({ temixCode: 'T1', recordedCode: 'T1' }), { 'C1-01': pshop() }));
    // A new shop on its sheet route is not counted.
    addGroup(s, plan([prow({ branchCode: '02', routeCode: 'R2' })], customer(), { 'C1-01': pshop() }));
    expect(s.routeNotApplied).toBe(2);
    expect(summaryLines(s, false).filter((l) => l.text.startsWith('Route NOT applied'))).toEqual([
      {
        tone: 'warn',
        text: 'Route NOT applied: 2 row(s) name a route other than the current route of their shop, which is already in the CRM. The rest of each row loads as the lines here say; the route does not. The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.',
      },
    ]);
    // The overwrite option does not change it.
    expect(summaryLines(s, true).some((l) => l.text.startsWith('Route NOT applied: 2 row(s)'))).toBe(true);
  });

  it('an empty batch, and one with nothing to say, read as two plain lines', () => {
    expect(summaryLines(emptySummary(), false)).toEqual([
      { tone: 'plain', text: 'Checked 0 clean rows for 0 customers against the CRM as it is now.' },
      { tone: 'plain', text: 'This is a check, not a lock: Promote works from the CRM as it is at that moment.' },
    ]);
    const one = addGroup(emptySummary(), plan([prow()], customer(), { 'C1-01': pshop() }));
    expect(summaryLines(one, false).map((l) => l.text)).toEqual([
      'Checked 1 clean row for 1 customer against the CRM as it is now.',
      'No change: 1 customer(s) are already as the sheet says.',
      'This is a check, not a lock: Promote works from the CRM as it is at that moment.',
    ]);
  });

  it('a line with a shop the sheet names and the CRM does not have says it is not added', () => {
    const s = addGroup(
      emptySummary(),
      plan([prow({ temixCode: 'T1', branchCode: '05' })], customer({ temixCode: 'T1', recordedCode: 'T1' }), { 'C1-01': pshop() })
    );
    expect(summaryLines(s, false)[1]!.text).toBe(
      "Loaded, shop NOT changed: 0 shop(s) of 1 customer(s) differ from the record and are not changed by a row that carries the customer's Temix code (0 of them a different route, and that route is NOT applied); 1 shop(s) in the sheet are not in the CRM and are not added."
    );
  });
});

// Code review 2026-11-10, finding 7.
describe('planGroup — a new customer under another live customer\'s Temix code', () => {
  const withHeld = (existing: PlanCustomer | null, codes: string[]) =>
    planGroup({
      custCode: 'c1',
      overwrite: false,
      rows: [prow({ branchCode: '01' })],
      existing,
      shopByCode: new Map(),
      routeByCode: ROUTES,
      channelIdByKey: CHANNELS,
      liveTemixCodes: new Set(codes),
    });
  it('is expected to be rejected, as the promote rejects it', () => {
    expect(withHeld(null, ['C1']).rejected).toBe(REJECT_REASONS.HELD_CODE);
  });
  it('a code no live customer holds is created as before', () => {
    const p = withHeld(null, ['OTHER']);
    expect(p.rejected).toBeNull();
    expect(p.newCustomer).toBe(true);
  });
});

// Owner's answers 2026-11-11 (A5).
describe('planGroup — a shop code that only looks like one of the customer’s shops or rows', () => {
  const withShops = (rows: PlanRow[], existing: PlanCustomer | null, customerShops: string[]) =>
    planGroup({
      custCode: 'C1',
      overwrite: false,
      rows,
      existing,
      shopByCode: new Map(),
      routeByCode: ROUTES,
      channelIdByKey: CHANNELS,
      customerShops,
    });

  it('is expected to be rejected, as the promote rejects it', () => {
    expect(withShops([prow({ branchCode: '1' })], customer(), ['C1-01']).rejected).toBe(REJECT_REASONS.LOOKALIKE_CODE);
    expect(withShops([prow({ branchCode: 'ab' })], customer(), ['C1-AB']).rejected).toBe(REJECT_REASONS.LOOKALIKE_CODE);
    expect(withShops([prow({ branchCode: '01' }), prow({ branchCode: '1' })], null, []).rejected).toBe(
      REJECT_REASONS.LOOKALIKE_CODE
    );
  });

  // Review of A5 (2026-11-11): a NEW customer's row with a blank branch_code is
  // numbered C1-01 by its place; beside a row coded "1" that was two shops.
  it('a new customer: a blank branch_code numbered like a sibling row’s code is expected to be rejected', () => {
    expect(withShops([prow({ branchCode: null }), prow({ branchCode: '1' })], null, []).rejected).toBe(
      REJECT_REASONS.LOOKALIKE_CODE
    );
    expect(withShops([prow({ branchCode: '2' }), prow({ branchCode: null })], null, []).rejected).toBe(
      REJECT_REASONS.LOOKALIKE_CODE
    );
    // Numbers that look like nothing else: loaded as before.
    expect(withShops([prow({ branchCode: null }), prow({ branchCode: '03' })], null, []).rejected).toBeNull();
    expect(withShops([prow({ branchCode: null }), prow({ branchCode: null })], null, []).rejected).toBeNull();
  });

  it('an identical code, another code, or a row released as a different shop is not', () => {
    expect(withShops([prow({ branchCode: '01' })], customer(), ['C1-01']).rejected).not.toBe(REJECT_REASONS.LOOKALIKE_CODE);
    expect(withShops([prow({ branchCode: '02' })], customer(), ['C1-01']).rejected).toBeNull();
    expect(
      withShops([prow({ branchCode: '1', shopCodeReleased: true })], customer(), ['C1-01']).rejected
    ).toBeNull();
  });

  it('the summary line counts the rows whose codes were read in capitals', () => {
    const s = emptySummary();
    s.codesCapitalised = 2;
    expect(summaryLines(s, false).filter((l) => l.text.startsWith('Codes in capitals'))).toEqual([
      {
        tone: 'plain',
        text: 'Codes in capitals: 2 row(s) have a customer code or Temix code typed in small letters. They are read in capital letters (cct0005 is CCT0005), so they load as that customer; each row says so.',
      },
    ]);
    expect(summaryLines(emptySummary(), false).some((l) => l.text.startsWith('Codes in capitals'))).toBe(false);
  });
});


// Code review 2026-11-10, finding 28.
describe('shopNotChangedNote — a shop the import loaded without changing', () => {
  it('says the route was NOT applied and that route moves are made in Temix, before the other fields', () => {
    expect(shopNotChangedNote('C1-01', ['route', 'address', 'visit day'])).toBe(
      "branch C1-01: loaded, shop NOT changed — a row that carries the customer's Temix code never changes an existing shop. The route was NOT applied; the shop stays on its current route. Route moves are made in Temix. The address, visit day in this row differ from the CRM and were not applied either; they can be changed by an edit on the customer page."
    );
  });
  it('without a route, only the fields — and never the words "on the customer page" about a route', () => {
    expect(shopNotChangedNote('C1-01', ['address'])).toBe(
      "branch C1-01: loaded, shop NOT changed — a row that carries the customer's Temix code never changes an existing shop. The address in this row differs from the CRM and was not applied; it can be changed by an edit on the customer page."
    );
    expect(shopNotChangedNote('C1-01', ['route'])).not.toMatch(/customer page/);
  });
  it('promises nothing that is not built', () => {
    expect(ROUTE_NOT_APPLIED).not.toMatch(/will|later|soon|daily|Temix file/i);
  });
  // Second round: the owner settled that route moves are made in Temix. The
  // first round's sentence offered an import row with temix_code left blank, or
  // a fixed held-back row, as the way to move a shop; nothing says that now.
  it('never offers an import row or a fix in the CRM as a way to move a route', () => {
    expect(ROUTE_NOT_APPLIED).toBe(
      "The route was NOT applied; the shop stays on its current route. Route moves are made in Temix."
    );
    for (const text of [ROUTE_NOT_APPLIED, shopNotChangedNote('C1-01', ['route'])]) {
      expect(text).not.toMatch(/temix_code left blank|held-back|rejected row|batch page|customer-import row/i);
      // Third round: two import paths can still set a shop's route (a fixed
      // held-back row, a row with no temix_code), so it must not claim none can.
      expect(text).not.toMatch(/No screen/i);
    }
  });
});
