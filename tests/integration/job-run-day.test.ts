// @vitest-environment node
/**
 * Gap 21 (data audit 2026-10-10), on Postgres: the scheduled jobs' run history
 * is kept as history (lib/job-run-day.ts, the retention sweep's step 4).
 *
 *   - every Oman day that is over gets one JobRunDay row per job: runs,
 *     failures, first and last start, the slowest run, the schedulers — a run
 *     at 23:30 Oman counts on its own day, one at 00:30 on the next;
 *   - writing again adds nothing (ON CONFLICT DO NOTHING), and the day that is
 *     still running is not written;
 *   - CronRun rows past the cutoff go only when their day has its row: a day
 *     without one keeps its runs, whatever their age;
 *   - JobRunDay rows cannot be changed or deleted.
 *
 * The synthetic runs are dated January 2026, before CronRun existed anywhere, so
 * the prune below (its cutoff is 1 February 2026) can only ever reach them.
 *
 *   RUN_ACCOUNTABILITY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/job-run-day.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { pruneSummarisedCronRuns, summariseJobRunDays } from '@/lib/job-run-day';
import { purgeJobRunDays } from '../support/audit';
import { assertNotProductionEnv } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_ACCOUNTABILITY === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('gap 21: one kept row per job per Oman day', () => {
  let prisma: PrismaClient;
  const sfx = `zzjrd${Date.now().toString(36)}`;
  const key = `${sfx}-job`;
  const at = (iso: string) => new Date(iso);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const ours = () => prisma.jobRunDay.findMany({ where: { key }, orderBy: { day: 'asc' } });

  beforeAll(async () => {
    assertNotProductionEnv();
    ({ prisma } = await import('@/lib/db'));
    await prisma.cronRun.createMany({
      data: [
        // 10 January 2026 in Oman: 00:30 (20:30 UTC on the 9th) and 14:00, one failed.
        { id: `${sfx}-1`, key, at: at('2026-01-09T20:30:00Z'), ok: true, durationMs: 120, source: 'vercel' },
        { id: `${sfx}-2`, key, at: at('2026-01-10T10:00:00Z'), ok: false, durationMs: 950, source: 'github' },
        // 23:30 Oman on 10 January — still the 10th.
        { id: `${sfx}-3`, key, at: at('2026-01-10T19:30:00Z'), ok: true, durationMs: 40, source: 'vercel' },
        // 11 January in Oman.
        { id: `${sfx}-4`, key, at: at('2026-01-10T20:30:00Z'), ok: true, durationMs: 60, source: null },
        // Today: its day is not over.
        { id: `${sfx}-now`, key, at: new Date(), ok: true, durationMs: 5, source: 'other' },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.cronRun.deleteMany({ where: { key } });
    await purgeJobRunDays(prisma, { where: { key } });
    await prisma.$disconnect();
  });

  it('writes each Oman day that is over, once, and not the day that is running', async () => {
    await summariseJobRunDays(prisma);
    const days = await ours();
    expect(days.map((d) => [day(d.day), d.runs, d.failures, d.maxDurationMs, d.sources])).toEqual([
      ['2026-01-10', 3, 1, 950, ['github', 'vercel']],
      ['2026-01-11', 1, 0, 60, []],
    ]);
    expect(days[0]!.firstAt.toISOString()).toBe('2026-01-09T20:30:00.000Z');
    expect(days[0]!.lastAt.toISOString()).toBe('2026-01-10T19:30:00.000Z');
    await summariseJobRunDays(prisma);
    expect((await ours()).map((d) => String(d.id))).toEqual(days.map((d) => String(d.id)));
  });

  it('prunes only runs whose day has its row', async () => {
    // A run on a day that has no row yet (inserted after the summary above).
    await prisma.cronRun.create({ data: { id: `${sfx}-late`, key, at: at('2026-01-12T08:00:00Z'), ok: true, durationMs: 7 } });
    await pruneSummarisedCronRuns(prisma, at('2026-02-01T00:00:00Z'), 100);
    const left = await prisma.cronRun.findMany({ where: { key }, select: { id: true }, orderBy: { id: 'asc' } });
    expect(left.map((r) => r.id)).toEqual([`${sfx}-late`, `${sfx}-now`]);
    // Its day is written by the next summary, and only then may it go.
    await summariseJobRunDays(prisma);
    await pruneSummarisedCronRuns(prisma, at('2026-02-01T00:00:00Z'), 100);
    expect((await prisma.cronRun.findMany({ where: { key }, select: { id: true } })).map((r) => r.id)).toEqual([`${sfx}-now`]);
    expect((await ours()).map((d) => day(d.day))).toEqual(['2026-01-10', '2026-01-11', '2026-01-12']);
  });

  it('a day row cannot be changed or deleted outside the owner’s maintenance window', async () => {
    const one = (await ours())[0]!;
    await expect(prisma.jobRunDay.update({ where: { id: one.id }, data: { runs: 99 } })).rejects.toThrow(/append-only|permission denied/i);
    await expect(prisma.jobRunDay.delete({ where: { id: one.id } })).rejects.toThrow(/append-only|permission denied/i);
  });
});
