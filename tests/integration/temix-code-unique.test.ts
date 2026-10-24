// @vitest-environment node
/**
 * Owner decisions 2026-10-25 on Postgres.
 *
 * (1) Temix codes are unique, and the database enforces it: one LIVE customer
 *     per code, compared upper case with the ends trimmed (the partial unique
 *     index of migration 20261025120000_temix_code_unique).
 *       - a second live customer is refused in any spelling, by a model write
 *         and by a raw one, and the refusal names the customer holding the code
 *         (lib/temix-code.ts temixCodeRefusal); a path that does not translate it
 *         is told the rule (lib/errors.ts runAction);
 *       - an archived customer keeps its code out of the index (the application
 *         still refuses to reuse it: temixCodeHolder), and bringing it back while
 *         a live customer holds the code is refused;
 *       - the approval's finalize: an older row holding the code with an outer
 *         space is not seen by finalize's own check, so the database refuses the
 *         new customer; the Accountant is told who holds the code, in the code
 *         box, and nothing was approved;
 *       - the customer import: a row whose code a live customer holds in another
 *         spelling is rejected, naming that customer; nothing is created.
 * (2) CR numbers are NOT unique, but every shared one is flagged: two live
 *     customers on one CR are both counted by the nightly cr-number-shared check
 *     (information), and the duplicates detector pairs them by its CR rule.
 *
 * Synthetic ZZ rows only (createFlowFixture's tag), removed in afterAll. UAT is
 * shared, so the nightly count is read before and after and the difference is
 * asserted.
 *
 *   RUN_TEMIX_UNIQUE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/temix-code-unique.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createFlowFixture } from '../support/create-flow-fixture';
import { purgeAuditLog, purgeHistory } from '../support/audit';
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ENABLED = process.env.RUN_TEMIX_UNIQUE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const fx = createFlowFixture('zztu', (u) => {
  current = u;
});

const HEADERS = [
  'cust_code', 'cust_name', 'branch_code', 'sales_region', 'route', 'address',
  'phone', 'contact_person', 'cr_no', 'payment_terms', 'credit_limit',
  'payment_term_days', 'temix_code', 'day_of_visit',
] as const;
type Row = Partial<Record<(typeof HEADERS)[number], string | number>>;

async function sheet(rows: Row[]): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(HEADERS as unknown as string[]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as unknown as Uint8Array);
  return new File([buf], 'temix-code-unique.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe.skipIf(!ENABLED)('owner decisions 2026-10-25: Temix codes unique, CR numbers flagged', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let creates: typeof import('@/services/creates');
  let imports: typeof import('@/services/imports');
  let tc: typeof import('@/lib/temix-code');
  let dbErrors: typeof import('@/lib/db-errors');
  const P = fx.TAG;
  const steward = `${fx.tag}-stew`;
  const made: string[] = [];

  const customer = async (suffix: string, data: Record<string, unknown> = {}) => {
    const c = await prisma.customer.create({
      data: { nmwcCode: `${P}-${suffix}`, legalName: `ZZ TU ${suffix} ${fx.tag}`, paymentTerms: 'CASH', ...data },
    });
    made.push(c.id);
    return c;
  };
  /** The error a write rejects with (the test fails when it does not reject). */
  const refused = async (write: Promise<unknown>): Promise<unknown> => {
    try {
      await write;
    } catch (e) {
      return e;
    }
    throw new Error('the write was not refused');
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    imports = await import('@/services/imports');
    tc = await import('@/lib/temix-code');
    dbErrors = await import('@/lib/db-errors');
    await fx.setup(prisma);
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: `ZZ TU Steward ${fx.tag}`, role: 'STEWARD' } });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await fx.cleanup();
      const batches = await prisma.importBatch.findMany({ where: { uploadedById: steward }, select: { id: true } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batches.map((b) => b.id) } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batches.map((b) => b.id) } } });
      const ours = await prisma.customer.findMany({ where: { nmwcCode: { startsWith: `${P}-` } }, select: { id: true } });
      const ids = [...new Set([...made, ...ours.map((c) => c.id)])];
      const branchIds = (await prisma.branch.findMany({ where: { customerId: { in: ids } }, select: { id: true } })).map((b) => b.id);
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: steward }, { entityId: { in: [...ids, ...branchIds] } }] } });
      await prisma.notification.deleteMany({ where: { userId: steward } });
      await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.rateLimit.deleteMany({ where: { key: { startsWith: `import:${steward}` } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: steward } });
      await purgeHistory(prisma, { customerIds: ids, branchIds, userIds: [steward] });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('the index is there, valid, and defined as the migration defines it', async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string; valid: boolean }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = ${dbErrors.TEMIX_CODE_UNIQUE_INDEX}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.def).toMatch(/^CREATE UNIQUE INDEX "Customer_temixCode_live_unique" ON public\."Customer" USING btree/);
    expect(rows[0]!.def).toContain('(upper(btrim("temixCode")))');
    expect(rows[0]!.def).toContain('WHERE (("deletedAt" IS NULL) AND ("temixCode" IS NOT NULL))');
  });

  it('a second live customer with the code is refused in any spelling, and the refusal names the holder', async () => {
    const code = `${P}-K1`;
    const holder = await customer('H1', { temixCode: code });
    for (const [i, spelling] of [code, code.toLowerCase(), ` ${code} `].entries()) {
      const e = await refused(prisma.customer.create({ data: { nmwcCode: `${P}-X${i}`, legalName: 'ZZ TU X', temixCode: spelling } }));
      expect(dbErrors.temixCodeIndexViolated(e), JSON.stringify(e)).toBe(true);
      expect(await tc.temixCodeRefusal(prisma, e, spelling)).toBe(tc.temixCodeTakenMessage(code, holder.nmwcCode));
    }
    // A raw write is refused too, and read the same way.
    const other = await customer('N1');
    const raw = await refused(prisma.$executeRaw`UPDATE "Customer" SET "temixCode" = ${code.toLowerCase()} WHERE "id" = ${other.id}`);
    expect(dbErrors.temixCodeIndexViolated(raw)).toBe(true);
    expect(await tc.temixCodeRefusal(prisma, raw, code, other.id)).toBe(tc.temixCodeTakenMessage(code, holder.nmwcCode));
    // A path that does not translate it is told the rule.
    const { runAction } = await import('@/lib/errors');
    expect(await runAction(() => prisma.customer.update({ where: { id: other.id }, data: { temixCode: code } }))).toEqual({
      ok: false,
      code: 'TEMIX_CODE_TAKEN',
      message: tc.TEMIX_CODE_UNIQUE_MESSAGE,
    });
    // The holder saving its own code again is no conflict; customers with no code never conflict.
    await prisma.customer.update({ where: { id: holder.id }, data: { temixCode: code } });
    await customer('N2');
    expect(await prisma.customer.count({ where: { id: { in: made }, temixCode: null } })).toBe(2);
    expect(await prisma.customer.count({ where: { nmwcCode: { startsWith: `${P}-X` } } })).toBe(0);
  });

  it('an archived customer keeps its code out of the index; bringing it back while a live one holds the code is refused', async () => {
    const code = `${P}-K2`;
    const archived = await customer('A2', { temixCode: code, deletedAt: new Date() });
    // The database allows a live customer the archived one's code ...
    const live = await customer('B2', { temixCode: code });
    // ... which the application never gives (temixCodeHolder names the archived one).
    expect(await tc.temixCodeHolder(prisma, code, live.id)).toEqual({ nmwcCode: archived.nmwcCode, archived: true, branchCode: null });
    const e = await refused(prisma.customer.update({ where: { id: archived.id }, data: { deletedAt: null } }));
    expect(dbErrors.temixCodeIndexViolated(e)).toBe(true);
    expect(await tc.temixCodeRefusal(prisma, e, code, archived.id)).toBe(tc.temixCodeTakenMessage(code, live.nmwcCode));
  });

  it('the approval’s finalize: an older row spelling the code with an outer space is named in the code box, and nothing is approved', async () => {
    const code = `${P}-K3`;
    const older = await customer('OLD3', { temixCode: ` ${code} ` });
    fx.as(fx.ids.salesman, 'SALESMAN');
    const name = `ZZ TU Finalize ${fx.tag}`;
    const sent = await creates.submitCreateAction(await fx.cashBody(name, 41));
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    const editId = sent.data.editId;
    fx.as(fx.ids.supervisor, 'SUPERVISOR');
    expect((await fx.decide('approve', editId)).ok).toBe(true);

    fx.as(fx.ids.accountant, 'ACCOUNTANT');
    // finalize's own check compares without trimming, so it does not see the older row ...
    expect(await tc.temixCodeHolder(prisma, code)).toBeNull();
    // ... and the database refuses the new customer: the Accountant is told who holds it.
    const message = tc.temixCodeTakenMessage(code, older.nmwcCode);
    expect(await fx.decide('approve', editId, { temixCode: code.toLowerCase() })).toEqual({
      ok: false,
      code: 'TEMIX_CODE_TAKEN',
      message,
      fields: { temixCode: message },
    });
    const edit = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect(edit).toMatchObject({ state: 'SUBMITTED', customerId: null });
    expect(await prisma.customer.count({ where: { legalName: name } })).toBe(0);

    // Another code goes through.
    const done = await fx.decide('approve', editId, { temixCode: `${P}-K4` });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(await prisma.customer.findFirstOrThrow({ where: { legalName: name }, select: { temixCode: true } })).toEqual({ temixCode: `${P}-K4` });
  });

  it('the customer import: a row whose code a live customer holds in another spelling is rejected naming it; nothing is created', async () => {
    const code = `${P}-K5`;
    const holder = await customer('OWN5', { temixCode: ` ${code.toLowerCase()} ` });
    current = { id: steward, role: 'STEWARD', username: steward };
    const fd = new FormData();
    fd.set(
      'file',
      await sheet([
        {
          cust_code: `${P}-IMP5`,
          cust_name: `ZZ TU Import ${fx.tag}`,
          branch_code: `${P}-IMP5-01`,
          sales_region: `${fx.TAG}G`,
          route: `${fx.TAG}R`,
          address: 'ZZ Way 5, synthetic',
          phone: '+96890555991',
          payment_terms: 'CASH',
          temix_code: code,
        },
      ])
    );
    const up = await imports.uploadCustomerMasterAction(fd);
    expect(up.ok, JSON.stringify(up)).toBe(true);
    if (!up.ok) return;
    const batchId = (up.data as { batchId: string }).batchId;
    const totals = await promoteFully(imports, batchId);
    expect(totals).toMatchObject({ promoted: 0, failed: 1 });
    const [row] = await prisma.importRow.findMany({ where: { batchId } });
    expect(row!.state).toBe('REJECTED');
    expect(row!.issues).toEqual([{ field: '_promote', message: tc.temixCodeTakenMessage(code, holder.nmwcCode) }]);
    expect(await prisma.customer.count({ where: { nmwcCode: `${P}-IMP5` } })).toBe(0);
  });

  it('CR numbers are not unique: two live customers share one, the nightly check counts both, and the duplicates detector pairs them', async () => {
    const { CHECK_BY_ID } = await import('@/lib/integrity/checks');
    const { pairCandidates } = await import('@/lib/duplicate-pairing');
    const check = CHECK_BY_ID.get('cr-number-shared')!;
    const ctx = () => ({ now: new Date(), previous: new Map() });
    const before = (await check.run!(prisma, ctx())).count;

    const cr = `ZZCR${P}`;
    const a = await customer('CR1', { crNumber: cr, crNumberNorm: cr });
    const b = await customer('CR2', { crNumber: ` ${cr.toLowerCase()} `, crNumberNorm: cr });
    // An archived customer on the CR is not counted.
    await customer('CR3', { crNumber: cr, crNumberNorm: cr, deletedAt: new Date() });

    const after = await check.run!(prisma, ctx());
    expect(after.count - before).toBe(2);
    expect(check.policy).toBe('info');

    // Read as services/duplicates findDuplicateCandidates reads the live customers.
    const live = await prisma.customer.findMany({
      where: { deletedAt: null, id: { in: made } },
      orderBy: { nmwcCode: 'asc' },
      select: {
        id: true, nmwcCode: true, legalName: true, primaryPhone: true, primaryPhoneNorm: true, crNumber: true,
        crNumberNorm: true, completenessScore: true, branches: { where: { deletedAt: null }, select: { regionId: true } },
      },
    });
    const scan = pairCandidates(
      live.map((c) => ({ ...c, branchCount: c.branches.length, regionIds: [...new Set(c.branches.map((x) => x.regionId))] })),
      new Map(),
      100
    );
    const crPairs = scan.pairs.filter((p) => p.reason === 'CR');
    expect(crPairs.map((p) => [p.a.id, p.b.id].sort())).toEqual([[a.id, b.id].sort()]);
  });
});
