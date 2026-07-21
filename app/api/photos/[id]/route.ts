/**
 * Streams a photo from R2 through the app, gated by auth AND scope.
 *
 * QA-002 fix: previously checked only "is signed in" — now resolves the
 * attachment's owning customer/branch and applies the same scope rules used
 * everywhere else.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { r2, R2_BUCKET } from '@/lib/r2';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { loadScope, assertCanAccessAttachment } from '@/lib/access';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const { id } = await ctx.params;

  // NEW-PHOTO-010: rate-limit per-user photo fetches. Bursts of ~30 are
  // legitimate (a customer profile loads several photos at once); sustained
  // 1/s is fine. Anything above is enumeration / DoS.
  const lim = await checkLimit(`photo-get:${session.user.id}`, { capacity: 60, refillPerSec: 1 });
  if (!lim.ok) {
    return NextResponse.json(
      { error: 'TOO_MANY_REQUESTS' },
      { status: 429, headers: { 'Retry-After': String(lim.retryAfterSec) } }
    );
  }

  // UXI-008 / RBAC-05-015: filter soft-deleted attachments. Returning 404 is
  // the same response as "doesn't exist" so a soft-delete cannot be observed
  // through status-code timing.
  const att = await prisma.attachment.findFirst({
    where: { id, deletedAt: null },
  });
  if (!att) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  try {
    const scope = await loadScope(session.user.id);
    await assertCanAccessAttachment(sessionUser, att, scope);
  } catch (err) {
    if (err instanceof AppError) {
      // Use 404 (not 403) so attackers can't confirm IDs they shouldn't see.
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    logger.error({ err: (err as Error).message }, 'photo.access_check_fail');
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: att.r2Key }));
    const stream = out.Body as ReadableStream<Uint8Array> | null;
    if (!stream) return NextResponse.json({ error: 'EMPTY_BODY' }, { status: 502 });
    // NEW-PHOTO-009 (+ final-hunt #18): CR registration docs AND GUARANTEE credit-
    // security documents are confidential financial PII; never cache them. The
    // no-store guard must cover every confidential kind, not just CR — a GUARANTEE
    // is at least as sensitive. Shop/signboard photos are non-confidential and keep
    // the short 60s cache.
    const CONFIDENTIAL_KINDS = new Set(['CR', 'GUARANTEE']);
    const cache = CONFIDENTIAL_KINDS.has(att.kind)
      ? 'private, no-store, no-cache, must-revalidate'
      : 'private, max-age=60, must-revalidate';
    void req; // intentionally unused — kept for future Origin-check defense-in-depth
    return new NextResponse(stream, {
      headers: {
        'Content-Type': att.mimeType,
        'Cache-Control': cache,
        'Content-Length': String(att.bytes),
      },
    });
  } catch {
    return NextResponse.json({ error: 'R2_FETCH_FAILED' }, { status: 502 });
  }
}
