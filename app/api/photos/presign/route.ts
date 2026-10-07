import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkActor } from '@/lib/session';
import { r2, R2_BUCKET } from '@/lib/r2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '@/lib/logger';
import { checkLimit, PHOTO_LIMIT } from '@/lib/rate-limit';
import { PRESIGN_EXPIRES_S, PHOTO_ROLE_REFUSED_MESSAGE } from '@/lib/photo-attach';
import { canUploadPhoto } from '@/lib/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const refuseRole = () =>
  NextResponse.json({ error: 'FORBIDDEN_ROLE', message: PHOTO_ROLE_REFUSED_MESSAGE }, { status: 403 });

// SEC-14e: this list is NOT a security boundary for the upload. The S3 request
// presigner marks `content-type` unsignable, so it never reaches SignedHeaders and
// the client may PUT the signed URL with any Content-Type at all. What this list
// DOES decide is the key extension below — which, because the presigned PUT binds
// the Key, is server-minted and is what lib/photo-mime.ts falls back to when it
// pins the type a photograph is SERVED as. So it is load-bearing for the key and
// worthless for the upload, and both halves matter: relaxing the zod refine to
// admit application/pdf for GUARANTEE without also deciding the disposition in
// lib/photo-mime.ts re-opens the navigation surface SEC-14e closed.
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
// NEW-PHOTO-005: cap raw upload at 3 MB. Client compresses to ~500 KB; nothing
// legitimate exceeds this. Aligns with the finalize-time HeadObject check.
const MAX_BYTES = 3 * 1024 * 1024;

const presignSchema = z.object({
  // GUARANTEE (Phase 1): credit guarantee / security documents captured during
  // a net-new-customer CREATE request. Image-only for now (Q-guarantee-pdf).
  kind: z.enum(['SHOP', 'SIGNBOARD', 'CR', 'FREE', 'GUARANTEE']),
  mimeType: z.string().refine((m) => ALLOWED_MIME.includes(m), 'Invalid mime type'),
  bytes: z.number().int().min(1).max(MAX_BYTES),
});

// Every refusal below carries a `message` beside its machine `error`: the photo
// slot shows it (PhotoCaptureSlot readRefusal). Without one it said "Could not
// get upload URL." to a salesman who was signed out, throttled or not allowed.
export async function POST(req: NextRequest) {
  const who = await checkActor(); // F15: a session that must change its password gets 403
  if (!who.ok) {
    return NextResponse.json(
      { error: who.status === 401 ? 'UNAUTHORIZED' : who.code, message: who.message },
      { status: who.status }
    );
  }
  const session = { user: who.user };
  // ENH-3: only a role that can attach a photo may upload one. Here, not only
  // at finalize: a presigned PUT that is never finalized leaves an object in R2
  // with no row at all. Before the bucket, so a refused role spends none of it.
  if (!canUploadPhoto(session.user.role)) return refuseRole();
  const lim = await checkLimit(`photo:${session.user.id}`, PHOTO_LIMIT);
  if (!lim.ok) {
    return NextResponse.json(
      {
        error: 'RATE_LIMITED',
        retryAfterSec: lim.retryAfterSec,
        message: `Too many photos in a short time. Try again in ${lim.retryAfterSec} seconds.`,
      },
      { status: 429, headers: { 'Retry-After': String(lim.retryAfterSec) } }
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON', message: 'The upload request was not valid.' }, { status: 400 });
  }
  const parsed = presignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'VALIDATION_FAILED',
        message: 'This photo cannot be uploaded: it must be a JPEG, PNG or WebP image of 3 MB at most.',
        details: parsed.error.format(),
      },
      { status: 400 }
    );
  }

  const { kind, mimeType, bytes } = parsed.data;
  if (!canUploadPhoto(session.user.role, kind)) return refuseRole();

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
      {
        expiresIn: PRESIGN_EXPIRES_S, // 10 minutes
        // The SDK can inherit server tracing headers that the browser PUT never sends.
        // Keep the upload's content-length and host bound without requiring that context.
        unsignableHeaders: new Set(['traceparent', 'tracestate', 'baggage']),
      }
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
