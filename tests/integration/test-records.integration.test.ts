// @vitest-environment node
/**
 * Gap 30 on Postgres (migration 20261024120000_test_records): the isTest flag
 * moves only in the owner's maintenance window, and a flagged record is left out
 * of the figures and the load counts.
 *
 *   - the application's credential (and an owner session outside the window)
 *     cannot set the flag, on insert or on update; the window can, and flipping
 *     it writes no history row;
 *   - a shop of a flagged customer is not a "real" shop to the dashboard's SQL
 *     (lib/test-records.ts realBranchSql), and verify-load's information line
 *     counts it among the test records left out.
 *
 * Synthetic rows only (zz<suite><base36>), written under a test change context
 * and removed again, history included. Never production.
 *
 *   RUN_WATCH=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/test-records.integration.test.ts
 *
 * Written with the watch-and-prove branch; NOT run there (no database was used).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { realBranchSql } from '@/lib/test-records';
import { testRecordsCheck } from '../../scripts/ops/verify-load';
import { withAuditMaintenance } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_WATCH === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('gap 30: test records are flagged by the owner and left out', () => {
  let prisma: PrismaClient;
  let w: World;

  beforeAll(async () => {
    assertNotProductionEnv();
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    w = await buildWorld(prisma, 'testrec');
  });

  afterAll(async () => {
    if (!prisma || !w) return;
    // Unflag first, in the window, so the fixture deletes are ordinary ones.
    await withAuditMaintenance(prisma, (tx) => tx.customer.updateMany({ where: { id: { in: w.customers } }, data: { isTest: false } }));
    await tearDownWorld(prisma, w);
    await prisma.$disconnect();
  });

  it('the application credential cannot set the flag, on update or on insert', async () => {
    await expect(prisma.customer.update({ where: { id: w.customer }, data: { isTest: true } })).rejects.toThrow(
      /Only the database owner, inside a maintenance transaction/
    );
    await expect(
      prisma.region.create({ data: { code: `${w.sfx.toUpperCase()}T`, name: `ZZ test ${w.sfx}`, isTest: true } })
    ).rejects.toThrow(/Only the database owner/);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: w.customer } })).isTest).toBe(false);
  });

  it('the owner’s maintenance window can, and the flag writes no history row', async () => {
    const before = await prisma.customerHistory.count({ where: { customerId: w.customer } });
    await withAuditMaintenance(prisma, (tx) => tx.customer.update({ where: { id: w.customer }, data: { isTest: true } }));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: w.customer } })).isTest).toBe(true);
    expect(await prisma.customerHistory.count({ where: { customerId: w.customer } })).toBe(before);
  });

  it('a shop of a flagged customer is no longer a real shop to the figures', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM "Branch" b WHERE b."id" = ANY(${w.branches}::text[]) AND ${realBranchSql('b')}`
    );
    expect(rows[0]!.n).toBe(0);
    const all = await prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM "Branch" b WHERE b."id" = ANY(${w.branches}::text[])`
    );
    expect(all[0]!.n).toBe(w.branches.length);
  });

  it('verify-load counts it among the test records it leaves out', async () => {
    const r = await testRecordsCheck(prisma).run();
    expect(r.ok).toBe(true);
    const customers = Number(/^(\d+) customer/.exec(r.detail)?.[1] ?? -1);
    expect(customers).toBeGreaterThanOrEqual(1);
  });
});
