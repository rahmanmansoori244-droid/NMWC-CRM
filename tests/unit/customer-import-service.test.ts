// @vitest-environment node
/**
 * services/imports.ts, customer master, with the database mocked:
 *
 *  - N05: the upload stages what the sheet says in each column, under the row
 *    number Excel shows, whatever blank headings and blank lines it has — a real
 *    ExcelJS workbook through the real parser and the real row check.
 *  - N03: the promote locks the customer by its code FIRST, reads it under that
 *    lock, and refuses an archived customer before any lane is chosen — a blank
 *    temix_code, no branch_code and a row fixed in the app included — writing
 *    nothing about it.
 *  - F11: the crosswalk guard also refuses a temix_code that is the customer
 *    code of an archived customer with no Temix code whose deactivation Temix
 *    gets under that code (queued, in a batch, or sent).
 *  - F16 (owner decision 1, 2026-09-29): a row that changes the customer's
 *    channel clears a stored sub-channel of the old channel in the same write,
 *    and the lead row says so — a note the full lane's row reset used to wipe.
 *  - F21: a branch the row would not change is not written; one it changes is
 *    written with version + 1, on both branch paths (on the full lane, one
 *    left in the old region of a route since moved counts as changed); and
 *    the group transaction rescores the customer and every live branch,
 *    writing only the scores that differ (lib/rescore.ts).
 *  - Owner decision 2026-10-08, the backup match: a customer created in the app
 *    (an app-minted code, its finalize's CREATE audit row) and sent to Temix,
 *    with no Temix code yet, takes the refresh lane from a row whose cust_code is
 *    its customer code and that carries a temix_code — the code only, its
 *    acknowledgement to the salesman — and nothing else does. The temix_code is
 *    compared upper case, and a new customer created with one takes the
 *    finalize's lock.
 *
 * The same paths against Postgres, and an archive racing the promote on two
 * connections, are in tests/integration/import-archived-parent.test.ts and
 * tests/integration/import-multibranch.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  scoreBranch,
  scoreCustomer,
  type BranchForScore,
  type CustomerForScore,
} from '@/lib/completeness';

type Fn = ReturnType<typeof vi.fn>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  info: vi.fn(),
  notify: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: 'STEWARD', username: 'steward.x' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {},
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/alert', () => ({ sendAlert: async () => {} }));
vi.mock('@/lib/notifications', () => ({ notifyUsers: h.notify }));
vi.mock('@/lib/logger', () => ({
  logger: { info: h.info, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('@/lib/import-master-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import-master-lookup')>()),
  masterCollisionMaps: async () => ({ masterPhones: new Map(), masterCrs: new Map() }),
  newerUploadsCarrying: async () => new Map(),
}));
vi.mock('@/lib/db', () => ({ prisma: h.db }));

import { matchesWhere } from '../support/where-eval';
import { loadExcelJS } from '@/lib/excel';
import {
  uploadCustomerMasterAction,
  promoteCustomerBatchAction,
} from '@/services/imports';

// ── N05: upload ─────────────────────────────────────────────────────────────

describe('uploadCustomerMasterAction — N05', () => {
  let staged: Array<{ rowNumber: number; raw: Record<string, unknown>; parsed: Record<string, unknown>; state: string }>;

  beforeEach(() => {
    staged = [];
    Object.assign(h.db, {
      importBatch: {
        create: vi.fn(async () => ({ id: 'batch-1' })),
        update: vi.fn(async () => ({})),
      },
      channel: { findMany: vi.fn(async () => [{ key: 'HORECA' }]) },
      importRow: {
        createMany: vi.fn(async ({ data }: { data: typeof staged }) => {
          staged.push(...data);
          return { count: data.length };
        }),
      },
    });
  });

  it('stages each field from its own column, under the Excel row number', async () => {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    // Headings in A, C, D, E; B is a helper column with no heading.
    ws.getCell('A1').value = 'cust_code';
    ws.getCell('C1').value = 'cust_name';
    ws.getCell('D1').value = 'branch_code';
    ws.getCell('E1').value = 'address';
    ws.getCell('A2').value = 'C001';
    ws.getCell('B2').value = 'HELPER';
    ws.getCell('C2').value = 'Real Shop';
    ws.getCell('D2').value = '01';
    ws.getCell('E2').value = 'Way 12, Muscat';
    // Row 3 left blank; the next customer is on Excel row 4.
    ws.getCell('A4').value = 'C002';
    ws.getCell('B4').value = 'HELPER 2';
    ws.getCell('C4').value = 'Other Shop';
    ws.getCell('E4').value = 'Way 40, Seeb';
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const fd = new FormData();
    fd.set('file', new File([buf], 'gap.xlsx'));
    const res = await uploadCustomerMasterAction(fd);
    expect(res.ok).toBe(true);

    expect(staged.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(staged.map((r) => r.state)).toEqual(['CLEAN', 'CLEAN']);
    expect(staged[0].parsed).toMatchObject({
      custCode: 'C001',
      custName: 'Real Shop',
      branchCode: '01',
      address: 'Way 12, Muscat',
    });
    expect(staged[1].parsed).toMatchObject({
      custCode: 'C002',
      custName: 'Other Shop',
      branchCode: null,
      address: 'Way 40, Seeb',
    });
    // The stored raw row keeps the heading-keyed shape, and the helper is not in it.
    expect(staged[0].raw).toEqual({
      cust_code: 'C001',
      cust_name: 'Real Shop',
      branch_code: '01',
      address: 'Way 12, Muscat',
    });
  });

  it('refuses a workbook with the same heading twice, as a file error, staging nothing', async () => {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['cust_code', 'cust_name', 'phone', 'Phone']);
    ws.addRow(['C003', 'Twice', '+96891234567', '']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const fd = new FormData();
    fd.set('file', new File([buf], 'dup.xlsx'));
    const res = await uploadCustomerMasterAction(fd);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('the heading \\"Phone\\" is in more than one column (C and D)');
    expect((h.db.importBatch as { create: Fn }).create).not.toHaveBeenCalled();
    expect(staged).toEqual([]);
  });

  it('a heading repeated on a later sheet, which the upload never reads, does not refuse it', async () => {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['cust_code', 'cust_name', 'address']);
    ws.addRow(['C004', 'Fine Shop', 'Way 7, Ruwi']);
    wb.addWorksheet('Notes').addRow(['note', 'Note']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const fd = new FormData();
    fd.set('file', new File([buf], 'notes.xlsx'));
    const res = await uploadCustomerMasterAction(fd);
    expect(res.ok).toBe(true);
    expect(staged.map((r) => [r.rowNumber, r.parsed.custCode])).toEqual([[2, 'C004']]);
  });
});

// ── N03: promote ────────────────────────────────────────────────────────────

type Parsed = Record<string, unknown>;
const parsed = (over: Parsed = {}): Parsed => ({
  custCode: 'ARC1',
  custName: 'Name From Sheet',
  branchCode: 'ARC1-02',
  branchName: 'New shop',
  regionCode: null,
  routeCode: null,
  address: 'Way 9, Muscat',
  phone: '+96891111111',
  contactPerson: 'Someone',
  crNumber: null,
  paymentTerms: 'CASH',
  paymentTermsPresent: true,
  temixCode: null,
  creditLimit: null,
  paymentTermDays: null,
  channelKey: null,
  dayOfVisit: null,
  customerStatus: 'ACTIVE',
  ...over,
});

const STORED = {
  id: 'cust-1',
  temixCode: null as string | null,
  paymentTerms: 'CASH',
  createdById: 'someone',
  legalName: 'Stored Name',
  primaryPhoneNorm: '+96899999999',
  crNumberNorm: null,
  contactPerson: 'Stored Contact',
  channel: null as { key: string } | null,
  channelId: null as string | null,
  subChannelId: null as string | null,
  subChannel: null as { channelId: string } | null,
};

/** A branch as the promote's reads return it (the full lane's owner read, the refresh lane's). */
type StoredBranch = {
  id: string;
  customerId: string;
  deletedAt: Date | null;
  customer: { nmwcCode: string };
  branchName: string;
  routeId: string;
  regionId: string;
  address: string;
  dayOfVisit: string | null;
  status: string;
};

