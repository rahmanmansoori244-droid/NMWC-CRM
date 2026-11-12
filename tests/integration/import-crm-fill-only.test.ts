// @vitest-environment node
/**
 * Code review 2026-11-10, finding 1 — against Postgres, through the real upload,
 * the real "Before you promote" check, the real option action and the real promote.
 *
 * What was wrong: re-loading a customer sheet replaced what salesmen had
 * collected. For a customer with no Temix code on record (about 3,300 seeded
 * ones), and for every customer when the sheet had no column spelt exactly
 * `temix_code`, the import wrote the sheet's name, phone, contact, shop address,
 * visit day and status over the record, reopened a shop an approved request had
 * closed, dropped the credit cells without a word, and marked the row PROMOTED.
 *
 * Proven here:
 *   - an "old" sheet over a customer with two shops, one CLOSED: nothing on record
 *     is replaced, blanks are filled, the route the sheet names for a shop that
 *     exists is NOT applied (owner's answer 2026-11-11, "A1 stop"; until then it
 *     moved the shop), the CLOSED shop stays CLOSED, each row says what was kept and which credit cells were not applied,
 *     no audit row is written for a kept field, and the check's counts are what
 *     Promote then did;
 *   - the same sheet with "Overwrite CRM fields from this sheet" switched on:
 *     replaced as before, every audit row marked, the switch audited, and the
 *     option off again when the batch finishes;
 *   - who may switch it, and when;
 *   - a sheet with no temix_code column is refused when it names a customer linked
 *     to Temix (no batch is created), and accepted, with its unread headings
 *     listed, when it names none;
 *   - a `Temix code` heading is the temix_code column: the row takes the refresh
 *     lane and its credit limit is applied.
 *
 *   RUN_IMPORT_TESTS=1 npx vitest run tests/integration/import-crm-fill-only.test.ts
 */
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';
import { overwriteOn, promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

type Cells = Record<string, string | number>;

/** A workbook whose headings are exactly the keys of its first row. */
async function workbook(rows: Cells[]): Promise<Uint8Array<ArrayBuffer>> {
  const headings = Object.keys(rows[0]!);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(headings);
  for (const r of rows) ws.addRow(headings.map((h) => r[h] ?? ''));
  const out = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out));
  return bytes;
}

