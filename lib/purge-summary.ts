/**
 * Gap 25 (data audit 2026-10-10): a clean-up never deletes evidence without
 * leaving a summary of what it deleted.
 *
 * Every retention rule (lib/retention-rules.ts) deletes — or, for an import
 * row, empties — through ONE statement built here. The statement chooses the
 * batch, removes it with the row predicate restated (a row whose state changed
 * after it was chosen is left alone), and writes one PurgeSummary row from what
 * it removed: the table, the rule, how many, the oldest and newest date, the
 * cut-off and a few allowlisted counts. One statement commits as one: there is
 * no deletion without its summary and no summary without its deletion. An empty
 * batch writes no summary (PurgeSummary_rows_check: rows > 0).
 *
 * PurgeSummary is append-only like AuditLog (migration
 * 20261024120100_purge_summaries) and holds no personal value: the counts are
 * by category only (never a rate-limit key, an id of a person, a name or text).
 * Its source and transaction are stamped by the database from the writer's
 * change context, so the routes run these inside withChangeContext.
 *
 * This module is the ONLY place in app/, lib/ and services/ that deletes from
 * RateLimit, Notification, CronRun, Attachment or PasswordHistory, or empties an
 * import row's payload (tests/unit/purge-summary-guard.test.ts).
 *
 * PURE: no next/* and no lib/db import; the caller passes its client.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { RETENTION_RULES, retentionCutoff, type RetentionRule, type RetentionRuleId } from './retention-rules';

/** Who is running a purge: its job's run id and, where it has no change context, its source. */
export type PurgeRun = {
  /** `<job>:<run start ISO>`, so the summaries of one run are found together. */
  runId: string | null;
  /** Left null when a change context names the cause (the database stamps it). */
  source?: string | null;
};

/** What one statement did: rows removed (or emptied), and summary rows written (0 or 1). */
export type PurgeOutcome = { affected: number; summarised: number };

/** The categories a summary may count by, per table. Anything else is a bug in a builder. */
export const PURGE_DETAIL_KEYS: Record<RetentionRule['table'], readonly string[]> = {
  RateLimit: ['byKind'],
  ImportRow: ['byBatch', 'excludedAt'],
  Notification: ['byMonth'],
  CronRun: ['byKey'],
  Attachment: ['byKind'],
  PasswordHistory: [],
};

/** The rate-limit categories a summary counts: the bucket's kind, never its key. */
export const RATE_LIMIT_KINDS = ['login:user', 'login:ip', 'passwordreset', 'other'] as const;

/** The category a rate-limit key is counted under (the SQL below is its twin). */
export function rateLimitKind(key: string): (typeof RATE_LIMIT_KINDS)[number] {
  if (key.startsWith('login:user:')) return 'login:user';
  if (key.startsWith('login:ip:')) return 'login:ip';
  if (key.startsWith('passwordreset')) return 'passwordreset';
  return 'other';
}

export class PurgeSummaryMismatch extends Error {
  constructor(rule: RetentionRuleId, o: PurgeOutcome) {
    super(`purge ${rule}: ${o.affected} row(s) removed but ${o.summarised} summary row(s) written`);
    this.name = 'PurgeSummaryMismatch';
  }
}

/** A summary for every batch that removed something, and none for an empty one. */
export function checkPurgeOutcome(rule: RetentionRuleId, o: PurgeOutcome): number {
  if (o.summarised !== (o.affected > 0 ? 1 : 0)) throw new PurgeSummaryMismatch(rule, o);
  return o.affected;
}

