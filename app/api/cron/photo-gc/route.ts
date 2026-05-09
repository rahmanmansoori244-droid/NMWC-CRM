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
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRACE_DAYS = 30;
const BATCH_SIZE = 200;

export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected || bearer !== `Bearer ${expected}`) {
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
  for (const c of candidates) {
    try {
      await r2().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: c.r2Key }));
    } catch (err) {
      // R2 may already be missing — that's fine; record the failure for
      // visibility but don't block DB cleanup.
      r2Errors++;
      logger.warn({ key: c.r2Key, err: (err as Error).message?.slice(0, 80) }, 'gc.r2_delete_failed');
    }
    try {
      await prisma.attachment.delete({ where: { id: c.id } });
      deleted++;
    } catch (err) {
      logger.warn({ id: c.id, err: (err as Error).message?.slice(0, 80) }, 'gc.row_delete_failed');
    }
  }
  logger.info({ deleted, r2Errors, scanned: candidates.length }, 'gc.photo_done');
  return NextResponse.json({ deleted, r2Errors, scanned: candidates.length });
}