describe.skipIf(!ENABLED)('finding 1: an import fills blank CRM fields only, unless the batch says otherwise', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  let review: typeof import('@/services/import-review');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZFO-${tag}`;
  const REGION = `ZZFO${tag}R`;
  const ROUTE1 = `ZZFO${tag}-R1`;
  const ROUTE2 = `ZZFO${tag}-R2`;
  const steward = `${P}-stew`;
  const manager = `${P}-mgr`;
  const batchIds: string[] = [];
  let regionId = '';
  let route1 = '';
  let route2 = '';
  const base = parseInt(tag.slice(0, 6), 16) % 1_000_000;
  const phone = (n: number) => `+9689${String((base * 10 + n) % 10_000_000).padStart(7, '0')}`;
  const cr = `77${String(base).padStart(6, '0')}`;

  const X = `${P}-X`; // no Temix code on record: the seeded shape
  const L = `${P}-L`; // linked to Temix
  const S = `${P}-S`; // seeded, no shop yet

  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const send = async (rows: Cells[], name = `${P}.xlsx`) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const f = new FormData();
    f.set('file', new File([await workbook(rows)], name, { type: XLSX_MIME }));
    return imports.uploadCustomerMasterAction(f);
  };
  const upload = async (rows: Cells[], name?: string) => {
    const res = await send(rows, name);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = (res as { ok: true; data: { batchId: string; notRead: string[] } }).data;
    batchIds.push(data.batchId);
    return data;
  };
  const check = async (batchId: string) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const res = await review.summariseCustomerBatchAction(fd({ batchId }));
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.data;
  };
  const promoteOnce = async (batchId: string) => {
    const res = await imports.promoteCustomerBatchAction(fd({ batchId }));
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.data;
  };
  const notesOf = async (batchId: string) =>
    (await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' }, select: { state: true, issues: true } })).map(
      (r) => ({ state: r.state, issues: (r.issues as Array<{ field: string; message: string }> | null) ?? [] })
    );
  const customerOf = (code: string) =>
    prisma.customer.findUniqueOrThrow({
      where: { nmwcCode: code },
      include: { branches: { orderBy: { branchCode: 'asc' } } },
    });
  const auditOf = async (entityId: string, batchId: string) =>
    (
      await prisma.auditLog.findMany({
        where: { entityId, reason: { startsWith: `import ${batchId} ` } },
        orderBy: { at: 'asc' },
      })
    ).map((a) => ({ action: a.action, before: a.before as Record<string, unknown> | null, after: a.after as Record<string, unknown> }));

  /** The sheet as it was before the salesmen's corrections were approved: every CRM value older. */
  const oldSheet = (): Cells[] => [
    {
      cust_code: X,
      cust_name: 'ZZ Old Name',
      branch_code: `${X}-01`,
      branch_name: 'ZZ Old Shop Name',
      sales_region: REGION,
      route: ROUTE2, // Temix moved the shop
      address: 'Old address 1',
      phone: phone(2),
      contact_person: 'ZZ Old Contact',
      cr_no: cr, // the record has none: filled
      payment_terms: 'CASH',
      credit_limit: 750,
      payment_term_days: 30,
      temix_code: '',
      day_of_visit: 'MON',
      customer_status: 'ACTIVE',
    },
    {
      cust_code: X,
      cust_name: 'ZZ Old Name',
      branch_code: `${X}-02`,
      branch_name: '',
      sales_region: REGION,
      route: ROUTE1,
      address: 'Old address 2',
      phone: phone(2),
      contact_person: 'ZZ Old Contact',
      cr_no: cr,
      payment_terms: 'CASH',
      credit_limit: '',
      payment_term_days: '',
      temix_code: '',
      day_of_visit: 'TUE',
      customer_status: 'ACTIVE', // the shop was closed by an approved request
    },
  ];
  const closedAt = new Date('2026-10-20T09:00:00Z');

  beforeAll(async () => {
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    review = await import('@/services/import-review');
    regionId = (await prisma.region.create({ data: { code: REGION, name: `ZZ FO ${tag}` } })).id;
    route1 = (await prisma.route.create({ data: { code: ROUTE1, name: `ZZ FO1 ${tag}`, regionId } })).id;
    route2 = (await prisma.route.create({ data: { code: ROUTE2, name: `ZZ FO2 ${tag}`, regionId } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ FO Steward', role: 'STEWARD' } });
    await prisma.user.create({ data: { id: manager, username: manager, passwordHash: 'x', fullName: 'ZZ FO Manager', role: 'MANAGER' } });
    // X as the field left it: name, phone, contact and shop details approved in the app.
    const x = await prisma.customer.create({
      data: {
        nmwcCode: X,
        legalName: 'ZZ Field Name',
        paymentTerms: 'CASH',
        primaryPhone: phone(1),
        primaryPhoneNorm: phone(1),
        contactPerson: 'ZZ Field Contact',
        status: 'ACTIVE',
      },
    });
    await prisma.branch.create({
      data: { customerId: x.id, branchCode: `${X}-01`, branchName: 'ZZ Field Shop', address: 'Approved address 1', regionId, routeId: route1, dayOfVisit: 'SUN', status: 'ACTIVE' },
    });
    await prisma.branch.create({
      data: { customerId: x.id, branchCode: `${X}-02`, branchName: 'Main', address: 'Address pending', regionId, routeId: route1, dayOfVisit: null, status: 'CLOSED', lastStatusChangeAt: closedAt },
    });
    const l = await prisma.customer.create({
      data: { nmwcCode: L, legalName: 'ZZ Linked CRM Name', temixCode: L, paymentTerms: 'CREDIT', creditLimit: 500, paymentTermDays: 30, temixSyncState: 'SYNCED' },
    });
    await prisma.branch.create({
      data: { customerId: l.id, branchCode: `${L}-01`, branchName: 'Main', address: 'Linked address 1', regionId, routeId: route1 },
    });
    await prisma.customer.create({ data: { nmwcCode: S, legalName: 'ZZ Seeded Name', paymentTerms: 'CASH' } });
  });

  beforeEach(() => {
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: P } }, select: { id: true } });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: { in: [steward, manager] } } });
      await prisma.notification.deleteMany({ where: { userId: { in: [steward, manager] } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: { in: [route1, route2] } } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: { in: [steward, manager] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('an old sheet, the option off: nothing on record is replaced, blanks are filled, the route is NOT applied, the closed shop stays closed', async () => {
    const before = await customerOf(X);
    const { batchId, notRead } = await upload(oldSheet());
    expect(notRead).toEqual([]);

    // What the Steward is shown before Promote.
    const told = await check(batchId);
    expect(told.overwrite).toBe(false);
    expect(told.summary).toMatchObject({
      rows: 2,
      customers: 1,
      created: { customers: 0, shops: 0, closedCustomersReopened: 0 },
      // Owner's answer 2026-11-11 ("A1 stop"): this pinned temix.shopsRouteMoved: 1.
      temix: { customersOnRefresh: 0 },
      routeNotApplied: 1,
      crm: { customersFilled: 1, shopsFilled: 1, customersDiffer: 1, shopsDiffer: 2, shopsWouldReopen: 1, shopsWouldClose: 0 },
      credit: { rows: 1, reasons: [{ reason: 'NO_CODE_ON_RECORD', rows: 1 }] },
      expectRejected: { customers: 0 },
      unchangedCustomers: 0,
    });
    const said = told.lines.map((l) => l.text);
    expect(said).toContain('Checked 2 clean rows for 1 customer against the CRM as it is now.');
    expect(said).toContain('Blank CRM fields filled: 1 customer(s), 1 shop(s).');
    expect(said.find((t) => t.startsWith('CRM fields kept: on 1 customer(s) and 2 shop(s)'))).toContain(
      'The sheet would have reopened 1 closed shop(s) and closed 0 open shop(s); they stay as they are.'
    );
    expect(said.some((t) => t.startsWith('Credit cells not applied: 1 row(s)'))).toBe(true);
    expect(said).toContain(
      'Route NOT applied: 1 row(s) name a route other than the current route of their shop, which is already in the CRM. The rest of each row loads as the lines here say; the route does not. The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.'
    );

    const out = await promoteOnce(batchId);
    expect(out).toMatchObject({
      promoted: 2,
      failed: 0,
      done: true,
      notes: { kept: 2, replaced: 0, creditNotApplied: 1, routeNotApplied: 1 },
    });

    const after = await customerOf(X);
    // The customer: what the field collected is still there; the blank CR number was filled.
    expect(after).toMatchObject({
      legalName: 'ZZ Field Name',
      primaryPhone: phone(1),
      primaryPhoneNorm: phone(1),
      contactPerson: 'ZZ Field Contact',
      crNumber: cr,
      status: 'ACTIVE',
      paymentTerms: 'CASH',
      creditLimit: null,
      paymentTermDays: null,
    });
    const [b1, b2] = after.branches;
    const [was1, was2] = before.branches;
    // Shop 1: still on its route (route 2 in the sheet is NOT applied: owner's answer
    // 2026-11-11; this pinned the move to route 2). Its name, address and visit day
    // are the CRM's, so nothing of it changed and it was not written at all.
    expect(b1).toMatchObject({ routeId: route1, branchName: 'ZZ Field Shop', address: 'Approved address 1', dayOfVisit: 'SUN', status: 'ACTIVE' });
    expect(b1!.version).toBe(was1!.version);
    // Shop 2: its placeholder address and missing visit day were filled; it is still CLOSED,
    // and the day it was closed (reactivation evidence is dated against it) has not moved.
    expect(b2).toMatchObject({ address: 'Old address 2', dayOfVisit: 'TUE', status: 'CLOSED', branchName: 'Main' });
    expect(b2!.lastStatusChangeAt?.toISOString()).toBe(closedAt.toISOString());
    expect(was2!.status).toBe('CLOSED');

    // Each row says what was kept, and which credit cells were not applied.
    expect(await notesOf(batchId)).toEqual([
      {
        state: 'PROMOTED',
        issues: [
          {
            field: '_route',
            message: `shop ${X}-01: the sheet names route ${ROUTE2}; the shop is on route ${ROUTE1}. The route was NOT applied; the shop stays on its current route. Route moves are made in Temix.`,
          },
          {
            field: '_kept',
            message:
              'customer: the name, phone and contact person in this row differ from the record and were kept — an import fills blank CRM fields only',
          },
          {
            field: '_kept',
            message: `shop ${X}-01: the shop name, address and visit day in this row differ from the record and were kept — an import fills blank CRM fields only`,
          },
          {
            field: '_credit',
            message:
              'the credit_limit and payment_term_days in this row were not applied — this customer has no Temix code on record, and credit figures are taken only from a row carrying the Temix code already recorded for the customer',
          },
        ],
      },
      {
        state: 'PROMOTED',
        issues: [
          {
            field: '_kept',
            message: `shop ${X}-02: the status in this row differs from the record and was kept — an import fills blank CRM fields only, and does not open or close a shop`,
          },
        ],
      },
    ]);

    // The audit log has a row for what changed, and none for what was kept.
    const customerAudit = await auditOf(after.id, batchId);
    expect(customerAudit.map((a) => [a.action, Object.keys(a.before ?? {}).sort()])).toEqual([['UPDATE', ['crNumber', 'crNumberNorm']]]);
    expect(customerAudit[0]!.after).not.toHaveProperty('overwriteCrmFields');
    // No route change is recorded for shop 1: the row's note is the record.
    expect(await auditOf(b1!.id, batchId)).toEqual([]);
    expect((await auditOf(b2!.id, batchId)).map((a) => [a.action, Object.keys(a.before ?? {}).sort()])).toEqual([
      ['UPDATE', ['address', 'dayOfVisit']],
    ]);
    // No status row: neither the shop nor the customer was opened or closed.
    expect(
      await prisma.auditLog.count({ where: { entityId: { in: [after.id, b1!.id, b2!.id] }, action: { in: ['CLOSE', 'REACTIVATE'] } } })
    ).toBe(0);

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    // The end-of-load notice counts the row whose route was not applied.
    expect(batch).toMatchObject({ status: 'PROMOTED', overwriteCrmFields: false, overwriteCrmFieldsAt: null, shopNotChangedRows: 1 });
    const slice = await prisma.auditLog.findFirstOrThrow({ where: { action: 'IMPORT', entityType: 'ImportBatch', entityId: batchId } });
    expect(slice.after).toMatchObject({ overwriteCrmFields: false, rowsKept: 2, rowsReplaced: 0, rowsCreditNotApplied: 1 });
  });

  it('who may switch the option, and when', async () => {
    const { batchId } = await upload(oldSheet());
    const flag = async () => (await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).overwriteCrmFields;
    const reason = 'A deliberate bulk correction agreed with the owner';

    // Not a Manager — nor anyone but the Data Steward.
    current = { id: manager, role: 'MANAGER', username: manager };
    expect(await fixes.setImportOverwriteAction(fd({ batchId, on: 'on', reason }))).toMatchObject({ ok: false });
    expect(await flag()).toBe(false);
    expect((await review.summariseCustomerBatchAction(fd({ batchId }))).ok).toBe(false);
    current = { id: steward, role: 'STEWARD', username: steward };

    // Not without a reason.
    const bare = await fixes.setImportOverwriteAction(fd({ batchId, on: 'on', reason: 'short' }));
    expect(JSON.stringify(bare)).toContain('Say why this sheet should replace CRM fields (10+ characters).');
    expect(await flag()).toBe(false);

    // Not part-way through a promote: an interrupted batch resumes under the option it started with.
    await prisma.importBatch.update({ where: { id: batchId }, data: { status: 'PROMOTING', promoteLeaseBy: null, promoteLeaseUntil: null } });
    const mid = await fixes.setImportOverwriteAction(fd({ batchId, on: 'on', reason }));
    expect(JSON.stringify(mid)).toContain(
      'This batch is part-way through a promote — resume it first. The option cannot change in the middle of a load.'
    );
    expect(await flag()).toBe(false);
    await prisma.importBatch.update({ where: { id: batchId }, data: { status: 'READY' } });

    // On, with a reason: dated and audited; off again: audited, the date kept.
    expect(await fixes.setImportOverwriteAction(fd({ batchId, on: 'on', reason }))).toEqual({ ok: true, data: { on: true } });
    const on = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(on.overwriteCrmFields).toBe(true);
    expect(on.overwriteCrmFieldsAt).toBeInstanceOf(Date);
    expect(await fixes.setImportOverwriteAction(fd({ batchId, on: 'off' }))).toEqual({ ok: true, data: { on: false } });
    const off = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect([off.overwriteCrmFields, off.overwriteCrmFieldsAt?.getTime()]).toEqual([false, on.overwriteCrmFieldsAt!.getTime()]);
    const switches = await prisma.auditLog.findMany({
      where: { action: 'UPDATE', entityType: 'ImportBatch', entityId: batchId },
      orderBy: { at: 'asc' },
    });
    expect(switches.map((a) => [a.actorId, a.reason, a.before, a.after])).toEqual([
      [steward, `Overwrite CRM fields from this sheet switched ON: ${reason}`, { overwriteCrmFields: false }, { overwriteCrmFields: true }],
      [steward, 'Overwrite CRM fields from this sheet switched off', { overwriteCrmFields: true }, { overwriteCrmFields: false }],
    ]);
    // The batch is left unpromoted: exclude nothing, it is deleted with the suite.
  });

  it('the same sheet with the option ON: replaced as every re-import did, each audit row marked, and the option off again at the finish', async () => {
    const before = await customerOf(X);
    const { batchId } = await upload(oldSheet());
    await overwriteOn(batchId, 'Bulk correction: this sheet is right about these shops');

    const told = await check(batchId);
    expect(told.overwrite).toBe(true);
    const replaced = told.lines.find((l) => l.tone === 'danger')!;
    expect(replaced.text).toMatch(/^CRM fields REPLACED: on 1 customer\(s\) and 2 shop\(s\) the values on record will be replaced by this sheet's/);
    expect(replaced.text).toContain('1 closed shop(s) will be reopened and 0 open shop(s) closed.');
    expect(told.lines.some((l) => l.text.startsWith('CRM fields kept'))).toBe(false);

    const out = await promoteOnce(batchId);
    expect(out).toMatchObject({ promoted: 2, failed: 0, done: true, notes: { kept: 0, replaced: 2, creditNotApplied: 1 } });

    const after = await customerOf(X);
    expect(after).toMatchObject({ legalName: 'ZZ Old Name', primaryPhoneNorm: phone(2), contactPerson: 'ZZ Old Contact', status: 'ACTIVE' });
    const [b1, b2] = after.branches;
    // Owner's answer 2026-11-11: the option replaces CRM fields, never the route (this pinned routeId: route2).
    expect(b1).toMatchObject({ branchName: 'ZZ Old Shop Name', address: 'Old address 1', dayOfVisit: 'MON', routeId: route1 });
    // The sheet reopened the closed shop, and the day of that change moved.
    expect(b2!.status).toBe('ACTIVE');
    expect(b2!.lastStatusChangeAt!.getTime()).toBeGreaterThan(closedAt.getTime());

    // Every replaced value is in the audit log, before and after, marked as an overwrite.
    const [customerAudit] = await auditOf(after.id, batchId);
    expect(customerAudit).toMatchObject({
      action: 'UPDATE',
      before: { legalName: 'ZZ Field Name', contactPerson: 'ZZ Field Contact', primaryPhoneNorm: phone(1) },
      after: { legalName: 'ZZ Old Name', contactPerson: 'ZZ Old Contact', lane: 'full', overwriteCrmFields: true },
    });
    const [shopAudit] = await auditOf(b1!.id, batchId);
    expect(shopAudit).toMatchObject({
      before: { branchName: 'ZZ Field Shop', address: 'Approved address 1', dayOfVisit: 'SUN' },
      after: { address: 'Old address 1', dayOfVisit: 'MON', overwriteCrmFields: true },
    });
    expect(shopAudit!.before).not.toHaveProperty('routeId');
    expect(shopAudit!.after).not.toHaveProperty('routeId');
    expect((await auditOf(b2!.id, batchId))[0]).toMatchObject({ before: { status: 'CLOSED' }, after: { status: 'ACTIVE', overwriteCrmFields: true } });
    expect(before.branches[1]!.status).toBe('CLOSED');

    // A row loads as it did before the change: no "kept" note; the credit cells still say why.
    // ... and, since 2026-11-11, the route it named that was not applied.
    expect((await notesOf(batchId)).map((r) => r.issues.map((i) => i.field))).toEqual([['_route', '_credit'], []]);

    // One deliberate load: off again, with the date it was switched on kept as the record.
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('PROMOTED');
    expect(batch.overwriteCrmFields).toBe(false);
    expect(batch.overwriteCrmFieldsAt).toBeInstanceOf(Date);
    const slice = await prisma.auditLog.findFirstOrThrow({ where: { action: 'IMPORT', entityType: 'ImportBatch', entityId: batchId } });
    expect(slice.after).toMatchObject({ overwriteCrmFields: true, rowsKept: 0, rowsReplaced: 2, rowsCreditNotApplied: 1 });
  });

  it('a sheet with no temix_code column: refused when it names a customer linked to Temix, accepted with its unread headings when it names none', async () => {
    const batchesBefore = await prisma.importBatch.count({ where: { uploadedById: steward } });
    // The agreed daily-file shape: no temix_code, and headings the import does not read.
    const daily = (code: string): Cells => ({
      cust_code: code,
      branch_code: `${code}-01`,
      cust_name: 'ZZ Daily Name',
      route: ROUTE1,
      terms: 'CREDIT',
      limit: 900,
      days: 45,
      status: 'ACTIVE',
    });
    const refused = await send([daily(X), daily(L)]);
    expect(refused.ok).toBe(false);
    expect((refused as { fields?: Record<string, string> }).fields?.file).toBe(
      `This sheet has no temix_code column, and 1 of its customers already has a Temix code in the CRM (for example ${L}). Nothing was uploaded. Without that column the import cannot tell which rows are a Temix refresh, and their credit limit and credit days would be ignored. Add a column headed temix_code holding each customer's Temix code (it is on the customer page; leave the cell blank for a customer not yet in Temix) and upload again. A Temix extract is not loaded through this screen.`
    );
    // Nothing was staged: no batch, no rows.
    expect(await prisma.importBatch.count({ where: { uploadedById: steward } })).toBe(batchesBefore);

    const accepted = await upload([daily(X)]);
    expect(accepted.notRead).toEqual(['terms', 'limit', 'days', 'status']);
    const [row] = await prisma.importRow.findMany({ where: { batchId: accepted.batchId } });
    expect(row!.state).toBe('CLEAN');
    expect(row!.parsed).toMatchObject({ custCode: X, temixCode: null, creditLimit: null, paymentTermsPresent: false });
  });

  it('a `Temix code` heading is the temix_code column: the row takes the refresh lane, and its credit limit is applied', async () => {
    const { batchId, notRead } = await upload([
      {
        'Cust Code': L,
        'Cust Name': 'ZZ ERP Wants To Rename',
        'Branch Code': `${L}-01`,
        Address: 'An ERP address',
        'Payment Terms': 'CREDIT',
        'Credit Limit': 900,
        'Payment Term Days': 45,
        'Temix code': L.toLowerCase(),
      },
    ]);
    expect(notRead).toEqual([]);
    const told = await check(batchId);
    expect(told.summary).toMatchObject({
      temix: { customersOnRefresh: 1, customersChanged: 1 },
      crm: { customersDiffer: 0, linkedShops: 1 },
      credit: { rows: 0 },
    });
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1, failed: 0 });
    const l = await customerOf(L);
    expect(Number(l.creditLimit)).toBe(900);
    expect(l.paymentTermDays).toBe(45);
    // The refresh lane writes Temix's fields only: the CRM's name and the shop's address are untouched.
    expect(l.legalName).toBe('ZZ Linked CRM Name');
    expect(l.branches[0]!.address).toBe('Linked address 1');
    const [audit] = await auditOf(l.id, batchId);
    expect(audit).toMatchObject({ action: 'UPDATE', before: { creditLimit: '500', paymentTermDays: 30 }, after: { lane: 'refresh' } });
    const [row] = await notesOf(batchId);
    // Owner's answer 2026-11-11 (A5): the Temix code typed in small letters is noted too.
    expect(row!.issues.map((i) => i.field)).toEqual(['_lane', '_capitals']);
  });

  it('a go-live-shaped row over a seeded customer, the option off: the shop is created, the name on record kept, and the row says so', async () => {
    const { batchId } = await upload([
      {
        cust_code: S,
        cust_name: 'ZZ Master Name',
        branch_code: `${S}-01`,
        sales_region: REGION,
        route: ROUTE1,
        address: 'Way 21, Muscat',
        temix_code: S, // every builder row carries one; the record has none
      },
    ]);
    const told = await check(batchId);
    expect(told.summary).toMatchObject({ created: { customers: 0, shops: 1, shopsOnExisting: 1 }, crm: { customersDiffer: 1 } });
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1, failed: 0 });
    const s = await customerOf(S);
    expect(s.legalName).toBe('ZZ Seeded Name');
    expect(s.temixCode).toBeNull();
    expect(s.branches.map((b) => [b.branchCode, b.address, b.routeId, b.status])).toEqual([[`${S}-01`, 'Way 21, Muscat', route1, 'ACTIVE']]);
    expect((await notesOf(batchId))[0]!.issues).toEqual([
      {
        field: '_kept',
        message: 'customer: the name in this row differs from the record and was kept — an import fills blank CRM fields only',
      },
    ]);
  });
});
