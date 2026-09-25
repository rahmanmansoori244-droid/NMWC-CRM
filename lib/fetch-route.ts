import { NextResponse, type NextRequest } from 'next/server';

/**
 * For a route handler that stands in for a server action, so the phone can
 * abort it (item 22: app/api/forms/[form]; since the post-merge review of
 * 30ec23a also app/api/photos/attach and app/api/photos/detach). A server
 * action gets Next's Origin check for free; these routes check the same here.
 */

/** A refusal in the action shape `{ ok: false, code, message }`, with its status. */
export const refuse = (status: number, code: string, message: string) =>
  NextResponse.json({ ok: false, code, message }, { status });

/** The host an Origin header names, or null for "null" and anything unparseable. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Same-origin JSON only: 415 for any other body, 403 for another site. A JSON
 * body cannot be sent cross-site without a CORS preflight these routes never
 * grant, and a browser that sends Origin must name this host. Null when the
 * request may go on.
 */
export function refuseCrossSite(req: NextRequest): NextResponse | null {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) {
    return refuse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  }
  const origin = req.headers.get('origin');
  if (origin && originHost(origin) !== (req.headers.get('x-forwarded-host') ?? req.headers.get('host'))) {
    return refuse(403, 'FORBIDDEN', 'Cross-site request refused.');
  }
  return null;
}

/** The body as a JSON object, or the 400 that refuses it. */
export async function readJsonObject(
  req: NextRequest
): Promise<{ body: Record<string, unknown> } | { refused: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { refused: refuse(400, 'INVALID_JSON', 'The request was not valid JSON.') };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { refused: refuse(400, 'INVALID_JSON', 'The request was not a JSON object.') };
  }
  return { body: body as Record<string, unknown> };
}
