// @vitest-environment node
/**
 * IMP-RECON — customer-master upload reconciliation against the synthetic
 * ground-truth manifest (qa/fixtures/dirty-<seed>). Proves the UPLOAD/parse
 * layer's clean-vs-quarantine disposition per row, and documents where the
 * upload layer is (correctly) silent because the check lives at PROMOTE time.
 *
 * GATED like the other integration suites — the default `npm test` (no Postgres)
 * skips cleanly. Writes only ZZ-synthetic rows + one import batch, cleaned up in
 * afterAll. Runs against the ISOLATED QA branch, never production.
 *
 *   RUN_IMPORT_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/import-reconciliation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_IMPORT_TESTS === '1' && !!process.env.DATABASE_URL;
const FIXTURE = path.join('qa', 'fixtures', 'dirty-424242');

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

type Manifest = {
  rowNumber: number; custCode: string; branchCode: string;
  expectedDisposition: string; expectedErrorCode?: string; note?: string;
}[];

describe.skipIf(!ENABLED)('customer-master upload reconciliation (dirty catalogue)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');
  const stewardId = 'ZZ-IMP-' + randomUUID().slice(0, 8);
  let batchId: string;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    manifest = JSON.parse(readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'));
    await prisma.user.create({ data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ Steward', role: 'STEWARD' } });
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    if (batchId) {
      await prisma.importRow.deleteMany({ where: { batchId } });
      await prisma.importBatch.deleteMany({ where: { id: batchId } });
    }
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('stages the dirty master and reconciles each row against the manifest', async () => {
    const buf = readFileSync(path.join(FIXTURE, 'master.xlsx'));
    const fd = new FormData();
    fd.set('file', new File([buf], 'dirty-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const res = await imports.uploadCustomerMasterAction(fd);
    if (!res.ok) console.error('UPLOAD FAILED:', JSON.stringify(res));
    expect(res.ok).toBe(true);
    batchId = (res as { ok: true; data: { batchId: string; clean: number; quarantined: number } }).data.batchId;

    const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    expect(rows.length).toBe(manifest.length);

    // The upload/parse layer catches these dimensions; the rest (crosswalk
    // conflict, route/region mismatch, >3dp credit rounding) are PROMOTE-time,
    // so those manifest rows are expected CLEAN at this layer.
    const PROMOTE_TIME_ONLY = new Set(['CROSSWALK:temix_code', 'route_region_mismatch']);
    const recon: string[] = [];
    let matches = 0;
    const divergences: { row: number; custCode: string; expected: string; actualClean: boolean; issues: string; reason: string }[] = [];

    rows.forEach((r, idx) => {
      const m = manifest[idx];
      const issues = (r.issues as { field: string; message: string }[] | null) ?? [];
      const issueFields = issues.map((i) => i.field).join(',') || '—';
      const actualClean = r.state === 'CLEAN';
      const expectedClean =
        m.expectedDisposition === 'ACCEPTED' ||
        (!!m.expectedErrorCode && PROMOTE_TIME_ONLY.has(m.expectedErrorCode)) ||
        // row 14: >3dp credit is rounded (accepted) at upload, not rejected
        (m.expectedErrorCode === 'credit_limit' && (m.note ?? '').includes('precision'));
      const ok = actualClean === expectedClean;
      if (ok) matches++;
      else divergences.push({ row: r.rowNumber, custCode: m.custCode, expected: m.expectedDisposition, actualClean, issues: issueFields, reason: m.note ?? '' });
      recon.push(`row ${String(r.rowNumber).padStart(2)} ${(m.custCode || '(blank)').padEnd(13)} exp=${m.expectedDisposition.padEnd(16)} actual=${actualClean ? 'CLEAN' : 'QUARANTINED'} issues=[${issueFields}] ${ok ? '' : '  <-- DIVERGENCE'}`);
    });

    console.log('\n=== IMPORT RECONCILIATION (dirty catalogue) ===\n' + recon.join('\n'));
    console.log(`\nmatches ${matches}/${rows.length}; divergences:`, JSON.stringify(divergences, null, 1));

    // ---- targeted assertions on the dimensions the UPLOAD layer owns ----
    const byRow = (n: number) => rows.find((r) => r.rowNumber === n)!;
    const fieldsOf = (n: number) => ((byRow(n).issues as { field: string }[] | null) ?? []).map((i) => i.field);
    // rowNumber = manifest index + 1 (header row offset)
    expect(byRow(2).state).toBe('QUARANTINED'); expect(fieldsOf(2)).toContain('cust_code');        // missing cust_code
    expect(byRow(3).state).toBe('QUARANTINED'); expect(fieldsOf(3)).toContain('cust_name');         // missing cust_name
    expect(byRow(4).state).toBe('QUARANTINED'); expect(fieldsOf(4)).toContain('payment_terms');     // bad payment_terms
    expect(byRow(5).state).toBe('QUARANTINED'); expect(fieldsOf(5)).toContain('phone');             // bad phone
    expect(byRow(6).state).toBe('QUARANTINED'); expect(fieldsOf(6)).toContain('cust_name');         // formula payload
    expect(byRow(7).state).toBe('CLEAN');                                                           // <script> stripped -> clean
    expect(byRow(8).state).toBe('QUARANTINED'); expect(fieldsOf(8)).toContain('cr_no');             // in-file CR dup A
    expect(byRow(9).state).toBe('QUARANTINED'); expect(fieldsOf(9)).toContain('cr_no');             // in-file CR dup B
    expect(byRow(11).state).toBe('QUARANTINED'); expect(fieldsOf(11)).toContain('phone');           // in-file phone dup

    // Whole-batch clean/quarantine split must be internally consistent.
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    const cleanCount = rows.filter((r) => r.state === 'CLEAN').length;
    expect(batch?.cleanRows).toBe(cleanCount);
    expect(batch?.quarantinedRows).toBe(rows.length - cleanCount);

    // With upload-layer-adjusted expectations (promote-time checks excluded, >3dp
    // credit rounded, in-file phone dup flags both), every manifest row must
    // reconcile. Any residual divergence is a real finding — fail loudly.
    expect(divergences).toEqual([]);
  });
});
