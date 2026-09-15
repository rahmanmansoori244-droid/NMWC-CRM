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

/**
 * NEW-PHOTO-001: pull the kind segment out of the key path and require it to
 * match the body kind. Without this, a scripted client can presign as SHOP and
 * finalize as CR, sliding a signboard photo into the CR slot at attach time.
 */
function kindFromKey(key: string): AttachmentKind | null {
  // Keep in lockstep with the presign kind enum — GUARANTEE was added for the
  // Phase 1 creation flow (updating only one of the two produces 403s).
  const m = /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[a-z0-9]+\/(SHOP|SIGNBOARD|CR|FREE|GUARANTEE)\//.exec(
    key
  );
  return m ? (m[1] as AttachmentKind) : null;
}

// NEW-PHOTO-005: cap finalize content-length at 3 MB. Client compresses to
// ~500 KB; anything bigger is malicious or a misconfigured device.
const MAX_FINALIZE_BYTES = 3 * 1024 * 1024;

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
  // NEW-PHOTO-007: ignore client-supplied capturedAt. Reactivation evidence
  // checks freshness against this timestamp; if the client controls it, the
  // "fresh photo" gate is trivially bypassed by retroactively stamping an old
  // photo. We pull the time from R2's HeadObject (LastModified) below.
  const { key, kind, hash, width, height, capturedLat, capturedLng } = parsed.data;

  // QA-005 fix: bind the key to the calling user's presign prefix.
  const allowed = expectedPrefixes(session.user.id);
  if (!allowed.some((p) => key.startsWith(p))) {
    logger.warn({ userId: session.user.id, key }, 'photo.finalize.key_mismatch');
    return NextResponse.json({ error: 'KEY_MISMATCH' }, { status: 403 });
  }
  // NEW-PHOTO-001: server-side kind check derived from the key path so the
  // attachment.kind cannot be swapped at finalize time.
  const keyKind = kindFromKey(key);
  if (!keyKind || keyKind !== kind) {
    logger.warn({ userId: session.user.id, key, body_kind: kind, key_kind: keyKind }, 'photo.finalize.kind_mismatch');
    return NextResponse.json({ error: 'KIND_MISMATCH' }, { status: 403 });
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
  // SEC-14e: attacker-influenced. The presigned PUT does not bind Content-Type, so
  // this is whatever the client sent. It is stored for the record; NEVER echo it
  // back as a response Content-Type — lib/photo-mime.ts decides what a photograph
  // is served as.
  const mimeType = head.ContentType ?? 'application/octet-stream';
  // NEW-PHOTO-005: enforce server-side size cap at finalize time. Presign
  // signs ContentLength but a malicious client can re-PUT with a different
  // size and still finalize.
  if (bytes > MAX_FINALIZE_BYTES) {
    return NextResponse.json({ error: 'TOO_LARGE', limit: MAX_FINALIZE_BYTES }, { status: 413 });
  }

  // NEW-PHOTO-002: hash dedupe ONLY within the same uploader. Cross-user
  // dedupe was a confirmation oracle ("does this exact JPEG already exist in
  // any customer's master?") and tangled multiple customers' slots into a
  // single Attachment row.
  const existing = await prisma.attachment.findFirst({
    where: { hash, capturedById: session.user.id, deletedAt: null },
  });
  if (existing) {
    return NextResponse.json({ attachmentId: existing.id, deduped: true });
  }

  // NEW-PHOTO-007: capturedAt is the R2 upload time, not a client claim.
  const capturedAt = head.LastModified ?? new Date();

  const att = await prisma.attachment.create({
    data: {
      kind,
      r2Key: key,
      mimeType,
      bytes,
      width,
      height,
      capturedById: session.user.id,
      capturedAt,
      capturedLat,
      capturedLng,
      hash,
    },
  });

  return NextResponse.json({ attachmentId: att.id, deduped: false });
}
