/**
 * B6 (enterprise assessment, 2026-09-14): make the retention schedule a thing
 * the system DOES, not a thing a document says.
 *
 * Before this, exactly three mechanisms removed personal data: photo garbage
 * collection (30 days after soft-delete), a read-notification sweep (90 days),
 * and password-history pruning (last five). Everything else grew forever —
 * including three stores that hold personal data with no purpose once they are
 * a few days old:
 *
 *   RateLimit  — token-bucket rows keyed `login:user:<username>` and
 *                `login:ip:<address>`. The bucket refills within minutes, so a
 *                row older than a day is a login-attempt log nobody asked for.
 *   ImportRow  — `raw` holds the source spreadsheet row verbatim, so every
 *                re-import duplicates the whole customer master into this table.
 *                Kept while the batch may still be resumed or reconciled, then
 *                the payload is emptied and the row's outcome is kept.
 *   Notification — the existing sweep only deletes rows a user has READ, so a
 *                disengaged approver's queue keeps customer names forever.
 *
 * Deletion is intentionally conservative: each rule has a stated purpose and a
 * period taken from docs/compliance/DATA-RETENTION-SCHEDULE.md, and the sweep
 * NEVER touches the append-only ledgers (AuditLog, EditApproval, the dated
 * history, JobRunDay, AuthEvent) — those are retained deliberately and any
 * change to them is an owner-authorised maintenance operation, not a cron job.
 * It only ever ADDS to one: each day of scheduled-job runs is written to
 * JobRunDay before that day's runs may be pruned (gap 21, lib/job-run-day.ts).
 *
 * Gap 25 (data audit 2026-10-10): and every batch it deletes or empties leaves a
 * PurgeSummary row, written by the same statement (lib/purge-summary.ts): what,
 * how many, the date range, the cut-off and the rule. The periods are read from
 * lib/retention-rules.ts, unchanged. Each statement runs in its own transaction
 * under the job's change context, so the summary names its cause.
 *
 * Daily via vercel.json crons. Reports through the same heartbeat machinery as
 * the other jobs so a silently dead sweep alarms on /api/health.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';
import { src, withChangeContext } from '@/lib/change-context';
import { pruneSummarisedCronRuns, summariseJobRunDays } from '@/lib/job-run-day';
import { RETENTION_RULES, retentionCutoff } from '@/lib/retention-rules';
import {
  importPayloadPurgeSql,
  purgeRunId,
  rateLimitPurgeSql,
  runPurge,
  unreadNotificationPurgeSql,
  type PurgeRun,
} from '@/lib/purge-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The periods (lib/retention-rules.ts, held to the schedule by
// tests/unit/retention-rules-doc.test.ts):
//   rate-limit-1d            token-bucket state is meaningless once refilled
//   import-payload-90d       a batch stays resumable and reconcilable for a quarter
//                            (the Steward's in-app fix refuses a row past the same 90 days)
//   notification-unread-180d the read ones are swept at 90 days by the SLA job
//   cron-run-90d             three 30-day service-level windows
/** Bound the work per run so the job stays well inside the function timeout. */
const BATCH = 500;
/**
 * Import payloads are cleared in bounded statements, repeated while rows are
 * left and time remains. Every go-live row crosses the 90-day line on the same
 * day — some 40,000 of them — and one 500-row statement a day would have kept
 * them months past the schedule while the heartbeat stayed green (post-merge
 * review). The budget leaves the other steps room inside the 60 s limit.
 */
const IMPORT_BATCH = 2000;
const IMPORT_BUDGET_MS = 30_000;
/** Scheduled-run history: the service-level report reads 30 days; keep three windows. */
// Not exported: a route file may export only what Next allows, and only
// `next build` checks that (CLAUDE.md).
const CRON_RUN_BATCH = 2000;

