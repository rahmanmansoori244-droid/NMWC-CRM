// @vitest-environment node
/**
 * Photos of a large customer, buffered serving (2026-11-15): GET /api/photos/[id]
 * reads an ordinary photo (up to PHOTO_BUFFER_MAX_BYTES, 8 MB) from the store to its
 * end before it answers.
 *
 * Measured after the first build: the 30 s idle limit on the store socket cut a
 * browser that was still reading, slowly, once a photo was bigger than the buffers
 * between the store and the browser (a 3 MB photo read at 16 KB every 20 s). Read in
 * full first, the store connection is held only while the store delivers; what the
 * browser does afterwards cannot hold it or get it cut, and a store that fails in the
 * middle of a photo gives a clean 502 instead of a 200 with a cut body.
 *
 * Held here: a buffered answer is every stored byte and does not depend on the store
 * body; a body shorter or longer than the recorded size answers 502 with
 * photo.size_mismatch; an idle cut or a browser that leaves during the read answers
 * 502; HEAD reads nothing; the limit is inclusive. The stream path, for an object
 * above the limit, is tests/unit/photo-route-release.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

/** An ordinary photo, read in full before it is sent. */
const BYTES = 300_000;
const CHUNK = 16 * 1024;

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

const att = (kind: string, bytes = BYTES): Att => ({
  id: `ph-${kind.toLowerCase()}`,
  kind,
  customerId: 'cu-1',
  branchId: kind === 'CR' ? null : 'br-1',
  branchExtraId: null,
  editId: null,
  r2Key: `2026/11/15/u-sa/${kind}/0f0e.jpg`,
  mimeType: 'image/jpeg',
  bytes,
  capturedById: 'u-sa',
  deletedAt: null,
});

/** A store body that the test feeds: `feed(b, n)` writes the next n bytes in 16 KB chunks. */
let body: Body;
let byteNo = 0;
function openBody(): Body {
  const b = new PassThrough() as Body;
  b.setTimeout = vi.fn();
  byteNo = 0;
  return b;
}
function feed(b: Body, n: number) {
  for (let left = n; left > 0; left -= CHUNK) {
    const len = Math.min(CHUNK, left);
    const chunk = Buffer.alloc(len);
    for (let i = 0; i < len; i++) chunk[i] = (byteNo + i) % 251;
    byteNo += len;
    b.write(chunk);
  }
}
const expected = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

function request(opts: { method?: string; ac?: AbortController } = {}) {
  const ac = opts.ac ?? new AbortController();
  const req = new NextRequest(`https://nmwc.example/api/photos/${h.att!.id}`, {
    method: opts.method ?? 'GET',
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
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  h.att = att('SHOP');
  h.serveThrows = false;
  h.auditCreate.mockResolvedValue({ id: 'al-1' });
  body = openBody();
  h.send.mockImplementation(async () => ({ Body: body }));
});

describe('an ordinary photo is read in full, then sent', () => {
  it('200 with exactly the stored bytes; the store body ended before the route returned, and the answer does not depend on it', async () => {
    feed(body, BYTES);
    body.end();
    const res = await call(request().req);
    expect(res.status).toBe(200);
    expect(body.readableEnded).toBe(true); // read to its end before the answer
    expect(body.setTimeout).toHaveBeenCalledWith(30_000, expect.any(Function));
    expect(res.headers.get('content-length')).toBe(String(BYTES));
    // Not the store stream: the store body is gone and the answer still reads in full.
    body.destroy();
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got).toEqual(expected(BYTES));
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.logWarn).not.toHaveBeenCalled();
  });

  it('the route waits for a body that arrives slowly, and answers once the last byte is in', async () => {
    let done = false;
    const pending = call(request().req).then((r) => ((done = true), r));
    await vi.waitFor(() => expect(body.setTimeout).toHaveBeenCalledTimes(1));
    feed(body, BYTES - 1000);
    await tick();
    expect(done).toBe(false);
    feed(body, 1000);
    body.end();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(expected(BYTES));
  });

  it('a photo read in full while the row is written is served 200', async () => {
    const releaseRow = holdTheRow();
    feed(body, BYTES);
    body.end();
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.readableEnded).toBe(true));
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(BYTES);
  });

  it('an ordinary photo whose row fails is still served 200 with every byte', async () => {
    h.auditCreate.mockRejectedValue(new Error('db down'));
    feed(body, BYTES);
    body.end();
    const res = await call(request().req);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(BYTES);
    expect(logged(h.logError, 'photo.view_not_recorded')).toHaveLength(1);
  });
});

describe('a body that is not the recorded size is not shown', () => {
  it('a short body: 502, photo.size_mismatch (ids and sizes only), exactly one PHOTO_VIEW row', async () => {
    feed(body, 200_000);
    body.end();
    const res = await call(request().req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(logged(h.logWarn, 'photo.size_mismatch')).toEqual([
      [{ attachmentId: h.att!.id, kind: 'SHOP', expected: BYTES, got: 200_000, more: false }, 'photo.size_mismatch'],
    ]);
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.logError).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain(h.att!.r2Key);
  });

  it('a short body while the row is still written: 502, and no unhandled rejection', async () => {
    const releaseRow = holdTheRow();
    feed(body, 1000);
    body.end();
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.readableEnded).toBe(true));
    await tick(); // the read has rejected by now, with `viewed` still pending
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(logged(h.logWarn, 'photo.size_mismatch')).toHaveLength(1);
  });

  it('a long body: 502, reading stops and the body is destroyed', async () => {
    feed(body, BYTES + 5 * CHUNK); // and the store would go on sending
    const res = await call(request().req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(body.destroyed).toBe(true);
    expect(body.readableEnded).toBe(false);
    const lines = logged(h.logWarn, 'photo.size_mismatch');
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({ attachmentId: h.att!.id, expected: BYTES, more: true });
    expect((lines[0]![0] as { got: number }).got).toBeGreaterThan(BYTES);
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('a long body found while the row is still written is logged as a size mismatch too', async () => {
    const releaseRow = holdTheRow();
    feed(body, BYTES + 5 * CHUNK);
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.destroyed).toBe(true));
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(logged(h.logWarn, 'photo.size_mismatch')).toHaveLength(1);
    expect(logged(h.logInfo, 'photo.client_gone')).toHaveLength(0);
  });
});

