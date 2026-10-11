// @vitest-environment node
/**
 * Gap 2 (data audit 2026-10-10): nobody's viewing of a customer's photos was
 * recorded. AuditAction.PHOTO_VIEW existed, nothing wrote it, and the role guides
 * said views were logged.
 *
 * Owner decisions 2026-10-11, held here against GET /api/photos/[id]:
 *   (a) every view the route serves writes one PHOTO_VIEW row — the 200 and the
 *       304 alike — after the access check and before anything goes back, with
 *       ids only in `after` and the IP and device from the request;
 *   (b) a CR or a guarantee is not served when that row cannot be written (503,
 *       in words); any other photo is served and the failure is logged and sent
 *       to Sentry, never swallowed.
 * The rate limit, the access check and the caching headers are unchanged.
 *
 * The real lib/audit.ts writes the row: only its database client and the request
 * headers it reads are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const h = vi.hoisted(() => ({
  actor: { ok: true, user: { id: 'u-mgr', role: 'MANAGER', username: 'mgr.one' } } as Record<string, unknown>,
  att: null as Att | null,
  limitOk: true,
  access: vi.fn(),
  auditCreate: vi.fn(),
  send: vi.fn(),
  logError: vi.fn(),
  capture: vi.fn(),
  reqHeaders: {} as Record<string, string>,
}));

vi.mock('@/lib/session', () => ({ checkActor: async () => h.actor }));
vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: { findFirst: async () => h.att },
    auditLog: { create: h.auditCreate },
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(h.reqHeaders) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] }),
  assertCanAccessAttachment: h.access,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkLimitLocal: () => (h.limitOk ? { ok: true } : { ok: false, retryAfterSec: 7 }),
}));
vi.mock('@/lib/r2', () => ({ r2: () => ({ send: h.send }), R2_BUCKET: 'test-bucket' }));
vi.mock('@/lib/logger', () => ({
  logger: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: h.capture }));

import { GET } from '@/app/api/photos/[id]/route';
import { ForbiddenError } from '@/lib/errors';

const att = (kind: string, over: Partial<Att> = {}): Att => ({
  id: `ph-${kind.toLowerCase()}`,
  kind,
  customerId: 'cu-1',
  branchId: kind === 'CR' || kind === 'GUARANTEE' ? null : 'br-1',
  branchExtraId: kind === 'FREE' ? 'br-1' : null,
  editId: kind === 'GUARANTEE' ? 'ed-1' : null,
  r2Key: `2026/10/11/u-sa/${kind}/0f0e.jpg`,
  mimeType: 'image/jpeg',
  bytes: 3,
  capturedById: 'u-sa',
  deletedAt: null,
  ...over,
});

const body = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });

function get(id: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(`https://nmwc.example/api/photos/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

const STRICT = ['CR', 'GUARANTEE'] as const;
const SERVED_ANYWAY = ['SHOP', 'SIGNBOARD', 'FREE'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.actor = { ok: true, user: { id: 'u-mgr', role: 'MANAGER', username: 'mgr.one' } };
  h.att = att('SHOP');
  h.limitOk = true;
  h.reqHeaders = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Mozilla/5.0 (test)' };
  h.access.mockResolvedValue(undefined);
  h.auditCreate.mockResolvedValue({ id: 'al-1' });
  h.send.mockImplementation(async () => ({ Body: body() }));
});

describe('every served view writes one PHOTO_VIEW row (owner decision a)', () => {
  it.each([...STRICT, ...SERVED_ANYWAY])('%s, 200: the viewer, the photo, ids only, and the IP and device', async (kind) => {
    h.att = att(kind);
    const res = await get(h.att.id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    const { data } = h.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).toEqual({
      actorId: 'u-mgr',
      action: 'PHOTO_VIEW',
      entityType: 'Attachment',
      entityId: h.att.id,
      before: undefined,
      after: {
        kind,
        customerId: h.att.customerId,
        branchId: h.att.branchId,
        branchExtraId: h.att.branchExtraId,
        editId: h.att.editId,
      },
      reason: undefined,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (test)',
    });
    // Ids only: no name, number, key or capture point of the photo rides along.
    expect(Object.keys(data.after as object).sort()).toEqual(['branchExtraId', 'branchId', 'customerId', 'editId', 'kind']);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a 304 still shows the photo, so it is a view too — and still skips R2', async () => {
    h.att = att('SIGNBOARD');
    const res = await get(h.att.id, { 'if-none-match': `"p-${h.att.id}"` });
    expect(res.status).toBe(304);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.auditCreate.mock.calls[0]![0]).toMatchObject({
      data: { actorId: 'u-mgr', action: 'PHOTO_VIEW', entityType: 'Attachment', entityId: h.att.id, ip: '203.0.113.7' },
    });
  });

  it('each view is its own row: three opens, three rows', async () => {
    for (let i = 0; i < 3; i++) expect((await get(h.att!.id)).status).toBe(200);
    expect(h.auditCreate).toHaveBeenCalledTimes(3);
  });

  it('nothing goes back before the row is written: the answer waits for the INSERT', async () => {
    let release!: () => void;
    h.auditCreate.mockImplementation(() => new Promise((r) => (release = () => r({ id: 'al-1' }))));
    let answered = false;
    const pending = get(h.att!.id).then((r) => {
      answered = true;
      return r;
    });
    // The INSERT and the R2 fetch overlap (no extra round trip in series)...
    await vi.waitFor(() => expect(h.auditCreate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    // ...and the photo is held until the row lands.
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    release();
    expect((await pending).status).toBe(200);
  });

  it.each(STRICT)('%s: the document is fetched from storage only after its row is written', async (kind) => {
    h.att = att(kind);
    let release!: () => void;
    h.auditCreate.mockImplementation(() => new Promise((r) => (release = () => r({ id: 'al-1' }))));
    const pending = get(h.att.id);
    await vi.waitFor(() => expect(h.auditCreate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.send).not.toHaveBeenCalled();
    release();
    expect((await pending).status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('the caching headers are unchanged (the owner decides them separately)', async () => {
    h.att = att('CR');
    const cr = await get(h.att.id);
    expect(cr.headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');
    expect(cr.headers.get('etag')).toBeNull();
    h.att = att('GUARANTEE');
    expect((await get(h.att.id)).headers.get('cache-control')).toBe('private, no-store, no-cache, must-revalidate');
    h.att = att('SHOP');
    const shop = await get(h.att.id);
    expect(shop.headers.get('cache-control')).toBe('private, max-age=3600, immutable');
    expect(shop.headers.get('etag')).toBe(`"p-${h.att.id}"`);
  });
});

describe('a refused request is not a view: nothing is written', () => {
  it('signed out', async () => {
    h.actor = { ok: false, status: 401, code: 'SIGNED_OUT', message: 'Not signed in.' };
    expect((await get('ph-shop')).status).toBe(401);
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it('a session that must change its password', async () => {
    h.actor = { ok: false, status: 403, code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change it first.' };
    expect((await get('ph-shop')).status).toBe(403);
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it('over the photo rate limit (unchanged: 429 with Retry-After)', async () => {
    h.limitOk = false;
    const res = await get('ph-shop');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it('no such photo, or a removed one', async () => {
    h.att = null;
    expect((await get('ph-gone')).status).toBe(404);
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it.each([...STRICT, ...SERVED_ANYWAY])('%s outside the viewer’s scope: 404, no row, nothing fetched', async (kind) => {
    h.att = att(kind);
    h.access.mockRejectedValue(new ForbiddenError('out of scope'));
    expect((await get(h.att.id)).status).toBe(404);
    expect(h.auditCreate).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('an access check that crashed: 500, no row', async () => {
    h.access.mockRejectedValue(new Error('db went away'));
    expect((await get('ph-shop')).status).toBe(500);
    expect(h.auditCreate).not.toHaveBeenCalled();
  });
});

describe('when the row cannot be written (owner decision b)', () => {
  beforeEach(() => {
    h.auditCreate.mockRejectedValue(new Error('Can’t reach database server at `db.example:5432`'));
  });

  it.each(STRICT)('%s fails closed: 503 in words, the document is never fetched, the failure reported', async (kind) => {
    h.att = att(kind);
    const res = await get(h.att.id);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      error: 'VIEW_NOT_RECORDED',
      message: 'This document could not be opened right now. Try again.',
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ attachmentId: h.att.id, kind, actorId: 'u-mgr', served: false });
    expect(h.logError.mock.calls[0]![1]).toBe('photo.view_not_recorded');
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0]![1]).toEqual({ tags: { event: 'photo.view_not_recorded', kind } });
  });

  it.each(SERVED_ANYWAY)('%s is still served, and the lost row is logged and sent to Sentry', async (kind) => {
    h.att = att(kind);
    const res = await get(h.att.id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ attachmentId: h.att.id, kind, served: true, errName: 'Error' });
    expect(h.logError.mock.calls[0]![1]).toBe('photo.view_not_recorded');
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('a 304 still goes back, and the lost row is reported', async () => {
    h.att = att('SHOP');
    const res = await get(h.att.id, { 'if-none-match': `"p-${h.att.id}"` });
    expect(res.status).toBe(304);
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ served: true }), 'photo.view_not_recorded');
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('a Sentry that cannot load does not cost the photo', async () => {
    h.capture.mockImplementation(() => {
      throw new Error('sentry down');
    });
    h.att = att('FREE');
    expect((await get(h.att.id)).status).toBe(200);
    expect(h.logError).toHaveBeenCalledTimes(1);
  });
});

describe('storage failing after the access check', () => {
  it('502 as before; the row already written for the attempt stands (the ledger is append-only)', async () => {
    h.send.mockRejectedValue(new Error('R2 down'));
    const res = await get(h.att!.id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'R2_FETCH_FAILED' });
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
  });
});