type SetupOptions = {
  /** Stored branches by branchCode, read back with only the keys each read selects. */
  branches?: Record<string, StoredBranch>;
  /** Routes besides UNASSIGNED (rtU, in rgU), as the promote's reference read returns them. */
  routes?: Array<{ id: string; code: string; regionId: string }>;
  /** What the rescore's read returns (lib/rescore.ts RESCORE_CUSTOMER_SELECT). */
  scored?: unknown[];
  channels?: Array<{ id: string; key: string }>;
};

let order: string[];
let lockSql: string[];
let tx: Record<string, Record<string, Fn> | Fn>;
let rejected: Array<{ where: unknown; data: { state: string; issues: Array<{ message: string }> } }>;
/** The rescore's raw UPDATEs: the table, and the (id, score) pairs it was given. */
let rescoreWrites: Array<{ table: string; sql: string; rows: Array<[unknown, unknown]> }>;
/** The keys of the Temix-code advisory locks taken (lib/temix-code.ts lockTemixCode). */
let temixLocks: unknown[];

/** Other customers in the master, as the crosswalk guard's findFirst reads them. */
type Other = {
  nmwcCode: string;
  temixCode: string | null;
  deletedAt: Date | null;
  temixSyncState: string;
  lastTemixUploadAt: Date | null;
};

function setup(
  stored:
    | (typeof STORED & { deletedAt: Date | null; temixSyncState?: string; lastTemixUploadAt?: Date | null })
    | null,
  rows: Parsed[],
  others: Other[] = [],
  opts: SetupOptions = {}
) {
  order = [];
  lockSql = [];
  rejected = [];
  rescoreWrites = [];
  temixLocks = [];
  h.info.mockClear();
  h.notify.mockClear();
  const w = (name: string, value: unknown = {}) =>
    vi.fn(async () => {
      order.push(name);
      return value;
    });
  tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      order.push('lock');
      lockSql.push(strings.join('?'));
      return stored ? [{ id: stored.id }] : [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      if (/pg_advisory_xact_lock/.test(q.sql)) {
        order.push('temix.lock');
        temixLocks.push(...q.values);
        return 1;
      }
      const table = /^UPDATE "(\w+)"/.exec(q.sql)?.[1] ?? '?';
      order.push(`rescore.${table}`);
      const rows: Array<[unknown, unknown]> = [];
      for (let i = 0; i < q.values.length; i += 2) rows.push([q.values[i], q.values[i + 1]]);
      rescoreWrites.push({ table, sql: q.sql, rows });
      return rows.length;
    }),
    customer: {
      findUnique: vi.fn(async () => {
        order.push('customer.read');
        return stored ? { ...stored, branches: [] } : null;
      }),
      findMany: vi.fn(async () => {
        order.push('customer.score-read');
        return opts.scored ?? [];
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          others.find((o) => matchesWhere(o, where)) ?? null
      ),
      upsert: w('customer.upsert', { id: stored?.id ?? 'new-cust' }),
      update: w('customer.update'),
      updateMany: w('customer.updateMany', { count: 1 }),
    },
    branch: {
      // Only the selected keys, as Prisma returns them: the full lane's owner
      // read selects the region and the refresh lane's does not, and what each
      // compares follows from that (post-merge review of phase 2, finding 6).
      findUnique: vi.fn(
        async ({ where, select }: { where: { branchCode: string }; select?: Record<string, unknown> }) => {
          const b = opts.branches?.[where.branchCode];
          if (!b) return null;
          return select ? Object.fromEntries(Object.entries(b).filter(([k]) => k in select)) : b;
        }
      ),
      count: vi.fn(async () => 0),
      // Owner decision 7's before/after read of the live branch statuses
      // (lib/customer-status.ts): none here, so the customer's status is not moved.
      findMany: vi.fn(async () => []),
      upsert: w('branch.upsert'),
      create: w('branch.create'),
      update: w('branch.update'),
    },
    importRow: { updateMany: w('importRow.promoted', { count: rows.length }) },
  };
  const now = new Date();
  Object.assign(h.db, {
    importBatch: {
      findUnique: vi.fn(async () => ({ kind: 'CUSTOMER', uploadedAt: now })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => null),
    },
    region: { findMany: vi.fn(async () => [{ id: 'rgU', code: 'UNASSIGNED' }]) },
    route: {
      findMany: vi.fn(async () => [{ id: 'rtU', code: 'UNASSIGNED', regionId: 'rgU' }, ...(opts.routes ?? [])]),
    },
    channel: { findMany: vi.fn(async () => opts.channels ?? []) },
    importRow: {
      findMany: vi.fn(async () =>
        rows.map((p, i) => ({ id: `row-${i}`, parsed: p, corrections: null, rowNumber: i + 2, createdAt: now }))
      ),
      updateMany: vi.fn(async (args: (typeof rejected)[number]) => {
        if (args.data?.state === 'REJECTED') rejected.push(args);
        return { count: 1 };
      }),
      update: vi.fn(async () => ({})),
      groupBy: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  });
}

