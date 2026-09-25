// @vitest-environment node
/**
 * app/api/photos/attach and app/api/photos/detach — the photo slot's attach and
 * remove over fetch (post-merge review of 30ec23a). As server actions they
 * could not be aborted, and Next runs server actions one at a time: after an
 * attach with no answer, Retry's re-send — and every other slot's attach, and
 * every Remove — queued behind the stalled one and never left the phone.
 *
 * Each route calls the SAME function the server action was, replies with its
 * `{ ok, … }` as 200, and refuses what a server action would have refused:
 * another site, a non-JSON body, a signed-out caller. The role, scope and
 * validation checks inside the service are run for real, through these routes,
 * in photo-attach-service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn(), signedIn: true }));
vi.mock('@/lib/auth', () => ({
  auth: async () => (h.signedIn ? { user: { id: 'u1', role: 'SALESMAN', username: 'c4' } } : null),
}));
vi.mock('@/services/photos', () => ({ attachPhotoAction: h.attach, detachPhotoAction: h.detach }));

import { POST as attachPOST } from '@/app/api/photos/attach/route';
import { POST as detachPOST } from '@/app/api/photos/detach/route';

const HOST = 'nmwc.example';
const ROUTES = [
  ['attach', attachPOST, h.attach],
  ['detach', detachPOST, h.detach],
] as const;
function post(
  handler: (req: NextRequest) => Promise<Response>,
  name: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const req = new NextRequest(`https://${HOST}/api/photos/${name}`, {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handler(req);
}

beforeEach(() => {
  h.signedIn = true;
  h.attach.mockReset().mockResolvedValue({ ok: true, data: undefined });
  h.detach.mockReset().mockResolvedValue({ ok: true, data: undefined });
});

describe.each(ROUTES)('POST /api/photos/%s', (name, handler, action) => {
  it('hands the body to the service and replies with its result as an answer — a refusal included', async () => {
    const body = { attachmentId: 'ckabc0000000000000000000a', branchId: 'ckabc0000000000000000000b', slot: 'SHOP' };
    action.mockResolvedValue({ ok: false, code: 'FORBIDDEN', message: 'Branch not on your route.' });
    const res = await post(handler, name, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: false, code: 'FORBIDDEN', message: 'Branch not on your route.' });
    expect(action).toHaveBeenCalledWith(body);
  });

  it('the happy path: ok, as 200', async () => {
    const res = await post(handler, name, { attachmentId: 'ckabc0000000000000000000a' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('signed out: 401 before the body is read or the service runs — the middleware does not stop it', async () => {
    h.signedIn = false;
    const res = await post(handler, name, { attachmentId: 'ckabc0000000000000000000a' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(action).not.toHaveBeenCalled();
  });

  it('refuses another site, and an Origin it cannot read', async () => {
    for (const origin of ['https://evil.example', 'null', 'not a url']) {
      const res = await post(handler, name, {}, { origin });
      expect(res.status, origin).toBe(403);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it('accepts a same-origin request behind a proxy that names the public host', async () => {
    const res = await post(handler, name, {}, { host: 'internal:3000', 'x-forwarded-host': HOST });
    expect(res.status).toBe(200);
  });

  it('refuses a body that is not a JSON object — a form post from another site cannot send JSON without CORS', async () => {
    const form = await post(handler, name, 'a=1', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    expect((await post(handler, name, '{not json')).status).toBe(400);
    expect((await post(handler, name, '[1,2]')).status).toBe(400);
    expect((await post(handler, name, 'null')).status).toBe(400);
    expect(action).not.toHaveBeenCalled();
  });

  it('lets a programmer error propagate (500, reported) instead of answering', async () => {
    action.mockRejectedValue(new Error('bug'));
    await expect(post(handler, name, {})).rejects.toThrow('bug');
  });
});
