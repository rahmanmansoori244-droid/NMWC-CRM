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
 *
 * The same paths against Postgres, and an archive racing the promote on two
 * connections, are in tests/integration/import-archived-parent.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Fn = ReturnType<typeof vi.fn>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
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
vi.mock('@/lib/notifications', () => ({ notifyUsers: async () => {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('@/lib/import-master-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import-master-lookup')>()),
  masterCollisionMaps: async () => ({ masterPhones: new Map(), masterCrs: new Map() }),
  newerUploadsCarrying: async () => new Map(),
}));
vi.mock('@/lib/db', () => ({ prisma: h.db }));

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
  channel: null,
};

let order: string[];
let lockSql: string[];
let tx: Record<string, Record<string, Fn> | Fn>;
let rejected: Array<{ where: unknown; data: { state: string; issues: Array<{ message: string }> } }>;

function setup(stored: (typeof STORED & { deletedAt: Date | null }) | null, rows: Parsed[]) {
  order = [];
  lockSql = [];
  rejected = [];
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
    customer: {
      findUnique: vi.fn(async (args: { include?: unknown }) => {
        order.push(args.include ? 'customer.score-read' : 'customer.read');
        return stored ? { ...stored, branches: [] } : null;
      }),
      findFirst: vi.fn(async () => null),
      upsert: w('customer.upsert', { id: stored?.id ?? 'new-cust' }),
      update: w('customer.update'),
      updateMany: w('customer.updateMany', { count: 1 }),
    },
    branch: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
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
    route: { findMany: vi.fn(async () => [{ id: 'rtU', code: 'UNASSIGNED', regionId: 'rgU' }]) },
    channel: { findMany: vi.fn(async () => []) },
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
