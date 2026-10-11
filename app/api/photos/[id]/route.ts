/**
 * Streams a photo from R2 through the app, gated by auth AND scope.
 *
 * QA-002 fix: previously checked only "is signed in" — now resolves the
 * attachment's owning customer/branch and applies the same scope rules used
 * everywhere else.
 *
 * Gap 2 (data audit 2026-10-10): nobody's viewing of a photo was recorded, while
 * the role guides said it was. Every view this route serves now writes one
 * PHOTO_VIEW audit row (owner decisions 2026-10-11) — read by the Data Steward
 * only (lib/audit-scope.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import type { Attachment } from '@prisma/client';
import { checkActor } from '@/lib/session';
import { prisma } from '@/lib/db';
import { r2, R2_BUCKET } from '@/lib/r2';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { loadScope, assertCanAccessAttachment } from '@/lib/access';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkLimitLocal } from '@/lib/rate-limit';
import { serveHeadersFor } from '@/lib/photo-mime';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { errorLogFields, reportableError } from '@/lib/account-import';
import { CONFIDENTIAL_KINDS as CONFIDENTIAL_DOCUMENT_KINDS } from '@/lib/credit-documents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Owner decision 2026-10-11 (b): a CR copy or a guarantee is not served unless its
 * view is on the ledger — no row, no file. Every other kind is served anyway, and
 * the lost row is reported. Deliberately NOT the no-store set in GET: how photos
 * are cached is a separate owner decision, and changing it must not change this.
 * The credit documents and the signed credit application are handled exactly
 * like CR copies and guarantees (owner decisions 2026-10-11, credit flow), so
 * both sets are read from lib/credit-documents.ts CONFIDENTIAL_KINDS — still two
 * named sets, each changeable on its own.
 */
const VIEW_RECORD_REQUIRED = new Set<string>(CONFIDENTIAL_DOCUMENT_KINDS);
const VIEW_NOT_RECORDED_MESSAGE = 'This document could not be opened right now. Try again.';

/**
 * Gap 2 (data audit 2026-10-10): the PHOTO_VIEW row for one served view, with ids
 * only and no personal data in `after` (owner decision 2026-10-11 a), and the
 * viewer's IP and device from the request, as every audit row carries them.
 *
 * Resolves true when the row is written and false when it is not; never rejects.
 * A failure is logged and sent to Sentry here, whatever the caller then does, so a
 * lost row is never silent (decision b).
 */
async function recordPhotoView(actorId: string, att: Attachment): Promise<boolean> {
  try {
    await writeAudit(null, await getAuditEnvelope(actorId), {
      action: 'PHOTO_VIEW',
      entityType: 'Attachment',
      entityId: att.id,
      after: {
        kind: att.kind,
        customerId: att.customerId,
        branchId: att.branchId,
        branchExtraId: att.branchExtraId,
        editId: att.editId,
      },
    });
    return true;
  } catch (err) {
    // errorLogFields, not err.message: a Prisma validation error quotes the call's
    // arguments, the viewer's IP and device among them.
    logger.error(
      {
        attachmentId: att.id,
        kind: att.kind,
        actorId,
        served: !VIEW_RECORD_REQUIRED.has(att.kind),
        ...errorLogFields(err),
      },
      'photo.view_not_recorded'
    );
    // Caught, so it would not reach Sentry the way an uncaught error does
    // (instrumentation.ts). The SDK is loaded on this path only.
    try {
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureException(reportableError(err), {
        tags: { event: 'photo.view_not_recorded', kind: att.kind },
      });
    } catch {
      /* the log line above still carries it */
    }
    return false;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const who = await checkActor(); // F15: a session that must change its password gets 403
  if (!who.ok) {
    return NextResponse.json({ error: who.status === 401 ? 'UNAUTHORIZED' : who.code }, { status: who.status });
  }
  const session = { user: who.user };
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
  // is at least as sensitive. So are the owner's ID card, the membership, VAT and
  // tax documents and the signed credit application (owner decisions 2026-10-11).
  const CONFIDENTIAL_KINDS = new Set<string>(CONFIDENTIAL_DOCUMENT_KINDS);
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

  // Gap 2 (data audit 2026-10-10; owner decisions 2026-10-11): the view is recorded
  // after the access check above — a refused request is not a view — and before
  // anything goes back, the 304 included: a 304 still shows the photo. Started here,
  // so for most kinds the INSERT runs while R2 is fetched instead of after it. A CR
  // or guarantee waits for it first: that document does not leave storage unrecorded.
  const viewed = recordPhotoView(sessionUser.id, att);
  if (VIEW_RECORD_REQUIRED.has(att.kind) && !(await viewed)) {
    return NextResponse.json(
      { error: 'VIEW_NOT_RECORDED', message: VIEW_NOT_RECORDED_MESSAGE },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (!confidential && req.headers.get('if-none-match') === etag) {
    await viewed; // never rejects: a lost row is reported inside, and the 304 still goes
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': cache },
    });
  }
  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: att.r2Key }));
    await viewed;
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
    // Settled before answering, so the INSERT is not cut off when the function ends.
    await viewed;
    return NextResponse.json({ error: 'R2_FETCH_FAILED' }, { status: 502 });
  }
}
