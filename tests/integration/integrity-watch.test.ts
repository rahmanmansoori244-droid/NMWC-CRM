// @vitest-environment node
/**
 * Gap 29 on Postgres: the nightly integrity checks see real faults, leave the
 * flagged test records out of the data checks, and one run appends its results
 * and alerts the Steward it is given — once.
 *
 * A synthetic world (zz<suite><base36>): a customer whose only shop is closed
 * while it stays active (status drift), two customers sharing a Temix code, and
 * a change written with no change context (source 'sql'). The same status drift
 * and shared code on a customer the owner flags as a test record must NOT be
 * counted. UAT is shared, so each check is read before and after the faults and
 * the DIFFERENCE is asserted.
 *
 * The run writes a seal on UAT's own chain (crons do not run there, and its chain
 * is broken by every integration clean-up anyway, docs/OPERATIONS.md 5k); the
 * suite removes the seals and results it added, in the owner's maintenance
 * window. R2 is a fake.
 *
 *   RUN_WATCH=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/integrity-watch.test.ts
 *
 * Written with the watch-and-prove branch; NOT run there (no database was used).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { CHECK_BY_ID, type CheckContext } from '@/lib/integrity/checks';
import { runIntegrityWatch } from '@/lib/integrity/run';
import { contextClient, src } from '@/lib/change-context';
import { withAuditMaintenance } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_WATCH === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('gap 29: the nightly integrity checks on Postgres', () => {
  let prisma: PrismaClient;
  let w: World;
  let sealsBefore = -1;
  const runAt = new Date();
  const ctx = (): CheckContext => ({ now: new Date(), previous: new Map() });
  const count = async (id: string) => (await CHECK_BY_ID.get(id)!.run!(prisma, ctx())).count;
  const before: Record<string, number> = {};

  beforeAll(async () => {
    assertNotProductionEnv();
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    w = await buildWorld(prisma, 'intwatch');
    const [s] = await prisma.$queryRaw<Array<{ n: number | null }>>`SELECT max("seq") AS n FROM "SealRecord"`;
    sealsBefore = s?.n ?? -1;
    for (const id of ['customer-status-follows-shops', 'temix-code-shared', 'history-unattributed-since-last-run']) before[id] = await count(id);

    const db = contextClient(prisma, { actorId: null, source: src.test('integrity-watch') });
    const SFX = w.sfx.toUpperCase();
    // Real faults.
    await prisma.$executeRaw`UPDATE "Branch" SET "status" = 'CLOSED' WHERE "id" = ${w.branch}`; // drift (and a no-context write)
    for (const n of [1, 2]) {
      const c = await db.customer.create({ data: { nmwcCode: `${SFX}-T${n}`, legalName: `ZZ shared ${n}`, paymentTerms: 'CASH', temixCode: `${SFX}T` } });
      w.customers.push(c.id);
    }
    // The same faults on a test customer.
    const t = await db.customer.create({ data: { nmwcCode: `${SFX}-X`, legalName: 'ZZ test', paymentTerms: 'CASH', temixCode: `${SFX}T` } });
    w.customers.push(t.id);
    const tb = await db.branch.create({
      data: { customerId: t.id, branchCode: `${SFX}-X-01`, branchName: 'ZZ', routeId: w.route, regionId: w.regionA, address: 'ZZ', status: 'CLOSED' },
    });
    w.branches.push(tb.id);
    await withAuditMaintenance(prisma, (tx) => tx.customer.update({ where: { id: t.id }, data: { isTest: true } }));
  });

  afterAll(async () => {
    if (!prisma || !w) return;
    await withAuditMaintenance(prisma, async (tx) => {
      await tx.customer.updateMany({ where: { id: { in: w.customers } }, data: { isTest: false } });
      await tx.integrityCheckResult.deleteMany({ where: { runAt } });
      await tx.$executeRaw`DELETE FROM "SealRecord" WHERE "seq" > ${sealsBefore}`;
    });
    await tearDownWorld(prisma, w);
    await prisma.$disconnect();
  });

  it('counts the real faults and not the test record’s', async () => {
    expect((await count('customer-status-follows-shops')) - before['customer-status-follows-shops']!).toBe(1);
    // The two real customers; the flagged one sharing the code is left out.
    expect((await count('temix-code-shared')) - before['temix-code-shared']!).toBe(2);
    expect((await count('history-unattributed-since-last-run')) - before['history-unattributed-since-last-run']!).toBeGreaterThanOrEqual(1);
  });

  it('the recorder checks see the protection as the migrations made it', async () => {
    expect(await count('protection-triggers')).toBe(0);
    expect(await count('protection-functions')).toBe(0);
  });

  it('one run appends its results and alerts the Steward it is given', async () => {
    const store = { get: async () => null, put: async () => undefined, list: async () => [] };
    const alert = vi.fn(async () => true);
    const s = await runIntegrityWatch(prisma, { store, now: runAt, audience: async () => [w.steward], alert, inAppAlerts: true });
    const rows = await prisma.integrityCheckResult.findMany({ where: { runAt } });
    expect(rows.length).toBe(s.checks);
    for (const r of rows) expect(r.sampleIds.length).toBeLessThanOrEqual(10);
    // Results are append-only.
    await expect(prisma.integrityCheckResult.update({ where: { id: rows[0]!.id }, data: { status: 'pass' } })).rejects.toThrow(/append-only/);
    expect(s.failing).toBeGreaterThan(0);
    const notes = await prisma.notification.findMany({ where: { kind: 'INTEGRITY_ALERT', userId: w.steward } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).not.toContain(w.sfx);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ event: 'integrity.failed' }));
  });
});
