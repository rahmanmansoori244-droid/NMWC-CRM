// @vitest-environment node
/**
 * Item 9: every scheduled run leaves one CronRun row — the history the service
 * levels are measured from — and writing it can never cost the heartbeat or the
 * alert, which are what page someone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
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
import { callArguments, objectAfter, objectsAfter, sourceFiles, topLevel } from '../support/call-args';
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

  it('every decision claim is built from the reviewer’s decision token, so a stale decision cannot land', () => {
    // A step-back then a re-advance returns to the same step in the same cycle, so
    // the claim pins the visit (stageEnteredAt), not just the step. N01: it used to
    // take those values from the row reloaded a moment before, which guarded only
    // the reload-to-write window — a tab opened before a correction round approved
    // figures it had never shown. Every value now comes from the token the page
    // rendered (lib/decision-token.ts), so the check and the claim are one statement.
    const src = stripComments(readFileSync('services/edits.ts', 'utf8'), 'edits.ts');
    // A claim: moves a SUBMITTED request off its current step.
    const claims = callArguments(src, /\btx\.customerEdit\.updateMany\b/).filter((a) => {
      const where = objectAfter(a, /\bwhere\s*:/);
      return !!where && /\bstate:\s*EditState\.SUBMITTED\b/.test(topLevel(where)) && /\bcurrentStepIndex\s*:/.test(where);
    });
    // Advance, CREATE final, UPDATE final, reject.
    expect(claims).toHaveLength(4);
    const fromToken: Array<[column: string, field: string]> = [
      ['cycle', 'cycle'],
      ['currentStepIndex', 'stepIndex'],
      ['stageEnteredAt', 'stageEnteredAt'],
      ['requestedCreditLimit', 'creditLimit'],
      ['requestedPaymentTermDays', 'paymentTermDays'],
    ];
    for (const c of claims) {
      // In the WHERE, where it guards the claim — not in the data it writes.
      const where = objectAfter(c, /\bwhere\s*:/);
      expect(where, 'a claim without a where').not.toBeNull();
      // At the top level of the where — not tucked inside an OR, where it would
      // not constrain the claim — and the token's value itself, not edit.* and
      // not an expression built on it.
      const top = topLevel(where!);
      for (const [column, field] of fromToken) {
        expect(top, `${column} in a claim`).toMatch(new RegExp(`\\b${column}:\\s*expected\\.${field}\\s*(,|$)`));
      }
    }
  });

  it('every decision entry point reads the token, and compares it after the authorization gate', () => {
    const src = stripComments(readFileSync('services/edits.ts', 'utf8'), 'edits.ts');
    const sf = ts.createSourceFile('edits.ts', src, ts.ScriptTarget.Latest, true);
    const body = (name: string): string => {
      const fn = sf.statements.find(
        (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name
      );
      expect(fn?.body, `${name} not found`).toBeDefined();
      return fn!.body!.getText(sf);
    };
    for (const core of ['approveEditCore', 'rejectEditCore']) {
      const b = body(core);
      expect(b.match(/\bconst expected = readDecisionToken\(formData\);/g), core).toHaveLength(1);
      const gate = b.search(/!canActOnStep\(/);
      const check = b.search(/\bassertDecisionView\(expected, edit\);/);
      const firstWrite = b.search(/\bprisma\.\$transaction\(/);
      expect(gate, `${core}: the authorization gate`).toBeGreaterThan(-1);
      // After the gate: before it, a caller with no right to the request could
      // tell STALE_VIEW from FORBIDDEN and test guesses of its credit figures.
      expect(check, `${core}: compared after the gate`).toBeGreaterThan(gate);
      expect(firstWrite, `${core}: a write`).toBeGreaterThan(-1);
      expect(check, `${core}: compared before anything is written`).toBeLessThan(firstWrite);
    }
    for (const bulk of ['bulkApproveEditsAction', 'bulkRejectEditsAction']) {
      const b = body(bulk);
      expect(b, bulk).toMatch(/\bconst \{ editIds, tokenOf \} = readBulkDecisions\(formData\);/);
      // Each item is decided against its own card's token.
      expect(b, bulk).toMatch(/\bfd\.set\('decisionToken', tokenOf\.get\(editId\)!\);/);
    }
  });

  it('every decision transaction re-reads the guarantee documents straight after its claim', () => {
    // N01, guarantees: they are attachments, not columns, so the claim cannot
    // compare them. Each decision reads them again on its transaction, right after
    // the claim (which holds the request's row lock) and before its first write
    // after it — so a Remove is either seen or waits (lib/decision-token.ts), and
    // a refusal rolls the claim back. The defect it guards is "nobody called it".
    const problems = (src: string) => {
      const sf = ts.createSourceFile('edits.ts', stripComments(src, 'edits.ts'), ts.ScriptTarget.Latest, true);
      const out: string[] = [];
      let claims = 0;
      const visit = (n: ts.Node): void => {
        if (ts.isBlock(n)) {
          n.statements.forEach((s, i) => {
            if (!/^const claim = await tx\.customerEdit\.updateMany\(/.test(s.getText(sf))) return;
            claims += 1;
            const countCheck = n.statements[i + 1]?.getText(sf) ?? '';
            const next = n.statements[i + 2]?.getText(sf) ?? '';
            if (!/^if \(claim\.count === 0\)/.test(countCheck)) out.push(`claim ${claims}: no count check after it`);
            if (next !== 'await assertGuaranteesAsViewed(tx, edit, expected);') {
              out.push(`claim ${claims}: next is ${next.split('\n')[0]}`);
            }
          });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return { claims, out };
    };
    const src = readFileSync('services/edits.ts', 'utf8');
    // Advance, CREATE final, UPDATE final, reject.
    expect(problems(src)).toEqual({ claims: 4, out: [] });

    // A guard that cannot fail is not a guard: the check dropped from one
    // transaction, read on the pooled client, or moved below the first write.
    const CALL = 'await assertGuaranteesAsViewed(tx, edit, expected);';
    expect(src.split(CALL)).toHaveLength(5);
    expect(problems(src.replace(CALL, '')).out).toHaveLength(1);
    expect(problems(src.replace(CALL, `// ${CALL}`)).out).toHaveLength(1);
    expect(problems(src.replace(CALL, 'await assertGuaranteesAsViewed(prisma, edit, expected);')).out).toHaveLength(1);
    const moved = src.replace(
      /(await assertGuaranteesAsViewed\(tx, edit, expected\);)(\s*)(await tx\.editApproval\.create\(\{[\s\S]*?\n {8}\}\);)/,
      '$3$2$1'
    );
    expect(moved).not.toBe(src);
    expect(problems(moved).out).toHaveLength(1);
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
        // Every occurrence: an `include: { steps: true }` first in the file
        // must not hide a `data: { steps: { create } }` later (post-merge review).
        for (const nested of objectsAfter(src, new RegExp(`\\b${rel}\\s*:`))) {
          expect(nested, `${f}: a nested write through ${rel}`).not.toMatch(/\b(create\w*|connectOrCreate|upsert)\b/);
        }
      }
    }
  });
});