/** The job's change context: the summaries and any history the purge causes name it. */
const CAUSE = { actorId: null, source: src.cron('retention-sweep') } as const;

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  let errors = 0;
  const swept: Record<string, number> = {};
  const now = new Date();
  // The summaries of this run share one run id.
  const run: PurgeRun = { runId: purgeRunId('retention-sweep', now) };

  // 1. Spent rate-limit buckets (usernames and IP addresses).
  try {
    // Bounded: an unbounded delete over an unindexed predicate is how a daily
    // job discovers the 60 s function limit on the one night it matters.
    // Gap 25: the batch and its summary (counts by bucket kind, never the key).
    swept.rateLimit = await withChangeContext(prisma, CAUSE, (tx) =>
      runPurge(tx, 'rate-limit-1d', rateLimitPurgeSql(now, BATCH, run))
    );
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.rate_limit_failed');
  }

  // 2. Import payloads: keep the row and its outcome, drop the verbatim copies
  //    of the customer data — but ONLY for rows whose work is finished.
  //
  //    `services/imports.ts` reads `row.parsed` to promote a row. Clearing it on
  //    a row that has not been promoted or rejected yet would leave a staged
  //    batch permanently unpromotable, which a rollback cannot undo because the
  //    payload is gone. So the predicate requires a terminal ROW state, in a
  //    batch that is not being promoted; a CLEAN row keeps its payload however
  //    old it is, and an operator who abandons a batch before promoting it can
  //    still see what was in it.
  //
  //    Raw SQL on purpose: Prisma reads `undefined` as "leave this column
  //    alone", so the obvious `{ raw: {}, parsed: undefined }` silently kept the
  //    customer's name, address, phone and CR number in `parsed`.
  //
  //    Item 20: "corrections" (cells the Steward fixed in the app) is the same
  //    customer data and goes with the rest. And a held-back row the Steward
  //    accepted as excluded is finished too — it will never be promoted — so it
  //    follows the same rule as a rejected one, counted from when it was
  //    excluded. Before, a QUARANTINED row kept its payload for ever.
  //
  //    A PROMOTED or REJECTED row is finished whatever its batch's status, bar
  //    a batch being promoted right now: promote reads only CLEAN rows, and a
  //    fix refuses a row past the same 90 days. Requiring a PROMOTED or FAILED
  //    batch kept every row of a promoted batch that a fix had set back to
  //    READY — for ever, once the fix was withdrawn and nothing was left to
  //    promote (post-merge review). The CLEAN rows of such a batch are the ones
  //    promote still needs, and keep their payload.
  try {
    const started = Date.now();
    let cleared = 0;
    let last = 0;
    do {
      // An excluded held-back row is read by nothing (promote reads CLEAN rows;
      // a fix refuses excluded ones), so it is finished too: a wrong file
      // excluded whole never leaves READY, and kept its data for ever. The
      // statement (lib/purge-summary.ts importPayloadPurgeSql) restates the
      // predicate on the row it empties, and summarises each 2,000-row batch by
      // import batch and row state.
      last = await withChangeContext(prisma, CAUSE, (tx) =>
        runPurge(tx, 'import-payload-90d', importPayloadPurgeSql(now, IMPORT_BATCH, run))
      );
      cleared += last;
    } while (last === IMPORT_BATCH && Date.now() - started < IMPORT_BUDGET_MS);
    swept.importRowPayloads = cleared;
    // Rows still waiting when the budget ran out: tomorrow's run takes them,
    // and the heartbeat detail says so instead of reading as caught up.
    if (last === IMPORT_BATCH) swept.importRowPayloadsBehind = 1;
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.import_rows_failed');
  }

  // 3. Notifications nobody ever opened. The SLA sweep handles read ones at 90
  //    days; these would otherwise keep customer names indefinitely.
  try {
    // Gap 25: the summary counts them by month, kind and e-mail outcome, so the
    // e-mail delivery figures outlive the rows.
    swept.unreadNotifications = await withChangeContext(prisma, CAUSE, (tx) =>
      runPurge(tx, 'notification-unread-180d', unreadNotificationPurgeSql(now, BATCH, run))
    );
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.notifications_failed');
  }

  // 4. Scheduled-run history (item 9). Three 30-day service-level windows, then
  //    the runs go — but never their day (gap 21, lib/job-run-day.ts): first
  //    every Oman day that is over is written to JobRunDay, kept for ever, and
  //    only runs whose day has its row are pruned. A failed summary prunes
  //    nothing it has not summarised. Up to ~450 rows arrive a day while three
  //    schedulers call keep-warm; one 2,000-row statement a day stays ahead of
  //    that with room to catch up.
  try {
    swept.jobRunDays = await summariseJobRunDays(prisma);
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.job_run_days_failed');
  }
  try {
    swept.cronRuns = await withChangeContext(prisma, CAUSE, (tx) =>
      pruneSummarisedCronRuns(tx, retentionCutoff(RETENTION_RULES['cron-run-90d'], now), CRON_RUN_BATCH, run)
    );
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.cron_runs_failed');
  }

  logger.info({ swept, errors }, 'cron.retention_sweep');
  return NextResponse.json({ swept, errors, policy: 'docs/compliance/DATA-RETENTION-SCHEDULE.md' });
}

export const GET = withHeartbeat(
  'retention-sweep',
  handle,
  (body) => Number(body?.errors ?? 0) === 0
);
