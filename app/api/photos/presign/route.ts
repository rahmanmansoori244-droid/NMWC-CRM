import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { r2, R2_BUCKET } from '@/lib/r2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '@/lib/logger';
import { checkLimit, PHOTO_LIMIT } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB raw upload limit

const presignSchema = z.object({
  kind: z.enum(['SHOP', 'SIGNBOARD', 'CR', 'FREE']),
  mimeType: z.string().refine((m) => ALLOWED_MIME.includes(m), 'Invalid mime type'),
  bytes: z.number().int().min(1).max(MAX_BYTES),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const lim = await checkLimit(`photo:${session.user.id}`, PHOTO_LIMIT);
  if (!lim.ok) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', retryAfterSec: lim.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(lim.retryAfterSec) } }
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }
  const parsed = presignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_FAILED', details: parsed.error.format() },
      { status: 400 }
    );
  }

  const { kind, mimeType, bytes } = parsed.data;

  // Build a unique key — date-prefixed for cheap R2 list operations
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const date = new Date();
  const ymd = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
  const id = crypto.randomUUID();
  const key = `${ymd}/${session.user.id}/${kind}/${id}.${ext}`;

  try {
    const url = await getSignedUrl(
      r2(),
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: mimeType,
        ContentLength: bytes,
      }),
      { expiresIn: 600 } // 10 minutes
    );

    return NextResponse.json({
      url,
      key,
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'r2.presign.fail');
    return NextResponse.json({ error: 'PRESIGN_FAILED' }, { status: 500 });
  }
}