async function promote() {
  const fd = new FormData();
  fd.set('batchId', 'batch-9');
  const res = await promoteCustomerBatchAction(fd);
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res.data;
}

const WRITES = [
  'customer.upsert',
  'customer.update',
  'customer.updateMany',
  'branch.upsert',
  'branch.create',
  'branch.update',
  'importRow.promoted',
  'rescore.Branch',
  'rescore.Customer',
];

describe('promoteCustomerBatchAction — N03: an archived customer is refused before any lane', () => {
  const archived = { ...STORED, deletedAt: new Date('2026-09-01T08:00:00Z') };

  it.each([
    ['a blank temix_code and a NEW branch_code', [parsed()]],
    ['no branch_code at all', [parsed({ branchCode: null })]],
    ['a row the Steward fixed in the app', [parsed({ fixedInApp: true })]],
    [
      'two rows, one of them without a branch_code',
      [parsed({ branchCode: 'ARC1-05' }), parsed({ branchCode: null, address: 'Way 10, Muscat' })],
    ],
  ])('%s: REJECTED, and nothing about the customer or its branches is written', async (_label, rows) => {
    setup(archived, rows);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 0, failed: 1 });
    expect(order.filter((o) => WRITES.includes(o))).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].where).toEqual({ id: { in: rows.map((_, i) => `row-${i}`) } });
    const message = rejected[0].data.issues[0].message;
    expect(message).toBe(
      'customer is archived in the CRM, and an import does not bring an archived customer back — exclude the row; steward review'
    );
    // Offers Re-check and Exclude only: no cell of the row would change this.
    expect(message).not.toMatch(/branch_?code|temix/i);
  });

  it('a populated temix_code is still refused, with the Temix wording', async () => {
    setup(archived, [parsed({ temixCode: 'ARC1' })]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 0, failed: 1 });
    expect(order.filter((o) => WRITES.includes(o))).toEqual([]);
    expect(rejected[0].data.issues[0].message).toBe(
      'customer is archived in the CRM — resolve its Temix deactivation before refreshing'
    );
  });

  it('locks the customer row by its code, and reads it only after the lock', async () => {
    setup(archived, [parsed()]);
    await promote();
    expect(lockSql).toHaveLength(1);
    expect(lockSql[0]).toMatch(/SELECT "id" FROM "Customer" WHERE "nmwcCode" = \? FOR UPDATE/);
    expect((tx.$queryRaw as Fn).mock.calls[0].slice(1)).toEqual(['ARC1']);
    expect(order.slice(0, 2)).toEqual(['lock', 'customer.read']);
    expect((tx.customer as Record<string, Fn>).findUnique.mock.calls[0][0].where).toEqual({ id: 'cust-1' });
  });
});

