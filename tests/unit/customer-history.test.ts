// @vitest-environment node
/**
 * The customer's History page, assembled (lib/customer-history.ts): which routes
 * served it and which salesman held each route then, its terms over time, every
 * change with who, when and why, and how it was created — and the rule that a
 * personal value never reaches the page (the history stores those by name only).
 *
 * Pure: rows in, view model out, no database. The page and its access are in
 * customer-history-page.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { Prisma, Role } from '@prisma/client';
import { canSeeCustomerHistory } from '@/lib/permissions';
import { PII_CLASSIFICATION } from '@/lib/compliance/pii-classification';
import { omanDate, omanDateTime } from '@/lib/tz';
import {
  BRANCH_VALUE_FIELDS,
  CUSTOMER_VALUE_FIELDS,
  MALFORMED_SOURCE_LABEL,
  NAME_ONLY_LABELS,
  PAGE_SIZE,
  READ_CAP,
  assembleCustomerHistory,
  buildLookups,
  changeEntries,
  changeText,
  collectLookupIds,
  creationEntry,
  describeActor,
  describeSource,
  fieldChange,
  holderText,
  isInferred,
  paginate,
  parseSource,
  routePeriods,
  shopCreationEntry,
  termsPeriods,
  type BranchHistoryRow,
  type CustomerHistoryRow,
  type DocumentHistoryRow,
  type HistoryLookups,
  type HistoryMeta,
  type RawCustomerHistory,
  type RouteIntervalRow,
} from '@/lib/customer-history';

const X = 'cust-x';
const Y = 'cust-y';

let seq = 0n;
let txSeq = 1000n;

type MetaIn = Partial<Omit<HistoryMeta, 'validFrom' | 'recordedAt'>> & {
  validFrom: string | Date;
  recordedAt?: string | Date;
};

function meta(o: MetaIn): HistoryMeta {
  const validFrom = new Date(o.validFrom);
  const source = o.source ?? 'sql';
  return {
    id: o.id ?? ++seq,
    changeKind: o.changeKind ?? 'UPDATE',
    changedFields: o.changedFields ?? [],
    validFrom,
    recordedAt: o.recordedAt ? new Date(o.recordedAt) : validFrom,
    effectiveRequested: o.effectiveRequested ?? null,
    actorId: o.actorId ?? null,
    source,
    sourceKind: o.sourceKind ?? source.split(':')[0],
    txId: o.txId ?? ++txSeq,
  };
}

function crow(o: MetaIn & Partial<Omit<CustomerHistoryRow, keyof HistoryMeta>>): CustomerHistoryRow {
  return {
    nmwcCode: 'NMWC-2026-000001',
    paymentTerms: 'CASH',
    creditLimit: null,
    paymentTermDays: null,
    temixCode: null,
    status: 'ACTIVE',
    channelId: null,
    subChannelId: null,
    crPhotoId: null,
    deletedAt: null,
    mergedIntoId: null,
    ...o,
    ...meta(o),
  };
}

function brow(o: MetaIn & Partial<Omit<BranchHistoryRow, keyof HistoryMeta>>): BranchHistoryRow {
  return {
    branchId: 'b1',
    branchCode: 'NMWC-2026-000001-01',
    customerId: X,
    routeId: 'r1',
    regionId: 'g1',
    dayOfVisit: 'SUN',
    status: 'ACTIVE',
    deletedAt: null,
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    equipmentConfirmed: false,
    shopPhotoId: null,
    signboardPhotoId: null,
    ...o,
    ...meta(o),
  };
}

function drow(o: MetaIn & Partial<Omit<DocumentHistoryRow, keyof HistoryMeta>>): DocumentHistoryRow {
  return { attachmentId: 'a1', kind: 'ID_CARD', deletedAt: null, ...o, ...meta(o) };
}

type IntervalIn = Omit<Partial<RouteIntervalRow>, 'valid_from' | 'valid_to'> & { valid_from: string; valid_to?: string | null };

function interval({ valid_from, valid_to, ...o }: IntervalIn): RouteIntervalRow {
  return {
    branch_id: 'b1',
    branch_code: 'NMWC-2026-000001-01',
    route_id: 'r1',
    route_code: 'MCT-01',
    salesman_id: 's1',
    salesman_username: 'mct01',
    from_inferred: false,
    merged_into_id: null,
    note: null,
    ...o,
    valid_from: new Date(valid_from),
    valid_to: valid_to ? new Date(valid_to) : null,
  };
}

const L: HistoryLookups = buildLookups({
  users: [
    { id: 's1', fullName: 'Salim Al Balushi', role: Role.SALESMAN },
    { id: 's2', fullName: 'Hamed Al Rawahi', role: Role.SALESMAN },
    { id: 'stw', fullName: 'Aisha Al Hinai', role: Role.STEWARD },
    { id: 'acc', fullName: 'Khalid Al Harthy', role: Role.ACCOUNTANT },
    { id: 'm1', fullName: 'Nasser Al Farsi', role: Role.MANAGER },
  ],
  userHistory: [
    { userId: 'm1', validFrom: new Date('2026-01-01T00:00:00Z'), role: Role.SUPERVISOR, username: 'nasser' },
    { userId: 'm1', validFrom: new Date('2026-09-01T00:00:00Z'), role: Role.MANAGER, username: 'nasser' },
    { userId: 'gone', validFrom: new Date('2026-01-01T00:00:00Z'), role: Role.SALESMAN, username: 'mct09' },
  ],
  routes: [
    { id: 'r1', code: 'MCT-01', name: 'Muscat 01' },
    { id: 'r2', code: 'MCT-02', name: 'Muscat 02' },
  ],
  regions: [{ id: 'g1', code: 'MCT', name: 'Muscat' }],
  channels: [{ id: 'ch1', label: 'General Trade' }],
  subChannels: [{ id: 'sc1', label: 'Grocery' }],
  customers: [
    { id: X, nmwcCode: 'NMWC-2026-000001' },
    { id: Y, nmwcCode: 'NMWC-2026-000002' },
  ],
  batches: [{ id: 'bat1', filename: 'master-oct.xlsx', kind: 'CUSTOMER' }],
  edits: [
    { id: 'e-create', process: 'CREATE', target: 'CUSTOMER', isReactivation: false, state: 'APPROVED', submittedById: 's1', reviewedById: 'acc', customerId: X, submittedBy: { fullName: 'Salim Al Balushi' } },
    { id: 'e-upd', process: 'UPDATE', target: 'CUSTOMER', isReactivation: false, state: 'APPROVED', submittedById: 's1', reviewedById: 'm1', customerId: X, submittedBy: { fullName: 'Salim Al Balushi' } },
    { id: 'e-close', process: 'UPDATE', target: 'BRANCH', isReactivation: false, state: 'APPROVED', submittedById: 's1', reviewedById: 'm1', customerId: X, submittedBy: { fullName: 'Salim Al Balushi' } },
    { id: 'e-react', process: 'UPDATE', target: 'BRANCH', isReactivation: true, state: 'SUBMITTED', submittedById: 's1', reviewedById: null, customerId: X, submittedBy: { fullName: 'Salim Al Balushi' } },
    { id: 'e-direct', process: 'UPDATE', target: 'CUSTOMER', isReactivation: false, state: 'APPROVED', submittedById: 'stw', reviewedById: 'stw', customerId: X, submittedBy: { fullName: 'Aisha Al Hinai' } },
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routes that served the customer', () => {
  it('groups the stretches per shop, shops in the order they first served it, stretches oldest first', () => {
    const { shops } = routePeriods(
      [
        interval({ branch_id: 'b2', branch_code: 'C-02', valid_from: '2026-05-01T00:00:00Z', route_id: 'r2', route_code: 'MCT-02' }),
        interval({ branch_id: 'b1', branch_code: 'C-01', valid_from: '2026-03-01T00:00:00Z', valid_to: '2026-04-01T00:00:00Z' }),
        interval({ branch_id: 'b2', branch_code: 'C-02', valid_from: '2026-02-01T00:00:00Z', valid_to: '2026-05-01T00:00:00Z' }),
        interval({ branch_id: 'b1', branch_code: 'C-01', valid_from: '2026-04-01T00:00:00Z', route_id: 'r2', route_code: 'MCT-02' }),
      ],
      L
    );
    expect(shops.map((s) => s.branchCode)).toEqual(['C-02', 'C-01']);
    expect(shops[0].periods.map((p) => p.routeCode)).toEqual(['MCT-01', 'MCT-02']);
    expect(shops[1].periods.map((p) => [p.routeCode, p.routeName])).toEqual([
      ['MCT-01', 'Muscat 01'],
      ['MCT-02', 'Muscat 02'],
    ]);
  });

  it('a move effective at Oman midnight on 16/10 reads "… – 15/10" then "16/10 – now"', () => {
    const { shops } = routePeriods(
      [
        interval({ valid_from: '2026-09-01T00:00:00Z', valid_to: '2026-10-15T20:00:00Z' }),
        interval({ valid_from: '2026-10-15T20:00:00Z', route_id: 'r2', route_code: 'MCT-02', salesman_id: 's2', salesman_username: 'mct02' }),
      ],
      L
    );
    const [a, b] = shops[0].periods;
    expect(omanDate(a.until!)).toBe('15/10/2026');
    expect(a.until!.toISOString()).toBe('2026-10-15T19:59:59.999Z');
    expect(omanDate(b.from)).toBe('16/10/2026');
    expect(b.until, 'an open end reads "now"').toBeNull();
  });

  it('marks a stretch that rests on the first page as inferred', () => {
    const { shops } = routePeriods([interval({ valid_from: '2026-01-01T00:00:00Z', from_inferred: true })], L);
    expect(shops[0].periods[0].inferred).toBe(true);
  });

  it('says where the customer was not on record: merged, and no shop before history start', () => {
    const { shops, notes } = routePeriods(
      [
        interval({ branch_id: null, branch_code: null, route_id: null, route_code: null, salesman_id: null, salesman_username: null, valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-03-01T00:00:00Z', from_inferred: true, note: 'no-shop-recorded' }),
        interval({ branch_id: null, branch_code: null, route_id: null, route_code: null, salesman_id: null, salesman_username: null, valid_from: '2026-10-01T00:00:00Z', merged_into_id: Y, note: 'merged' }),
      ],
      L
    );
    expect(shops).toEqual([]);
    expect(notes).toEqual([
      { kind: 'no-shop-recorded', from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-03-01T00:00:00Z'), inferred: true },
      { kind: 'merged', from: new Date('2026-10-01T00:00:00Z'), until: null, mergedIntoId: Y, mergedIntoCode: 'NMWC-2026-000002', inferred: false },
    ]);
  });

  it("in one shop's view, only that shop's stretches, and no customer notes", () => {
    const { shops, notes } = routePeriods(
      [
        interval({ branch_id: 'b1', valid_from: '2026-03-01T00:00:00Z' }),
        interval({ branch_id: 'b2', branch_code: 'C-02', valid_from: '2026-03-01T00:00:00Z' }),
        interval({ branch_id: null, branch_code: null, route_id: null, route_code: null, salesman_id: null, salesman_username: null, valid_from: '2026-10-01T00:00:00Z', merged_into_id: Y, note: 'merged' }),
      ],
      L,
      'b2'
    );
    expect(shops.map((s) => s.branchId)).toEqual(['b2']);
    expect(notes).toEqual([]);
  });
});

describe('the salesman of each stretch', () => {
  const holderOf = (o: Omit<IntervalIn, 'valid_from'>) =>
    routePeriods([interval({ valid_from: '2026-03-01T00:00:00Z', ...o })], L).shops[0].periods[0].holder;

  it('his name today, and the username he signed in with then', () => {
    expect(holderOf({ salesman_id: 's1', salesman_username: 'mct01-old' })).toEqual({
      kind: 'person',
      name: 'Salim Al Balushi',
      usernameThen: 'mct01-old',
      accountGone: false,
    });
  });

  it('nobody, when the route had no holder', () => {
    const h = holderOf({ salesman_id: null, salesman_username: null });
    expect(h).toEqual({ kind: 'nobody' });
    expect(holderText(h)).toBe('Nobody held the route');
  });

  it('not recorded, for the part before the route’s first holder row', () => {
    const h = holderOf({ salesman_id: null, salesman_username: null, note: 'holder-unrecorded' });
    expect(h).toEqual({ kind: 'unrecorded' });
    expect(holderText(h)).toBe('Salesman not recorded');
  });

  it('an account no longer on record, by the username it had', () => {
    expect(holderOf({ salesman_id: 'gone', salesman_username: 'mct09' })).toEqual({
      kind: 'person',
      name: 'Account mct09',
      usernameThen: 'mct09',
      accountGone: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('terms over time', () => {
  it('one period per stretch the terms held: a name or phone change does not split one; zero-length rows are skipped', () => {
    const rows = [
      crow({ changeKind: 'CREATE', validFrom: '2026-03-01T06:00:00Z', source: 'edit:e-create', actorId: 'acc', channelId: 'ch1', subChannelId: 'sc1' }),
      crow({ changedFields: ['primaryPhone'], validFrom: '2026-04-01T06:00:00Z', channelId: 'ch1', subChannelId: 'sc1' }),
      // Superseded at the same instant: no period of its own.
      crow({ changedFields: ['paymentTerms'], paymentTerms: 'CREDIT', validFrom: '2026-05-01T06:00:00Z', channelId: 'ch1', subChannelId: 'sc1' }),
      crow({
        changedFields: ['creditLimit', 'paymentTermDays'],
        paymentTerms: 'CREDIT',
        creditLimit: new Prisma.Decimal('500'),
        paymentTermDays: 30,
        temixCode: 'CAA0367',
        validFrom: '2026-05-01T06:00:00Z',
        source: 'edit:e-upd',
        actorId: 'm1',
        channelId: 'ch1',
        subChannelId: 'sc1',
      }),
    ];
    const periods = termsPeriods(rows, X, L);
    expect(periods).toHaveLength(2);
    const [cash, credit] = periods;
    expect(cash).toMatchObject({ cashCredit: 'Cash', limit: '—', days: '—', temixCode: '—', status: 'Active', channel: 'General Trade / Grocery', record: 'Live', inferred: false });
    expect(cash.from).toEqual(new Date('2026-03-01T06:00:00Z'));
    expect(cash.until).toEqual(new Date(new Date('2026-05-01T06:00:00Z').getTime() - 1));
    expect(cash.setBy.who).toBe('Khalid Al Harthy (Accountant)');
    expect(cash.setBy.cause.label).toBe('New-customer request sent by Salim Al Balushi');
    expect(credit).toMatchObject({ cashCredit: 'Credit', limit: 'OMR 500.000', days: '30 days', temixCode: 'CAA0367', until: null });
    // The Manager was a Supervisor until September: his role then, not now.
    expect(credit.setBy.who).toBe('Nasser Al Farsi (Supervisor)');
  });

  it('an inferred first period, and the archived and merged record states', () => {
    const periods = termsPeriods(
      [
        crow({ changeKind: 'BASELINE', validFrom: '2025-06-01T00:00:00Z', recordedAt: '2026-10-13T10:00:00Z', source: 'migration:20261013100100_history_foundation' }),
        crow({ changedFields: ['deletedAt'], deletedAt: new Date('2026-10-20T00:00:00Z'), validFrom: '2026-10-20T00:00:00Z', source: `archive:${X}`, actorId: 'stw' }),
        crow({ changedFields: ['mergedIntoId'], deletedAt: new Date('2026-10-20T00:00:00Z'), mergedIntoId: Y, validFrom: '2026-10-21T00:00:00Z', source: `merge:${Y}:${X}`, actorId: 'stw' }),
      ],
      X,
      L
    );
    expect(periods.map((p) => [p.record, p.inferred])).toEqual([
      ['Live', true],
      ['Archived', false],
      ['Merged into NMWC-2026-000002', false],
    ]);
    expect(periods[0].setBy).toEqual({ who: 'System (history start)', cause: { label: 'History start', href: null, raw: false } });
    expect(periods[2].mergedIntoId).toBe(Y);
  });

  it('formats a credit limit as OMR with three decimals, from a number too', () => {
    const [p] = termsPeriods([crow({ changeKind: 'CREATE', paymentTerms: 'CREDIT', creditLimit: 1250.5, paymentTermDays: 1, validFrom: '2026-03-01T00:00:00Z' })], X, L);
    expect([p.limit, p.days]).toEqual(['OMR 1250.500', '1 day']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('every change', () => {
  it('diffs a row against the previous row of the same record, with labels for codes and channels', () => {
    const entries = changeEntries(
      {
        customerId: X,
        customerRows: [
          crow({ changeKind: 'CREATE', validFrom: '2026-03-01T00:00:00Z' }),
          crow({
            changedFields: ['paymentTerms', 'creditLimit', 'channelId', 'status'],
            paymentTerms: 'CREDIT',
            creditLimit: '500',
            channelId: 'ch1',
            status: 'SUSPENDED',
            validFrom: '2026-04-01T00:00:00Z',
            source: 'edit:e-upd',
            actorId: 'm1',
          }),
        ],
        branchRows: [],
        docRows: [],
      },
      L
    );
    expect(entries[0].records[0].changes.map(changeText)).toEqual([
      'Payment terms: Cash → Credit',
      'Credit limit: — → OMR 500.000',
      'Channel: — → General Trade',
      'Status: Active → Suspended',
    ]);
    expect(entries[0].cause).toEqual({ label: 'Update request sent by Salim Al Balushi', href: '/audit?entityType=CustomerEdit&q=e-upd', raw: false });
  });

  it('one entry per transaction and cause: the customer first, then its shops by code', () => {
    const at = '2026-10-16T08:00:00Z';
    const entries = changeEntries(
      {
        customerId: X,
        customerRows: [crow({ changedFields: ['contactPerson'], validFrom: at, txId: 7n, source: 'edit:e-direct', actorId: 'stw' })],
        branchRows: [
          brow({ branchId: 'b2', branchCode: 'C-02', changeKind: 'CREATE', validFrom: '2026-03-01T00:00:00Z' }),
          brow({ branchId: 'b2', branchCode: 'C-02', changedFields: ['dayOfVisit'], dayOfVisit: 'TUE', validFrom: at, txId: 7n, source: 'edit:e-direct', actorId: 'stw' }),
          brow({ branchId: 'b1', branchCode: 'C-01', changeKind: 'CREATE', validFrom: '2026-03-01T00:00:00Z', txId: 1n, source: 'e2e:run1' }),
          brow({ branchId: 'b1', branchCode: 'C-01', changedFields: ['coolersCount'], coolersCount: 2, validFrom: at, txId: 7n, source: 'edit:e-direct', actorId: 'stw' }),
        ],
        docRows: [],
      },
      L
    );
    const [first] = entries;
    expect(first.records.map((r) => `${r.subject} — ${r.title}`)).toEqual(['Customer — Changed', 'Shop C-01 — Changed', 'Shop C-02 — Changed']);
    expect(first.records.map((r) => r.changes.map(changeText))).toEqual([
      ['Contact person: changed'],
      ['Coolers: 0 → 2'],
      ['Day of visit: Sunday → Tuesday'],
    ]);
    expect(first.who).toBe('Aisha Al Hinai (Data Steward)');
    // A direct write's ledger row is the customer's UPDATE, not a CustomerEdit row.
    expect(first.cause).toEqual({ label: 'Direct change by Aisha Al Hinai, no approval step', href: `/audit?entityType=Customer&q=${X}`, raw: false });
    expect(first.showRecorded).toBe(false);
    expect(omanDateTime(first.effective)).toBe('16/10/2026, 12:00:00');
  });

  it('a CREATE and an UPDATE of the same record in one transaction read as "Created" with the final values', () => {
    const at = '2026-03-01T06:00:00Z';
    const entries = changeEntries(
      {
        customerId: X,
        customerRows: [
          crow({ changeKind: 'CREATE', validFrom: at, txId: 5n, source: 'edit:e-create', actorId: 'acc' }),
          crow({ changedFields: ['temixCode'], temixCode: 'CAA0999', validFrom: at, txId: 5n, source: 'edit:e-create', actorId: 'acc' }),
        ],
        branchRows: [brow({ changeKind: 'CREATE', validFrom: at, txId: 5n, source: 'edit:e-create', actorId: 'acc' })],
        docRows: [drow({ changeKind: 'UPDATE', changedFields: ['customerId'], validFrom: at, txId: 5n, source: 'edit:e-create', actorId: 'acc' })],
      },
      L
    );
    expect(entries).toHaveLength(1);
    const [c, s, d] = entries[0].records;
    expect([c.kind, c.title]).toEqual(['created', 'Created']);
    expect(c.changes.map(changeText)).toEqual(['Payment terms: Cash', 'Temix code: CAA0999', 'Status: Active']);
    expect(s.changes.map(changeText)).toEqual([
      'Route: MCT-01',
      'Region: MCT',
      'Day of visit: Sunday',
      'Status: Active',
      'Coolers: 0',
      'Stands: 0',
      'Empty bottles: 0',
    ]);
    expect(`${d.subject} — ${d.title}`).toBe("Owner's ID card — attached");
  });

  it('the first page, a hard delete, and a document removed', () => {
    const entries = changeEntries(
      {
        customerId: X,
        customerRows: [
          crow({ changeKind: 'BASELINE', validFrom: '2025-06-01T00:00:00Z', recordedAt: '2026-10-13T10:00:00Z', source: 'migration:20261013100100_history_foundation' }),
          crow({ changeKind: 'DELETE', validFrom: '2026-10-22T00:00:00Z', source: 'script:purge:run7' }),
        ],
        branchRows: [],
        docRows: [
          drow({ changeKind: 'BASELINE', validFrom: '2025-06-01T00:00:00Z', recordedAt: '2026-10-14T10:00:00Z', source: 'migration:20261014100000_lossless_paths' }),
          drow({ changedFields: ['deletedAt'], deletedAt: new Date('2026-10-20T00:00:00Z'), validFrom: '2026-10-20T00:00:00Z', source: 'photo:a1', actorId: 'stw' }),
        ],
      },
      L
    );
    expect(entries.map((e) => e.records.map((r) => `${r.subject} — ${r.title}`))).toEqual([
      ['Customer — Deleted from the database'],
      ["Owner's ID card — removed"],
      ['Customer — On record at history start'],
    ]);
    expect(entries[0].who).toBe('Operator script');
    expect(entries[1].cause.href).toBe('/audit?entityType=Attachment&q=a1');
    const baseline = entries[2];
    expect(baseline.inferred).toBe(true);
    expect(baseline.showRecorded).toBe(true);
  });

  it('a shop moving in and out; its rows from while it was another customer’s are not shown', () => {
    const branchRows = [
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changeKind: 'CREATE', validFrom: '2026-02-01T00:00:00Z' }),
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changedFields: ['coolersCount'], coolersCount: 3, validFrom: '2026-02-15T00:00:00Z' }),
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: X, changedFields: ['customerId'], coolersCount: 3, validFrom: '2026-03-01T00:00:00Z', source: `merge:${X}:${Y}`, actorId: 'stw' }),
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: X, changedFields: ['standsCount'], coolersCount: 3, standsCount: 1, validFrom: '2026-04-01T00:00:00Z' }),
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changedFields: ['customerId', 'routeId'], routeId: 'r2', coolersCount: 3, standsCount: 1, validFrom: '2026-05-01T00:00:00Z' }),
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changedFields: ['dayOfVisit'], dayOfVisit: 'MON', routeId: 'r2', validFrom: '2026-06-01T00:00:00Z' }),
    ];
    const entries = changeEntries({ customerId: X, customerRows: [], branchRows, docRows: [] }, L);
    expect(entries.map((e) => [omanDate(e.effective), e.records[0].title, e.records[0].changes.map(changeText)])).toEqual([
      ['01/05/2026', 'Moved to another customer', ['Customer: NMWC-2026-000001 → NMWC-2026-000002']],
      ['01/04/2026', 'Changed', ['Stands: 0 → 1']],
      ['01/03/2026', 'Moved to this customer', ['Customer: NMWC-2026-000002 → NMWC-2026-000001']],
    ]);
    expect(entries[2].cause).toMatchObject({ label: 'Duplicate merge (NMWC-2026-000002 folded into NMWC-2026-000001)', href: `/audit?action=MERGE&q=${X}` });
  });

  it('orders by effective time, then by when recorded, then by id, newest first', () => {
    const entries = changeEntries(
      {
        customerId: X,
        customerRows: [
          crow({ changeKind: 'CREATE', validFrom: '2026-03-01T00:00:00Z', id: 1n }),
          crow({ changedFields: ['status'], status: 'CLOSED', validFrom: '2026-03-05T00:00:00Z', recordedAt: '2026-03-05T00:00:10Z', id: 3n }),
          crow({ changedFields: ['status'], status: 'ACTIVE', validFrom: '2026-03-05T00:00:00Z', recordedAt: '2026-03-05T00:00:20Z', id: 4n }),
        ],
        branchRows: [],
        docRows: [],
      },
      L
    );
    expect(entries.map((e) => e.records[0].changes.map(changeText).join())).toEqual([
      'Status: Closed → Active',
      'Status: Active → Closed',
      'Payment terms: Cash,Status: Active',
    ]);
  });

  it('says when it was recorded only when it matters: an effective date asked for, or a minute or more apart', () => {
    const shown = (o: Partial<MetaIn>) =>
      changeEntries(
        { customerId: X, customerRows: [crow({ changedFields: ['status'], status: 'CLOSED', validFrom: '2026-03-05T00:00:00Z', ...o })], branchRows: [], docRows: [] },
        L
      )[0].showRecorded;
    expect(shown({}), 'the same instant').toBe(false);
    expect(shown({ effectiveRequested: new Date('2026-03-05T00:00:00Z') }), 'an effective date was asked for').toBe(true);
    expect(shown({ recordedAt: '2026-03-05T00:00:59Z' }), '59 s apart').toBe(false);
    expect(shown({ recordedAt: '2026-03-05T00:01:01Z' }), '61 s apart').toBe(true);
  });

  it('pages of 25, the page clamped to the first and the last', () => {
    const list = Array.from({ length: 60 }, (_, i) => i);
    expect(paginate(list, 1)).toMatchObject({ page: 1, pages: 3, total: 60, items: list.slice(0, PAGE_SIZE) });
    expect(paginate(list, 3).items).toEqual(list.slice(50));
    expect(paginate(list, 99).page).toBe(3);
    expect(paginate(list, 0).page).toBe(1);
    expect(paginate(list, Number.NaN).page).toBe(1);
    expect(paginate([], 4)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a personal value never reaches the page', () => {
  const row = crow({ validFrom: '2026-03-01T00:00:00Z' });

  it.each([
    ...Object.entries(NAME_ONLY_LABELS.customer).map(([f, label]) => ['customer', f, label] as const),
    ...Object.entries(NAME_ONLY_LABELS.shop).map(([f, label]) => ['shop', f, label] as const),
    ['customer', 'aFieldAddedLater', 'aFieldAddedLater'] as const,
    ['shop', 'hasGps', 'hasGps'] as const,
  ])('%s.%s reads "<label>: changed", with no value', (table, field, label) => {
    // Even if a row somehow carried a value under that name, it is not read.
    const loaded = { ...row, [field]: '+96899991234' };
    const c = fieldChange(table, field, loaded, { ...row, [field]: '+96891111111' }, L);
    expect(c).toEqual({ kind: 'changed', label });
    expect(Object.keys(c).sort()).toEqual(['kind', 'label']);
    expect(changeText(c)).toBe(`${label}: changed`);
  });

  it('GPS is one name, "GPS point", never a coordinate', () => {
    expect(changeText(fieldChange('shop', 'gps', brow({ validFrom: '2026-03-01T00:00:00Z' }), null, L))).toBe('GPS point: changed');
  });

  it('the value fields are the history columns the PII register classifies, and the name-only ones are not columns at all', () => {
    for (const f of CUSTOMER_VALUE_FIELDS) expect(PII_CLASSIFICATION, f).toHaveProperty([`CustomerHistory.${f}`]);
    for (const f of BRANCH_VALUE_FIELDS) expect(PII_CLASSIFICATION, f).toHaveProperty([`BranchHistory.${f}`]);
    for (const f of Object.keys(NAME_ONLY_LABELS.customer)) expect(PII_CLASSIFICATION).not.toHaveProperty([`CustomerHistory.${f}`]);
    for (const f of Object.keys(NAME_ONLY_LABELS.shop)) expect(PII_CLASSIFICATION).not.toHaveProperty([`BranchHistory.${f}`]);
  });

  it('a photo slot says added, replaced or removed, never the photo id', () => {
    const b = (shopPhotoId: string | null) => brow({ validFrom: '2026-03-01T00:00:00Z', shopPhotoId });
    expect(changeText(fieldChange('shop', 'shopPhotoId', b('p1'), b(null), L))).toBe('Shop photo: added');
    expect(changeText(fieldChange('shop', 'shopPhotoId', b('p2'), b('p1'), L))).toBe('Shop photo: replaced');
    expect(changeText(fieldChange('shop', 'shopPhotoId', b(null), b('p2'), L))).toBe('Shop photo: removed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what caused it', () => {
  it.each([
    ['edit:e-create', 'New-customer request sent by Salim Al Balushi', '/audit?entityType=CustomerEdit&q=e-create'],
    ['edit:e-upd', 'Update request sent by Salim Al Balushi', '/audit?entityType=CustomerEdit&q=e-upd'],
    ['edit:e-close', 'Close-shop request sent by Salim Al Balushi', '/audit?entityType=CustomerEdit&q=e-close'],
    ['edit:e-react', 'Reactivation request sent by Salim Al Balushi', '/audit?entityType=CustomerEdit&q=e-react'],
    ['edit:e-direct', 'Direct change by Aisha Al Hinai, no approval step', `/audit?entityType=Customer&q=${X}`],
    ['edit:e-unknown', 'Request e-unknown', null],
    ['import:bat1:12:full', 'Import master-oct.xlsx, row 12', '/import/bat1'],
    ['import:bat1:12:refresh', 'Import master-oct.xlsx, row 12 (Temix code on record)', '/import/bat1'],
    ['import:bat1:12:backup', 'Import master-oct.xlsx, row 12 (first Temix code)', '/import/bat1'],
    ['import:bat1:12:fixed', 'Import master-oct.xlsx, row 12 (corrected in the app)', '/import/bat1'],
    ['import:bat1:Users!14', 'Import master-oct.xlsx, Users sheet row 14', '/import/bat1'],
    ['import:bat1:setup', 'Import master-oct.xlsx (set-up)', '/import/bat1'],
    ['import:bat9:3', 'Import bat9, row 3', '/import/bat9'],
    ['import-fix:bat1:row77', 'Correction of a held-back row of import master-oct.xlsx', '/import/bat1'],
    [`merge:${X}:${Y}`, 'Duplicate merge (NMWC-2026-000002 folded into NMWC-2026-000001)', `/audit?action=MERGE&q=${X}`],
    [`archive:${X}`, 'Archived from the customer page', `/audit?entityType=Customer&q=${X}`],
    ['photo:a1', 'Photo or document attached, replaced or removed', '/audit?entityType=Attachment&q=a1'],
    ['photo:upload', 'Photo upload', null],
    ['users:role:u1', 'Account administration (role)', '/audit?entityType=User&q=u1'],
    ['users:create:mct01', 'Account administration (create)', null],
    ['routes:toggle-route:r1', 'Route administration (toggle-route)', '/routes'],
    ['temix:loaded:tb1', 'Temix upload queue (loaded)', '/temix'],
    ['temix-daily:f20261020:44', 'Daily Temix file f20261020, row 44', null],
    ['cron:photo-gc', 'Scheduled job photo-gc', null],
    ['script:reassign-route:run9', 'Operator script reassign-route (run run9)', null],
    ['migration:20261013100100_history_foundation', 'History start', null],
    ['e2e:run1', 'Test or seed data (e2e:run1)', null],
    ['seed:pilot', 'Test or seed data (seed:pilot)', null],
    ['test:history-asof', 'Test or seed data (test:history-asof)', null],
    ['verify:app-role', 'Test or seed data (verify:app-role)', null],
    ['sql', 'No recorded cause (changed directly in the database)', null],
  ])('%s', (source, label, href) => {
    expect(describeSource(source, L)).toEqual({ label, href, raw: false });
  });

  it('a direct write made before a merge links to the customer it was written on', () => {
    const merged = buildLookups({
      edits: [
        { id: 'e-old', process: 'UPDATE', target: 'CUSTOMER', isReactivation: false, state: 'APPROVED', submittedById: 'stw', reviewedById: 'stw', customerId: Y, originalCustomerId: X, submittedBy: { fullName: 'Aisha Al Hinai' } },
      ],
    });
    expect(describeSource('edit:e-old', merged).href).toBe(`/audit?entityType=Customer&q=${X}`);
  });

  it('a photo change links to the audit rows of the record it went on', () => {
    expect(describeSource('photo:a1', L, { entityType: 'Branch', entityId: 'b1' }).href).toBe('/audit?entityType=Branch&q=b1');
  });

  it('a SOURCE_RE-valid kind this code does not know is shown as it is, in monospace, with no link', () => {
    expect(describeSource('print:abc', L)).toEqual({ label: 'print:abc', href: null, raw: true });
    expect(parseSource('edit:a:b')).toEqual({ kind: 'unknown', source: 'edit:a:b' });
    expect(describeSource('edit:a:b', L)).toEqual({ label: 'edit:a:b', href: null, raw: true });
  });

  it('a source that fails SOURCE_RE (typed in psql, say) is never printed: a neutral label, no link', () => {
    // nmwc_change_ctx keeps any nmwc.source text up to 200 characters; the app checks SOURCE_RE, the database does not.
    const typed = [
      'not a source',
      'fixed for Ahmed Al Balushi +968 9123 4567',
      'call 91234567',
      'Edit:abc',
      'edit:',
      'x',
      '',
      `edit:${'a'.repeat(81)}`,
      'edit:a b',
      "note:o'brien",
    ];
    for (const s of typed) {
      expect(parseSource(s), s).toEqual({ kind: 'malformed' });
      const view = describeSource(s, L, { entityType: 'Customer', entityId: X });
      expect(view, s).toEqual({ label: MALFORMED_SOURCE_LABEL, href: null, raw: false });
      if (s.length > 1) expect(view.label, s).not.toContain(s);
    }
    // The neutral label names no part of what was stored.
    expect(MALFORMED_SOURCE_LABEL).not.toMatch(/\d/);
    // 'sql', the database's own fallback, is still its own cause.
    expect(parseSource('sql')).toEqual({ kind: 'sql' });
  });

  it('every link is to a page the Data Steward can open', () => {
    const sources = [
      'edit:e-create', 'edit:e-direct', 'import:bat1:1:full', 'import-fix:bat1:r', `merge:${X}:${Y}`, `archive:${X}`,
      'photo:a1', 'users:role:u1', 'routes:create-route:MCT-09', 'temix:generate:new',
    ];
    for (const s of sources) {
      const href = describeSource(s, L).href;
      expect(href, s).not.toBeNull();
      expect(href!, s).toMatch(/^(\/audit\?|\/import\/|\/routes$|\/temix$|\/customers\/)/);
    }
  });
});

describe('who', () => {
  it('his role at the time of the change, not today’s', () => {
    expect(describeActor('m1', new Date('2026-05-01T00:00:00Z'), 'edit', L)).toBe('Nasser Al Farsi (Supervisor)');
    expect(describeActor('m1', new Date('2026-10-01T00:00:00Z'), 'edit', L)).toBe('Nasser Al Farsi (Manager)');
    // Before his first account row: his first role.
    expect(describeActor('m1', new Date('2025-01-01T00:00:00Z'), 'edit', L)).toBe('Nasser Al Farsi (Supervisor)');
    // No account history read: today's role.
    expect(describeActor('stw', new Date('2026-05-01T00:00:00Z'), 'edit', L)).toBe('Aisha Al Hinai (Data Steward)');
  });

  it('an account no longer on record, and the job or script when nobody signed in', () => {
    expect(describeActor('gone', new Date('2026-05-01T00:00:00Z'), 'edit', L)).toBe('Account mct09');
    expect(describeActor('nobody-known', new Date('2026-05-01T00:00:00Z'), 'edit', L)).toBe('An account no longer on record');
    expect(describeActor(null, new Date(), 'cron', L)).toBe('Scheduled job');
    expect(describeActor(null, new Date(), 'script', L)).toBe('Operator script');
    expect(describeActor(null, new Date(), 'migration', L)).toBe('System (history start)');
    expect(describeActor(null, new Date(), 'temix-daily', L)).toBe('Daily Temix file');
    expect(describeActor(null, new Date(), 'e2e', L)).toBe('Test harness');
    expect(describeActor(null, new Date(), 'sql', L)).toBe('Nobody recorded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('how it was created', () => {
  const live = { id: X, importBatchId: null, createdById: null };

  it('by a new-customer request: who sent it and who approved it', () => {
    const c = creationEntry(crow({ changeKind: 'CREATE', validFrom: '2026-03-01T06:00:00Z', source: 'edit:e-create', actorId: 'acc' }), L, live);
    expect(c.kind).toBe('created');
    expect(c.text).toBe('Created 01/03/2026, 10:00:00 by new-customer request sent by Salim Al Balushi, approved by Khalid Al Harthy (Accountant).');
    expect(c.cause?.href).toBe('/audit?entityType=CustomerEdit&q=e-create');
  });

  it('by an import row, promoted by the Steward', () => {
    const c = creationEntry(crow({ changeKind: 'CREATE', validFrom: '2026-03-01T06:00:00Z', source: 'import:bat1:12:full', actorId: 'stw' }), L, live);
    expect(c.text).toBe('Created 01/03/2026, 10:00:00 by import master-oct.xlsx, row 12, promoted by Aisha Al Hinai (Data Steward).');
  });

  it('by a test harness', () => {
    const c = creationEntry(crow({ changeKind: 'CREATE', validFrom: '2026-03-01T06:00:00Z', source: 'e2e:run1' }), L, live);
    expect(c.text).toBe('Created 01/03/2026, 10:00:00 by test or seed data (e2e:run1).');
  });

  it('found when history began: on record from then, with the lineage the live row carries', () => {
    const c = creationEntry(
      crow({ changeKind: 'BASELINE', validFrom: '2025-06-01T00:00:00Z', recordedAt: '2026-10-13T10:00:00Z', source: 'migration:20261013100100_history_foundation' }),
      L,
      { id: X, importBatchId: 'bat1', createdById: 'stw' }
    );
    expect(c.kind).toBe('baseline');
    expect(c.text).toBe(
      'On record at history start (13/10/2026). In the CRM since 01/06/2025; how it was created was not recorded before history began.'
    );
    expect(c.lineage).toBe('Lineage on file: import master-oct.xlsx / created by Aisha Al Hinai');
    expect(c.inferred).toBe(true);
    expect(isInferred(crow({ changeKind: 'BASELINE', validFrom: '2026-10-13T10:00:00Z', recordedAt: '2026-10-13T10:00:00Z' }))).toBe(false);
  });

  it('a shop: its first row on this customer, or its move in', () => {
    const rows = [
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changeKind: 'CREATE', validFrom: '2026-02-01T00:00:00Z' }),
      brow({ branchId: 'b9', branchCode: 'Y-01', customerId: X, changedFields: ['customerId'], validFrom: '2026-03-01T06:00:00Z', source: `merge:${X}:${Y}`, actorId: 'stw' }),
    ];
    expect(shopCreationEntry(rows, X, 'b9', L).text).toBe(
      'Shop Y-01 moved to this customer from NMWC-2026-000002 01/03/2026, 10:00:00 by duplicate merge (NMWC-2026-000002 folded into NMWC-2026-000001).'
    );
    expect(shopCreationEntry([brow({ changeKind: 'CREATE', branchCode: 'C-01', validFrom: '2026-03-01T06:00:00Z', source: 'e2e:run1' })], X, 'b1', L).text).toBe(
      'Shop C-01 created 01/03/2026, 10:00:00 by test or seed data (e2e:run1).'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the page, assembled', () => {
  const raw = (over: Partial<RawCustomerHistory> = {}): RawCustomerHistory => {
    const customerRows = [
      crow({ changedFields: ['contactPerson'], validFrom: '2026-10-16T08:00:00Z', source: 'edit:e-direct', actorId: 'stw' }),
      crow({ changeKind: 'CREATE', validFrom: '2026-03-01T06:00:00Z', source: 'e2e:run1' }),
    ];
    return {
      customer: { id: X, nmwcCode: 'NMWC-2026-000001', legalName: 'Al Noor Trading', deletedAt: null, mergedIntoId: null, importBatchId: null, createdById: null },
      customerRows,
      birth: customerRows[1],
      intervals: [interval({ valid_from: '2026-03-01T06:00:00Z' })],
      shopIds: ['b1', 'b9'],
      branchRows: [
        brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changeKind: 'CREATE', validFrom: '2026-02-01T00:00:00Z' }),
        brow({ changeKind: 'CREATE', validFrom: '2026-03-01T06:00:00Z', source: 'e2e:run1' }),
        brow({ branchId: 'b9', branchCode: 'Y-01', customerId: X, changedFields: ['customerId'], validFrom: '2026-04-01T00:00:00Z', source: `merge:${X}:${Y}` }),
        brow({ branchId: 'b9', branchCode: 'Y-01', customerId: Y, changedFields: ['customerId'], validFrom: '2026-05-01T00:00:00Z', source: `merge:${Y}:${X}` }),
      ],
      docRows: [],
      liveShops: [
        { id: 'b1', customerId: X, branchCode: 'NMWC-2026-000001-01', branchName: 'Main shop', deletedAt: null },
        { id: 'b9', customerId: Y, branchCode: 'Y-01', branchName: 'Other shop', deletedAt: null },
      ],
      lookups: L,
      ...over,
    };
  };

  it('a shop picker of every shop ever its own, with the current name only while it still is', () => {
    const v = assembleCustomerHistory(raw(), { shopId: null, page: 1 })!;
    expect(v.shops).toEqual([
      { id: 'b1', code: 'NMWC-2026-000001-01', name: 'Main shop', current: true, standing: 'current' },
      { id: 'b9', code: 'Y-01', name: null, current: false, standing: 'moved' },
    ]);
    const archived = assembleCustomerHistory(
      raw({ liveShops: [{ id: 'b1', customerId: X, branchCode: 'NMWC-2026-000001-01', branchName: 'Main shop', deletedAt: new Date('2026-10-20T00:00:00Z') }] }),
      { shopId: null, page: 1 }
    )!;
    expect(archived.shops.map((s) => [s.id, s.standing, s.name])).toEqual([
      ['b1', 'archived', null],
      ['b9', 'gone', null],
    ]);
    expect(v.created.text).toBe('Created 01/03/2026, 10:00:00 by test or seed data (e2e:run1).');
    expect(v.terms).toHaveLength(1);
    expect(v.timeline.total).toBe(5);
    expect(v.truncated).toBe(false);
  });

  it("a shop's view: its rows only, its own first row, no terms", () => {
    const v = assembleCustomerHistory(raw(), { shopId: 'b9', page: 1 })!;
    expect(v.shop?.id).toBe('b9');
    expect(v.terms).toBeNull();
    expect(v.timeline.items.map((e) => e.records.map((r) => r.subject))).toEqual([['Shop Y-01'], ['Shop Y-01']]);
    expect(v.created.kind).toBe('moved-in');
  });

  it('a ?shop= that was never its own is not found', () => {
    expect(assembleCustomerHistory(raw(), { shopId: 'b-other', page: 1 })).toBeNull();
  });

  it('archived and merged customers carry their banner', () => {
    const archived = assembleCustomerHistory(raw({ customer: { ...raw().customer, deletedAt: new Date('2026-10-20T00:00:00Z') } }), { shopId: null, page: 1 })!;
    expect(archived.customer).toMatchObject({ live: false, archivedAt: new Date('2026-10-20T00:00:00Z'), mergedInto: null });
    const merged = assembleCustomerHistory(
      raw({ customer: { ...raw().customer, deletedAt: new Date('2026-10-20T00:00:00Z'), mergedIntoId: Y } }),
      { shopId: null, page: 1 }
    )!;
    expect(merged.customer).toMatchObject({ live: false, archivedAt: null, mergedInto: { id: Y, code: 'NMWC-2026-000002' } });
  });

  it('past the read cap it says so, and the creation entry still comes from the first row', () => {
    const many = Array.from({ length: READ_CAP + 1 }, (_, i) =>
      crow({ changedFields: ['notes'], validFrom: new Date(Date.UTC(2026, 9, 20) - i * 60_000) })
    );
    const birth = crow({ changeKind: 'CREATE', validFrom: '2026-01-01T00:00:00Z', source: 'edit:e-create', actorId: 'acc' });
    const v = assembleCustomerHistory(raw({ customerRows: many, birth, branchRows: [] }), { shopId: null, page: 999 })!;
    expect(v.truncated).toBe(true);
    expect(v.timeline.total).toBe(READ_CAP);
    expect(v.timeline.page).toBe(v.timeline.pages);
    expect(v.created.kind).toBe('created');
  });

  it("a shop's view says the list was cut only when that shop's rows were", () => {
    const many = Array.from({ length: READ_CAP + 1 }, (_, i) =>
      crow({ changedFields: ['notes'], validFrom: new Date(Date.UTC(2026, 9, 20) - i * 60_000) })
    );
    expect(assembleCustomerHistory(raw({ customerRows: many }), { shopId: 'b1', page: 1 })!.truncated).toBe(false);
    expect(assembleCustomerHistory(raw({ customerRows: many }), { shopId: null, page: 1 })!.truncated).toBe(true);
  });

  it('collects every id the rows name, for the label lookups', () => {
    const r = raw({ customer: { ...raw().customer, importBatchId: 'bat1', createdById: 'u-made', mergedIntoId: Y } });
    const ids = collectLookupIds({ ...r, customerRows: r.customerRows, birth: r.birth });
    expect(ids.editIds).toEqual(['e-direct']);
    expect(ids.batchIds).toEqual(['bat1']);
    expect(ids.actorIds).toEqual(['stw']);
    expect(ids.userIds.sort()).toEqual(['s1', 'stw', 'u-made']);
    expect(ids.customerIds.sort()).toEqual([X, Y].sort());
    expect(ids.routeIds).toEqual(['r1']);
  });
});

describe('who may open it', () => {
  it.each(Object.values(Role))('%s', (role) => {
    expect(canSeeCustomerHistory(role)).toBe(role === Role.STEWARD);
  });
});
