// @vitest-environment node
/**
 * ENH-3: app/api/photos/presign and app/api/photos/finalize answered any
 * signed-in role, while only SALESMAN, STEWARD and MANAGER can attach a photo
 * (services/photos.ts). A Viewer, Supervisor, Accountant, Finance Manager or GM
 * could fill R2 at 120 photos an hour that no slot would ever take, and nothing
 * sweeps a photo that was never attached. A presign followed by a PUT and no
 * finalize leaves an object with no row at all, so the gate is at presign, and
 * again at finalize (its own request, the one that writes the row).
 *
 * A GUARANTEE document belongs only to a new-customer request, which only a
 * salesman starts: the other two writers are refused that kind.
 *
 * R2, the presigner, the rate-limit bucket and Prisma are mocked; the routes and
 * lib/permissions are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Role } from '@prisma/client';

const h = vi.hoisted(() => ({
  user: { id: 'u1', role: 'SALESMAN', username: 'u1' } as { id: string; role: string; username: string },
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  checkLimit: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/r2', () => ({ r2: () => ({ send: h.send }), R2_BUCKET: 'bucket' }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: h.getSignedUrl }));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: h.checkLimit,
  PHOTO_LIMIT: { capacity: 120, refillPerSec: 120 / 3600 },
}));
vi.mock('@/lib/db', () => ({ prisma: { attachment: { findFirst: h.findFirst, create: h.create } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST as presignPOST } from '@/app/api/photos/presign/route';
import { POST as finalizePOST } from '@/app/api/photos/finalize/route';
import { PHOTO_ROLE_REFUSED_MESSAGE } from '@/lib/photo-attach';

const ALL_ROLES = ['SALESMAN', 'SUPERVISOR', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'MANAGER', 'STEWARD', 'VIEWER'];
const WRITERS = ['SALESMAN', 'STEWARD', 'MANAGER'];
const REFUSED = ALL_ROLES.filter((r) => !WRITERS.includes(r));
const HASH = 'a'.repeat(64);

function post(handler: (req: NextRequest) => Promise<Response>, name: string, body: unknown) {
  return handler(
    new NextRequest(`https://nmwc.example/api/photos/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}
const presign = (kind: string) => post(presignPOST, 'presign', { kind, mimeType: 'image/jpeg', bytes: 1000 });
const finalize = (key: string, kind: string) => post(finalizePOST, 'finalize', { key, kind, hash: HASH });

/** A key as presign mints it for this user — today's date, read once here. */
function mintedKey(userId: string, kind: string) {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${ymd}/${userId}/${kind}/00000000-0000-4000-8000-000000000000.jpg`;
}

const as = (role: string) => {
  // Lower-case alphanumeric: the key pattern finalize checks takes nothing else.
  h.user = { id: `user${role.toLowerCase().replace(/_/g, '')}`, role, username: role.toLowerCase() };
};

beforeEach(() => {
  as('SALESMAN');
  h.send.mockReset().mockResolvedValue({ ContentLength: 1000, ContentType: 'image/jpeg', LastModified: new Date() });
  h.getSignedUrl.mockReset().mockResolvedValue('https://r2.example/signed');
  h.checkLimit.mockReset().mockResolvedValue({ ok: true, retryAfterSec: 0 });
  h.findFirst.mockReset().mockResolvedValue(null);
  h.create.mockReset().mockResolvedValue({ id: 'ckattach000000000000000001' });
});

it('the matrix below covers every role there is', () => {
  expect([...Object.values(Role)].sort()).toEqual([...ALL_ROLES].sort());
});

describe('presign', () => {
  it.each(REFUSED)('%s is refused, before the rate-limit bucket and before a URL is signed', async (role) => {
    as(role);
    const res = await presign('SHOP');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'FORBIDDEN_ROLE', message: PHOTO_ROLE_REFUSED_MESSAGE });
    expect(h.checkLimit).not.toHaveBeenCalled();
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('%s gets an upload URL for a shop photo', async (role) => {
    as(role);
    const res = await presign('SHOP');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: 'https://r2.example/signed', method: 'PUT' });
    expect(h.checkLimit).toHaveBeenCalledWith(`photo:${h.user.id}`, expect.anything());
  });

  it('a GUARANTEE document: a salesman only', async () => {
    const ok = await presign('GUARANTEE');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { key: string }).key).toContain('/GUARANTEE/');
    for (const role of ['STEWARD', 'MANAGER']) {
      as(role);
      h.getSignedUrl.mockClear();
      const res = await presign('GUARANTEE');
      expect(res.status, role).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'FORBIDDEN_ROLE' });
      expect(h.getSignedUrl).not.toHaveBeenCalled();
    }
  });
});

describe('finalize', () => {
  it.each(REFUSED)('%s is refused, before R2 is asked and before a row is written', async (role) => {
    as(role);
    const res = await finalize(mintedKey(h.user.id, 'SHOP'), 'SHOP');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'FORBIDDEN_ROLE', message: PHOTO_ROLE_REFUSED_MESSAGE });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('%s finalizes the upload presign gave it', async (role) => {
    as(role);
    const { key } = (await (await presign('SHOP')).json()) as { key: string };
    const res = await finalize(key, 'SHOP');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attachmentId: 'ckattach000000000000000001', deduped: false });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('a GUARANTEE document: a salesman only', async () => {
    const { key } = (await (await presign('GUARANTEE')).json()) as { key: string };
    expect((await finalize(key, 'GUARANTEE')).status).toBe(200);
    for (const role of ['STEWARD', 'MANAGER']) {
      as(role);
      h.send.mockClear();
      h.create.mockClear();
      const res = await finalize(mintedKey(h.user.id, 'GUARANTEE'), 'GUARANTEE');
      expect(res.status, role).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'FORBIDDEN_ROLE' });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    }
  });
});

describe('finalize tells a missing object from R2 not answering', () => {
  // lib/r2.ts throws on requestTimeout since the phase-1 review. Before this, any
  // HeadObject failure answered 404 OBJECT_NOT_FOUND, which the phone does not
  // retry, so a slow R2 read as a photo that was never uploaded.
  it('R2 says there is no such object: 404, not retried', async () => {
    h.send.mockReset().mockRejectedValue(Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    const res = await finalize(mintedKey(h.user.id, 'SHOP'), 'SHOP');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'OBJECT_NOT_FOUND',
      message: 'The photo did not reach storage. Tap Retry upload to send it again.',
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('R2 times out or drops the connection: 503, which the phone retries', async () => {
    h.send.mockReset().mockRejectedValue(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
    const res = await finalize(mintedKey(h.user.id, 'SHOP'), 'SHOP');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'STORAGE_UNAVAILABLE' });
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('every refusal carries a message the photo slot shows (launch review)', () => {
  // The slot read only `{ ok: false, code, message }`, and these routes answered
  // `{ error }` alone: signed out, throttled or refused, the salesman read "Could
  // not get upload URL." The machine `error` stays; `message` is beside it.
  const signedOut = () => {
    h.user = null as unknown as typeof h.user;
  };

  it.each([
    ['presign', () => presign('SHOP')],
    ['finalize', () => finalize(mintedKey('nobody', 'SHOP'), 'SHOP')],
  ])('%s, signed out: 401 with a message, before anything else', async (_name, call) => {
    signedOut();
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED', message: 'Not signed in.' });
    expect(h.checkLimit).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('presign, throttled: 429 with the wait in the body, the header and the message', async () => {
    h.checkLimit.mockResolvedValue({ ok: false, retryAfterSec: 30 });
    const res = await presign('SHOP');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      error: 'RATE_LIMITED',
      retryAfterSec: 30,
      message: 'Too many photos in a short time. Try again in 30 seconds.',
    });
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('presign, a photo over 3 MB: 400 that says what is accepted', async () => {
    const res = await post(presignPOST, 'presign', { kind: 'SHOP', mimeType: 'image/jpeg', bytes: 4 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'VALIDATION_FAILED', message: expect.stringMatching(/3 MB at most/) });
  });

  it('finalize, a key another sign-in was given: 403 that says to send it again', async () => {
    const res = await finalize(mintedKey('someoneelse', 'SHOP'), 'SHOP');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'KEY_MISMATCH',
      message: 'This upload was started under another sign-in. Tap Retry upload to send the photo again.',
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('finalize, over 3 MB in R2: 413 that says to take it again', async () => {
    h.send.mockResolvedValue({ ContentLength: 4 * 1024 * 1024, ContentType: 'image/jpeg', LastModified: new Date() });
    const res = await finalize(mintedKey(h.user.id, 'SHOP'), 'SHOP');
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'TOO_LARGE', message: 'This photo is larger than 3 MB. Take it again.' });
    expect(h.create).not.toHaveBeenCalled();
  });
});
