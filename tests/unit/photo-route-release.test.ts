// @vitest-environment node
/**
 * Photos of a large customer (2026-11-15): GET /api/photos/[id] gives the photo
 * store's connection back on every path where Next will not read the body.
 *
 * Measured on a local production build: the route handed the store's Node body to
 * NextResponse, and when the browser dropped the request before the route returned
 * (a page closed while its photos loaded), or sent HEAD, nobody read or destroyed
 * that body. Each one held one of the store client's 50 pooled connections until the
 * process ended; at 50 every photo answered 502 and every upload check 503.
 *
 * Held here: the store call gets the request's signal; a browser gone before the
 * answer, HEAD, an empty body and any error release the body; a body cut by the
 * idle limit is never answered 200; the silent failures are logged, with ids only.
 * What is recorded (PHOTO_VIEW), answered and cached is unchanged
 * (tests/unit/photo-view-audit.test.ts holds that in full).
 *
 * Since buffered serving, a photo up to PHOTO_BUFFER_MAX_BYTES (8 MB) is read in full
 * before it is sent (tests/unit/photo-route-buffered.test.ts). The stream hand-off held
 * here is kept for an object above that limit, so every case below uses one.
 */
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { PassThrough } from 'node:stream';
import { NextRequest } from 'next/server';

type Att = {
  id: string;
  kind: string;
  customerId: string | null;
  branchId: string | null;
  branchExtraId: string | null;
  editId: string | null;
  r2Key: string;
  mimeType: string;
  bytes: number;
  capturedById: string;
  deletedAt: null;
};

type Body = PassThrough & { setTimeout: ReturnType<typeof vi.fn> };

/** Above the 8 MB buffer limit: the stream path. */
const BYTES = 8 * 1024 * 1024 + 300_000;

const h = vi.hoisted(() => ({
  att: null as Att | null,
  auditCreate: vi.fn(),
  send: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  serveThrows: false,
}));

vi.mock('@/lib/session', () => ({
  checkActor: async () => ({ ok: true, user: { id: 'u-mgr', role: 'MANAGER', username: 'mgr.one' } }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: { findFirst: async () => h.att },
    auditLog: { create: h.auditCreate },
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (test)' }),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] }),
  assertCanAccessAttachment: async () => undefined,
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimitLocal: () => ({ ok: true }) }));
vi.mock('@/lib/r2', () => ({ r2: () => ({ send: h.send }), R2_BUCKET: 'test-bucket' }));
vi.mock('@/lib/logger', () => ({
  logger: { error: h.logError, warn: h.logWarn, info: h.logInfo, debug: vi.fn() },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/photo-mime', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/photo-mime')>();
  return {
    ...real,
    serveHeadersFor: (...args: Parameters<typeof real.serveHeadersFor>) => {
      if (h.serveThrows) throw new Error('mime table broken');
      return real.serveHeadersFor(...args);
    },
  };
});

import { GET } from '@/app/api/photos/[id]/route';
import { PHOTO_BUFFER_MAX_BYTES } from '@/lib/photo-body';

const att = (kind: string): Att => ({
  id: `ph-${kind.toLowerCase()}`,
  kind,
  customerId: 'cu-1',
  branchId: kind === 'CR' ? null : 'br-1',
  branchExtraId: null,
  editId: null,
  r2Key: `2026/11/15/u-sa/${kind}/0f0e.jpg`,
  mimeType: 'image/jpeg',
  bytes: BYTES,
  capturedById: 'u-sa',
  deletedAt: null,
});

/**
 * The store's body: BYTES waiting in a Node stream, in 16 KB chunks as a
 * socket delivers them (so the web stream holds one chunk and the rest waits), with
 * destroy and setTimeout spies.
 */
let body: Body;
let destroy: MockInstance<(error?: Error) => Body>;
function freshBody(bytes = BYTES, chunk = 16 * 1024): Body {
  const b = new PassThrough() as Body;
  b.setTimeout = vi.fn();
  for (let at = 0; at < bytes; at += chunk) b.write(Buffer.alloc(Math.min(chunk, bytes - at), 7));
  b.end();
  destroy = vi.spyOn(b, 'destroy');
  return b;
}

function request(opts: { method?: string; headers?: Record<string, string>; ac?: AbortController } = {}) {
  const ac = opts.ac ?? new AbortController();
  const req = new NextRequest(`https://nmwc.example/api/photos/${h.att!.id}`, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    signal: ac.signal,
  });
  return { req, ac };
}
const call = (req: NextRequest) => GET(req, { params: Promise.resolve({ id: h.att!.id }) });

