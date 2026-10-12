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
  appLoginRole,
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
  /** The login the client connects as (session_user); the runtime role by default. */
  login?: string;
  fail?: boolean;
}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const $queryRaw = vi.fn(async (q: Prisma.Sql) => {
    calls.push({ sql: q.sql, values: q.values });
    if (opts.fail) throw new Error('function nmwc_history_unattributed(timestamp) does not exist');
    if (q.sql.includes('nmwc_history_unattributed')) return opts.rows ?? [];
    if (q.sql.includes('pg_trigger'))
      return opts.triggers ?? HISTORY_TRIGGERS.map((t) => ({ tgname: t, tgenabled: 'O' }));
    if (q.sql.includes('session_user')) return [{ role: opts.login ?? RUNTIME_ROLE }];
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
    expect(r.appRole).toBe(RUNTIME_ROLE);
  });

  it('while the application connects as the owner, the owner’s rows are the application’s (they cannot be told apart)', () => {
    const r = summarize(
      NOW,
      [
        { table: 'BranchHistory', day: '2026-10-12', dbUser: 'neondb_owner', n: 2, sampleIds: ['1'] },
        { table: 'AuthEvent', day: '2026-10-12', dbUser: 'neondb_owner', n: 1, sampleIds: ['5'] },
        { table: 'CustomerHistory', day: '2026-10-12', dbUser: 'someone_else', n: 4, sampleIds: ['9'] },
      ],
      'neondb_owner'
    );
    expect(r).toMatchObject({ appRole: 'neondb_owner', fromApp: 3, fromOther: 4 });
  });
});

describe('appLoginRole', () => {
  it('reads the login the client connects as', async () => {
    const { client, calls } = fakeClient({ login: 'neondb_owner' });
    expect(await appLoginRole(client)).toBe('neondb_owner');
    expect(calls[0]!.sql).toContain('session_user');
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
      appRole: RUNTIME_ROLE,
      fromApp: 0,
      fromOther: 0,
    });
    expect(calls[0]!.values).toEqual(['2026-09-13 08:00:00.000']);
  });

  it('splits by the login the application itself connects as', async () => {
    const day = '2026-10-12';
    const { client } = fakeClient({
      login: 'neondb_owner',
      rows: [{ table_name: 'UserHistory', day, db_user: 'neondb_owner', n: 2n, sample_ids: [3n, 4n] }],
    });
    expect(await loadHistoryReport(client, NOW)).toMatchObject({ appRole: 'neondb_owner', fromApp: 2, fromOther: 0 });
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

  it('while production still connects as the owner, the owner’s rows warn: the safety net is not off there', async () => {
    const day = '2026-10-13';
    const rows = [{ table_name: 'AuthEvent', day, db_user: 'neondb_owner', n: 1n, sample_ids: [2n] }];
    // The application's own probe, connected as the owner.
    expect(await loadHistoryHealth(fakeClient({ login: 'neondb_owner', rows }).client, NOW)).toEqual(['history:unattributed']);
    // An operator script, connected as the owner, says which login the application is.
    expect(await loadHistoryHealth(fakeClient({ login: 'neondb_owner', rows }).client, NOW, RUNTIME_ROLE)).toEqual([]);
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
