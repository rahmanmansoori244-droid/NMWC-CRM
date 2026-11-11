// @vitest-environment node
/**
 * The "Before you promote" check (code review 2026-11-10, finding 1):
 * lib/import-promote-summary.ts loadPromoteSummary on a fake database, and
 * services/import-review.ts, the Steward-only action that serves it.
 *
 * The decisions are lib/import-plan.ts (tests/unit/import-plan.test.ts); what is
 * pinned here is what the loader READS — the clean rows, grouped as the promote
 * groups them, the customers and shops they name, in chunks — and that it
 * writes nothing. Against Postgres: tests/integration/import-crm-fill-only.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'STEWARD',
  limit: { ok: true as boolean, retryAfterSec: 0 },
  limitKeys: [] as string[],
  batch: null as null | { kind: string; overwriteCrmFields: boolean },
  /** Code review 2026-11-10, finding 6: when the batch was uploaded, and the newer loads of its customers. */
  uploadedAt: new Date(),
  newer: [] as Array<{ code: string; filename: string; rowNumber: number }>,
  // The fake database (below), handed to the '@/lib/db' mock.
  db: {} as Record<string, unknown>,
}));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'stew', role: h.role, username: 'steward.x' } }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async (key: string) => {
    h.limitKeys.push(key);
    return h.limit;
  },
}));

type Row = Record<string, unknown>;
type Call = { model: string; args: { where: Record<string, { in?: string[] }> & Record<string, unknown> } };

let staged: Row[];
let customers: Row[];
let shops: Row[];
let calls: Call[];

/** Reads only: a write on any model is a method this fake does not have. */
const fake = {
  importRow: {
    findMany: async (args: Call['args']) => {
      calls.push({ model: 'importRow', args });
      return staged.map((parsed) => ({ parsed }));
    },
  },
  route: { findMany: async () => [{ id: 'rt1', code: 'R1', regionId: 'rg1' }, { id: 'rt2', code: 'r2', regionId: 'rg2' }] },
  channel: { findMany: async () => [{ id: 'ch-horeca', key: 'horeca' }] },
  customer: {
    findMany: async (args: Call['args']) => {
      // Finding 7: the live customers whose Temix code is one of the new codes.
      if (args.where.temixCode) {
        calls.push({ model: 'customer.temixCode', args });
        const wanted = (args.where.temixCode as { in: string[] }).in.map((c) => c.toUpperCase());
        return customers.filter(
          (c) => !c.deletedAt && typeof c.temixCode === 'string' && wanted.includes(c.temixCode.toUpperCase())
        );
      }
      calls.push({ model: 'customer', args });
      return customers.filter((c) => args.where.nmwcCode!.in!.includes(c.nmwcCode as string));
    },
  },
  branch: {
    findMany: async (args: Call['args']) => {
      // Owner's answer 2026-11-11 (A5): every shop code of the customers found.
      if (args.where.customerId) {
        calls.push({ model: 'branch.ofCustomer', args });
        return shops.filter((b) => (args.where.customerId as { in: string[] }).in.includes(b.customerId as string));
      }
      calls.push({ model: 'branch', args });
      return shops.filter((b) => args.where.branchCode!.in!.includes(b.branchCode as string));
    },
  },
  importBatch: {
    findUnique: async () => (h.batch ? { uploadedAt: h.uploadedAt, uploadedBy: { fullName: 'ZZ Steward' }, ...h.batch } : null),
  },
  // Finding 6: lib/import-master-lookup.ts newerLoadsOfBatch.
  $queryRaw: async () => h.newer,
};
Object.assign(h.db, fake);
vi.mock('@/lib/db', () => ({ prisma: h.db }));

import { SUMMARY_CHUNK, loadPromoteSummary } from '@/lib/import-promote-summary';
import { summariseCustomerBatchAction } from '@/services/import-review';

