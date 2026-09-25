import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { attachPhotoAction } from '@/services/photos';
import { readJsonObject, refuse, refuseCrossSite } from '@/lib/fetch-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The photo slot's attach, over fetch (post-merge review of 30ec23a). As a
 * server action it could not be aborted, and Next runs server actions one at a
 * time: after an attach with no answer, Retry's re-send — and every other slot's
 * attach, and every Remove — queued behind the stalled one and never left the
 * phone. It calls the SAME function the server action was, so the role, uploader,
 * kind and scope checks and the audit row are one code path; the service
 * validates the body.
 *
 * The reply is always the service's own `{ ok, … }` with status 200. Anything
 * else the slot treats as no answer: a 500 here is a programmer error thrown
 * through runAction, left to propagate so it reaches the error reporting.
 */
export async function POST(req: NextRequest) {
  const crossSite = refuseCrossSite(req);
  if (crossSite) return crossSite;
  // The middleware does not stop a signed-out request (auth.config.ts).
  if (!(await auth())?.user) {
    return refuse(401, 'SIGNED_OUT', 'You are signed out, so nothing was sent.');
  }
  const read = await readJsonObject(req);
  if ('refused' in read) return read.refused;
  return NextResponse.json(
    await attachPhotoAction(read.body as Parameters<typeof attachPhotoAction>[0])
  );
}
