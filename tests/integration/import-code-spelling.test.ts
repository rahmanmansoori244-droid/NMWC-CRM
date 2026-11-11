// @vitest-environment node
/**
 * Owner's answers of 2026-11-11 (item A5) — against Postgres, through the real
 * upload, the real fix flow, the real "Before you promote" check and the real
 * promote:
 *   - a customer code (and a Temix code) typed in small letters is read in
 *     capitals: it is the customer the CRM knows, on the full lane and on the
 *     refresh lane, and a new customer is stored in capitals; the cell stays as
 *     uploaded in ImportRow.raw; the row says so, and the summary counts it;
 *   - a shop code that differs from one of the SAME customer's shops, or from
 *     another of its rows, only by leading zeros or letter case is held back on
 *     its branch_code cell; corrected, it loads as that shop; released as a
 *     different shop (zeros only), it is created; an identical code is never
 *     held back;
 *   - the promote applies the rule again to a staged row (a shop added since the
 *     upload), and the summary expects it; a re-check then holds the row back.
 *
 *   RUN_IMPORT_TESTS=1 npx vitest run tests/integration/import-code-spelling.test.ts
 */
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { purgeAuditLog } from '../support/audit';
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

type Cells = Record<string, string | number>;

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

describe.skipIf(!ENABLED)('A5: code spellings on the customer import', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  let fixes: typeof import('@/services/import-fixes');
  let review: typeof import('@/services/import-review');
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const P = `ZZCS-${tag}`;
  const REGION = `ZZCS${tag}A`;
  const ROUTE1 = `ZZCS${tag}-R1`;
  const steward = `${P}-stew`;
  const batchIds: string[] = [];
  let regionA = '';
  let route1 = '';
  const base = parseInt(tag.slice(0, 6), 16) % 1_000_000;
  const phone = (n: number) => `+9689${String((base * 10 + n) % 10_000_000).padStart(7, '0')}`;

  const F = `${P}-F`; // no Temix code: the full lane; shops F-01 and F-AB
  const L = `${P}-L`; // linked to Temix: the refresh lane; shop L-01
  const G = `${P}-G`; // no Temix code; shop G-01, and a lookalike added after the upload

  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const upload = async (rows: Cells[]) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const f = new FormData();
    f.set('file', new File([await workbook(rows)], `${P}.xlsx`, { type: XLSX_MIME }));
    const res = await imports.uploadCustomerMasterAction(f);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = (res as { ok: true; data: { batchId: string } }).data;
    batchIds.push(data.batchId);
    return data.batchId;
  };
  const check = async (batchId: string) => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
    const res = await review.summariseCustomerBatchAction(fd({ batchId }));
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.data;
  };
  const rowsOf = (batchId: string) => prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
  const issuesOf = (r: { issues: unknown }) => (r.issues as Array<{ field: string; message: string }> | null) ?? [];
  const customersCalled = (code: string) =>
    prisma.customer.findMany({ where: { nmwcCode: { equals: code, mode: 'insensitive' } }, select: { nmwcCode: true } });
  const shopsOf = async (code: string) =>
    (
      await prisma.branch.findMany({ where: { customer: { nmwcCode: code } }, select: { branchCode: true }, orderBy: { branchCode: 'asc' } })
    ).map((b) => b.branchCode);

  const row = (over: Cells): Cells => ({
    cust_code: '',
    cust_name: 'ZZ Code Spelling',
    branch_code: '',
    route: ROUTE1,
    address: 'Way 31, Muscat',
    phone: '',
    payment_terms: 'CASH',
    temix_code: '',
    ...over,
  });

  beforeAll(async () => {
    if (pointsAtProduction(process.env.DATABASE_URL ?? '')) throw new Error('ABORT: production');
    if (pointsAtProduction(process.env.DIRECT_URL ?? '')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    fixes = await import('@/services/import-fixes');
    review = await import('@/services/import-review');
    regionA = (await prisma.region.create({ data: { code: REGION, name: `ZZ CS A ${tag}` } })).id;
    route1 = (await prisma.route.create({ data: { code: ROUTE1, name: `ZZ CS1 ${tag}`, regionId: regionA } })).id;
    await prisma.user.create({ data: { id: steward, username: steward, passwordHash: 'x', fullName: 'ZZ CS Steward', role: 'STEWARD' } });
    const make = async (code: string, n: number, shops: string[], temix: boolean) => {
      const c = await prisma.customer.create({
        data: {
          nmwcCode: code,
          legalName: 'ZZ Code Spelling',
          paymentTerms: 'CASH',
          primaryPhone: phone(n),
          primaryPhoneNorm: phone(n),
          ...(temix ? { temixCode: code, temixSyncState: 'SYNCED' as const } : {}),
        },
      });
      for (const s of shops) {
        await prisma.branch.create({
          data: { customerId: c.id, branchCode: s, branchName: 'Main', address: 'Way 31, Muscat', regionId: regionA, routeId: route1 },
        });
      }
    };
    await make(F, 1, [`${F}-01`, `${F}-AB`], false);
    await make(L, 2, [`${L}-01`], true);
    await make(G, 3, [`${G}-01`], false);
  });

  beforeEach(() => {
    current = { id: steward, role: 'STEWARD', username: steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      const custs = await prisma.customer.findMany({
        where: { nmwcCode: { startsWith: P, mode: 'insensitive' } },
        select: { id: true },
      });
      const ids = custs.map((c) => c.id);
      await purgeAuditLog(prisma, { where: { actorId: { in: [steward] } } });
      await prisma.notification.deleteMany({ where: { userId: steward } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.rateLimit.deleteMany({ where: { key: { contains: steward } } });
      await prisma.route.deleteMany({ where: { id: route1 } });
      await prisma.region.deleteMany({ where: { id: regionA } });
      await prisma.user.deleteMany({ where: { id: steward } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('full lane and a new customer: small letters are read in capitals, raw stays as uploaded, the row says so', async () => {
    const f = F.toLowerCase();
    const n = `${P}-n`.toLowerCase();
    const batchId = await upload([
      row({ cust_code: f, branch_code: '01', phone: phone(1) }),
      row({ cust_code: n, branch_code: '01', phone: phone(4) }),
      row({ cust_code: n, branch_code: '02', phone: phone(4) }),
    ]);
    const staged = await rowsOf(batchId);
    expect(staged.map((r) => r.state)).toEqual(['CLEAN', 'CLEAN', 'CLEAN']);
    expect(staged.map((r) => (r.parsed as { custCode: string }).custCode)).toEqual([F, `${P}-N`, `${P}-N`]);
    expect((staged[0]!.raw as Record<string, unknown>).cust_code).toBe(f);

    const told = await check(batchId);
    expect(told.summary).toMatchObject({ codesCapitalised: 3, created: { customers: 1, shops: 2 } });
    expect(told.lines.some((l) => l.text.startsWith('Codes in capitals: 3 row(s)'))).toBe(true);

    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 3, failed: 0 });
    // One customer F, still; the new one stored in capitals, its shops on the sheet's route.
    expect(await customersCalled(F)).toEqual([{ nmwcCode: F }]);
    expect(await customersCalled(`${P}-N`)).toEqual([{ nmwcCode: `${P}-N` }]);
    expect(await shopsOf(F)).toEqual([`${F}-01`, `${F}-AB`]);
    expect(await shopsOf(`${P}-N`)).toEqual([`${P}-N-01`, `${P}-N-02`]);
    expect((await prisma.branch.findUniqueOrThrow({ where: { branchCode: `${P}-N-01` } })).routeId).toBe(route1);
    const after = await rowsOf(batchId);
    expect(after.map((r) => r.state)).toEqual(['PROMOTED', 'PROMOTED', 'PROMOTED']);
    expect(issuesOf(after[0]!)).toContainEqual({
      field: '_capitals',
      message: `Small letters changed to capitals: customer code "${f}" was read as "${F}". The sheet is not changed.`,
    });
  });

  it('refresh lane: a customer and Temix code in small letters refresh the customer linked to Temix', async () => {
    const l = L.toLowerCase();
    const batchId = await upload([row({ cust_code: l, branch_code: '01', phone: phone(2), temix_code: l })]);
    expect((await rowsOf(batchId)).map((r) => r.state)).toEqual(['CLEAN']);
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 1, failed: 0 });
    expect(await customersCalled(L)).toEqual([{ nmwcCode: L }]);
    expect(await shopsOf(L)).toEqual([`${L}-01`]);
    const [r] = await rowsOf(batchId);
    expect(issuesOf(r!)).toContainEqual({
      field: '_capitals',
      message: `Small letters changed to capitals: customer code "${l}" was read as "${L}"; Temix code "${l}" was read as "${L}". The sheet is not changed.`,
    });
  });

  it('a shop code that only looks like an existing shop is held back; corrected, it loads as that shop', async () => {
    const batchId = await upload([
      row({ cust_code: F, branch_code: '1', phone: phone(1) }),
      row({ cust_code: F, branch_code: 'ab', phone: phone(1) }),
    ]);
    const [one, ab] = await rowsOf(batchId);
    expect([one!.state, ab!.state]).toEqual(['QUARANTINED', 'QUARANTINED']);
    expect(issuesOf(one!)).toEqual([
      {
        field: 'branch_code',
        message: `Shop code "1" looks like this customer's existing shop "${F}-01" (Excel may have dropped a zero). Correct the code if it is the same shop; if it is a different shop, release the row with a reason.`,
      },
    ]);
    expect(issuesOf(ab!)[0]!.message).toContain(`looks like this customer's existing shop "${F}-AB" (only capital and small letters differ)`);
    expect((one!.raw as Record<string, unknown>).branch_code).toBe('1');

    // Letters alone: never released, only corrected.
    const refused = await fixes.releaseImportRowShopCodeAction(fd({ rowId: ab!.id, reason: 'a different shop' }));
    expect(refused.ok).toBe(false);
    for (const [r, code] of [[one!, '01'], [ab!, 'AB']] as const) {
      const res = await fixes.correctImportRowAction(fd({ rowId: r.id, cells: JSON.stringify({ branch_code: code }) }));
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { clean: 1, held: 0 } });
    }
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });
    // No second shop.
    expect(await shopsOf(F)).toEqual([`${F}-01`, `${F}-AB`]);
  });

  it('two rows of one customer whose codes only look alike: released as different shops, both are created; the release is audited', async () => {
    const M = `${P}-M`;
    const batchId = await upload([
      row({ cust_code: M, branch_code: '01', phone: phone(5) }),
      row({ cust_code: M, branch_code: '1', phone: phone(5) }),
    ]);
    const [r01, r1] = await rowsOf(batchId);
    expect(issuesOf(r01!)[0]!.message).toMatch(/^Shop code "01" looks like shop code "1" on row 3 /);
    expect(issuesOf(r1!)[0]!.message).toMatch(/^Shop code "1" looks like shop code "01" on row 2 /);

    const released = await fixes.releaseImportRowShopCodeAction(fd({ rowId: r1!.id, reason: 'two shops in one mall' }));
    expect(released, JSON.stringify(released)).toMatchObject({ ok: true, data: { clean: 1, held: 0 } });
    // The other row, checked again, no longer compares itself with the released one.
    const again = await fixes.recheckImportRowAction(fd({ rowId: r01!.id }));
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true, data: { clean: 1, held: 0 } });
    const audit = await prisma.auditLog.findMany({ where: { entityId: r1!.id, action: 'FORCE_OVERRIDE' } });
    expect(audit.map((a) => a.reason)).toEqual(['Shop code released as a different shop by the Data Steward: two shops in one mall']);

    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });
    expect(await shopsOf(M)).toEqual([`${M}-01`, `${M}-1`]);
  });

  // Review of A5 (2026-11-11): a "Different shop" release belongs to the code it
  // was given for. A correction of that code ends it: a new code that only looks
  // like another shop is held back again, not loaded as a second shop.
  it('a release does not outlive a correction of the shop code: a new lookalike is held back again', async () => {
    const K = `${P}-K`;
    const k = await prisma.customer.create({
      data: { nmwcCode: K, legalName: 'ZZ Code Spelling', paymentTerms: 'CASH', primaryPhone: phone(6), primaryPhoneNorm: phone(6) },
    });
    for (const s of [`${K}-A01`, `${K}-02`]) {
      await prisma.branch.create({
        data: { customerId: k.id, branchCode: s, branchName: 'Main', address: 'Way 31, Muscat', regionId: regionA, routeId: route1 },
      });
    }
    const batchId = await upload([
      row({ cust_code: K, branch_code: 'A1', phone: phone(6) }),
      row({ cust_code: K, branch_code: 'a1', phone: phone(6) }),
    ]);
    const [x] = await rowsOf(batchId);
    expect(x!.state).toBe('QUARANTINED');
    expect(issuesOf(x!)[0]!.message).toContain(`existing shop "${K}-A01" (Excel may have dropped a zero)`);
    // Released as a different shop: still held, now on the sibling row that differs in letters alone.
    const released = await fixes.releaseImportRowShopCodeAction(fd({ rowId: x!.id, reason: 'a different shop' }));
    expect(released, JSON.stringify(released)).toMatchObject({ ok: true, data: { clean: 0, held: 1 } });
    expect(issuesOf((await rowsOf(batchId))[0]!)[0]!.message).toContain('(only capital and small letters differ)');
    // Corrected to "2", which only looks like the shop K-02: held back again.
    const corrected = await fixes.correctImportRowAction(fd({ rowId: x!.id, cells: JSON.stringify({ branch_code: '2' }) }));
    expect(corrected, JSON.stringify(corrected)).toMatchObject({ ok: true, data: { clean: 0, held: 1 } });
    const [after] = await rowsOf(batchId);
    expect(after!.state).toBe('QUARANTINED');
    expect(issuesOf(after!)[0]!.message).toContain(`existing shop "${K}-02" (Excel may have dropped a zero)`);
    expect((after!.corrections as Record<string, unknown>).shopCodeReleased).toBeUndefined();
    // Final check of the review (2026-11-11): the ledger records that the
    // correction ended the release, after the release's own FORCE_OVERRIDE row.
    const ledger = await prisma.auditLog.findMany({
      where: { entityId: x!.id, action: { in: ['UPDATE', 'FORCE_OVERRIDE'] } },
      orderBy: { at: 'asc' },
    });
    expect(ledger.map((a) => [a.action, a.reason])).toEqual([
      ['FORCE_OVERRIDE', 'Shop code released as a different shop by the Data Steward: a different shop'],
      [
        'UPDATE',
        "Import row corrected by the Data Steward; its shop code changed, so the 'Different shop' release ends",
      ],
    ]);
    expect(ledger[1]!.after).toMatchObject({ shopCodeReleaseEnded: true, columns: ['branch_code'] });
    // A correction made with no release in place says nothing of one.
    const again = await fixes.correctImportRowAction(fd({ rowId: x!.id, cells: JSON.stringify({ branch_code: '3' }) }));
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    const last = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: x!.id, action: 'UPDATE' },
      orderBy: { at: 'desc' },
    });
    expect(last.reason).toBe('Import row corrected by the Data Steward');
    expect(last.after).not.toHaveProperty('shopCodeReleaseEnded');
    expect(await shopsOf(K)).toEqual([`${K}-02`, `${K}-A01`]);
  });

  // Review of A5 (2026-11-11): a NEW customer's blank branch_code is numbered by
  // its place (N-01) only at promote; beside a row coded "1" that made two shops.
  it('a new customer: a blank branch_code numbered like a sibling row is rejected, and loads once given a code', async () => {
    const B = `${P}-B`;
    const batchId = await upload([
      row({ cust_code: B, branch_code: '', phone: phone(7) }),
      row({ cust_code: B, branch_code: '1', phone: phone(7) }),
    ]);
    expect((await rowsOf(batchId)).map((r) => r.state)).toEqual(['CLEAN', 'CLEAN']);
    const told = await check(batchId);
    expect(told.summary.expectRejected.reasons.map((r) => r.reason)).toEqual([
      "a branch_code that only looks like one of the customer's shops or rows (01 / 1, Ab / AB)",
    ]);
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 0, failed: 1 });
    expect(await customersCalled(B)).toEqual([]);
    const [blank, one] = await rowsOf(batchId);
    expect([blank!.state, one!.state]).toEqual(['REJECTED', 'REJECTED']);
    // One reason for the whole customer, written to BOTH rows: it names the rows
    // by number, so it is true on the coded row 3 as well as on the blank row 2.
    const reason = `branch_code: The branch_code on row 2 is blank, so it would be numbered "${B}-01", which looks like shop code "1" on row 3 of the same customer in this sheet (only the zeros differ). Give row 2 a branch_code: the same code if it is the same shop, a different one if it is a different shop.`;
    expect(issuesOf(blank!)[0]!.message).toBe(reason);
    expect(issuesOf(one!)[0]!.message).toBe(reason);
    const given = await fixes.correctImportRowAction(fd({ rowId: blank!.id, cells: JSON.stringify({ branch_code: '02' }) }));
    expect(given, JSON.stringify(given)).toMatchObject({ ok: true, data: { clean: 2, held: 0 } });
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 2, failed: 0 });
    expect(await shopsOf(B)).toEqual([`${B}-02`, `${B}-1`]);
  });

  it('the promote applies the rule to a staged row (a shop added since the upload), and a re-check holds it back', async () => {
    const batchId = await upload([row({ cust_code: G, branch_code: '02', phone: phone(3) })]);
    expect((await rowsOf(batchId)).map((r) => r.state)).toEqual(['CLEAN']);
    const g = await prisma.customer.findUniqueOrThrow({ where: { nmwcCode: G } });
    await prisma.branch.create({
      data: { customerId: g.id, branchCode: `${G}-002`, branchName: 'Main', address: 'Way 31, Muscat', regionId: regionA, routeId: route1 },
    });
    const told = await check(batchId);
    expect(told.summary.expectRejected.reasons.map((r) => r.reason)).toEqual([
      "a branch_code that only looks like one of the customer's shops or rows (01 / 1, Ab / AB)",
    ]);
    expect(await promoteFully(imports, batchId)).toMatchObject({ promoted: 0, failed: 1 });
    const [r] = await rowsOf(batchId);
    expect(r!.state).toBe('REJECTED');
    expect(issuesOf(r!)[0]!.message).toBe(
      `branch_code: Shop code "02" looks like this customer's existing shop "${G}-002" (Excel may have dropped a zero). Correct the code if it is the same shop; if it is a different shop, release the row with a reason.`
    );
    expect(await shopsOf(G)).toEqual([`${G}-002`, `${G}-01`]);
    const res = await fixes.recheckImportRowAction(fd({ rowId: r!.id }));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { clean: 0, held: 1 } });
    expect(issuesOf((await rowsOf(batchId))[0]!)[0]).toMatchObject({ field: 'branch_code' });
  });
});
