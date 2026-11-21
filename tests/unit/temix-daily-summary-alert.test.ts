/**
 * The daily Temix import, stage 2: the alert kind TEMIX_DAILY_SUMMARY, step one
 * of two (lib/temix-daily-policy.ts, lib/temix-daily-summary.ts).
 *
 *  - The enum value is added by an enum-only migration and is in the schema.
 *  - The inbox reads it: a label, a colour and a link to /temix-daily.
 *  - The writer is OFF: with the switch false it writes and reads nothing, and
 *    no source but the writer itself names the kind in a write. So an older
 *    build (the rollback target) never meets a row it cannot read.
 *  - When the switch is turned on (stage 7): one per active, non-test Steward
 *    per Oman day, counts only.
 *  - It is not an e-mailed kind.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Role } from '@prisma/client';
import { stripComments } from '../support/strip-comments';
import { TEMIX_DAILY_HREF, TEMIX_DAILY_SUMMARY_ENABLED } from '@/lib/temix-daily-policy';
import { notifyTemixDailySummary, summaryText } from '@/lib/temix-daily-summary';
import { hrefFor } from '@/lib/notification-links';
import { EMAIL_KINDS, MUST_ACT_KINDS } from '@/lib/notify-policy';

const MIGRATION = '20261114110000_notification_temix_daily_summary';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'node_modules' || e === '.next' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

/** A fake transaction that records every call. */
function fakeTx(opts: { stewards: string[]; already?: string[] }) {
  const calls: string[] = [];
  const created: Array<{ userId: string; kind: string; title: string; body: string }> = [];
  const tx = {
    user: {
      findMany: async (q: { where: Record<string, unknown> }) => {
        calls.push(`user.findMany ${JSON.stringify(q.where)}`);
        return opts.stewards.map((id) => ({ id }));
      },
    },
    notification: {
      findFirst: async (q: { where: { userId: string } }) => {
        calls.push('notification.findFirst');
        return opts.already?.includes(q.where.userId) ? { id: 'n0' } : null;
      },
      createMany: async (q: { data: typeof created }) => {
        calls.push('notification.createMany');
        created.push(...q.data);
        return { count: q.data.length };
      },
    },
    $executeRaw: async () => {
      calls.push('lock');
      return 0;
    },
  };
  return { tx: tx as never, calls, created };
}

