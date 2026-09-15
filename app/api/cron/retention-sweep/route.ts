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
 * NEVER touches the append-only ledgers (AuditLog, EditApproval) — those are
 * retained deliberately and any change to them is an owner-authorised
 * maintenance operation, not a cron job.
 *
 * Daily via vercel.json crons. Reports through the same heartbeat machinery as
 * the other jobs so a silently dead sweep alarms on /api/health.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Token-bucket state is meaningless once the bucket has refilled — hours, not days. */
const RATE_LIMIT_DAYS = 1;
/** An import batch stays resumable and reconcilable for a quarter; then the raw payload goes. */
const IMPORT_PAYLOAD_DAYS = 90;
/** Unread notifications: the read ones are already swept at 90 days by the SLA job. */
const UNREAD_NOTIFICATION_DAYS = 180;
/** Bound the work per run so the job stays well inside the function timeout. */
const BATCH = 500;

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  let errors = 0;
  const swept: Record<string, number> = {};

  // 1. Spent rate-limit buckets (usernames and IP addresses).
  try {
    // Bounded: an unbounded delete over an unindexed predicate is how a daily
    // job discovers the 60 s function limit on the one night it matters.
    const count = await prisma.$executeRaw`
      DELETE FROM "RateLimit"
       WHERE "key" IN (
         SELECT "key" FROM "RateLimit"
          WHERE "updatedAt" < ${cutoff(RATE_LIMIT_DAYS)}
          ORDER BY "updatedAt"
          LIMIT ${BATCH}
       )`;
    swept.rateLimit = count;
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
  //    payload is gone. So the predicate requires a terminal ROW state AND a
  //    terminal BATCH status; anything still in flight keeps its payload however
  //    old it is, and an operator who abandons a batch can still see what was in
  //    it.
  //
  //    Raw SQL on purpose: Prisma reads `undefined` as "leave this column
  //    alone", so the obvious `{ raw: {}, parsed: undefined }` silently kept the
  //    customer's name, address, phone and CR number in `parsed`.
  try {
    const cleared = await prisma.$executeRaw`
      UPDATE "ImportRow"
         SET "raw" = '{}'::jsonb, "parsed" = NULL, "issues" = NULL
       WHERE "id" IN (
         SELECT r."id"
           FROM "ImportRow" r
           JOIN "ImportBatch" b ON b."id" = r."batchId"
          WHERE r."createdAt" < ${cutoff(IMPORT_PAYLOAD_DAYS)}
            AND r."state" IN ('PROMOTED', 'REJECTED')
            AND b."status" IN ('PROMOTED', 'FAILED')
            AND (r."raw" <> '{}'::jsonb OR r."parsed" IS NOT NULL OR r."issues" IS NOT NULL)
          ORDER BY r."createdAt"
          LIMIT ${BATCH}
       )`;
    swept.importRowPayloads = cleared;
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.import_rows_failed');
  }

  // 3. Notifications nobody ever opened. The SLA sweep handles read ones at 90
  //    days; these would otherwise keep customer names indefinitely.
  try {
    const count = await prisma.$executeRaw`
      DELETE FROM "Notification"
       WHERE "id" IN (
         SELECT "id" FROM "Notification"
          WHERE "readAt" IS NULL
            AND "createdAt" < ${cutoff(UNREAD_NOTIFICATION_DAYS)}
          ORDER BY "createdAt"
          LIMIT ${BATCH}
       )`;
    swept.unreadNotifications = count;
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.notifications_failed');
  }

  logger.info({ swept, errors }, 'cron.retention_sweep');
  return NextResponse.json({ swept, errors, policy: 'docs/compliance/DATA-RETENTION-SCHEDULE.md' });
}

export const GET = withHeartbeat(
  'retention-sweep',
  handle,
  (body) => Number(body?.errors ?? 0) === 0
);
