// @vitest-environment node
/**
 * IMP-MULTIBRANCH (F-UAT-7) — a legitimate MULTI-BRANCH customer repeats the
 * SAME phone + CR on each of its branch rows (that is exactly how promote groups
 * branch rows by cust_code into one customer). The in-file duplicate-phone / CR
 * check must therefore key on cust_code and NOT quarantine a customer against
 * ITSELF — while STILL quarantining a genuine cross-customer collision (two
 * different cust_codes sharing a phone/CR).
 *
 * Before the fix, the medium synthetic master quarantined 324/499 rows: every
 * multi-branch customer was flagged "duplicate phone/CR in this file" against
 * its own branches. This test reproduces that in the small and pins the fix.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-multibranch.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const HEADERS = [
  'cust_code', 'cust_name', 'branch_code', 'sales_region', 'region_code', 'route',
  'address', 'phone', 'alt_phone', 'contact_person', 'contact_role', 'cr_no',
  'payment_terms', 'credit_limit', 'payment_term_days', 'temix_code', 'channel',
  'sub_channel', 'day_of_visit', 'coolers', 'stands', 'empty_bottles',
  'gps_lat', 'gps_lng', 'customer_status', 'temix_sync_state',
] as const;

function row(over: Record<string, string | number>) {
  return {
    cust_code: '', cust_name: 'ZZ-SYN MB Co', branch_code: '', sales_region: 'Muscat',
    region_code: 'MCT', route: 'MCT-R01', address: 'Way 1, Muscat', phone: '', alt_phone: '',
    contact_person: 'ZZ-SYN C', contact_role: 'Owner', cr_no: '', payment_terms: 'CASH',
    credit_limit: '', payment_term_days: '', temix_code: '', channel: 'HORECA',
    sub_channel: 'Restaurants', day_of_visit: 'MON', coolers: 0, stands: 0, empty_bottles: 0,
    gps_lat: 23.6, gps_lng: 58.4, customer_status: 'ACTIVE', temix_sync_state: 'SYNCED', ...over,
  } as Record<string, string | number>;
}

async function buildXlsx(rows: Array<Record<string, string | number>>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(HEADERS as unknown as string[]);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!ENABLED)('F-UAT-7: multi-branch customer must not self-quarantine on phone/CR', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const stewardId = 'ZZ-MB-' + randomUUID().slice(0, 8);
  const tag = randomUUID().slice(0, 6).toUpperCase();
  // unique per-run values so reruns never collide with residual master rows
  const sharedPhone = `+96890${String(700000 + (parseInt(tag, 36) % 90000)).slice(0, 6)}`;
  const sharedCr = String(9_800_000 + (parseInt(tag, 36) % 90000));
  const codeA = `ZZMB-A-${tag}`;
  const codeB = `ZZMB-B-${tag}`;
  const codeC = `ZZMB-C-${tag}`;
  let batchId: string;
  const extraBatchIds: string[] = [];

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    await prisma.user.create({ data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ MB Steward', role: 'STEWARD' } });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    const allBatches = [batchId, ...extraBatchIds].filter(Boolean);
    if (allBatches.length) {
      await prisma.importRow.deleteMany({ where: { batchId: { in: allBatches } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: allBatches } } });
    }
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('keeps a 3-branch customer CLEAN while still quarantining a cross-customer collision', async () => {
    const rows = [
      // Customer A: 3 branches, SAME phone + CR across all three (legitimate).
      row({ cust_code: codeA, branch_code: `${codeA}-01`, phone: sharedPhone, cr_no: sharedCr }),
      row({ cust_code: codeA, branch_code: `${codeA}-02`, phone: sharedPhone, cr_no: sharedCr, address: 'Way 2, Muscat' }),
      row({ cust_code: codeA, branch_code: `${codeA}-03`, phone: sharedPhone, cr_no: sharedCr, address: 'Way 3, Muscat' }),
      // Customer B + C: DIFFERENT cust_codes but the SAME phone AND cr — a real
      // cross-customer collision that MUST still be quarantined on BOTH rows.
      row({ cust_code: codeB, branch_code: `${codeB}-01`, phone: `+96890111${tag.slice(0, 3)}`, cr_no: `${sharedCr}9` }),
      row({ cust_code: codeC, branch_code: `${codeC}-01`, phone: `+96890111${tag.slice(0, 3)}`, cr_no: `${sharedCr}9` }),
    ];
    const buf = await buildXlsx(rows);
    const fd = new FormData();
    fd.set('file', new File([buf], 'mb-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error('UPLOAD FAILED:', JSON.stringify(res));
    expect(res.ok).toBe(true);
    batchId = (res as { ok: true; data: { batchId: string } }).data.batchId;

    const staged = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    const fieldsOf = (n: number) =>
      ((staged.find((r) => r.rowNumber === n)!.issues as { field: string }[] | null) ?? []).map((i) => i.field);
    const stateOf = (n: number) => staged.find((r) => r.rowNumber === n)!.state;

    // rowNumber = sheet row = data index + 2 (header on row 1)
    // Customer A's three branch rows (sheet rows 2,3,4): all CLEAN — must NOT be
    // flagged for phone/CR dup against their own siblings.
    for (const n of [2, 3, 4]) {
      expect(fieldsOf(n)).not.toContain('phone');
      expect(fieldsOf(n)).not.toContain('cr_no');
      expect(stateOf(n)).toBe('CLEAN');
    }
    // Customer B and C (sheet rows 5,6): cross-customer phone+CR collision — both
    // QUARANTINED, and the phone/cr issues still name the OTHER row.
    for (const n of [5, 6]) {
      expect(stateOf(n)).toBe('QUARANTINED');
      expect(fieldsOf(n)).toContain('phone');
      expect(fieldsOf(n)).toContain('cr_no');
    }
  });

  // Scaled confirmation: the medium synthetic master (300 customers, ~40%
  // multi-branch, manifest = all-ACCEPTED) once lost 324/499 rows to bogus
  // in-file phone/CR dup quarantines. After the fix, ZERO rows may carry an
  // "in this file" phone/CR issue. (Rows may still be flagged for master-level
  // collisions if the synthetic band pre-exists on the branch — those are
  // legitimate and counted separately.)
  it('scaled: the full medium master produces ZERO in-file phone/CR dup quarantines', async () => {
    const fixture = path.join('qa', 'fixtures', 'medium-424242', 'master.xlsx');
    if (!existsSync(fixture)) {
      console.warn('medium fixture absent — run: npx tsx scripts/qa/generate-synthetic-master.ts --scale=medium --seed=424242');
      return;
    }
    const fd = new FormData();
    fd.set('file', new File([readFileSync(fixture)], 'medium-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error('UPLOAD FAILED:', JSON.stringify(res));
    expect(res.ok).toBe(true);
    const bId = (res as { ok: true; data: { batchId: string } }).data.batchId;
    extraBatchIds.push(bId);

    const staged = await prisma.importRow.findMany({ where: { batchId: bId }, select: { state: true, issues: true } });
    expect(staged.length).toBe(499);
    let inFileDup = 0, masterDup = 0;
    for (const r of staged) {
      const issues = (r.issues as { field: string; message: string }[] | null) ?? [];
      for (const iss of issues) {
        if ((iss.field === 'phone' || iss.field === 'cr_no') && /in this file/.test(iss.message)) inFileDup++;
        if ((iss.field === 'phone' || iss.field === 'cr_no') && /already exists in master/.test(iss.message)) masterDup++;
      }
    }
    const quarantined = staged.filter((r) => r.state === 'QUARANTINED').length;
    console.log(`\n=== MEDIUM MASTER (fixed importer) === rows=${staged.length} quarantined=${quarantined} inFileDupIssues=${inFileDup} masterDupIssues=${masterDup}`);
    // The fix's contract: no legitimate multi-branch customer is flagged against
    // its own branches. Pre-fix this was ~324.
    expect(inFileDup).toBe(0);
  });
});