describe('step one: the kind exists and is read', () => {
  it('an enum-only migration adds it, and the schema has it', () => {
    const sql = readFileSync(`prisma/migrations/${MIGRATION}/migration.sql`, 'utf8');
    const statements = sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual([`ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TEMIX_DAILY_SUMMARY'`]);
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const kinds = /enum NotificationKind \{([\s\S]*?)\}/.exec(schema)![1]!;
    expect(kinds).toMatch(/^\s*TEMIX_DAILY_SUMMARY\b/m);
  });

  it('the inbox labels it and links it to the daily file page, for the Steward', () => {
    expect(hrefFor({ kind: 'TEMIX_DAILY_SUMMARY', editId: null, customerId: null }, Role.STEWARD)).toBe('/temix-daily');
    expect(TEMIX_DAILY_HREF).toBe('/temix-daily');
    const list = readFileSync('app/(app)/notifications/NotificationList.tsx', 'utf8');
    expect(list).toMatch(/TEMIX_DAILY_SUMMARY: 'Temix daily'/);
    expect(list).toMatch(/TEMIX_DAILY_SUMMARY: 'bg-violet-50/);
  });

  it('is not e-mailed and asks nobody to act', () => {
    expect(EMAIL_KINDS as readonly string[]).not.toContain('TEMIX_DAILY_SUMMARY');
    expect(MUST_ACT_KINDS as readonly string[]).not.toContain('TEMIX_DAILY_SUMMARY');
  });
});

describe('the writer is off', () => {
  it('the switch ships false (turning it on is its own deploy: stage 7)', () => {
    expect(TEMIX_DAILY_SUMMARY_ENABLED).toBe(false);
  });

  it('switched off, it reads and writes nothing', async () => {
    const f = fakeTx({ stewards: ['stw-1'] });
    expect(await notifyTemixDailySummary(f.tx, { today: '2026-11-14', loadDay: '2026-11-14', counts: { ROUTE_MOVE: 2 } })).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it('no source but the writer writes the kind, and only finalize calls the writer, behind the switch', () => {
    const named: string[] = [];
    const callers: string[] = [];
    const READERS = new Set([
      'lib/temix-daily-summary.ts',
      'lib/notification-links.ts',
      'app/(app)/notifications/NotificationList.tsx',
    ]);
    for (const file of ['app', 'components', 'lib', 'services'].flatMap(walk)) {
      const code = stripComments(readFileSync(file, 'utf8'), file);
      if (/TEMIX_DAILY_SUMMARY\b(?!_ENABLED)/.test(code) && !READERS.has(file)) named.push(file);
      if (/\bnotifyTemixDailySummary\s*\(/.test(code) && file !== 'lib/temix-daily-summary.ts') callers.push(file);
    }
    expect(named).toEqual([]);
    // Stage 6: finalize calls it once per loaded file, inside the switch, so
    // while the switch is off not even its counts are read.
    expect(callers).toEqual(['services/temix-daily-apply.ts']);
    const apply = stripComments(readFileSync('services/temix-daily-apply.ts', 'utf8'), 'services/temix-daily-apply.ts');
    expect([...apply.matchAll(/\bnotifyTemixDailySummary\s*\(/g)]).toHaveLength(1);
    expect(apply).toMatch(
      /if \(TEMIX_DAILY_SUMMARY_ENABLED\) \{\s*const day = await loadDaySummaryInput\(tx, file\.loadDay\);\s*await notifyTemixDailySummary\(tx, \{ today: omanDateISO\(\), loadDay: file\.loadDay, counts: summaryCountsOf\(day\.changes, day\.heldRows\) \}\);\s*\}/
    );
  });
});

describe('when switched on (stage 7)', () => {
  it('one per active, non-test Steward per Oman day; a second file the same day sends none', async () => {
    vi.resetModules();
    vi.doMock('@/lib/temix-daily-policy', () => ({ TEMIX_DAILY_SUMMARY_ENABLED: true, TEMIX_DAILY_HREF: '/temix-daily' }));
    const on = await import('@/lib/temix-daily-summary');
    const f = fakeTx({ stewards: ['stw-1', 'stw-2'], already: ['stw-2'] });
    expect(await on.notifyTemixDailySummary(f.tx, { today: '2026-11-14', loadDay: '2026-11-14', counts: { ROUTE_MOVE: 2, HELD_ROWS: 1 } })).toBe(1);
    expect(f.calls[0]).toMatch(/"role":"STEWARD","isActive":true,"isTest":false/);
    expect(f.created).toEqual([
      {
        userId: 'stw-1',
        kind: 'TEMIX_DAILY_SUMMARY',
        title: 'Temix daily file for 2026-11-14: loaded',
        body: '2 shops moved to another route; 1 row held back. Open the Temix daily file page for the details.',
      },
    ]);
    // Each Steward is checked under his own lock.
    expect(f.calls.filter((c) => c === 'lock')).toHaveLength(2);
    vi.doUnmock('@/lib/temix-daily-policy');
    vi.resetModules();
  });

  it('counts only: the words are built from kinds and numbers, never a value', () => {
    expect(summaryText('2026-11-14', {})).toEqual({
      title: 'Temix daily file for 2026-11-14: loaded',
      body: 'No changes. Open the Temix daily file page for the details.',
    });
    // The counts are typed by ledger kind; anything else is not a key it reads.
    expect(summaryText('2026-11-14', { ['Customer 1' as never]: 3 }).body).toBe('No changes. Open the Temix daily file page for the details.');
  });

  it('a count of one reads in the singular, any other count in the plural', () => {
    expect(summaryText('2026-11-14', { CUSTOMER_CREATED: 1, SHOP_CREATED: 2, HELD_ROWS: 1, STATUS_DIFFERS: 1200 }).body).toBe(
      '1 customer created; 2 shops created; 1,200 status differences; 1 row held back. Open the Temix daily file page for the details.'
    );
  });
});
