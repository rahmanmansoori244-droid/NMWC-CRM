/**
 * GAP-03 + NEW-PHOTO-003: 30-day garbage collection for soft-deleted
 * Attachments. The remediation report previously claimed this existed; it
 * didn't. Without it, R2 storage grows unboundedly with every photo
 * replacement and detach.
 *
 * Triggered by `vercel.json` cron at 03:00 UTC (07:00 Oman) — outside
 * working hours. Authenticates by `Authorization: Bearer ${CRON_SECRET}`
 * which Vercel injects automatically on `crons` invocations.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { r2, R2_BUCKET } from '@/lib/r2';
import { PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { logger } from '@/lib/logger';
// B-16 constant-time bearer comparison — shared with keep-warm + sla-escalate.
import { cronAuthorized } from '@/lib/cron-auth';
import { withHeartbeat } from '@/lib/heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRACE_DAYS = 30;
const BATCH_SIZE = 200;
/**
 * X-OPS-3 (auditor recheck, 2026-09-27): one run pages through EVERY candidate,
 * oldest first, until this budget is spent. It read one unordered page of 200,
 * and a row whose storage or database step fails stays a candidate — so 200 rows
 * that kept failing could fill every page, every night, and nothing newer was
 * ever reached. The route's limit is 60 s (vercel.json). No candidate is started
 * after this budget, so a long night stops cleanly, is recorded, and the next run
 * carries on.
 */
const TIME_BUDGET_MS = 40_000;
/**
 * Review of the recheck fixes (2026-09-28): the budget above decides when the last
 * tag call STARTS, not when it ends, and the call in flight had no deadline of its
 * own. R2 can accept a request and never answer it. The client's request timeout
 * only logged a warning until the same review (lib/r2.ts), so one such call held
 * the run until Vercel killed it at 60 s; and now that it throws, two attempts of
 * up to 13 s each still outlast what is left after a call started near the budget.
 * Killed, the run recorded nothing through withHeartbeat — no heartbeat, no run
 * row, no alert — and the degraded night the r2Errors count exists to report
 * stayed invisible until the 72-hour staleness warning.
 *
 * So every R2 call is aborted at this deadline, counted from the same start as the
 * budget. The 15 s left before the limit hold the cold start before the clock
 * starts, the one row delete after the last call, the heartbeat's two writes and
 * the failure alert (lib/alert.ts stops that at 5 s). A call started just inside
 * the budget still has 5 s, where a tag takes well under one; a call cut off here
 * is a slow R2 and counts as an R2 error, so the run goes red and alerts.
 */
const R2_DEADLINE_MS = 45_000;

type Candidate = { id: string; r2Key: string; deletedAt: Date | null };

/**
 * Whether R2 itself answered that the object is not there — the one failure on
 * which dropping the row orphans nothing. Decided from the service's answer
 * alone: its error name, or the HTTP status it replied with. A substring test on
 * the message ran before (post-merge review, 2026-09-29): "NotFound" matched
 * inside "getaddrinfo ENOTFOUND <account>.r2.cloudflarestorage.com", so a night
 * on which the resolver could not find R2 deleted every row it reached, left
 * each object with no row and no tag, and — every call failing that way —
 * reported a green run. A failure with no answer from R2 (DNS, a dropped
 * connection, a timeout, the deadline's abort) has no status, so it keeps the
 * row. A 404 that names the bucket is a wrong bucket, not a missing object.
 */
