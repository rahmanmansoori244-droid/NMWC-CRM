// @vitest-environment node
/**
 * Gap 24: the changes the dated history recorded with no cause, and whether the
 * history is still being written (lib/history-report.ts) — the Steward's /status
 * card and the /api/health warnings.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { stripComments } from '../support/strip-comments';
import { evaluateHealth } from '@/lib/health';
import { HISTORY_TRIGGERS } from '@/lib/history-tables';

import {
  RUNTIME_ROLE,
  historyWarnings,
  loadHistoryHealth,
  loadHistoryReport,
  loadUnattributed,
  summarize,
} from '@/lib/history-report';

const NOW = new Date('2026-10-13T08:00:00.000Z');

/** A fake client: the unattributed rows, and the history triggers pg_trigger lists. */
function fakeClient(opts: {
  rows?: Array<{ table_name: string; day: string; db_user: string; n: bigint; sample_ids: bigint[] }>;
  triggers?: Array<{ tgname: string; tgenabled: string }>;
  fail?: boolean;
}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const $queryRaw = vi.fn(async (q: Prisma.Sql) => {
    calls.push({ sql: q.sql, values: q.values });
    if (opts.fail) throw new Error('function nmwc_history_unattributed(timestamp) does not exist');
    if (q.sql.includes('nmwc_history_unattributed')) return opts.rows ?? [];
    if (q.sql.includes('pg_trigger'))
      return opts.triggers ?? HISTORY_TRIGGERS.map((t) => ({ tgname: t, tgenabled: 'O' }));
    throw new Error(`unexpected SQL ${q.sql}`);
  });
  return { client: { $queryRaw } as never, calls };
}

describe('summarize', () => {
  it('splits the runtime role’s rows (a missing context: a bug) from any other login’s', () => {
    const r = summarize(NOW, [
      {
        table: 'BranchHistory',
        day: '2026-10-12',
        dbUser: RUNTIME_ROLE,
        n: 2,
        sampleIds: ['1', '2'],
      },
      {
        table: 'CustomerHistory',
        day: '2026-10-12',
        dbUser: 'neondb_owner',
        n: 5,
        sampleIds: ['9'],
      },
      { table: 'UserHistory', day: '2026-10-11', dbUser: RUNTIME_ROLE, n: 1, sampleIds: ['4'] },
    ]);
    expect(r.fromApp).toBe(3);
    expect(r.fromOther).toBe(5);
  });
});

describe('loadUnattributed', () => {
  it('asks the database function for the rows since a UTC instant and maps them', async () => {
    const { client, calls } = fakeClient({
      rows: [
        {
          table_name: 'BranchHistory',
          day: '2026-10-12',
          db_user: 'nmwc_app',
          n: 3n,
          sample_ids: [41n, 42n, 43n],
        },
      ],
    });
    const rows = await loadUnattributed(client, new Date('2026-10-12T05:06:07.890Z'));
    expect(rows).toEqual([
      {
        table: 'BranchHistory',
        day: '2026-10-12',
        dbUser: 'nmwc_app',
        n: 3,
        sampleIds: ['41', '42', '43'],
      },
    ]);
    expect(calls[0]!.sql).toContain('FROM nmwc_history_unattributed(');
    // The TIMESTAMP columns hold UTC wall-clock time: the bound is sent as such.
    expect(calls[0]!.values).toEqual(['2026-10-12 05:06:07.890']);
  });
});

describe('loadHistoryReport (the /status card)', () => {
  it('reads the last 30 days', async () => {
    const { client, calls } = fakeClient({});
    const r = await loadHistoryReport(client, NOW);
    expect(r).toEqual({
      since: new Date('2026-09-13T08:00:00.000Z'),
      rows: [],
      fromApp: 0,
      fromOther: 0,
    });
    expect(calls[0]!.values).toEqual(['2026-09-13 08:00:00.000']);
  });

  it('answers null when the history cannot be read, never zero', async () => {
    const { client } = fakeClient({ fail: true });
    expect(await loadHistoryReport(client, NOW)).toBeNull();
  });
});

describe('the /api/health warnings', () => {
  it('historyWarnings names each problem once', () => {
    expect(
      historyWarnings({ appUnattributedLastDay: 0, disabledTriggers: [], missingTriggers: [] })
    ).toEqual([]);
    expect(
      historyWarnings({
        appUnattributedLastDay: 1,
        disabledTriggers: ['branch_history_capture'],
        missingTriggers: ['x'],
      })
    ).toEqual(['history:unattributed', 'history:triggers-disabled', 'history:triggers-missing']);
  });

  it('only the runtime role’s rows of the last day warn; a hand-typed change does not', async () => {
    const day = '2026-10-13';
    const owner = fakeClient({
      rows: [
        { table_name: 'CustomerHistory', day, db_user: 'neondb_owner', n: 4n, sample_ids: [1n] },
      ],
    });
    expect(await loadHistoryHealth(owner.client, NOW)).toEqual([]);
    expect(owner.calls[0]!.values).toEqual(['2026-10-12 08:00:00.000']);
    const app = fakeClient({
      rows: [{ table_name: 'BranchHistory', day, db_user: RUNTIME_ROLE, n: 1n, sample_ids: [7n] }],
    });
    expect(await loadHistoryHealth(app.client, NOW)).toEqual(['history:unattributed']);
  });

  it('a disabled capture trigger and a missing guard are reported', async () => {
    const triggers = HISTORY_TRIGGERS.filter((t) => t !== 'branchhistory_insert_guard').map(
      (t) => ({
        tgname: t,
        tgenabled: t === 'customer_history_capture_upd' ? 'D' : 'O',
      })
    );
    const { client, calls } = fakeClient({ triggers });
    expect(await loadHistoryHealth(client, NOW)).toEqual([
      'history:triggers-disabled',
      'history:triggers-missing',
    ]);
    // Every trigger of the history foundation is asked about, by name.
    expect(calls[1]!.values).toEqual([...HISTORY_TRIGGERS]);
  });

  it('an unreadable history is a warning of its own, not a quiet pass', async () => {
    const { client } = fakeClient({ fail: true });
    expect(await loadHistoryHealth(client, NOW)).toEqual(['history:unreadable']);
  });

  it('the warnings are reported and never page', () => {
    const v = evaluateHealth({
      checks: { app: 'ok', db: 'ok', r2: 'ok', heartbeats: 'ok' },
      jobs: [],
      production: true,
      warnings: ['history:unattributed', 'history:triggers-disabled'],
    });
    expect(v).toMatchObject({
      status: 'warn',
      httpStatus: 200,
      warnings: ['history:unattributed', 'history:triggers-disabled'],
    });
  });

  it('the bearer probe asks for them only when the database answered, and hands them to the verdict', () => {
    const src = stripComments(readFileSync('app/api/health/route.ts', 'utf8'), 'route.ts');
    expect(src).toMatch(
      /const historyWarnings = checks\.db === 'ok' \? await loadHistoryHealth\(prisma\) : \[\];/
    );
    expect(src).toMatch(/evaluateHealth\(\{[^}]*warnings: historyWarnings,?\s*\}\)/);
  });
});