const parsed = (over: Row = {}): Row => ({
  custCode: 'C1',
  custName: 'Sheet Name',
  branchCode: '01',
  branchName: null,
  regionCode: null,
  routeCode: 'R1',
  address: 'Sheet address 1',
  phone: null,
  contactPerson: null,
  crNumber: null,
  paymentTerms: 'CASH',
  paymentTermsPresent: false,
  temixCode: null,
  creditLimit: null,
  paymentTermDays: null,
  channelKey: null,
  dayOfVisit: null,
  customerStatus: null,
  ...over,
});
const customer = (nmwcCode: string, over: Row = {}): Row => ({
  id: `id-${nmwcCode}`,
  nmwcCode,
  deletedAt: null,
  temixCode: null,
  temixSyncState: 'SYNCED',
  lastTemixUploadAt: null,
  paymentTerms: 'CASH',
  legalName: 'Sheet Name',
  primaryPhone: null,
  primaryPhoneNorm: null,
  crNumber: null,
  crNumberNorm: null,
  creditLimit: null,
  paymentTermDays: null,
  contactPerson: null,
  channelId: null,
  subChannelId: null,
  subChannel: null,
  status: 'ACTIVE',
  _count: { branches: 1 },
  ...over,
});
const shop = (branchCode: string, customerId: string, over: Row = {}): Row => ({
  branchCode,
  customerId,
  deletedAt: null,
  branchName: 'Main',
  routeId: 'rt1',
  regionId: 'rg1',
  address: 'Sheet address 1',
  dayOfVisit: null,
  status: 'ACTIVE',
  ...over,
});

beforeEach(() => {
  staged = [];
  customers = [];
  shops = [];
  calls = [];
  h.role = 'STEWARD';
  h.limit = { ok: true, retryAfterSec: 0 };
  h.limitKeys = [];
  h.batch = { kind: 'CUSTOMER', overwriteCrmFields: false };
  h.uploadedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60_000);
  h.newer = [];
});

const load = (overwrite = false) => loadPromoteSummary(fake as never, 'batch-9', overwrite);