function objectIsGone(err: unknown): boolean {
  const e = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'NoSuchBucket' || e.Code === 'NoSuchBucket') return false;
  return (
    e.name === 'NoSuchKey' ||
    e.Code === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.$metadata?.httpStatusCode === 404
  );
}

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const started = Date.now();
  const cutoff = new Date(started - GRACE_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let r2Errors = 0;
  // N09 (auditor recheck, 2026-09-27): a failed row delete was logged and counted
  // nowhere, so a run in which every delete failed reported success and the
  // heartbeat stayed green.
  let dbErrors = 0;
  // Deleted by an overlapping run between our read and our delete: done, not a failure.
  let alreadyGone = 0;
  let skipped = 0;
  let scanned = 0;
  let pages = 0;
  let behind = false;
  const markedAt = new Date().toISOString();
  // Keyset paging on (deletedAt, id): a row that fails stays a candidate, and the
  // next page starts after it rather than at it.
  let after: { deletedAt: Date; id: string } | null = null;
  for (;;) {
    if (Date.now() - started >= TIME_BUDGET_MS) {
      behind = true;
      break;
    }
    const keyset = after
      ? { OR: [{ deletedAt: { gt: after.deletedAt } }, { deletedAt: after.deletedAt, id: { gt: after.id } }] }
      : {};
    const page: Candidate[] = await prisma.attachment.findMany({
      where: { deletedAt: { not: null, lt: cutoff }, ...keyset },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, r2Key: true, deletedAt: true },
      take: BATCH_SIZE,
    });
    pages++;
    for (const c of page) {
      if (Date.now() - started >= TIME_BUDGET_MS) {
        behind = true;
        break;
      }
      scanned++;
      // final-hunt #11 (C20): the DB row may be dropped ONLY once the R2 object is
      // safely tagged for lifecycle expiry, OR confirmed already gone. Deleting the
      // row on a TRANSIENT tag failure (throttle, network, permissions) permanently
      // ORPHANS the object — no DB reference AND no expiry tag, so it lives in R2
      // forever. On a transient failure, leave the row for the next GC run.
      let safeToDelete = false;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), Math.max(0, R2_DEADLINE_MS - (Date.now() - started)));
      try {
        // B-02 (audit 2026-05-10): tagged for R2 lifecycle expiry instead of hard-delete so accidents are recoverable for 7 days.
        await r2().send(
          new PutObjectTaggingCommand({
            Bucket: R2_BUCKET,
            Key: c.r2Key,
            Tagging: {
              TagSet: [
                { Key: 'gc-marked', Value: 'true' },
                { Key: 'gc-marked-at', Value: markedAt },
              ],
            },
          }),
          { abortSignal: deadline.signal }
        );
        safeToDelete = true;
      } catch (err) {
        // Object already gone, as R2 answered: nothing to orphan, so dropping the
        // row is safe. Any other failure is transient — keep the row.
        if (objectIsGone(err)) {
          safeToDelete = true;
        } else {
          r2Errors++;
          logger.warn({ key: c.r2Key, err: String((err as Error)?.message ?? '').slice(0, 80) }, 'gc.r2_tag_failed');
        }
      } finally {
        clearTimeout(timer);
      }
      if (!safeToDelete) {
        skipped++;
        continue; // retry on the next GC run rather than orphan the object
      }
      try {
        await prisma.attachment.delete({ where: { id: c.id } });
        deleted++;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'P2025') {
          // "Record to delete does not exist": a concurrent run got there first.
          alreadyGone++;
        } else {
          // The row stays soft-deleted, so the next run retries it; this run is a failure.
          dbErrors++;
          logger.warn(
            { id: c.id, code: typeof code === 'string' ? code : undefined, err: (err as Error).message?.slice(0, 80) },
            'gc.row_delete_failed'
          );
        }
      }
    }
    if (behind || page.length < BATCH_SIZE) break;
    const last = page[page.length - 1]!;
    after = { deletedAt: last.deletedAt!, id: last.id };
  }
  const result = { deleted, r2Errors, dbErrors, alreadyGone, skipped, scanned, pages, behind };
  logger.info(result, 'gc.photo_done');
  return NextResponse.json(result);
}

// B5: every finished run is recorded as a heartbeat (lib/heartbeat.ts); the
// bearer /api/health probe alarms when this job goes stale or never runs.
// N09: a failed database step fails the run as a failed storage step does.
// tests/unit/cron-heartbeat-guard.test.ts holds every *Errors key to this.
export const GET = withHeartbeat(
  'photo-gc',
  handle,
  (body) => Number(body?.r2Errors ?? 0) === 0 && Number(body?.dbErrors ?? 0) === 0
);
