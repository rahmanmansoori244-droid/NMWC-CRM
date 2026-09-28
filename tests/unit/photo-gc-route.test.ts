// @vitest-environment node
/**
 * N09 and X-OPS-3 (auditor recheck, 2026-09-27): the photo garbage collector,
 * run through its real route and heartbeat wrapper with the database, R2 and the
 * alert channel mocked.
 *
 * N09: after a successful tag (or an object already gone), a failed Attachment
 * delete was caught and counted nowhere. The run answered `r2Errors: 0`, the
 * heartbeat recorded success and no alert went out while every row stayed.
 *
 * X-OPS-3: the run read ONE unordered page of 200 candidates, and a row whose
 * storage or database step fails stays a candidate. Two hundred rows that kept
 * failing could fill that page every night, and nothing newer was ever reached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Row = { id: string; r2Key: string; deletedAt: Date | null };

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; r2Key: string; deletedAt: Date | null }>,
  /** R2 keys whose tag call throws, and what it throws. */
  r2Throws: new Map<string, Error>(),
  /** Attachment ids whose delete throws, and what it throws. */
  deleteThrows: new Map<string, Error>(),
  /** Milliseconds each R2 call takes, on the faked clock. */
  r2Ms: 0,
  findMany: vi.fn(),
  del: vi.fn(),
  send: vi.fn(),
  upsert: vi.fn(),
  runCreate: vi.fn(),
  alert: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: { findMany: h.findMany, delete: h.del },
    cronHeartbeat: { upsert: h.upsert },
    cronRun: { create: h.runCreate },
  },
}));
vi.mock('@/lib/r2', () => ({ r2: () => ({ send: h.send }), R2_BUCKET: 'test-bucket' }));
vi.mock('@/lib/alert', () => ({ sendAlert: h.alert }));
vi.mock('@/lib/logger', () => ({ logger: { info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() } }));

import { GET } from '@/app/api/cron/photo-gc/route';

const NOW = new Date('2026-10-01T03:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * The query the route sends, executed against `h.rows` — and ONLY that query:
 * anything else fails the test, so ordering and keyset paging are pinned by the
 * same double that serves them.
 */
function findMany(args: {
  where: { deletedAt: { not: null; lt: Date }; OR?: Array<Record<string, unknown>> };
  orderBy: unknown;
  select: unknown;
  take: number;
}): Row[] {
  expect(args.orderBy).toEqual([{ deletedAt: 'asc' }, { id: 'asc' }]);
  expect(args.select).toEqual({ id: true, r2Key: true, deletedAt: true });
  expect(args.where.deletedAt.not).toBeNull();
  let out = h.rows.filter((r) => r.deletedAt !== null && r.deletedAt < args.where.deletedAt.lt);
  if (args.where.OR) {
    const [later, sameThenId] = args.where.OR as [
      { deletedAt: { gt: Date } },
      { deletedAt: Date; id: { gt: string } },
    ];
    out = out.filter(
      (r) =>
        r.deletedAt! > later.deletedAt.gt ||
        (r.deletedAt!.getTime() === sameThenId.deletedAt.getTime() && r.id > sameThenId.id.gt)
    );
  }
  out.sort((a, b) => a.deletedAt!.getTime() - b.deletedAt!.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, args.take).map((r) => ({ ...r }));
}

function row(i: number, daysAgo = 40): Row {
  const id = `att${String(i).padStart(4, '0')}`;
  return { id, r2Key: `2026/08/01/u1/SHOP/${id}.jpg`, deletedAt: new Date(NOW.getTime() - daysAgo * DAY + i * 1000) };
}

const named = (name: string, message = name) => Object.assign(new Error(message), { name });
const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code });

const req = { headers: new Headers({ authorization: 'Bearer photo-gc-test-secret', 'user-agent': 'vercel-cron/1.0' }) } as unknown as NextRequest;

