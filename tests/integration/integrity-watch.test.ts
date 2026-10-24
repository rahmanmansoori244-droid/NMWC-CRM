// @vitest-environment node
/**
 * Gap 29 on Postgres: the nightly integrity checks see real faults, leave the
 * flagged test records out of the data checks, and one run appends its results
 * and alerts the Steward it is given — once.
 *
 * A synthetic world (zz<suite><base36>): a customer whose only shop is closed
 * while it stays active (status drift), two customers sharing a CR number, and
 * a change written with no change context (source 'sql'). The same status drift
 * and shared CR on a customer the owner flags as a test record must NOT be
 * counted. UAT is shared, so each check is read before and after the faults and
 * the DIFFERENCE is asserted.
 *
 * Owner decisions 2026-10-25: two live customers can no longer share a Temix
 * code — the database refuses the second (migration
 * 20261025120000_temix_code_unique), so temix-code-shared finds none of this
 * world's; a shared CR number is allowed and listed by cr-number-shared, as
 * information.
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
  /** The CR number this world's customers share (normalised already). */
  let CR = '';

  beforeAll(async () => {
    assertNotProductionEnv();
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    w = await buildWorld(prisma, 'intwatch');
    const [s] = await prisma.$queryRaw<Array<{ n: number | null }>>`SELECT max("seq") AS n FROM "SealRecord"`;
    sealsBefore = s?.n ?? -1;
    for (const id of ['customer-status-follows-shops', 'temix-code-shared', 'cr-number-shared', 'history-unattributed-since-last-run']) {
      before[id] = await count(id);
    }

    const db = contextClient(prisma, { actorId: null, source: src.test('integrity-watch') });
    const SFX = w.sfx.toUpperCase();
    CR = `ZZCR-${SFX}`;
    // Real faults.
    await prisma.$executeRaw`UPDATE "Branch" SET "status" = 'CLOSED' WHERE "id" = ${w.branch}`; // drift (and a no-context write)
    for (const n of [1, 2]) {
      const c = await db.customer.create({
        data: {
          nmwcCode: `${SFX}-T${n}`,
          legalName: `ZZ shared ${n}`,
          paymentTerms: 'CASH',
          crNumber: CR,
          crNumberNorm: CR,
          temixCode: n === 1 ? `${SFX}T` : null,
        },
      });
      w.customers.push(c.id);
    }
    // Owner decision 2026-10-25: a second live customer on the Temix code is refused by the database.
    await expect(
      db.customer.create({ data: { nmwcCode: `${SFX}-T3`, legalName: 'ZZ shared 3', paymentTerms: 'CASH', temixCode: ` ${SFX.toLowerCase()}t ` } })
    ).rejects.toMatchObject({ code: 'P2002' });
    // An archived customer on the CR is not counted.
    const archived = await db.customer.create({
      data: { nmwcCode: `${SFX}-A`, legalName: 'ZZ archived', paymentTerms: 'CASH', crNumber: CR, crNumberNorm: CR, deletedAt: new Date() },
    });
    w.customers.push(archived.id);
    // The same faults on a test customer.
    const t = await db.customer.create({ data: { nmwcCode: `${SFX}-X`, legalName: 'ZZ test', paymentTerms: 'CASH', crNumber: CR, crNumberNorm: CR } });
    w.customers.push(t.id);
    const tb = await db.branch.create({
      data: { customerId: t.id, branchCode: `${SFX}-X-01`, branchName: 'ZZ', routeId: w.route, regionId: w.regionA, address: 'ZZ Way 1, synthetic', status: 'CLOSED' },
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
    // Owner decision 2026-10-25: the database refused the second holder of the code, so none is shared.
    expect((await count('temix-code-shared')) - before['temix-code-shared']!).toBe(0);
    // The two real customers on the CR; the archived one and the flagged one are left out.
    const cr = await CHECK_BY_ID.get('cr-number-shared')!.run!(prisma, ctx());
    expect(cr.count - before['cr-number-shared']!).toBe(2);
    expect(CHECK_BY_ID.get('cr-number-shared')!.policy).toBe('info');
    expect((await count('history-unattributed-since-last-run')) - before['history-unattributed-since-last-run']!).toBeGreaterThanOrEqual(1);
  });

  it('the recorder checks see the protection as the migrations made it', async () => {
    expect(await count('protection-triggers')).toBe(0);
    expect(await count('protection-functions')).toBe(0);
  });

  it('gap 31: every NOT VALID database rule is present, and its older rows are counted as information', async () => {
    const c = CHECK_BY_ID.get('db-rules-older-rows')!;
    const out = await c.run!(prisma, ctx());
    const d = out.detail as { byRule: Record<string, { violations: number; validated: boolean | 'missing' }>; missing: string[]; readyToValidate: string[] };
    expect(d.missing).toEqual([]);
    for (const [name, r] of Object.entries(d.byRule)) {
      expect(r.validated, name).not.toBe('missing');
      // Ready means none left and not validated yet.
      expect(d.readyToValidate.includes(name)).toBe(r.violations === 0 && r.validated === false);
    }
    expect(out.sampleIds.length).toBeLessThanOrEqual(10);
    expect(c.policy).toBe('info');
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
