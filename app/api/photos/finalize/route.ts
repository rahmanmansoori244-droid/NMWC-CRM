import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { r2, R2_BUCKET } from '@/lib/r2';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@/lib/db';
import { AttachmentKind } from '@prisma/client';
import { logger } from '@/lib/logger';

/**
 * Build the expected key prefix that this user's presign would have issued.
 * Matches the format used in /api/photos/presign/route.ts:
 *   `${YYYY}/${MM}/${DD}/${userId}/${kind}/${uuid}.${ext}`
 *
 * Accept today and yesterday (UTC) to allow for upload duration around midnight.
 */
function expectedPrefixes(userId: string): string[] {
  const out: string[] = [];
  const now = new Date();
  for (const offset of [0, -1]) {
    const d = new Date(now.getTime() + offset * 86400_000);
    const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push(`${ymd}/${userId}/`);
  }
  return out;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const finalizeSchema = z.object({
  key: z.string().min(1).max(500),
  kind: z.nativeEnum(AttachmentKind),
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 hex required'),
  width: z.number().int().min(1).max(20000).optional(),
  height: z.number().int().min(1).max(20000).optional(),
  capturedLat: z.number().min(-90).max(90).optional(),
  capturedLng: z.number().min(-180).max(180).optional(),
  capturedAt: z.coerce.date().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  const parsed = finalizeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_FAILED', details: parsed.error.format() },
      { status: 400 }
    );
  }
  const { key, kind, hash, width, height, capturedLat, capturedLng, capturedAt } = parsed.data;

  // QA-005 fix: bind the key to the calling user's presign prefix.
  const allowed = expectedPrefixes(session.user.id);
  if (!allowed.some((p) => key.startsWith(p))) {
    logger.warn({ userId: session.user.id, key }, 'photo.finalize.key_mismatch');
    return NextResponse.json({ error: 'KEY_MISMATCH' }, { status: 403 });
  }

  // Confirm object exists in R2
  let head;
  try {
    head = await r2().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'r2.finalize.head_fail');
    return NextResponse.json({ error: 'OBJECT_NOT_FOUND' }, { status: 404 });
  }

  const bytes = head.ContentLength ?? 0;
  const mimeType = head.ContentType ?? 'application/octet-stream';

  // Hash dedupe — if any attachment exists with same hash, return that one (ref-counting can come later)
  const existing = await prisma.attachment.findFirst({ where: { hash } });
  if (existing) {
    return NextResponse.json({ attachmentId: existing.id, deduped: true });
  }

  const att = await prisma.attachment.create({
    data: {
      kind,
      r2Key: key,
      mimeType,
      bytes,
      width,
      height,
      capturedById: session.user.id,
      capturedAt: capturedAt ?? new Date(),
      capturedLat,
      capturedLng,
      hash,
    },
  });

  return NextResponse.json({ attachmentId: att.id, deduped: false });
}
