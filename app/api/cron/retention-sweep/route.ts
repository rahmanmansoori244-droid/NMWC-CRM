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
    const { count } = await prisma.rateLimit.deleteMany({
      where: { updatedAt: { lt: cutoff(RATE_LIMIT_DAYS) } },
    });
    swept.rateLimit = count;
  } catch (err) {
    errors += 1;
    logger.error({ err: (err as Error).message }, 'retention.rate_limit_failed');
  }

  // 2. Import payloads: keep the row and its outcome, drop the verbatim copies
  //    of the customer data.
  //
  //    This is raw SQL on purpose. The first version used
  //    `data: { raw: {}, parsed: undefined, issues: undefined }`, and Prisma
  //    reads `undefined` as "leave this column alone" — so only `raw` was
  //    emptied while `parsed` (name, address, phone, contact person, CR number)
  //    survived, and the `raw = {}` progress marker then excluded the row from
  //    every future sweep. One statement sets all three and cannot drift.
  try {
    const cleared = await prisma.$executeRaw`
      UPDATE "ImportRow"
         SET "raw" = '{}'::jsonb, "parsed" = NULL, "issues" = NULL
       WHERE "id" IN (
         SELECT "id" FROM "ImportRow"
          WHERE "createdAt" < ${cutoff(IMPORT_PAYLOAD_DAYS)}
            AND ("raw" <> '{}'::jsonb OR "parsed" IS NOT NULL OR "issues" IS NOT NULL)
          ORDER BY "createdAt"
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
    const { count } = await prisma.notification.deleteMany({
      where: { readAt: null, createdAt: { lt: cutoff(UNREAD_NOTIFICATION_DAYS) } },
    });
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
