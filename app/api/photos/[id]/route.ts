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
import { checkLimitLocal } from '@/lib/rate-limit';
import { serveHeadersFor } from '@/lib/photo-mime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const { id } = await ctx.params;

  // NEW-PHOTO-010: rate-limit per-user photo fetches. Bursts of ~30 are
  // legitimate (a customer profile loads several photos at once); sustained
  // 1/s is fine. Anything above is enumeration / DoS.
  // perf audit #24: in-memory limiter — the durable PG bucket cost a DB WRITE
  // per photo, serialized across a page's photo fan-out.
  const lim = checkLimitLocal(`photo-get:${session.user.id}`, { capacity: 60, refillPerSec: 1 });
  if (!lim.ok) {
    return NextResponse.json(
      { error: 'TOO_MANY_REQUESTS' },
      { status: 429, headers: { 'Retry-After': String(lim.retryAfterSec) } }
    );
  }

  // UXI-008 / RBAC-05-015: filter soft-deleted attachments. Returning 404 is
  // the same response as "doesn't exist" so a soft-delete cannot be observed
  // through status-code timing.
  // perf audit #25: the attachment read and the scope load are independent —
  // one parallel wave instead of two sequential round trips.
  const [att, scope] = await Promise.all([
    prisma.attachment.findFirst({ where: { id, deletedAt: null } }),
    loadScope(session.user.id),
  ]);
  if (!att) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  try {
    await assertCanAccessAttachment(sessionUser, att, scope);
  } catch (err) {
    if (err instanceof AppError) {
      // Use 404 (not 403) so attackers can't confirm IDs they shouldn't see.
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    logger.error({ err: (err as Error).message }, 'photo.access_check_fail');
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // NEW-PHOTO-009 (+ final-hunt #18): CR registration docs AND GUARANTEE credit-
  // security documents are confidential financial PII; never cache them. The
  // no-store guard must cover every confidential kind, not just CR — a GUARANTEE
  // is at least as sensitive.
  const CONFIDENTIAL_KINDS = new Set(['CR', 'GUARANTEE']);
  const confidential = CONFIDENTIAL_KINDS.has(att.kind);
  // perf audit #22: an Attachment's bytes are IMMUTABLE — replacement mints a new
  // row (NEW-PHOTO-003) and detach soft-deletes (→404) — so non-confidential
  // photos are safe to cache long. The old 60s window re-paid a full lambda +
  // R2 fetch per photo per minute.
  const cache = confidential
    ? 'private, no-store, no-cache, must-revalidate'
    : 'private, max-age=3600, immutable';
  // perf audit #23: ETag revalidation for the browser's stale-cache path — a 304
  // skips the R2 GetObject and the whole body transfer. Keyed by the immutable
  // attachment id; never for confidential kinds (no-store means no revalidation).
  const etag = `"p-${att.id}"`;
  if (!confidential && req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': cache },
    });
  }
  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: att.r2Key }));
    const stream = out.Body as ReadableStream<Uint8Array> | null;
    if (!stream) return NextResponse.json({ error: 'EMPTY_BODY' }, { status: 502 });
    // SEC-14e: the served type is decided by lib/photo-mime, NOT by the stored
    // column. A presigned PUT does not bind Content-Type, so `att.mimeType` is
    // attacker-influenceable and echoing it here served attacker HTML from this
    // origin to the approver who opened the tile.
    const serve = serveHeadersFor(att.mimeType, att.r2Key, att.id);
    if (serve.contentType !== att.mimeType) {
      // Either a hand-crafted PUT or an upload whose Content-Type header was lost.
      // Both are worth seeing; the stored value distinguishes them.
      logger.warn(
        { attachmentId: att.id, stored: att.mimeType, served: serve.contentType },
        'photo.mime.repinned'
      );
    }
    return new NextResponse(stream, {
      headers: {
        'Content-Type': serve.contentType,
        'Content-Disposition': serve.contentDisposition,
        'Cache-Control': cache,
        'Content-Length': String(att.bytes),
        ...(confidential ? {} : { ETag: etag }),
      },
    });
  } catch {
    return NextResponse.json({ error: 'R2_FETCH_FAILED' }, { status: 502 });
  }
}