async function run() {
  const res = await GET(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** What the heartbeat recorded for this run: the value the monitor alarms on. */
function recordedOk(): boolean {
  expect(h.upsert).toHaveBeenCalledTimes(1);
  const arg = h.upsert.mock.calls[0]![0] as { create: { lastOk: boolean }; update: { lastOk: boolean } };
  expect(arg.create.lastOk).toBe(arg.update.lastOk);
  return arg.update.lastOk;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = 'photo-gc-test-secret';
  h.rows = [];
  h.r2Throws.clear();
  h.deleteThrows.clear();
  h.r2Ms = 0;
  h.findMany.mockReset().mockImplementation(async (args) => findMany(args));
  h.send.mockReset().mockImplementation(async (cmd: { input: { Key: string } }) => {
    if (h.r2Ms) vi.setSystemTime(Date.now() + h.r2Ms);
    const err = h.r2Throws.get(cmd.input.Key);
    if (err) throw err;
    return {};
  });
  h.del.mockReset().mockImplementation(async ({ where: { id } }: { where: { id: string } }) => {
    const err = h.deleteThrows.get(id);
    if (err) throw err;
    h.rows = h.rows.filter((r) => r.id !== id);
    return {};
  });
  h.upsert.mockReset().mockResolvedValue({});
  h.runCreate.mockReset().mockResolvedValue({});
  h.alert.mockReset().mockResolvedValue(true);
  h.info.mockReset();
  h.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('N09: a failed database step is a failed run', () => {
  it('tag succeeds, the row delete throws: counted, reported, and the heartbeat goes red with an alert', async () => {
    h.rows = [row(1)];
    h.deleteThrows.set('att0001', prismaError('P1001', "Can't reach database server"));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ deleted: 0, r2Errors: 0, dbErrors: 1, alreadyGone: 0, scanned: 1 });
    expect(recordedOk()).toBe(false);
    expect(h.alert).toHaveBeenCalledTimes(1);
    // The row is still there for the next run to retry.
    expect(h.rows.map((r) => r.id)).toEqual(['att0001']);
    // And the run's own log line carries the count.
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ dbErrors: 1 }), 'gc.photo_done');
  });

  it('object already gone from R2, the row delete throws: the same', async () => {
    h.rows = [row(1)];
    h.r2Throws.set(row(1).r2Key, named('NoSuchKey', 'The specified key does not exist.'));
    h.deleteThrows.set('att0001', prismaError('P2034', 'Transaction failed due to a write conflict'));
    const { body } = await run();
    expect(body).toMatchObject({ deleted: 0, r2Errors: 0, dbErrors: 1 });
    expect(recordedOk()).toBe(false);
  });

  it('a row an overlapping run already deleted (P2025) is done, not a failure', async () => {
    h.rows = [row(1)];
    h.deleteThrows.set('att0001', prismaError('P2025', 'No record was found for a delete.'));
    const { body } = await run();
    expect(body).toMatchObject({ deleted: 0, r2Errors: 0, dbErrors: 0, alreadyGone: 1 });
    expect(recordedOk()).toBe(true);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('a mixed batch is counted exactly', async () => {
    h.rows = [1, 2, 3, 4, 5].map((i) => row(i));
    h.r2Throws.set(row(2).r2Key, named('NotFound', 'UnknownError 404')); // gone: safe to drop
    h.r2Throws.set(row(3).r2Key, named('SlowDown', 'Please reduce your request rate.')); // transient: keep
    h.deleteThrows.set('att0004', prismaError('P1017', 'Server has closed the connection.'));
    h.deleteThrows.set('att0005', prismaError('P2025', 'No record was found for a delete.'));
    const { body } = await run();
    expect(body).toEqual({ deleted: 2, r2Errors: 1, dbErrors: 1, alreadyGone: 1, skipped: 1, scanned: 5, pages: 1, behind: false });
    expect(recordedOk()).toBe(false);
    expect(h.rows.map((r) => r.id)).toEqual(['att0003', 'att0004', 'att0005']);
  });

  it('a clean run is green', async () => {
    h.rows = [1, 2, 3].map((i) => row(i));
    const { body } = await run();
    expect(body).toEqual({ deleted: 3, r2Errors: 0, dbErrors: 0, alreadyGone: 0, skipped: 0, scanned: 3, pages: 1, behind: false });
    expect(recordedOk()).toBe(true);
  });

  it('a row inside the 30-day grace is not touched', async () => {
    h.rows = [row(1, 29), row(2, 31)];
    const { body } = await run();
    expect(body).toMatchObject({ deleted: 1, scanned: 1 });
    expect(h.rows.map((r) => r.id)).toEqual(['att0001']);
  });
});

describe('X-OPS-3: rows that keep failing cannot starve the rest', () => {
  it('250 candidates whose oldest 200 always fail: the other 50 are collected in the same run, and the 200 turn it red', async () => {
    h.rows = Array.from({ length: 250 }, (_, i) => row(i + 1));
    for (const r of h.rows.slice(0, 200)) h.r2Throws.set(r.r2Key, named('AccessDenied', 'Access Denied'));
    const { body } = await run();
    expect(body).toEqual({ deleted: 50, r2Errors: 200, dbErrors: 0, alreadyGone: 0, skipped: 200, scanned: 250, pages: 2, behind: false });
    expect(h.rows).toHaveLength(200);
    expect(h.rows.every((r) => h.r2Throws.has(r.r2Key))).toBe(true);
    // The second page started AFTER the failing rows, not at them.
    const second = h.findMany.mock.calls[1]![0] as { where: { OR: Array<{ id?: { gt: string } }> } };
    expect(second.where.OR[1]?.id?.gt).toBe('att0200');
    expect(recordedOk()).toBe(false);
  });

  it('stops cleanly when the time budget is spent, says it is behind, and still records the run', async () => {
    h.rows = Array.from({ length: 100 }, (_, i) => row(i + 1));
    h.r2Ms = 1000; // each tag call takes a second on the faked clock
    const { status, body } = await run();
    expect(status).toBe(200);
    // The budget is 40 s: forty calls, then the run stops before the forty-first.
    expect(body).toMatchObject({ deleted: 40, scanned: 40, behind: true, r2Errors: 0, dbErrors: 0 });
    expect(h.rows).toHaveLength(60);
    // Behind is not broken: the next run carries on from the oldest.
    expect(recordedOk()).toBe(true);
  });

  it('pages through more than one full page when every row succeeds', async () => {
    h.rows = Array.from({ length: 450 }, (_, i) => row(i + 1));
    const { body } = await run();
    expect(body).toMatchObject({ deleted: 450, scanned: 450, pages: 3, behind: false });
    expect(h.rows).toHaveLength(0);
  });
});
