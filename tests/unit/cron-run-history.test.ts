// @vitest-environment node
/**
 * Item 9: every scheduled run leaves one CronRun row — the history the service
 * levels are measured from — and writing it can never cost the heartbeat or the
 * alert, which are what page someone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';

const db = vi.hoisted(() => ({
  upsert: vi.fn(),
  create: vi.fn(),
  alert: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: { cronHeartbeat: { upsert: db.upsert }, cronRun: { create: db.create } },
}));
vi.mock('@/lib/alert', () => ({ sendAlert: db.alert }));

import { classifyRunSource, recordHeartbeat, withHeartbeat } from '@/lib/heartbeat';
import { callArguments, objectAfter, sourceFiles } from '../support/call-args';
import { stripComments } from '../support/strip-comments';

beforeEach(() => {
  db.upsert.mockReset().mockResolvedValue({});
  db.create.mockReset().mockResolvedValue({});
  db.alert.mockReset().mockResolvedValue(true);
});

const req = (ua: string | null) =>
  ({ headers: new Headers(ua === null ? {} : { 'user-agent': ua }) }) as unknown as NextRequest;

describe('the scheduler is recorded as a label, never as the User-Agent', () => {
  it.each([
    ['vercel-cron/1.0', 'vercel'],
    ['Mozilla/5.0 (compatible; cron-job.org/1.2; +https://cron-job.org/en/faq/)', 'cron-job.org'],
    ['curl/8.5.0', 'github'],
    ['Mozilla/5.0 Chrome/120', 'other'],
    [null, 'other'],
  ])('%s → %s', (ua, want) => {
    expect(classifyRunSource(ua)).toBe(want);
  });
});

describe('one row per run', () => {
  it('records start, outcome, durations and source — and no error text or detail', async () => {
    const startedAt = new Date('2026-10-01T03:04:00.000Z');
    await recordHeartbeat('keep-warm', {
      ok: true,
      durationMs: 180,
      dbMs: 9,
      startedAt,
      source: 'vercel',
      error: 'must not be copied',
      detail: { anything: 'must not be copied' },
    });
    expect(db.create).toHaveBeenCalledTimes(1);
    const data = db.create.mock.calls[0]![0].data;
    expect(data).toEqual({ key: 'keep-warm', at: startedAt, ok: true, durationMs: 180, dbMs: 9, source: 'vercel' });
  });

  it('without a start time, the start is the report time minus the duration', async () => {
    const before = Date.now();
    await recordHeartbeat('db-backup', { ok: true, durationMs: 60_000 });
    const at = db.create.mock.calls[0]![0].data.at as Date;
    expect(at.getTime()).toBeLessThanOrEqual(Date.now() - 60_000);
    expect(at.getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });

  it('a reported duration that cannot fit an INTEGER is clamped, not a failed insert', async () => {
    await recordHeartbeat('db-backup', { ok: true, durationMs: 1e12, dbMs: -5 });
    const data = db.create.mock.calls[0]![0].data;
    expect(data.durationMs).toBe(2_147_483_647);
    expect(data.dbMs).toBe(0);
  });

  it('a failed history write loses neither the heartbeat nor the alert', async () => {
    db.create.mockRejectedValue(new Error('relation "CronRun" does not exist'));
    await recordHeartbeat('sla-escalate', { ok: false, durationMs: 5 });
    expect(db.upsert).toHaveBeenCalledTimes(1);
    expect(db.alert).toHaveBeenCalledTimes(1);
  });

  it('a failed heartbeat write does not skip the history row', async () => {
    db.upsert.mockRejectedValue(new Error('connection terminated'));
    await recordHeartbeat('keep-warm', { ok: true, durationMs: 5 });
    expect(db.create).toHaveBeenCalledTimes(1);
  });
});

describe('withHeartbeat passes the run start, the scheduler and keep-warm’s database time', () => {
  it('on a normal run', async () => {
    const handler = withHeartbeat('keep-warm', async () => NextResponse.json({ warm: true, dbMs: 7 }), (b) => b?.warm === true);
    const t0 = Date.now();
    await handler(req('vercel-cron/1.0'));
    const data = db.create.mock.calls[0]![0].data;
    expect(data.source).toBe('vercel');
    expect(data.dbMs).toBe(7);
    expect(data.ok).toBe(true);
    expect((data.at as Date).getTime()).toBeGreaterThanOrEqual(t0);
  });

  it('on a thrown run', async () => {
    const handler = withHeartbeat('photo-gc', async () => {
      throw new Error('boom');
    });
    await handler(req('curl/8.5.0'));
    const data = db.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ key: 'photo-gc', ok: false, source: 'github' });
  });

  it('a refused call (401) is not a run and leaves no row', async () => {
    const handler = withHeartbeat('keep-warm', async () => NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 }));
    await handler(req('vercel-cron/1.0'));
    expect(db.create).not.toHaveBeenCalled();
  });
});

describe('the approval engine snapshots the stage on every decision it records', () => {
  // A decision row written without the snapshot is one the service-level report
  // can never judge; the table is append-only, so it cannot be filled in later.
  // Every file the app and its scripts are built from, comments stripped, every
  // way Prisma or SQL can insert a row (review, 2026-09-27: the first version
  // read four named files with a lazy regex).
  const files = sourceFiles(['app', 'lib', 'services', 'scripts', 'components']).filter((f) => !/\.test\./.test(f));
  const code = files.map((f) => [f, stripComments(readFileSync(f, 'utf8'), f)] as const);

  it('every Prisma insert into EditApproval carries the stage as it was decided', () => {
    let sites = 0;
    for (const [f, src] of code) {
      // create, createMany, createManyAndReturn, upsert — anything that makes a row.
      for (const args of callArguments(src, /\beditApproval\.(create\w*|upsert)\b/)) {
        sites += 1;
        // `stageSnapshot(edit, …)`: the change request as loaded BEFORE the claim,
        // i.e. the stage being decided, not the one it advances to.
        expect(args, `${f}: an EditApproval insert without the stage snapshot`).toMatch(/\.\.\.stageSnapshot\(\s*edit\s*,/);
      }
    }
    expect(sites).toBe(4);
  });

  it('every decision claim pins the visit to the stage, so a stale decision cannot land on a later visit', () => {
    // A step-back then a re-advance returns to the same step in the same cycle;
    // without stageEnteredAt in the claim, a decision loaded before them passed.
    const src = stripComments(readFileSync('services/edits.ts', 'utf8'), 'edits.ts');
    const claims = callArguments(src, /\btx\.customerEdit\.updateMany\b/).filter((a) =>
      /currentStepIndex:\s*(stepIndex|rejectStepIndex)\b/.test(a)
    );
    expect(claims).toHaveLength(4);
    for (const c of claims) {
      // In the WHERE, where it guards the claim — not in the data it writes.
      const where = objectAfter(c, /\bwhere\s*:/);
      expect(where, 'a claim without a where').not.toBeNull();
      expect(where!).toMatch(/stageEnteredAt:\s*edit\.stageEnteredAt/);
    }
  });

  it('nothing inserts into EditApproval any other way', () => {
    // Every relation that points at EditApproval, read from the schema, so a new
    // one is covered the day it is added (CustomerEdit's steps, User's decisions).
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const relations = [...schema.matchAll(/^\s+(\w+)\s+EditApproval\[\]/gm)].map((m) => m[1]!);
    expect(relations.length).toBeGreaterThanOrEqual(2);
    for (const [f, src] of code) {
      expect(src, f).not.toMatch(/INSERT\s+INTO\s+"?EditApproval"?/i);
      for (const rel of relations) {
        const nested = objectAfter(src, new RegExp(`\\b${rel}\\s*:`));
        if (nested === null) continue;
        expect(nested, `${f}: a nested write through ${rel}`).not.toMatch(/\b(create\w*|connectOrCreate|upsert)\b/);
      }
    }
  });
});