/** A PHOTO_VIEW insert that waits until released. */
function holdTheRow() {
  let release!: () => void;
  h.auditCreate.mockImplementation(() => new Promise((r) => (release = () => r({ id: 'al-1' }))));
  return () => release();
}

const logged = (spy: ReturnType<typeof vi.fn>, event: string) => spy.mock.calls.filter((c) => c[1] === event);

beforeEach(() => {
  vi.clearAllMocks();
  h.att = att('SHOP');
  h.serveThrows = false;
  h.auditCreate.mockResolvedValue({ id: 'al-1' });
  body = freshBody();
  h.send.mockImplementation(async () => ({ Body: body }));
});

describe('the store connection is given back', () => {
  it('the attachment used here is above the buffer limit, so the route streams it', async () => {
    expect(h.att!.bytes).toBeGreaterThan(PHOTO_BUFFER_MAX_BYTES);
    const res = await call(request().req);
    expect(res.status).toBe(200);
    // Handed over as a stream: most of the store body is still unread at return.
    expect(body.readableEnded).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(BYTES);
  });

  it('(1) the store call gets the request signal', async () => {
    const { req } = request();
    const res = await call(req);
    expect(res.status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![1]).toEqual({ abortSignal: req.signal });
    expect(h.send.mock.calls[0]![1].abortSignal).toBe(req.signal);
    await res.arrayBuffer();
  });

  it('(2) a browser that leaves while the row is written: body destroyed, 502, one row, client_gone before_return', async () => {
    const releaseRow = holdTheRow();
    const { req, ac } = request();
    const pending = call(req);
    await vi.waitFor(() => expect(body.setTimeout).toHaveBeenCalledTimes(1)); // guarded
    expect(body.destroyed).toBe(false);
    ac.abort();
    expect(body.destroyed).toBe(true);
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(logged(h.logInfo, 'photo.client_gone')).toEqual([
      [{ attachmentId: h.att!.id, stage: 'before_return' }, 'photo.client_gone'],
    ]);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('(3) the signal is already aborted when the store answers: the body is destroyed', async () => {
    const { req, ac } = request();
    h.send.mockImplementation(async () => {
      ac.abort();
      return { Body: body };
    });
    const res = await call(req);
    expect(body.destroyed).toBe(true);
    expect(res.status).toBe(502);
    expect(logged(h.logInfo, 'photo.client_gone')).toHaveLength(1);
  });

  it('(4) HEAD: 200, no body, the GET headers, the body destroyed, one row, one store call', async () => {
    const get = await call(request().req);
    expect(get.status).toBe(200);
    await get.arrayBuffer();
    vi.clearAllMocks();
    h.auditCreate.mockResolvedValue({ id: 'al-1' });
    body = freshBody();
    h.send.mockImplementation(async () => ({ Body: body }));

    const head = await call(request({ method: 'HEAD' }).req);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    for (const name of ['content-type', 'content-disposition', 'cache-control', 'content-length', 'etag']) {
      expect(head.headers.get(name), name).not.toBeNull();
      expect(head.headers.get(name), name).toBe(get.headers.get(name));
    }
    expect(head.headers.get('content-length')).toBe(String(BYTES));
    expect(body.destroyed).toBe(true);
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('(5) an error after the store answered: 502, the body destroyed, photo.fetch_failed once', async () => {
    h.serveThrows = true;
    const res = await call(request().req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(body.destroyed).toBe(true);
    const lines = logged(h.logError, 'photo.fetch_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({ attachmentId: h.att!.id, kind: 'SHOP', errName: 'Error' });
    // Ids only: the storage key is never logged.
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain(h.att!.r2Key);
  });

  it('(6) no body: 502 EMPTY_BODY and photo.empty_body', async () => {
    h.send.mockImplementation(async () => ({ Body: undefined }));
    const res = await call(request().req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'EMPTY_BODY' });
    expect(logged(h.logError, 'photo.empty_body')).toEqual([
      [{ attachmentId: h.att!.id, kind: 'SHOP' }, 'photo.empty_body'],
    ]);
  });

  it('(7) the store call aborted because the browser left: 502, client_gone at the store, no error line', async () => {
    const { req, ac } = request();
    h.send.mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    });
    const res = await call(req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(logged(h.logInfo, 'photo.client_gone')).toEqual([
      [{ attachmentId: h.att!.id, stage: 'store' }, 'photo.client_gone'],
    ]);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('(8) a store timeout is logged as photo.fetch_failed with its name', async () => {
    h.send.mockRejectedValue(Object.assign(new Error('Connection timed out after 3000 ms'), { name: 'TimeoutError' }));
    const res = await call(request().req);
    expect(res.status).toBe(502);
    expect(logged(h.logError, 'photo.fetch_failed')).toEqual([
      [expect.objectContaining({ attachmentId: h.att!.id, kind: 'SHOP', errName: 'TimeoutError' }), 'photo.fetch_failed'],
    ]);
    expect(logged(h.logInfo, 'photo.client_gone')).toHaveLength(0);
  });

  it('(9) the idle limit cuts the body while the row is written, browser still there: 502, never a 200', async () => {
    const releaseRow = holdTheRow();
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.setTimeout).toHaveBeenCalledTimes(1));
    const [ms, onTimeout] = body.setTimeout.mock.calls[0]! as [number, () => void];
    expect(ms).toBe(30_000);
    onTimeout();
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(logged(h.logWarn, 'photo.store_idle_cut')).toEqual([
      [{ attachmentId: h.att!.id, kind: 'SHOP', idleMs: 30_000 }, 'photo.store_idle_cut'],
    ]);
    expect(logged(h.logInfo, 'photo.client_gone')).toHaveLength(0);
  });

  it('(10) a normal GET: 200, every byte, not destroyed early, idle limit 30 s', async () => {
    const res = await call(request().req);
    expect(res.status).toBe(200);
    expect(destroy).not.toHaveBeenCalled();
    expect(body.setTimeout).toHaveBeenCalledWith(30_000, expect.any(Function));
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(BYTES);
    expect(got.every((b) => b === 7)).toBe(true);
    expect(res.headers.get('content-length')).toBe(String(BYTES));
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.logWarn).not.toHaveBeenCalled();
  });
});

describe('a body that ended is not a body that was cut', () => {
  it('a small photo read in full while the row is written is still served 200 with every byte', async () => {
    // Its stream is destroyed by itself once it ends (autoDestroy), with every byte
    // already queued in the web stream: that must not read as a cut body. (The row
    // still says BYTES, so this is the stream path; the buffered path's version is in
    // photo-route-buffered.test.ts.)
    body = freshBody(3000, 3000);
    const releaseRow = holdTheRow();
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.destroyed).toBe(true));
    expect(body.readableEnded).toBe(true);
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(3000);
    expect(h.logError).not.toHaveBeenCalled();
  });
});

describe('what is recorded and answered is unchanged', () => {
  it('(11) a confidential kind whose row fails: 503 and the store is never asked', async () => {
    h.att = att('CR');
    h.auditCreate.mockRejectedValue(new Error('db down'));
    const res = await call(request().req);
    expect(res.status).toBe(503);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('(12) If-None-Match: 304 and the store is never asked', async () => {
    const res = await call(request({ headers: { 'if-none-match': `"p-${h.att!.id}"` } }).req);
    expect(res.status).toBe(304);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('(13) an ordinary photo whose row fails: still 200 with all bytes', async () => {
    h.auditCreate.mockRejectedValue(new Error('db down'));
    const res = await call(request().req);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(BYTES);
    expect(logged(h.logError, 'photo.view_not_recorded')).toHaveLength(1);
  });
});
