import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { detachPhotoAction } from '@/services/photos';
import { readJsonObject, refuse, refuseCrossSite } from '@/lib/fetch-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The photo slot's Remove, over fetch — for the reason app/api/photos/attach
 * gives: as a server action it queued behind a stalled attach, and the confirm
 * sat open with nothing happening. The SAME function the server action was; the
 * service validates the id and runs the scope, role and uploader checks.
 * Replies as the attach route does.
 */
export async function POST(req: NextRequest) {
  const crossSite = refuseCrossSite(req);
  if (crossSite) return crossSite;
  if (!(await auth())?.user) {
    return refuse(401, 'SIGNED_OUT', 'You are signed out, so nothing was sent.');
  }
  const read = await readJsonObject(req);
  if ('refused' in read) return read.refused;
  return NextResponse.json(
    await detachPhotoAction(read.body as Parameters<typeof detachPhotoAction>[0])
  );
}
