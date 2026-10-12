/**
 * Gap 21 (data audit 2026-10-10): the scheduled jobs' run history, kept for
 * ever, one row per job per Oman day (JobRunDay, migration
 * 20261015100000_authority_jobs_auth_events).
 *
 * CronRun keeps every run for 90 days (the service-level report reads 30). A
 * missing escalation a year later must still be told apart from a job that never
 * ran, so the retention sweep (app/api/cron/retention-sweep) does two things, in
 * this order, every day:
 *
 *   1. summariseJobRunDays: every Oman day that is over (by an hour, so a run
 *      started just before midnight has recorded itself) and has no row yet gets
 *      one per job: runs, failures, first and last start, the slowest run, the
 *      schedulers that called. INSERT … ON CONFLICT DO NOTHING: a day is written
 *      once and never corrected (the table is append-only).
 *   2. pruneSummarisedCronRuns: CronRun rows past 90 days are deleted ONLY when
 *      their day has its JobRunDay row. A sweep that failed to summarise, or did
 *      not run for weeks, therefore loses nothing: the runs wait until their day
 *      is written. So no day can be pruned in part before it is summarised, and
 *      step 1 needs no lower bound.
 *
 * Days are Oman calendar days of the run's START (Asia/Muscat, UTC+4). Every
 * time is converted explicitly (CronRun.at holds UTC without a zone), so the
 * answer does not depend on the database session's TimeZone setting.
 */
import type { PrismaClient } from '@prisma/client';
import { omanDayStart } from './change-context';
import { omanDateISO } from './tz';

/** A day is summarised once it has been over for this long. */
export const JOB_DAY_SETTLE_MS = 60 * 60 * 1000;

/**
 * Runs that started before this instant belong to Oman days that are over and
 * settled: the start of the Oman day that (now − 1 hour) falls on.
 */
export function completeDaysBefore(now: Date): Date {
  const day = omanDateISO(new Date(now.getTime() - JOB_DAY_SETTLE_MS));
  return omanDayStart(day)!;
}

type Raw = Pick<PrismaClient, '$executeRaw'>;

/** Write the day rows that are due. Returns how many were written. */
export function summariseJobRunDays(db: Raw, now: Date = new Date()): Promise<number> {
  const before = completeDaysBefore(now);
  return db.$executeRaw`
    INSERT INTO "JobRunDay" ("key", "day", "runs", "failures", "firstAt", "lastAt", "maxDurationMs", "sources")
    SELECT c."key",
           d.day,
           count(*)::int,
           (count(*) FILTER (WHERE NOT c."ok"))::int,
           min(c."at"),
           max(c."at"),
           max(c."durationMs"),
           COALESCE(array_agg(DISTINCT c."source" ORDER BY c."source") FILTER (WHERE c."source" IS NOT NULL), '{}')
      FROM "CronRun" c
      CROSS JOIN LATERAL (SELECT ((c."at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date AS day) d
     WHERE c."at" < (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       AND NOT EXISTS (SELECT 1 FROM "JobRunDay" j WHERE j."key" = c."key" AND j."day" = d.day)
     GROUP BY c."key", d.day
    ON CONFLICT ("key", "day") DO NOTHING`;
}

/**
 * Delete up to `limit` CronRun rows older than `cutoff` whose Oman day has its
 * JobRunDay row. Returns how many were deleted.
 */
export function pruneSummarisedCronRuns(db: Raw, cutoff: Date, limit: number): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "CronRun"
     WHERE "id" IN (
       SELECT c."id" FROM "CronRun" c
        WHERE c."at" < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          AND EXISTS (
                SELECT 1 FROM "JobRunDay" j
                 WHERE j."key" = c."key"
                   AND j."day" = ((c."at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date)
        ORDER BY c."at"
        LIMIT ${limit}
     )`;
}