describe('loadPromoteSummary', () => {
  it('reads the batch’s CLEAN rows in sheet order, and only what Promote reads of them', async () => {
    staged = [parsed()];
    await load();
    expect(calls[0]).toEqual({
      model: 'importRow',
      args: { where: { batchId: 'batch-9', state: 'CLEAN' }, select: { parsed: true }, orderBy: { rowNumber: 'asc' } },
    });
  });

  it('groups a customer’s rows, finds it by its exact customer code and its shops by their composed codes', async () => {
    staged = [
      parsed({ custCode: 'C1', branchCode: '01', address: 'Older address' }),
      parsed({ custCode: 'C2', branchCode: 'C2-01' }),
      parsed({ custCode: 'C1', branchCode: '02', routeCode: 'R2' }),
      parsed({ custCode: 'NEW', branchCode: null }),
    ];
    customers = [customer('C1'), customer('C2')];
    shops = [shop('C1-01', 'id-C1'), shop('C1-02', 'id-C1'), shop('C2-01', 'id-C2')];
    const s = await load();
    expect(calls.filter((c) => c.model === 'customer').map((c) => c.args.where.nmwcCode!.in)).toEqual([['C1', 'C2', 'NEW']]);
    // Each composed code, and each code as the sheet gave it.
    expect(calls.filter((c) => c.model === 'branch')[0]!.args.where.branchCode!.in!.slice().sort()).toEqual(
      ['01', '02', 'C1-01', 'C1-02', 'C2-01', 'NEW-01'].sort()
    );
    expect(s).toMatchObject({
      rows: 4,
      customers: 3,
      created: { customers: 1, shops: 1, shopsOnExisting: 0 },
      // Route codes are matched without case, as at Promote: 'R2' is the route stored as 'r2'.
      // Owner's answer 2026-11-11 ("A1 stop"): the shop is not moved to it any more
      // (this pinned temix.shopsRouteMoved: 1); the row is counted as route NOT applied.
      routeNotApplied: 1,
      crm: { customersDiffer: 0, shopsDiffer: 1, byField: [{ field: 'address', count: 1 }] },
      unchangedCustomers: 1,
    });
  });

  // Owner's answers 2026-11-11 (A5).
  it('counts the rows whose codes were read in capitals, and expects a lookalike shop code to be rejected', async () => {
    staged = [
      parsed({ custCode: 'C1', branchCode: '1', capitalised: [{ cell: 'cust_code', from: 'c1', to: 'C1' }] }),
      parsed({ custCode: 'C2', branchCode: '01' }),
    ];
    customers = [customer('C1'), customer('C2')];
    // C1's only shop is C1-01, which the row's "1" does not name: it is found by the customer's id.
    shops = [shop('C1-01', 'id-C1'), shop('C2-01', 'id-C2')];
    const s = await load();
    expect(calls.filter((c) => c.model === 'branch.ofCustomer').map((c) => c.args.where.customerId)).toEqual([
      { in: ['id-C1', 'id-C2'] },
    ]);
    expect(s).toMatchObject({
      codesCapitalised: 1,
      expectRejected: { customers: 1, rows: 1 },
      unchangedCustomers: 1,
    });
    expect(s.expectRejected.reasons.map((r) => r.reason)).toEqual([
      "a branch_code that only looks like one of the customer's shops or rows (01 / 1, Ab / AB)",
    ]);
  });

  it('a Temix code staged in lower case (an older batch) is folded as Promote folds it: the refresh lane', async () => {
    staged = [parsed({ temixCode: ' caa0367 ', paymentTerms: 'CREDIT', paymentTermsPresent: true, creditLimit: 750 })];
    customers = [customer('C1', { temixCode: 'caa0367', paymentTerms: 'CREDIT', creditLimit: 500 })];
    shops = [shop('C1-01', 'id-C1')];
    expect(await load()).toMatchObject({ temix: { customersOnRefresh: 1, customersChanged: 1 }, credit: { rows: 0 } });
  });

  it('the live-shop count decides whether a row with no branch_code is expected to be rejected', async () => {
    staged = [parsed({ branchCode: null })];
    customers = [customer('C1', { _count: { branches: 2 } })];
    expect((await load()).expectRejected).toEqual({
      customers: 1,
      rows: 1,
      reasons: [{ reason: 'no branch_code, for a customer that already has shops', customers: 1 }],
    });
    customers = [customer('C1', { _count: { branches: 0 } })];
    expect((await load()).expectRejected.customers).toBe(0);
  });

  // Code review 2026-11-10, finding 7.
  it('a new customer code that is a live customer\'s Temix code is counted as expected to be rejected', async () => {
    staged = [parsed({ custCode: 'CAA0999', branchCode: '01' })];
    customers = [customer('NMWC-2026-000123', { temixCode: 'caa0999' })];
    expect((await load()).expectRejected).toEqual({
      customers: 1,
      rows: 1,
      reasons: [{ reason: "a new customer code that is already another live customer's Temix code", customers: 1 }],
    });
    customers = [customer('NMWC-2026-000123', { temixCode: 'caa0999', deletedAt: new Date() })];
    expect((await load()).expectRejected.customers).toBe(0);
  });

  it('with the option on the same rows are counted as replaced, not kept — the counts are the same', async () => {
    staged = [parsed({ custName: 'Older Name', address: 'Older address' })];
    customers = [customer('C1')];
    shops = [shop('C1-01', 'id-C1')];
    const off = await load(false);
    const on = await load(true);
    expect(off.crm).toEqual(on.crm);
    expect(off.crm).toMatchObject({ customersDiffer: 1, shopsDiffer: 1 });
  });

  it(`asks for customers and shops ${SUMMARY_CHUNK.toLocaleString('en-US')} at a time`, async () => {
    const n = SUMMARY_CHUNK + 500;
    staged = Array.from({ length: n }, (_, i) => parsed({ custCode: `N${i}`, branchCode: '01' }));
    const s = await load();
    expect(s).toMatchObject({ rows: n, customers: n, created: { customers: n, shops: n } });
    const sizes = (model: string) => calls.filter((c) => c.model === model).map((c) => Object.values(c.args.where)[0]!.in!.length);
    expect(sizes('customer')).toEqual([SUMMARY_CHUNK, 500]);
    expect(sizes('customer.temixCode')).toEqual([SUMMARY_CHUNK, 500]);
    // n composed codes and the one bare code they share.
    expect(sizes('branch')).toEqual([SUMMARY_CHUNK, 501]);
  });

  it('rows with no customer code are not counted, as Promote skips them', async () => {
    staged = [parsed({ custCode: '' }), { nothing: true }, parsed()];
    expect(await load()).toMatchObject({ rows: 1, customers: 1 });
  });
});