/** A Date as the UTC timestamp the TIMESTAMP(3) columns hold, whatever the session's TimeZone. */
function ts(d: Date): Prisma.Sql {
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * The summary row, written from the `gone` CTE (which RETURNs `d`, the rule's
 * date column) when it holds anything.
 */
function summaryInsert(
  rule: RetentionRule,
  run: PurgeRun,
  cutoff: Date | null,
  detail: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`INSERT INTO "PurgeSummary" ("job", "rule", "tableName", "action", "rows", "dateColumn", "oldestAt", "newestAt", "cutoff", "retentionDays", "detail", "runId", "source")
    SELECT ${rule.job}::text, ${rule.id}::text, ${rule.table}::text, ${rule.action}::text, count(*)::int, ${rule.dateColumn}::text,
           min(gone.d), max(gone.d), ${cutoff ? ts(cutoff) : Prisma.sql`NULL::timestamp`}, ${rule.days}::int,
           ${detail}, ${run.runId}::text, ${run.source ?? null}::text
      FROM gone
    HAVING count(*) > 0
    RETURNING 1`;
}

const OUTCOME = Prisma.sql`SELECT (SELECT count(*) FROM gone)::int AS "affected", (SELECT count(*) FROM s)::int AS "summarised"`;

/** `{ "<k>": n, … }` over the gone rows, grouped by the expression `key`. */
function countBy(key: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT COALESCE(jsonb_object_agg(z.k, z.n), '{}'::jsonb) FROM (SELECT ${key} AS k, count(*)::int AS n FROM gone GROUP BY 1) z)`;
}

/** Notifications: `byMonth[YYYY-MM].byKind[kind][emailStatus]`, by the Oman month each was made. */
const NOTIFICATION_DETAIL = Prisma.sql`jsonb_build_object('byMonth', (
  SELECT COALESCE(jsonb_object_agg(m.month, jsonb_build_object('byKind', m.kinds)), '{}'::jsonb) FROM (
    SELECT k.month, jsonb_object_agg(k.kind, k.statuses) AS kinds FROM (
      SELECT st.month, st.kind, jsonb_object_agg(st.status, st.n) AS statuses FROM (
        SELECT to_char((gone.created AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat', 'YYYY-MM') AS month,
               gone.kind, COALESCE(gone.status, 'NONE') AS status, count(*)::int AS n
          FROM gone GROUP BY 1, 2, 3) st
      GROUP BY st.month, st.kind) k
    GROUP BY k.month) m))`;

// ── The statements ──────────────────────────────────────────────────────────

/** rate-limit-1d: spent token buckets, oldest first. */
export function rateLimitPurgeSql(now: Date, limit: number, run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['rate-limit-1d'];
  const cutoff = retentionCutoff(rule, now);
  return Prisma.sql`WITH doomed AS (
    SELECT "key" FROM "RateLimit" WHERE "updatedAt" < ${ts(cutoff)} ORDER BY "updatedAt" LIMIT ${limit}
  ), gone AS (
    DELETE FROM "RateLimit" x USING doomed WHERE x."key" = doomed."key" AND x."updatedAt" < ${ts(cutoff)}
    RETURNING x."updatedAt" AS d,
      CASE WHEN starts_with(x."key", 'login:user:') THEN 'login:user'
           WHEN starts_with(x."key", 'login:ip:') THEN 'login:ip'
           WHEN starts_with(x."key", 'passwordreset') THEN 'passwordreset'
           ELSE 'other' END AS kind
  ), s AS (
    ${summaryInsert(rule, run, cutoff, Prisma.sql`jsonb_build_object('byKind', ${countBy(Prisma.sql`gone.kind`)})`)}
  )
  ${OUTCOME}`;
}

/**
 * import-payload-90d: the verbatim payload of FINISHED import rows (promoted or
 * rejected, or held back and excluded 90 days ago) in a batch not being promoted.
 * The row, its outcome and its exclusion are kept. Counted by batch and state.
 */
export function importPayloadPurgeSql(now: Date, limit: number, run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['import-payload-90d'];
  const cutoff = retentionCutoff(rule, now);
  // A finished row: promoted or rejected, or held back and excluded before the cut-off.
  const finished = (r: string) =>
    Prisma.sql`(${Prisma.raw(r)}."state" IN ('PROMOTED', 'REJECTED') OR (${Prisma.raw(r)}."state" = 'QUARANTINED' AND ${Prisma.raw(r)}."excludedAt" < ${ts(cutoff)}))`;
  const hasPayload = (r: string) =>
    Prisma.raw(`(${r}."raw" <> '{}'::jsonb OR ${r}."parsed" IS NOT NULL OR ${r}."issues" IS NOT NULL OR ${r}."corrections" IS NOT NULL)`);
  return Prisma.sql`WITH doomed AS (
    SELECT r."id"
      FROM "ImportRow" r
      JOIN "ImportBatch" b ON b."id" = r."batchId"
     WHERE r."createdAt" < ${ts(cutoff)}
       AND b."status" <> 'PROMOTING'
       AND ${finished('r')}
       AND ${hasPayload('r')}
     ORDER BY r."createdAt"
     LIMIT ${limit}
  ), gone AS (
    UPDATE "ImportRow" x
       SET "raw" = '{}'::jsonb, "parsed" = NULL, "issues" = NULL, "corrections" = NULL
      FROM doomed
     WHERE x."id" = doomed."id"
       AND x."createdAt" < ${ts(cutoff)}
       AND ${finished('x')}
       AND ${hasPayload('x')}
       AND EXISTS (SELECT 1 FROM "ImportBatch" xb WHERE xb."id" = x."batchId" AND xb."status" <> 'PROMOTING')
    RETURNING x."createdAt" AS d, x."batchId" AS batch, x."state"::text AS state, x."excludedAt" AS excluded
  ), s AS (
    ${summaryInsert(
      rule,
      run,
      cutoff,
      Prisma.sql`jsonb_build_object(
        'byBatch', (SELECT COALESCE(jsonb_object_agg(bb.batch, bb.states), '{}'::jsonb) FROM (
                      SELECT st.batch, jsonb_object_agg(st.state, st.n) AS states FROM (
                        SELECT gone.batch, gone.state, count(*)::int AS n FROM gone GROUP BY 1, 2) st
                      GROUP BY st.batch) bb),
        'excludedAt', CASE WHEN count(gone.excluded) > 0
                           THEN jsonb_build_object('oldest', min(gone.excluded), 'newest', max(gone.excluded)) END)`
    )}
  )
  ${OUTCOME}`;
}

/** notification-unread-180d: notifications nobody ever opened. */
export function unreadNotificationPurgeSql(now: Date, limit: number, run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['notification-unread-180d'];
  const cutoff = retentionCutoff(rule, now);
  return Prisma.sql`WITH doomed AS (
    SELECT "id" FROM "Notification" WHERE "readAt" IS NULL AND "createdAt" < ${ts(cutoff)} ORDER BY "createdAt" LIMIT ${limit}
  ), gone AS (
    DELETE FROM "Notification" x USING doomed
     WHERE x."id" = doomed."id" AND x."readAt" IS NULL AND x."createdAt" < ${ts(cutoff)}
    RETURNING x."createdAt" AS d, x."createdAt" AS created, x."kind"::text AS kind, x."emailStatus" AS status
  ), s AS (
    ${summaryInsert(rule, run, cutoff, NOTIFICATION_DETAIL)}
  )
  ${OUTCOME}`;
}

/** notification-read-90d: notifications read 90 days ago (the SLA sweep's clean-up). */
export function readNotificationPurgeSql(now: Date, limit: number, run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['notification-read-90d'];
  const cutoff = retentionCutoff(rule, now);
  return Prisma.sql`WITH doomed AS (
    SELECT "id" FROM "Notification" WHERE "readAt" IS NOT NULL AND "readAt" < ${ts(cutoff)} ORDER BY "readAt" LIMIT ${limit}
  ), gone AS (
    DELETE FROM "Notification" x USING doomed
     WHERE x."id" = doomed."id" AND x."readAt" IS NOT NULL AND x."readAt" < ${ts(cutoff)}
    RETURNING x."readAt" AS d, x."createdAt" AS created, x."kind"::text AS kind, x."emailStatus" AS status
  ), s AS (
    ${summaryInsert(rule, run, cutoff, NOTIFICATION_DETAIL)}
  )
  ${OUTCOME}`;
}

/**
 * cron-run-90d: scheduled runs past the cut-off whose Oman day is kept in
 * JobRunDay (gap 21, lib/job-run-day.ts). A day without its row keeps its runs.
 */
export function cronRunPurgeSql(cutoff: Date, limit: number, run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['cron-run-90d'];
  const summarisedDay = (c: string) =>
    Prisma.raw(
      `EXISTS (SELECT 1 FROM "JobRunDay" j WHERE j."key" = ${c}."key" AND j."day" = ((${c}."at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat')::date)`
    );
  return Prisma.sql`WITH doomed AS (
    SELECT c."id" FROM "CronRun" c
     WHERE c."at" < ${ts(cutoff)} AND ${summarisedDay('c')}
     ORDER BY c."at"
     LIMIT ${limit}
  ), gone AS (
    DELETE FROM "CronRun" x USING doomed
     WHERE x."id" = doomed."id" AND x."at" < ${ts(cutoff)} AND ${summarisedDay('x')}
    RETURNING x."at" AS d, x."key" AS k
  ), s AS (
    ${summaryInsert(rule, run, cutoff, Prisma.sql`jsonb_build_object('byKey', ${countBy(Prisma.sql`gone.k`)})`)}
  )
  ${OUTCOME}`;
}

/**
 * photo-detached-30d: ONE detached photo's row, once its object is tagged for
 * expiry (app/api/cron/photo-gc). The row is deleted only if it is still
 * detached past the cut-off; its AttachmentHistory DELETE row and any slot the
 * foreign keys clear are written by the database in the same statement.
 */
export function photoPurgeSql(attachmentId: string, now: Date, run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['photo-detached-30d'];
  const cutoff = retentionCutoff(rule, now);
  return Prisma.sql`WITH gone AS (
    DELETE FROM "Attachment" x
     WHERE x."id" = ${attachmentId} AND x."deletedAt" IS NOT NULL AND x."deletedAt" < ${ts(cutoff)}
    RETURNING x."deletedAt" AS d, x."kind"::text AS kind
  ), s AS (
    ${summaryInsert(rule, run, cutoff, Prisma.sql`jsonb_build_object('byKind', ${countBy(Prisma.sql`gone.kind`)})`)}
  )
  ${OUTCOME}`;
}

/** password-history-last-5: a person's older password hashes, past the newest `keepIds`. */
export function passwordHistoryPurgeSql(userId: string, keepIds: string[], run: PurgeRun): Prisma.Sql {
  const rule = RETENTION_RULES['password-history-last-5'];
  return Prisma.sql`WITH gone AS (
    DELETE FROM "PasswordHistory" x
     WHERE x."userId" = ${userId} AND NOT (x."id" = ANY(${keepIds}::text[]))
    RETURNING x."createdAt" AS d
  ), s AS (
    ${summaryInsert(rule, run, null, Prisma.sql`NULL::jsonb`)}
  )
  ${OUTCOME}`;
}

// ── Running them ────────────────────────────────────────────────────────────

type Raw = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Run one purge statement and check it summarised what it removed. Throws on a
 * mismatch; inside a transaction (as every caller runs it) that rolls the batch
 * back, so the deletion is undone with its missing summary.
 */
export async function runPurge(db: Raw, rule: RetentionRuleId, statement: Prisma.Sql): Promise<number> {
  const rows = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ affected: number | bigint; summarised: number | bigint }>>(
    statement
  );
  return checkPurgeOutcome(rule, {
    affected: Number(rows[0]?.affected ?? 0),
    summarised: Number(rows[0]?.summarised ?? 0),
  });
}

/** The run id the summaries of one job run share. */
export function purgeRunId(job: string, startedAt: Date): string {
  return `${job}:${startedAt.toISOString()}`;
}
