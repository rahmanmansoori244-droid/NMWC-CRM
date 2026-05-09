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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const { id } = await ctx.params;

  const att = await prisma.attachment.findUnique({ where: { id } });
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
    return new NextResponse(stream, {
      headers: {
        'Content-Type': att.mimeType,
        // Tighter cache so revoked access takes effect within 60s.
        'Cache-Control': 'private, max-age=60, must-revalidate',
        'Content-Length': String(att.bytes),
      },
    });
  } catch {
    return NextResponse.json({ error: 'R2_FETCH_FAILED' }, { status: 502 });
  }
}