describe('a read that is cut answers 502, never 200', () => {
  it('an idle cut during the read, browser still there: 502, store_idle_cut then fetch_failed, no client_gone', async () => {
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.setTimeout).toHaveBeenCalledTimes(1));
    feed(body, 100_000); // then the store stops
    await tick();
    const [ms, onTimeout] = body.setTimeout.mock.calls[0]! as [number, () => void];
    expect(ms).toBe(30_000);
    onTimeout();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(logged(h.logWarn, 'photo.store_idle_cut')).toHaveLength(1);
    expect(logged(h.logError, 'photo.fetch_failed')).toHaveLength(1);
    expect(logged(h.logInfo, 'photo.client_gone')).toHaveLength(0);
  });

  it('an idle cut while the row is written: 502, never 200', async () => {
    const releaseRow = holdTheRow();
    const pending = call(request().req);
    await vi.waitFor(() => expect(body.setTimeout).toHaveBeenCalledTimes(1));
    feed(body, 100_000);
    (body.setTimeout.mock.calls[0]![1] as () => void)();
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(logged(h.logWarn, 'photo.store_idle_cut')).toHaveLength(1);
    expect(logged(h.logError, 'photo.fetch_failed')).toHaveLength(1);
    expect(logged(h.logInfo, 'photo.client_gone')).toHaveLength(0);
  });

  it('a browser that leaves during the read: the body is destroyed, 502, client_gone stage body, no error line', async () => {
    const { req, ac } = request();
    const pending = call(req);
    await vi.waitFor(() => expect(h.auditCreate).toHaveBeenCalledTimes(1));
    feed(body, 100_000);
    await tick(); // the row is written; the route waits for the rest of the body
    expect(body.destroyed).toBe(false);
    ac.abort();
    expect(body.destroyed).toBe(true);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(logged(h.logInfo, 'photo.client_gone')).toEqual([
      [{ attachmentId: h.att!.id, stage: 'body' }, 'photo.client_gone'],
    ]);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.logWarn).not.toHaveBeenCalled();
  });

  it('a browser that leaves while the row is written and the body is still coming: client_gone stage body', async () => {
    const releaseRow = holdTheRow();
    const { req, ac } = request();
    const pending = call(req);
    await vi.waitFor(() => expect(body.setTimeout).toHaveBeenCalledTimes(1));
    feed(body, 50_000);
    ac.abort();
    expect(body.destroyed).toBe(true);
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(logged(h.logInfo, 'photo.client_gone')).toEqual([
      [{ attachmentId: h.att!.id, stage: 'body' }, 'photo.client_gone'],
    ]);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('an error after the read (serveHeadersFor throws): 502, photo.fetch_failed once', async () => {
    h.serveThrows = true;
    feed(body, BYTES);
    body.end();
    const res = await call(request().req);
    expect(res.status).toBe(502);
    expect(logged(h.logError, 'photo.fetch_failed')).toHaveLength(1);
  });
});

describe('what is not buffered', () => {
  it('HEAD reads nothing: 200, no body, the body destroyed unread', async () => {
    const releaseRow = holdTheRow();
    feed(body, BYTES);
    body.end();
    const pending = call(request({ method: 'HEAD' }).req);
    await vi.waitFor(() => expect(h.auditCreate).toHaveBeenCalledTimes(1));
    await tick(); // time enough for a read of the whole body, had one started
    expect(body.readableEnded).toBe(false);
    releaseRow();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-length')).toBe(String(BYTES));
    expect(body.destroyed).toBe(true);
    expect(body.readableEnded).toBe(false);
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.logWarn).not.toHaveBeenCalled();
  });

  it('the limit is inclusive: exactly PHOTO_BUFFER_MAX_BYTES is read in full first', async () => {
    expect(PHOTO_BUFFER_MAX_BYTES).toBe(8 * 1024 * 1024);
    h.att = att('SHOP', PHOTO_BUFFER_MAX_BYTES);
    feed(body, PHOTO_BUFFER_MAX_BYTES);
    body.end();
    const res = await call(request().req);
    expect(res.status).toBe(200);
    expect(body.readableEnded).toBe(true);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(PHOTO_BUFFER_MAX_BYTES);
  });

  it('one byte above the limit takes the stream path: the route returns before the body is read', async () => {
    h.att = att('SHOP', PHOTO_BUFFER_MAX_BYTES + 1);
    feed(body, PHOTO_BUFFER_MAX_BYTES + 1);
    body.end();
    const res = await call(request().req);
    expect(res.status).toBe(200);
    expect(body.readableEnded).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(PHOTO_BUFFER_MAX_BYTES + 1);
    expect(body.readableEnded).toBe(true);
  });
});
