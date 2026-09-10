// @vitest-environment node
/**
 * UAT-LOAD — load 300+ synthetic customers into the LIVE UAT DB via the REAL
 * service actions (uploadCustomerMasterAction + promoteCustomerBatchAction), the
 * exact code the Steward UI calls. Uses the SEEDED steward and does NOT clean up,
 * so the imported customers persist for live browsing in the running app.
 *
 * Isolated branch only (endpoint-guarded). Run:
 *   RUN_UAT_LOAD=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/uat-load.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promoteFully } from '../support/promote';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_UAT_LOAD === '1' && !!process.env.DATABASE_URL;
const FIXTURE = path.join('qa', 'fixtures', 'medium-424242');

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('UAT load: import 300+ synthetic master into the live DB', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let imports: typeof import('@/services/imports');

  beforeAll(async () => {
    // hard safety: never against production
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production endpoint');
    ({ prisma } = await import('@/lib/db'));
    imports = await import('@/services/imports');
    const steward = await prisma.user.findFirst({ where: { role: 'STEWARD' }, select: { id: true, username: true } });
    if (!steward) throw new Error('No STEWARD seeded — run the org seed first.');
    current = { id: steward.id, role: 'STEWARD', username: steward.username };
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  it('uploads + promotes the medium master; customers persist for browsing', async () => {
    const before = await prisma.customer.count();
    const buf = readFileSync(path.join(FIXTURE, 'master.xlsx'));
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(buf)], 'uat-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const up = await imports.uploadCustomerMasterAction(fd);
    if (!up.ok) console.error('UPLOAD FAILED:', JSON.stringify(up));
    expect(up.ok).toBe(true);
    const upData = (up as { ok: true; data: { batchId: string; clean: number; quarantined: number } }).data;
    console.log('UPLOAD:', JSON.stringify(upData));

    // RK-3: a master this size no longer fits in one request — drive the slices.
    const prData = await promoteFully(imports, upData.batchId);
    console.log('PROMOTE:', JSON.stringify(prData));

    const after = await prisma.customer.count();
    const manifest = JSON.parse(readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')) as { expectedDisposition: string }[];
    const expectedClean = manifest.filter((m) => m.expectedDisposition === 'ACCEPTED').length;
    console.log(`RECONCILE: manifest rows=${manifest.length} expectedACCEPTED=${expectedClean} | uploaded clean=${upData.clean} quarantined=${upData.quarantined} | promoted=${prData.promoted} failed=${prData.failed}`);
    console.log(`CUSTOMER COUNT: before=${before} after=${after} (added ${after - before})`);

    // sanity: we loaded a meaningful batch and total is now 300+
    expect(after).toBeGreaterThanOrEqual(300);
    expect(prData.promoted).toBeGreaterThan(0);
  });
});
