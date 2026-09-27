/**
 * Item 9: the Service status page's SQL, run against a real Postgres.
 *
 * The verdicts are unit-tested (tests/unit/service-levels.test.ts); what only a
 * database can prove is the SQL — date_bin's slot grid lining up with the one
 * slotStarts() walks, bool_or collapsing two schedulers into one slot,
 * percentile_cont over the snapshot minutes, the enum casts, and the whole loader
 * running end to end.
 *
 * Every row this suite writes is dated in 2099 and every query reads from 2099
 * on, so rows other suites write in parallel cannot change what it asserts.
 *
 *   RUN_SERVICE_LEVELS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/service-levels.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_SERVICE_LEVELS === '1' && !!process.env.DATABASE_URL;
const sfx = `slo${Date.now().toString(36)}`;
const T = (iso: string) => new Date(`2099-06-01T${iso}Z`);
const FROM = new Date('2099-06-01T00:00:00Z');

describe.skipIf(!ENABLED)('item 9: the service-level queries', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let svc: typeof import('@/lib/service-status');
  let userId = '';
  let managerId = '';
  const editIds: string[] = [];

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    svc = await import('@/lib/service-status');

    const u = await prisma.user.create({
      data: { username: `${sfx}.op`, fullName: 'SLO Operator', role: 'STEWARD', passwordHash: 'x' },
    });
    userId = u.id;
    const m = await prisma.user.create({
      data: { username: `${sfx}.mgr`, fullName: 'SLO Manager', role: 'MANAGER', passwordHash: 'x' },
    });
    managerId = m.id;
    // One request waiting at the Supervisor step, for the open-queue test.
    const waiting = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'SUBMITTED', pendingRole: 'SUPERVISOR',
        submittedAt: T('04:00:00'), stageEnteredAt: T('04:00:00'), slaDueAt: T('12:00:00'),
        fieldChanges: [], attachmentChanges: [],
      },
    });
    editIds.push(waiting.id);

    // Keep-warm: two schedulers in the 03:00 slot (one failed), one failed run in
    // 03:04, nothing in 03:08, one success in 03:12.
    const kw = (id: string, at: Date, ok: boolean, dbMs: number | null, source: string) =>
      prisma.cronRun.create({ data: { id: `${sfx}-${id}`, key: 'keep-warm', at, ok, durationMs: 100, dbMs, source } });
    await kw('a', T('03:00:05'), true, 10, 'vercel');
    // A failed probe that still timed a slow round trip: it must not enter the p95.
    await kw('b', T('03:00:40'), false, 5000, 'cron-job.org');
    await kw('c', T('03:04:10'), false, null, 'vercel');
    await kw('d', T('03:12:30'), true, 30, 'cron-job.org');

    // Approval decisions: three tracked SUPERVISOR steps (two on time), one
    // untracked (made before the snapshot existed).
    const edit = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'APPROVED',
        fieldChanges: [], attachmentChanges: [],
      },
    });
    editIds.push(edit.id);
    const step = (i: number, at: Date, due: Date | null, minutes: number | null) =>
      prisma.editApproval.create({
        data: {
          editId: edit.id, cycle: 1, stepIndex: i, role: 'SUPERVISOR', decision: 'APPROVED', actorId: userId,
          at, stageEnteredAt: due ? T('04:00:00') : null, slaDueAt: due, workingMinutes: minutes,
        },
      });
    await step(0, T('05:00:00'), T('12:00:00'), 60);
    await step(1, T('06:00:00'), T('12:00:00'), 120);
    await step(2, T('13:00:00'), T('12:00:00'), 600);
    await step(3, T('07:00:00'), null, null);

    // A reactivation decided on time: the MANAGER tier.
    const re = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER', submittedById: userId, state: 'APPROVED', isReactivation: true,
        fieldChanges: [], attachmentChanges: [],
        submittedAt: T('04:00:00'), stageEnteredAt: T('04:00:00'), slaDueAt: T('12:00:00'), reviewedAt: T('06:00:00'),
        // Who decided it: the tier's "people" count, which decides whether a
        // Manager may see the tier on its own.
        reviewedById: userId,
      },
    });
    editIds.push(re.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.cronRun.deleteMany({ where: { id: { startsWith: sfx } } });
    // The step ledger is append-only: its rows go with their edit, in a maintenance window.
    if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, managerId].filter(Boolean) } } });
    await prisma.$disconnect();
  });

  it('keep-warm collapses to one row per 4-minute slot on the hour grid; a slot is ok if any run in it was', async () => {
    const slots = await svc.__internal.keepWarmSlots(FROM);
    const mine = slots
      .filter((s) => s.at.getUTCFullYear() === 2099)
      .map((s) => [s.at.toISOString().slice(11, 19), s.ok])
      .sort();
    expect(mine).toEqual([
      ['03:00:00', true],
      ['03:04:00', false],
      ['03:12:00', true],
    ]);
  });

  it('the database round trip is read from successful probes only', async () => {
    // [10, 30] → p95 = 10 + 0.95 × 20 = 29
    expect(await svc.__internal.p95DbMs(FROM)).toBe(29);
  });

  it('approval tiers: tracked vs untracked, on time, and percentiles of the snapshot minutes', async () => {
    const { tiers } = await svc.__internal.approvalTiers(FROM);
    const sup = tiers.find((t) => t.role === 'SUPERVISOR');
    // One person made all four decisions: the page folds this tier for a Manager.
    expect(sup).toEqual({
      role: 'SUPERVISOR', decided: 4, tracked: 3, within: 2, p50Minutes: 120, p90Minutes: 504, people: [userId],
    });
    const mgr = tiers.find((t) => t.role === 'MANAGER');
    expect(mgr).toEqual({ role: 'MANAGER', decided: 1, tracked: 1, within: 1, p50Minutes: 120, p90Minutes: 120, people: [userId] });
  });

  it('the last successful run from Vercel’s own cron, per job — the check before retiring cron-job.org', async () => {
    const last = await svc.__internal.lastVercelRuns(new Date('2099-06-02T00:00:00Z'));
    // 03:04:10 was Vercel's too, but it failed; 03:12:30 succeeded, from cron-job.org.
    expect(last.get('keep-warm')).toEqual(T('03:00:05'));
  });

  it('the open queue carries the people who can decide each step', async () => {
    // The seeded request waits at the Supervisor step, which Supervisors and
    // (as the region fallback) Managers decide. Our active Manager must be among
    // its holders; the role names read from the users must match the queue's.
    const tiers = await svc.__internal.openApprovals(new Date('2099-06-02T00:00:00Z'));
    const sup = tiers.find((t) => t.role === 'SUPERVISOR');
    expect(sup, 'the waiting Supervisor-step request').toBeDefined();
    expect(sup!.open).toBeGreaterThanOrEqual(1);
    expect(sup!.holders).toContain(managerId);
    const active = await prisma.user.count({ where: { isActive: true, role: { in: ['SUPERVISOR', 'MANAGER'] } } });
    expect(sup!.holders.length).toBeLessThanOrEqual(active + 5); // other suites add users in parallel
    expect(sup!.holders.length).toBeGreaterThanOrEqual(1);
  });

  it('the whole loader runs against real Postgres and returns verdicts', async () => {
    const s = await svc.loadServiceStatus(new Date('2099-06-02T00:00:00Z'));
    const statuses = ['met', 'at-risk', 'breached', 'no-data'];
    for (const v of [s.availability, s.slaSweep, s.backup, s.approvals]) expect(statuses).toContain(v.status);
    expect(statuses).toContain(s.temix.status);
    expect(statuses).toContain(s.imports.status);
    for (const t of s.openApprovals) expect(t.open).toBeGreaterThanOrEqual(t.pastDue);
    expect(s.jobs.length).toBeGreaterThan(0);
    for (const j of s.jobs) expect(j).not.toHaveProperty('lastError');
    // Our SUPERVISOR decisions are inside its 30-day window.
    expect(s.approvals.tiers.some((t) => t.role === 'SUPERVISOR' && t.decided >= 4)).toBe(true);
  });
});