describe('promoteCustomerBatchAction — the lock on the lanes that do write (N03 control)', () => {
  it('a live customer: lock, read, then the upsert and its branch', async () => {
    setup({ ...STORED, deletedAt: null }, [parsed()]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(rejected).toEqual([]);
    const i = (name: string) => order.indexOf(name);
    expect(i('lock')).toBe(0);
    expect(i('customer.read')).toBe(1);
    expect(i('customer.upsert')).toBeGreaterThan(i('customer.read'));
    expect(i('branch.upsert')).toBeGreaterThan(i('customer.upsert'));
  });

  it('a new customer: the lock finds nothing, nothing is read, and the upsert creates it', async () => {
    setup(null, [parsed({ custCode: 'NEW1', branchCode: 'NEW1-01' })]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(order[0]).toBe('lock');
    expect(order).not.toContain('customer.read');
    expect(order).toContain('customer.upsert');
  });
});

describe('promoteCustomerBatchAction — F11: a temix_code an archived, uncoded customer is deactivated under', () => {
  // X has no Temix code, so its deactivation goes out keyed on its customer code
  // C0900 (lib/temix.ts deactivationCode). A new live customer given C0900 as its
  // Temix code would either hold X back from every Generate for good, or lose its
  // Temix identity when the batch carrying X's deactivation is loaded.
  const archivedAt = new Date('2026-09-01T08:00:00Z');
  const X = (temixSyncState: string, lastTemixUploadAt: Date | null): Other => ({
    nmwcCode: 'C0900',
    temixCode: null,
    deletedAt: archivedAt,
    temixSyncState,
    lastTemixUploadAt,
  });
  const newRow = parsed({ custCode: 'NEW1', branchCode: 'NEW1-01', temixCode: 'C0900' });

  it.each([
    ['queued (DEACTIVATE_PENDING), never uploaded — a seeded customer', X('DEACTIVATE_PENDING', null)],
    ['in a batch not yet loaded (UPLOADED)', X('UPLOADED', archivedAt)],
    ['settled after it went out in a batch', X('SYNCED', archivedAt)],
  ])('its deactivation %s: REJECTED, and nothing is written', async (_label, x) => {
    setup(null, [newRow], [x]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 0, failed: 1 });
    expect(order.filter((o) => WRITES.includes(o))).toEqual([]);
    expect(rejected[0].data.issues[0].message).toBe(
      'temix_code is the customer code of archived C0900, which has no Temix code — its Temix deactivation goes out under that code — steward review'
    );
  });

  it('one Temix never heard of (archived before any upload, parked SYNCED) refuses nothing', async () => {
    setup(null, [newRow], [X('SYNCED', null)]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(order).toContain('customer.upsert');
  });

  it('a customer that already holds the code is not refused over it: the row gives it to nobody new', async () => {
    setup({ ...STORED, temixCode: 'C0900', deletedAt: null }, [parsed({ temixCode: 'C0900' })], [
      X('DEACTIVATE_PENDING', null),
    ]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(rejected).toEqual([]);
  });

  it('a customer holding the code as its Temix code is refused as before, in its own words', async () => {
    setup(null, [newRow], [{ ...X('SYNCED', archivedAt), nmwcCode: 'OLD1', temixCode: 'C0900' }]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 0, failed: 1 });
    expect(rejected[0].data.issues[0].message).toBe(
      'temix_code already recorded on OLD1 (archived — its Temix deactivation may be in flight) — steward review'
    );
  });
});

// ── F16: the import's channel change and the stored sub-channel ─────────────

const CHANNELS = [
  { id: 'ch-retail', key: 'RETAIL' },
  { id: 'ch-horeca', key: 'HORECA' },
];
const live = (over: Partial<typeof STORED> = {}) => ({ ...STORED, deletedAt: null, ...over });
const upsertArgs = () =>
  (tx.customer as Record<string, Fn>).upsert.mock.calls[0][0] as {
    update: Record<string, unknown>;
  };
/** The row notes writeLaneNotes put on each row, by row id. */
const notesWritten = () =>
  Object.fromEntries(
    ((h.db.importRow as Record<string, Fn>).update.mock.calls as Array<
      [{ where: { id: string }; data: { issues: Array<{ field: string; message: string }> } }]
    >).map(([a]) => [a.where.id, a.data.issues])
  );
/** The F-17 warnings written to every row of the group at once. */
const groupWarnings = () =>
  ((h.db.importRow as Record<string, Fn>).updateMany.mock.calls as Array<[{ data: Record<string, unknown> }]>)
    .map(([a]) => a.data)
    .filter((d) => 'issues' in d && !('state' in d));

describe('promoteCustomerBatchAction — F16: a channel change clears a sub-channel of the old channel', () => {
  const retailSub = { channelId: 'ch-retail', subChannelId: 'sub-retail', subChannel: { channelId: 'ch-retail' } };

  it('clears it in the same upsert, and the note lands on the LEAD row and survives the row reset', async () => {
    setup(
      live(retailSub),
      [parsed({ channelKey: 'HORECA' }), parsed({ channelKey: 'HORECA', branchCode: 'ARC1-03', address: 'Way 10, Muscat' })],
      [],
      { channels: CHANNELS }
    );
    const out = await promote();
    expect(out).toMatchObject({ promoted: 2, failed: 0 });
    expect(upsertArgs().update).toMatchObject({ channelId: 'ch-horeca', subChannelId: null });

    // Ruling 3: the full lane resets every row's note after its branch loop; the
    // lead row's note must be merged through it, not replaced. Its own key, not
    // '_lane': the batch page labels that "Branch not updated", and this row's
    // branch was written (review of phase 2).
    const notes = notesWritten();
    expect(Object.keys(notes)).toEqual(['row-0']);
    expect(notes['row-0']).toEqual([
      {
        field: '_subchannel',
        message:
          "the channel in this row (HORECA) replaces the customer's channel, so its sub-channel, which belongs to the old channel, was cleared — pick a sub-channel of the new channel on the customer page",
      },
    ]);

    // Logged once the group has committed: ids only.
    const logged = h.info.mock.calls.filter(([, msg]) => msg === 'import.promote.subchannel_cleared');
    expect(logged).toEqual([[{ customerId: 'cust-1', batchId: 'batch-9' }, 'import.promote.subchannel_cleared']]);
  });

  it('with route warnings too: the lead row gets both, every row its warning, and no group write overwrites them', async () => {
    setup(
      live(retailSub),
      [parsed({ channelKey: 'HORECA', routeCode: 'NOPE' }), parsed({ channelKey: 'HORECA', branchCode: 'ARC1-03' })],
      [],
      { channels: CHANNELS }
    );
    await promote();
    const warning = {
      field: '_resolve',
      message: 'route "NOPE" not found — a new branch is parked in UNASSIGNED, an existing one keeps its route',
    };
    const notes = notesWritten();
    expect(notes['row-0']).toEqual([expect.objectContaining({ field: '_subchannel' }), warning]);
    expect(notes['row-1']).toEqual([warning]);
    expect(groupWarnings()).toEqual([]);
  });

  it.each([
    ['the stored sub-channel belongs to the new channel', live({ channelId: 'ch-retail', subChannelId: 'sub-h', subChannel: { channelId: 'ch-horeca' } }), 'HORECA'],
    ['the channel does not change (a mismatch already on file is left alone)', live({ channelId: 'ch-horeca', subChannelId: 'sub-retail', subChannel: { channelId: 'ch-retail' } }), 'HORECA'],
    ['the channel cell is blank', live(retailSub), null],
    ['the customer has no sub-channel', live({ channelId: 'ch-retail' }), 'HORECA'],
  ])('keeps it when %s: nothing cleared, no note, no log line', async (_label, stored, channelKey) => {
    setup(stored, [parsed({ channelKey })], [], { channels: CHANNELS });
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(upsertArgs().update.subChannelId).toBeUndefined();
    expect(notesWritten()).toEqual({});
    expect(h.info.mock.calls.filter(([, msg]) => msg === 'import.promote.subchannel_cleared')).toEqual([]);
  });

  it('without a clear, the route warnings still go to every row in one group write, as before', async () => {
    setup(live(), [parsed({ routeCode: 'NOPE' })], [], { channels: CHANNELS });
    await promote();
    expect(notesWritten()).toEqual({});
    expect(groupWarnings()).toEqual([
      {
        issues: [
          {
            field: '_resolve',
            message: 'route "NOPE" not found — a new branch is parked in UNASSIGNED, an existing one keeps its route',
          },
        ],
      },
    ]);
  });
});

// ── F21: which branches the import writes, and their version ───────────────

const storedBranch = (over: Partial<StoredBranch> = {}): StoredBranch => ({
  id: 'b-02',
  customerId: 'cust-1',
  deletedAt: null,
  customer: { nmwcCode: 'ARC1' },
  // What parsed() gives, so a row of it changes nothing.
  branchName: 'New shop',
  routeId: 'rtU',
  regionId: 'rgU',
  address: 'Way 9, Muscat',
  dayOfVisit: null,
  status: 'ACTIVE',
  ...over,
});
const branchUpserts = () =>
  ((tx.branch as Record<string, Fn>).upsert.mock.calls as Array<
    [{ where: { branchCode: string }; update: Record<string, unknown>; create: Record<string, unknown> }]
  >).map(([a]) => a);

describe('promoteCustomerBatchAction — F21: an import writes a branch only when it changes it, and bumps its version', () => {
  it('full lane: an unchanged branch is not written at all; a changed one is, with version + 1', async () => {
    setup(
      live(),
      [parsed(), parsed({ branchCode: 'ARC1-03', address: 'Way 10, Muscat' })],
      [],
      { branches: { 'ARC1-02': storedBranch(), 'ARC1-03': storedBranch({ id: 'b-03', address: 'Old address, Muscat' }) } }
    );
    const out = await promote();
    expect(out).toMatchObject({ promoted: 2, failed: 0 });
    const ups = branchUpserts();
    expect(ups.map((u) => u.where.branchCode)).toEqual(['ARC1-03']);
    expect(ups[0].update).toMatchObject({ address: 'Way 10, Muscat', version: { increment: 1 } });
    // The status is only restated, so it is no status change (EL-11).
    expect(ups[0].update.lastStatusChangeAt).toBeUndefined();
  });

  it.each([
    ['branch name', {}, { branchName: 'Old name' }],
    ['visit day', { dayOfVisit: 'MON' }, { dayOfVisit: 'SUN' }],
    ['visit day, where none was stored', { dayOfVisit: 'MON' }, {}],
  ])('full lane: a different %s is a change', async (_label, row, stored) => {
    setup(live(), [parsed(row)], [], { branches: { 'ARC1-02': storedBranch(stored) } });
    await promote();
    expect(branchUpserts()).toHaveLength(1);
    expect(branchUpserts()[0].update.version).toEqual({ increment: 1 });
  });

  it('full lane: a blank cell is no change, whatever the branch holds (item 20)', async () => {
    setup(live(), [parsed({ customerStatus: null, branchName: null })], [], {
      branches: { 'ARC1-02': storedBranch({ status: 'CLOSED', branchName: 'Stored name' }) },
    });
    await promote();
    expect(branchUpserts()).toEqual([]);
  });

  it('full lane: a status the row changes stamps lastStatusChangeAt', async () => {
    setup(live(), [parsed()], [], { branches: { 'ARC1-02': storedBranch({ status: 'CLOSED' }) } });
    await promote();
    const [u] = branchUpserts();
    expect(u.update).toMatchObject({ status: 'ACTIVE', version: { increment: 1 } });
    expect(u.update.lastStatusChangeAt).toBeInstanceOf(Date);
  });

  it('full lane: a branch no one holds is written, and a create leaves version at its default', async () => {
    setup(live(), [parsed()], []);
    await promote();
    const [u] = branchUpserts();
    expect(u.where.branchCode).toBe('ARC1-02');
    expect(u.create).not.toHaveProperty('version');
    // The update half runs only when a concurrent insert beat the read: a change.
    expect(u.update.version).toEqual({ increment: 1 });
  });

  describe('a branch left in the old region of a route the account import moved (post-merge review, finding 6)', () => {
    // The account import moved route R1 from region rgA to rgB and wrote the
    // route alone: nothing fires on Route, so its branches still say rgA. Every
    // cell of the row matches the stored branch.
    const routes = [{ id: 'rt1', code: 'R1', regionId: 'rgB' }];
    const onR1 = (regionId: string) => ({ 'ARC1-02': storedBranch({ routeId: 'rt1', regionId }) });

    it('full lane: written into its route’s region, with version + 1, though no cell differs', async () => {
      setup(live(), [parsed({ routeCode: 'R1' })], [], { routes, branches: onR1('rgA') });
      const out = await promote();
      expect(out).toMatchObject({ promoted: 1, failed: 0 });
      const ups = branchUpserts();
      expect(ups).toHaveLength(1);
      expect(ups[0].where.branchCode).toBe('ARC1-02');
      expect(ups[0].update).toMatchObject({ regionId: 'rgB', routeId: 'rt1', version: { increment: 1 } });
      expect(ups[0].update.lastStatusChangeAt).toBeUndefined();
    });

    it('full lane: a branch already in its route’s region is not written', async () => {
      setup(live(), [parsed({ routeCode: 'R1' })], [], { routes, branches: onR1('rgB') });
      await promote();
      expect(branchUpserts()).toEqual([]);
    });

    it('full lane: a blank route cell compares no region, as it writes none (item 20)', async () => {
      setup(live(), [parsed()], [], { routes, branches: onR1('rgA') });
      await promote();
      expect(branchUpserts()).toEqual([]);
    });

    it('the refresh lane does not compare the region: a plain row writes nothing and names nothing', async () => {
      setup(live({ temixCode: 'ARC1' }), [parsed({ routeCode: 'R1', temixCode: 'ARC1' })], [], {
        routes,
        branches: onR1('rgA'),
      });
      const out = await promote();
      expect(out).toMatchObject({ promoted: 1, failed: 0 });
      expect((tx.branch as Record<string, Fn>).update).not.toHaveBeenCalled();
      expect(branchUpserts()).toEqual([]);
      expect(notesWritten()).toEqual({});
    });
  });

  it('a row fixed in the app: the branch it changes is updated with version + 1; one it does not change is left', async () => {
    const linked = live({ temixCode: 'ARC1' });
    setup(linked, [parsed({ fixedInApp: true, address: 'Way 10, Muscat' })], [], {
      branches: { 'ARC1-02': storedBranch() },
    });
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    const updates = (tx.branch as Record<string, Fn>).update.mock.calls as Array<[{ data: Record<string, unknown> }]>;
    expect(updates).toHaveLength(1);
    expect(updates[0][0].data).toMatchObject({ address: 'Way 10, Muscat', version: { increment: 1 } });

    setup(linked, [parsed({ fixedInApp: true })], [], { branches: { 'ARC1-02': storedBranch() } });
    await promote();
    expect((tx.branch as Record<string, Fn>).update).not.toHaveBeenCalled();
  });
});

// ── F21: the promote rescores the customer and every live branch ───────────

const scoringCustomer: CustomerForScore & { id: string } = {
  id: 'cust-1',
  channelId: null,
  subChannelId: null,
  primaryPhone: '+96899999999',
  contactPerson: 'Stored Contact',
  crNumber: null,
  crPhotoId: null,
  paymentTerms: 'CASH',
  notes: null,
};
const scoringBranch = (
  id: string,
  over: Partial<BranchForScore> = {}
): BranchForScore & { id: string; deletedAt: null } => ({
  id,
  deletedAt: null,
  gpsLat: null,
  gpsLng: null,
  address: 'Way 9, Muscat',
  shopPhotoId: null,
  signboardPhotoId: null,
  dayOfVisit: 'MON',
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  openingHours: null,
  deliveryWindow: null,
  status: 'ACTIVE',
  ...over,
});

describe('promoteCustomerBatchAction — F21: the group transaction rescores every live branch, not only the customer', () => {
  it('writes the branch scores that differ and the customer score, in raw SQL on the transaction, after the rows are promoted', async () => {
    const created = scoringBranch('b-new'); // created by this import: stored at the default 0
    const same = scoringBranch('b-same', { gpsLat: 23.6, gpsLng: 58.4 });
    const branches = [
      { ...created, completenessScore: 0 },
      { ...same, completenessScore: scoreBranch(same) },
    ];
    setup(live(), [parsed()], [], {
      scored: [{ ...scoringCustomer, completenessScore: 7, branches }],
    });
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });

    expect(rescoreWrites.map((w) => [w.table, w.rows])).toEqual([
      ['Branch', [['b-new', scoreBranch(created)]]],
      ['Customer', [['cust-1', scoreCustomer(scoringCustomer, [created, same])]]],
    ]);
    // Only a score that still differs is written; nothing else is set.
    for (const w of rescoreWrites) {
      expect(w.sql).toMatch(/SET "completenessScore" = v\.score FROM \(VALUES/);
      expect(w.sql).toMatch(/"completenessScore" <> v\.score$/);
      expect(w.sql).not.toMatch(/version|updatedAt/);
    }
    const i = (name: string) => order.indexOf(name);
    expect(i('importRow.promoted')).toBeLessThan(i('customer.score-read'));
    expect(i('customer.score-read')).toBeLessThan(i('rescore.Branch'));
    // The old customer-only write is gone.
    expect(order).not.toContain('customer.update');
    // On the transaction, not the pooled client.
    expect(h.db.$executeRaw).toBeUndefined();
  });

  it('writes nothing when every stored score is already right', async () => {
    const b = scoringBranch('b-1');
    setup(live(), [parsed()], [], {
      scored: [
        {
          ...scoringCustomer,
          completenessScore: scoreCustomer(scoringCustomer, [b]),
          branches: [{ ...b, completenessScore: scoreBranch(b) }],
        },
      ],
    });
    await promote();
    expect(order).toContain('customer.score-read');
    expect(rescoreWrites).toEqual([]);
  });

  it('rescores on the branch-only lane too (every row fixed in the app)', async () => {
    const b = scoringBranch('b-02');
    setup(live({ temixCode: 'ARC1' }), [parsed({ fixedInApp: true, address: 'Way 10, Muscat' })], [], {
      branches: { 'ARC1-02': storedBranch() },
      scored: [{ ...scoringCustomer, completenessScore: 0, branches: [{ ...b, completenessScore: 0 }] }],
    });
    await promote();
    expect(rescoreWrites.map((w) => w.table)).toEqual(['Branch', 'Customer']);
  });
});

// ── The branch-only lane and the export's "updated since" filter ────────────

describe("promoteCustomerBatchAction — branch only: a branch it writes moves the customer's updatedAt", () => {
  // services/exports.ts filters "updated since" on the CUSTOMER's updatedAt. On
  // this lane the requeue matches nothing on a customer already PENDING_UPLOAD
  // and the rescore is raw SQL, so nothing else moves it (review of phase 2).
  const pending = { ...live({ temixCode: 'ARC1' }), temixSyncState: 'PENDING_UPLOAD' };
  const customerUpdates = () =>
    (
      (tx.customer as Record<string, Fn>).update.mock.calls as Array<
        [{ where: unknown; data: Record<string, unknown> }]
      >
    ).map(([a]) => a);
  /** The customer updateManys, each evaluated against the PENDING_UPLOAD row. */
  let matched: number[];
  const pendingCustomer = () => {
    matched = [];
    (tx.customer as Record<string, Fn>).updateMany = vi.fn(
      async ({ where }: { where: Record<string, unknown> }) => {
        order.push('customer.updateMany');
        const count = matchesWhere(pending, where) ? 1 : 0;
        matched.push(count);
        return { count };
      }
    );
  };

  it.each([
    ['changes', { address: 'Way 10, Muscat' }, 'branch.update', {}],
    ['creates', { branchCode: 'ARC1-07' }, 'branch.create', {}],
  ] as const)(
    'a row that %s a branch: its customer is touched in the transaction — updatedAt only',
    async (_label, row, write, branches) => {
      setup(pending, [parsed({ fixedInApp: true, ...row })], [], {
        branches: { 'ARC1-02': storedBranch(), ...branches },
      });
      pendingCustomer();
      const before = Date.now();
      const out = await promote();
      expect(out).toMatchObject({ promoted: 1, failed: 0 });
      // The requeue matched nothing: the customer was already PENDING_UPLOAD.
      expect(matched).toEqual([0]);
      const touched = customerUpdates();
      expect(touched).toEqual([{ where: { id: 'cust-1' }, data: { updatedAt: expect.any(Date) } }]);
      expect((touched[0].data.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      // Not version, not lastEditedById: nothing of the customer's own changed.
      expect(Object.keys(touched[0].data)).toEqual(['updatedAt']);
      const i = (name: string) => order.indexOf(name);
      expect(i(write)).toBeGreaterThan(-1);
      expect(i('customer.update')).toBeGreaterThan(i(write));
      expect(i('customer.update')).toBeLessThan(i('importRow.promoted'));
    }
  );

  it('a row that leaves its branch as it was touches nothing of the customer', async () => {
    setup(pending, [parsed({ fixedInApp: true })], [], { branches: { 'ARC1-02': storedBranch() } });
    pendingCustomer();
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect((tx.branch as Record<string, Fn>).update).not.toHaveBeenCalled();
    expect((tx.branch as Record<string, Fn>).create).not.toHaveBeenCalled();
    expect(customerUpdates()).toEqual([]);
    expect(matched).toEqual([]);
  });
});


describe('promoteCustomerBatchAction — owner decision 2026-10-08: the first Temix code of a customer created in the app', () => {
  // A customer the Accountant approved before the code was typed at approval:
  // live, no Temix code, a customer code the app minted, the CREATE audit row its
  // finalize wrote, and sent to Temix in a batch (UPLOADED). Temix's file names
  // it by its customer code and carries the code Temix gave it.
  const CODE = 'NMWC-2026-000077';
  const APP = {
    ...STORED,
    temixCode: null as string | null,
    paymentTerms: 'CASH',
    createdById: 'u-sales',
    deletedAt: null,
    temixSyncState: 'UPLOADED',
    lastTemixUploadAt: new Date('2026-10-01T06:00:00Z') as Date | null,
  };
  const row = (over: Parsed = {}) =>
    parsed({
      custCode: CODE,
      branchCode: `${CODE}-02`,
      temixCode: 'TX900',
      paymentTerms: 'CREDIT',
      creditLimit: 999999,
      paymentTermDays: 120,
      ...over,
    });
  type Holder = { nmwcCode: string; archived: boolean; branchCode: string | null };
  let holderSql: string[];
  /** Its finalize's CREATE audit row (or none), and who else has the code (or no one). */
  function app(created: boolean, holder: Holder | null = null) {
    holderSql = [];
    tx.auditLog = { findFirst: vi.fn(async () => (created ? { id: 'audit-create' } : null)) };
    const lockByCode = tx.$queryRaw as Fn;
    tx.$queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?');
      if (/UPPER\("temixCode"\)/.test(q)) {
        order.push('temix.holder');
        holderSql.push(Prisma.sql(strings, ...values).text);
        expect(values).toEqual(['cust-1', 'cust-1', 'TX900', 'TX900']);
        return holder ? [{ nmwcCode: holder.nmwcCode }] : [];
      }
      return lockByCode(strings, ...values);
    });
  }
  const auditRead = () => (tx.auditLog as Record<string, Fn>).findFirst;
  const customerUpdate = () =>
    ((tx.customer as Record<string, Fn>).update.mock.calls[0]?.[0] ?? null) as {
      where: unknown;
      data: Record<string, unknown>;
    } | null;

  it('records the code and nothing else the ERP owns; UPLOADED → SYNCED; the salesman is told; no full-lane write', async () => {
    setup({ ...APP }, [row()], [], {
      branches: { [`${CODE}-02`]: storedBranch({ customer: { nmwcCode: CODE }, address: 'Way 9, Muscat' }) },
    });
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(rejected).toEqual([]);
    // Found by its customer code; created by a finalize: its own CREATE audit row.
    expect(auditRead().mock.calls[0]![0]).toEqual({
      where: { action: 'CREATE', entityType: 'Customer', entityId: 'cust-1' },
      select: { id: true },
    });
    // The code alone: not the payment terms, not the credit figures the row carries.
    expect(customerUpdate()).toEqual({
      where: { id: 'cust-1' },
      data: { temixCode: 'TX900', lastEditedById: 'stew', version: { increment: 1 } },
    });
    expect((tx.customer as Record<string, Fn>).updateMany.mock.calls[0]![0]).toEqual({
      where: { id: 'cust-1', temixSyncState: 'UPLOADED' },
      data: { temixSyncState: 'SYNCED' },
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]!.slice(1)).toEqual([
      ['u-sales'],
      {
        kind: 'TEMIX_SYNC_ACKED',
        title: 'Customer landed in Temix',
        body: `Stored Name (${CODE}) is now in Temix as TX900.`,
        customerId: 'cust-1',
      },
    ]);
    // The refresh lane: the customer's own fields and its branches are left as they are.
    expect(order).not.toContain('customer.upsert');
    expect(order).not.toContain('branch.upsert');
    expect(order).not.toContain('branch.update');
    expect(h.info).toHaveBeenCalledWith(
      { customerId: 'cust-1', temixCode: 'TX900', batchId: 'batch-9' },
      'import.promote.first_temix_code'
    );
  });

  it('checked under the lock a finalize takes, against every other live customer, before anything is written', async () => {
    setup({ ...APP }, [row()]);
    app(true);
    await promote();
    expect(temixLocks).toEqual(['nmwc:temix:TX900']);
    expect(holderSql).toHaveLength(1);
    const i = (name: string) => order.indexOf(name);
    expect(i('temix.lock')).toBeLessThan(i('temix.holder'));
    expect(i('temix.holder')).toBeLessThan(i('customer.update'));
  });

  it.each([
    [
      'another live customer has it',
      { nmwcCode: 'NMWC-2026-000012', archived: false, branchCode: null },
      'temix_code is already the Temix code of live customer NMWC-2026-000012 — steward review',
    ],
  ])('%s: reported on the row; nothing is written and nobody is told', async (_label, holder, message) => {
    setup({ ...APP }, [row()]);
    app(true, holder);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 0, failed: 1 });
    expect(rejected[0]!.data.issues[0]!.message).toBe(message);
    expect(order.filter((o) => WRITES.includes(o))).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a customer its finalize did not create (no CREATE audit row: a seeded or imported merge winner holding an app request) keeps the full lane', async () => {
    setup({ ...APP, paymentTerms: 'CREDIT' }, [row()]);
    app(false);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(auditRead()).toHaveBeenCalledTimes(1);
    expect(order).toContain('customer.upsert');
    expect(order).not.toContain('temix.lock');
    expect(customerUpdate()?.data.temixCode).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a customer code the app did not mint (migrated, seeded): the full lane, and nothing is even asked', async () => {
    setup({ ...APP, paymentTerms: 'CREDIT' }, [row({ custCode: 'ARC1', branchCode: 'ARC1-02' })]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(auditRead()).not.toHaveBeenCalled();
    expect(order).toContain('customer.upsert');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a customer never sent to Temix (queued, never in a batch) cannot have a Temix code yet: the full lane, nothing asked', async () => {
    setup({ ...APP, paymentTerms: 'CREDIT', temixSyncState: 'PENDING_UPLOAD', lastTemixUploadAt: null }, [row()]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(auditRead()).not.toHaveBeenCalled();
    expect(order).toContain('customer.upsert');
    expect(order).not.toContain('temix.lock');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('one sent in a batch and changed since (queued again) is still matched: its code is recorded', async () => {
    setup({ ...APP, temixSyncState: 'PENDING_UPLOAD' }, [row()]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(customerUpdate()!.data.temixCode).toBe('TX900');
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('a group with a row the Steward fixed in the app is no word from Temix: the full lane, and nothing is even asked', async () => {
    setup({ ...APP }, [row({ fixedInApp: true, paymentTerms: 'CASH' })]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(auditRead()).not.toHaveBeenCalled();
    expect(order).toContain('customer.upsert');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a row with no temix_code is the full lane, as before', async () => {
    setup({ ...APP }, [row({ temixCode: null, paymentTerms: 'CASH' })]);
    app(true);
    await promote();
    expect(auditRead()).not.toHaveBeenCalled();
    expect(order).toContain('customer.upsert');
  });

  it('once it has its code, the next refresh is the ordinary one: Temix figures applied, nobody told again', async () => {
    setup({ ...APP, temixCode: 'TX900', paymentTerms: 'CREDIT' }, [row()]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(auditRead()).not.toHaveBeenCalled();
    expect(customerUpdate()!.data).toMatchObject({
      temixCode: 'TX900',
      paymentTerms: 'CREDIT',
      creditLimit: 999999,
      paymentTermDays: 120,
    });
    expect(h.notify).not.toHaveBeenCalled();
  });

  // Review of the branch: the import compared temix_code with exact case while
  // finalize stores the code upper case and checks without regard to case.
  it('a temix_code staged in lower case (a batch from before the upload folded it) is folded: TX900 is recorded', async () => {
    setup({ ...APP }, [row({ temixCode: ' tx900​' })]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(temixLocks).toEqual(['nmwc:temix:TX900']);
    expect(customerUpdate()!.data.temixCode).toBe('TX900');
  });

  it('a code an older import recorded in lower case is the same code: the ordinary refresh, recorded upper case', async () => {
    setup({ ...APP, temixCode: 'tx900', paymentTerms: 'CREDIT' }, [row()]);
    app(true);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(rejected).toEqual([]);
    expect(customerUpdate()!.data).toMatchObject({ temixCode: 'TX900', creditLimit: 999999 });
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('promoteCustomerBatchAction — owner decision 2026-10-08: a NEW customer created with a temix_code', () => {
  // Finalize gives the code the Accountant typed under an advisory lock; the full
  // lane creating a customer with the sheet's temix_code takes the same lock, so
  // the two cannot both pass their checks for one code at the same moment.
  it('takes the lock a finalize takes, before the crosswalk check and the create', async () => {
    setup(null, [parsed({ custCode: 'NEW1', branchCode: 'NEW1-01', temixCode: 'c0900' })]);
    const ownerRead = (tx.customer as Record<string, Fn>).findFirst;
    (tx.customer as Record<string, Fn>).findFirst = vi.fn(async (a: unknown) => {
      order.push('crosswalk.read');
      return ownerRead(a);
    });
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(temixLocks).toEqual(['nmwc:temix:C0900']);
    const i = (name: string) => order.indexOf(name);
    expect(i('temix.lock')).toBeGreaterThan(i('lock'));
    expect(i('temix.lock')).toBeLessThan(i('crosswalk.read'));
    expect(i('crosswalk.read')).toBeLessThan(i('customer.upsert'));
    const created = (tx.customer as Record<string, Fn>).upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(created.create).toMatchObject({ nmwcCode: 'NEW1', temixCode: 'C0900', temixSyncState: 'SYNCED' });
  });

  it('a customer that exists is never given a new code by the full lane: no lock', async () => {
    setup({ ...STORED, deletedAt: null }, [parsed({ temixCode: 'C0900' })]);
    const out = await promote();
    expect(out).toMatchObject({ promoted: 1, failed: 0 });
    expect(temixLocks).toEqual([]);
    expect(order).toContain('customer.upsert');
  });
});
