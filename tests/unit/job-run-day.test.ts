// @vitest-environment node
/**
 * Gap 21 (data audit 2026-10-10): scheduled-job run history kept as history.
 * The retention sweep writes every Oman day that is over to JobRunDay, then
 * prunes only CronRun rows whose day has its row (lib/job-run-day.ts). On a real
 * Postgres: tests/integration/job-run-day.test.ts and retention-sweep.test.ts.
 *
 * What this pins: which days are "over", that the bounds are converted to UTC
 * explicitly (CronRun.at holds UTC without a zone, and a session in another
 * TimeZone must not move a day — it did, on a +04 test cluster), the order in
 * the sweep, and that a failed summary cannot let a day be pruned.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { completeDaysBefore, JOB_DAY_SETTLE_MS, pruneSummarisedCronRuns, summariseJobRunDays } from '@/lib/job-run-day';
import { stripComments } from '../support/strip-comments';

type Captured = { sql: string; values: unknown[] };
function capture(): { db: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    db: {
      $executeRaw: async (s: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: s.join('$?'), values });
        return 0;
      },
    },
  };
}

describe('which Oman days are over', () => {
  it('the start of the Oman day an hour ago: yesterday from 01:00 Oman, the day before until then', () => {
    // 09:00 Oman on 12 Oct: 11 Oct and before are over.
    expect(completeDaysBefore(new Date('2026-10-12T05:00:00Z')).toISOString()).toBe('2026-10-11T20:00:00.000Z');
    // 00:30 Oman on 12 Oct: 11 Oct ended half an hour ago — not settled yet.
    expect(completeDaysBefore(new Date('2026-10-11T20:30:00Z')).toISOString()).toBe('2026-10-10T20:00:00.000Z');
    // 01:00 Oman exactly: settled.
    expect(completeDaysBefore(new Date('2026-10-11T21:00:00Z')).toISOString()).toBe('2026-10-11T20:00:00.000Z');
    expect(JOB_DAY_SETTLE_MS).toBe(60 * 60 * 1000);
  });
});

describe('the statements', () => {
  it('summarise: Oman days, explicit UTC bounds, only days without a row, never an update', async () => {
    const { db, calls } = capture();
    await summariseJobRunDays(db as never, new Date('2026-10-12T05:00:00Z'));
    const { sql, values } = calls[0]!;
    expect(sql).toContain(`((c."at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date AS day`);
    expect(sql).toMatch(/c\."at" < \(\$\?::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(values).toEqual(['2026-10-11T20:00:00.000Z']);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "JobRunDay" j');
    expect(sql).toContain('ON CONFLICT ("key", "day") DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE/);
  });

  it('prune: only runs past the cutoff whose day has its row', async () => {
    const { db, calls } = capture();
    await pruneSummarisedCronRuns(db as never, new Date('2026-07-14T05:00:00Z'), 2000);
    const { sql, values } = calls[0]!;
    expect(sql).toMatch(/c\."at" < \(\$\?::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(sql).toMatch(/AND EXISTS \(\s*SELECT 1 FROM "JobRunDay" j\s*WHERE j\."key" = c\."key"\s*AND j\."day" = \(\(c\."at" AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Muscat'\)::date\)/);
    expect(values).toEqual(['2026-07-14T05:00:00.000Z', 2000]);
  });
});

describe('the retention sweep', () => {
  const src = stripComments(readFileSync('app/api/cron/retention-sweep/route.ts', 'utf8'), 'route.ts');

  it('summarises the days before it prunes their runs, each step on its own error count', () => {
    const summarise = src.indexOf('swept.jobRunDays = await summariseJobRunDays(prisma)');
    const prune = src.indexOf('swept.cronRuns = await pruneSummarisedCronRuns(prisma, cutoff(CRON_RUN_DAYS), CRON_RUN_BATCH)');
    expect(summarise).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(summarise);
    // Two try blocks: a failed summary is counted and the prune still only takes summarised days.
    expect(src.slice(summarise, prune)).toMatch(/catch \(err\) \{\s*errors \+= 1;/);
  });

  it('no longer deletes a run without its day row', () => {
    expect(src).not.toMatch(/DELETE FROM "CronRun"/);
  });
});
