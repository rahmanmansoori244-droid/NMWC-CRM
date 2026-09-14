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

async function handle(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await prisma.attachment.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: { id: true, r2Key: true },
    take: BATCH_SIZE,
  });

  let deleted = 0;
  let r2Errors = 0;
  let skipped = 0;
  const markedAt = new Date().toISOString();
  for (const c of candidates) {
    // final-hunt #11 (C20): the DB row may be dropped ONLY once the R2 object is
    // safely tagged for lifecycle expiry, OR confirmed already gone. Deleting the
    // row on a TRANSIENT tag failure (throttle, network, permissions) permanently
    // ORPHANS the object — no DB reference AND no expiry tag, so it lives in R2
    // forever. On a transient failure, leave the row for the next GC run.
    let safeToDelete = false;
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
        })
      );
      safeToDelete = true;
    } catch (err) {
      const name = String((err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code ?? '');
      const msg = String((err as Error).message ?? '');
      // Object already gone (NoSuchKey / NotFound / 404): nothing to orphan, so
      // dropping the row is safe. Any other error is transient — keep the row.
      if (/NoSuchKey|NotFound|404/i.test(name + ' ' + msg)) {
        safeToDelete = true;
      } else {
        r2Errors++;
        logger.warn({ key: c.r2Key, err: msg.slice(0, 80) }, 'gc.r2_tag_failed');
      }
    }
    if (!safeToDelete) {
      skipped++;
      continue; // retry on the next GC run rather than orphan the object
    }
    try {
      await prisma.attachment.delete({ where: { id: c.id } });
      deleted++;
    } catch (err) {
      logger.warn({ id: c.id, err: (err as Error).message?.slice(0, 80) }, 'gc.row_delete_failed');
    }
  }
  logger.info({ deleted, r2Errors, skipped, scanned: candidates.length }, 'gc.photo_done');
  return NextResponse.json({ deleted, r2Errors, skipped, scanned: candidates.length });
}

// B5: every finished run is recorded as a heartbeat (lib/heartbeat.ts); the
// bearer /api/health probe alarms when this job goes stale or never runs.
export const GET = withHeartbeat('photo-gc', handle, (body) => Number(body?.r2Errors ?? 0) === 0);