describe('summariseCustomerBatchAction', () => {
  const ask = (batchId = 'batch-9') => {
    const fd = new FormData();
    if (batchId) fd.set('batchId', batchId);
    return summariseCustomerBatchAction(fd);
  };

  it('the Steward gets the counts and the sentences, worded for the batch’s option as it is now', async () => {
    staged = [parsed({ custName: 'Older Name' })];
    customers = [customer('C1')];
    shops = [shop('C1-01', 'id-C1')];
    const off = await ask();
    if (!off.ok) throw new Error(JSON.stringify(off));
    expect(off.data.overwrite).toBe(false);
    expect(off.data.summary.crm.customersDiffer).toBe(1);
    expect(off.data.lines.map((l) => l.text)).toEqual([
      'Checked 1 clean row for 1 customer against the CRM as it is now.',
      'CRM fields kept: on 1 customer(s) and 0 shop(s) the sheet differs from the record. Their values stay as they are on record (name 1).',
      'This is a check, not a lock: Promote works from the CRM as it is at that moment.',
    ]);
    h.batch = { kind: 'CUSTOMER', overwriteCrmFields: true };
    const on = await ask();
    if (!on.ok) throw new Error(JSON.stringify(on));
    expect(on.data.overwrite).toBe(true);
    expect(on.data.lines[1]).toEqual({
      tone: 'danger',
      text: "CRM fields REPLACED: on 1 customer(s) and 0 shop(s) the values on record will be replaced by this sheet's (name 1).",
    });
    expect(h.limitKeys).toEqual(['import-summary:stew', 'import-summary:stew']);
  });

  it.each(['SALESMAN', 'SUPERVISOR', 'MANAGER', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'SALES_DIRECTOR', 'VIEWER'])(
    'a %s is refused before anything is read',
    async (role) => {
      h.role = role;
      const res = await ask();
      expect(res.ok).toBe(false);
      expect(calls).toEqual([]);
      expect(h.limitKeys).toEqual([]);
    }
  );

  it('an account-master batch, a missing batch and a missing id are refused; a spent limit says how long to wait', async () => {
    h.batch = { kind: 'ACCOUNT', overwriteCrmFields: false };
    expect(JSON.stringify(await ask())).toContain('not a customer import');
    h.batch = null;
    expect((await ask()).ok).toBe(false);
    expect(JSON.stringify(await ask(''))).toContain('required');
    h.batch = { kind: 'CUSTOMER', overwriteCrmFields: false };
    h.limit = { ok: false, retryAfterSec: 5 };
    expect(JSON.stringify(await ask())).toContain('Wait 5s before checking this batch again.');
    expect(calls).toEqual([]);
  });

  // Code review 2026-11-10, finding 6.
  it('says when and by whom the batch was uploaded and how old it is, and whether it is too old to promote', async () => {
    staged = [parsed()];
    const fresh = await ask();
    if (!fresh.ok) throw new Error(JSON.stringify(fresh));
    expect(fresh.data.staged).toMatchObject({ uploadedBy: 'ZZ Steward', age: '2 days ago', expired: false, expiredMessage: null, maxAgeDays: 7 });
    expect(fresh.data.newer).toEqual({ customers: 0, examples: [], refusal: null });
    h.uploadedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const old = await ask();
    if (!old.ok) throw new Error(JSON.stringify(old));
    expect(old.data.staged.expired).toBe(true);
    expect(old.data.staged.expiredMessage).toMatch(/^This batch was uploaded 9 days ago/);
  });

  it('names the customers a newer upload already loaded, with the refusal the promote gives', async () => {
    staged = [parsed()];
    h.newer = [{ code: 'C1', filename: 'newer.xlsx', rowNumber: 3 }];
    const res = await ask();
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(res.data.newer.customers).toBe(1);
    expect(res.data.newer.refusal!.startsWith('1 customer(s) in this batch (for example C1) were loaded since from a newer upload ("newer.xlsx")')).toBe(true);
  });
});
