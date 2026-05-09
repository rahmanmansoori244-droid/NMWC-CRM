/**
 * Streams a photo from R2 through the app, gated by auth.
 * Used by the customer profile and approval-diff views.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { r2, R2_BUCKET } from '@/lib/r2';
import { GetObjectCommand } from '@aws-sdk/client-s3';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const { id } = await ctx.params;

  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: att.r2Key }));
    const stream = out.Body as ReadableStream<Uint8Array> | null;
    if (!stream) return NextResponse.json({ error: 'EMPTY_BODY' }, { status: 502 });
    return new NextResponse(stream, {
      headers: {
        'Content-Type': att.mimeType,
        'Cache-Control': 'private, max-age=300',
        'Content-Length': String(att.bytes),
      },
    });
  } catch {
    return NextResponse.json({ error: 'R2_FETCH_FAILED' }, { status: 502 });
  }
}
