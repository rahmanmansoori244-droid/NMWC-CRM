// @vitest-environment node
/**
 * Gap 25 (data audit 2026-10-10): every purge leaves a summary
 * (lib/purge-summary.ts, lib/retention-rules.ts).
 *
 *  - Each rule's statement is ONE statement that both removes (or empties) the
 *    batch and writes the PurgeSummary row, so neither can commit without the
 *    other; the row predicate is restated on the delete.
 *  - A run whose statement removed rows but wrote no summary (or the reverse)
 *    throws, inside the caller's transaction.
 *  - A summary counts by allowlisted categories only: never a rate-limit key, a
 *    person, a name or text.
 *  - The migration's CHECK constraint names exactly the rule ids.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import {
  PURGE_DETAIL_KEYS,
  PurgeSummaryMismatch,
  RATE_LIMIT_KINDS,
  checkPurgeOutcome,
  cronRunPurgeSql,
  importPayloadPurgeSql,
  passwordHistoryPurgeSql,
  photoPurgeSql,
  purgeRunId,
  rateLimitKind,
  rateLimitPurgeSql,
  readNotificationPurgeSql,
  runPurge,
  unreadNotificationPurgeSql,
} from '@/lib/purge-summary';
import { RETENTION_RULES, RETENTION_RULE_IDS, retentionCutoff, type RetentionRuleId } from '@/lib/retention-rules';

const NOW = new Date('2026-10-24T02:30:00.000Z');
const RUN = { runId: purgeRunId('retention-sweep', NOW) };

const STATEMENTS: Record<RetentionRuleId, Prisma.Sql> = {
  'rate-limit-1d': rateLimitPurgeSql(NOW, 500, RUN),
  'import-payload-90d': importPayloadPurgeSql(NOW, 2000, RUN),
  'notification-unread-180d': unreadNotificationPurgeSql(NOW, 500, RUN),
  'cron-run-90d': cronRunPurgeSql(retentionCutoff(RETENTION_RULES['cron-run-90d'], NOW), 2000, RUN),
  'notification-read-90d': readNotificationPurgeSql(NOW, 500, RUN),
  'photo-detached-30d': photoPurgeSql('att-1', NOW, RUN),
  'password-history-last-5': passwordHistoryPurgeSql('user-1', ['k1', 'k2', 'k3', 'k4', 'k5'], { runId: null }),
};

describe('one statement removes the batch and writes its summary', () => {
  it.each(RETENTION_RULE_IDS)('%s', (id) => {
    const rule = RETENTION_RULES[id];
    const { sql, values } = STATEMENTS[id];
    // One statement: a single WITH, no statement separator.
    expect(sql.trimStart().startsWith('WITH ')).toBe(true);
    expect(sql).not.toContain(';');
    expect(sql.match(/\bWITH\b/g)).toHaveLength(1);
    // The removal and the summary are both in it.
    if (rule.action === 'DELETE') expect(sql).toContain(`DELETE FROM "${rule.table}"`);
    else expect(sql).toMatch(new RegExp(`UPDATE "${rule.table}" x\\s+SET "raw" = '\\{\\}'::jsonb, "parsed" = NULL, "issues" = NULL, "corrections" = NULL`));
    expect(sql).toContain('INSERT INTO "PurgeSummary"');
    // An empty batch writes no summary; the outcome is read back to be checked.
    expect(sql).toMatch(/FROM gone\s+HAVING count\(\*\) > 0\s+RETURNING 1/);
    expect(sql).toContain('SELECT (SELECT count(*) FROM gone)::int AS "affected", (SELECT count(*) FROM s)::int AS "summarised"');
    // Its rule, table, action and date column are bound, as the CHECK constraints expect.
    for (const v of [rule.job, rule.id, rule.table, rule.action, rule.dateColumn]) expect(values).toContain(v);
    // Timestamps are explicit UTC, whatever the session's TimeZone.
    for (const m of sql.matchAll(/\?::timestamptz/g)) expect(sql.slice(m.index!, m.index! + 40)).toContain("AT TIME ZONE 'UTC'");
  });

  it('the row predicate is restated on the row removed, not only where the batch was chosen', () => {
    expect(STATEMENTS['rate-limit-1d'].sql).toMatch(/WHERE x\."key" = doomed\."key" AND x\."updatedAt" < /);
    expect(STATEMENTS['notification-unread-180d'].sql).toMatch(/x\."readAt" IS NULL AND x\."createdAt" < /);
    expect(STATEMENTS['notification-read-90d'].sql).toMatch(/x\."readAt" IS NOT NULL AND x\."readAt" < /);
    expect(STATEMENTS['photo-detached-30d'].sql).toMatch(/x\."deletedAt" IS NOT NULL AND x\."deletedAt" < /);
    const imp = STATEMENTS['import-payload-90d'].sql;
    const update = imp.slice(imp.indexOf('UPDATE "ImportRow"'));
    expect(update).toMatch(/x\."state" IN \('PROMOTED', 'REJECTED'\) OR \(x\."state" = 'QUARANTINED' AND x\."excludedAt" < /);
    expect(update).toContain(`xb."status" <> 'PROMOTING'`);
    expect(update).toContain(`x."raw" <> '{}'::jsonb OR x."parsed" IS NOT NULL`);
  });

  it('a photo is purged by its own id and only past the cut-off; a password prune keeps the newest five it was given', () => {
    expect(STATEMENTS['photo-detached-30d'].values[0]).toBe('att-1');
    const pw = STATEMENTS['password-history-last-5'];
    expect(pw.values.slice(0, 2)).toEqual(['user-1', ['k1', 'k2', 'k3', 'k4', 'k5']]);
    expect(pw.sql).toContain('NOT (x."id" = ANY(?::text[]))');
  });

  it('the periods are the rules’ own (unchanged), counted back from the run', () => {
    const iso = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    expect(STATEMENTS['rate-limit-1d'].values[0]).toBe(iso(1));
    expect(STATEMENTS['import-payload-90d'].values[0]).toBe(iso(90));
    expect(STATEMENTS['notification-unread-180d'].values[0]).toBe(iso(180));
    expect(STATEMENTS['notification-read-90d'].values[0]).toBe(iso(90));
    expect(STATEMENTS['photo-detached-30d'].values[1]).toBe(iso(30));
    expect(STATEMENTS['cron-run-90d'].values[0]).toBe(iso(90));
  });
});

describe('a removal without its summary is refused', () => {
  it('checkPurgeOutcome: one summary for a batch that removed rows, none for an empty one', () => {
    expect(checkPurgeOutcome('rate-limit-1d', { affected: 0, summarised: 0 })).toBe(0);
    expect(checkPurgeOutcome('rate-limit-1d', { affected: 7, summarised: 1 })).toBe(7);
    expect(() => checkPurgeOutcome('rate-limit-1d', { affected: 7, summarised: 0 })).toThrow(PurgeSummaryMismatch);
    expect(() => checkPurgeOutcome('rate-limit-1d', { affected: 0, summarised: 1 })).toThrow(PurgeSummaryMismatch);
    expect(() => checkPurgeOutcome('rate-limit-1d', { affected: 3, summarised: 2 })).toThrow(/3 row\(s\) removed but 2 summary/);
  });

  it('runPurge sends the statement once and reads the outcome, bigints included', async () => {
    const sent: Prisma.Sql[] = [];
    const db = { $queryRaw: async (q: Prisma.Sql) => (sent.push(q), [{ affected: 12n, summarised: 1n }]) };
    expect(await runPurge(db as never, 'cron-run-90d', STATEMENTS['cron-run-90d'])).toBe(12);
    expect(sent).toEqual([STATEMENTS['cron-run-90d']]);
    const broken = { $queryRaw: async () => [{ affected: 12, summarised: 0 }] };
    await expect(runPurge(broken as never, 'cron-run-90d', STATEMENTS['cron-run-90d'])).rejects.toThrow(PurgeSummaryMismatch);
  });
});

describe('a summary holds counts by category, never a value', () => {
  /** The top-level keys of the summary's detail object. */
  function detailKeys(sql: string): string[] {
    const ins = sql.slice(sql.indexOf('INSERT INTO "PurgeSummary"'));
    const start = ins.indexOf('jsonb_build_object(');
    if (start < 0) return [];
    // Top-level 'key', pairs only: track the parenthesis depth from the call.
    const keys: string[] = [];
    let depth = 0;
    for (let i = start + 'jsonb_build_object'.length; i < ins.length; i++) {
      const ch = ins[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1 && ch === "'") {
        const end = ins.indexOf("'", i + 1);
        const prev = ins.slice(0, i).trimEnd();
        if (prev.endsWith('(') || prev.endsWith(',')) keys.push(ins.slice(i + 1, end));
        i = end;
      }
    }
    return keys;
  }

  it.each(RETENTION_RULE_IDS)('%s: only its allowlisted detail keys', (id) => {
    const keys = detailKeys(STATEMENTS[id].sql);
    expect(keys.sort()).toEqual([...PURGE_DETAIL_KEYS[RETENTION_RULES[id].table]].sort());
  });

  it('a rate-limit bucket is counted by its kind, never by its key', () => {
    expect(rateLimitKind('login:user:alice')).toBe('login:user');
    expect(rateLimitKind('login:ip:10.0.0.1')).toBe('login:ip');
    expect(rateLimitKind('passwordreset:bob')).toBe('passwordreset');
    expect(rateLimitKind('edit:u1')).toBe('other');
    for (const k of ['login:user:x', 'login:ip:y', 'passwordreset:z', 'import:u']) {
      expect(RATE_LIMIT_KINDS).toContain(rateLimitKind(k));
    }
    const sql = STATEMENTS['rate-limit-1d'].sql;
    const returning = sql.slice(sql.indexOf('RETURNING'), sql.indexOf('), s AS ('));
    // The key is read only to classify it: the CASE yields the four kinds and nothing else.
    expect(returning).not.toMatch(/x\."key" AS|, x\."key"\s*$/m);
    const yielded = [...returning.matchAll(/THEN '([^']+)'|ELSE '([^']+)'/g)].map((m) => m[1] ?? m[2]);
    expect(yielded.sort()).toEqual([...RATE_LIMIT_KINDS].sort());
  });

  it('a notification summary counts by Oman month, kind and e-mail outcome, from the row’s own columns', () => {
    for (const id of ['notification-unread-180d', 'notification-read-90d'] as const) {
      const sql = STATEMENTS[id].sql;
      expect(sql).toContain(`x."createdAt" AS created, x."kind"::text AS kind, x."emailStatus" AS status`);
      expect(sql).toContain(`to_char((gone.created AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Muscat', 'YYYY-MM')`);
      expect(sql).not.toMatch(/"title"|"body"|"userId"/);
    }
  });

  it('no summary reads a personal column', () => {
    for (const id of RETENTION_RULE_IDS) {
      expect(STATEMENTS[id].sql, id).not.toMatch(/"hash"|"title"|"body"|"r2Key"|"capturedLat"|"capturedLng"|"userId" AS|"raw" AS|"parsed" AS/);
    }
  });
});

describe('the migration agrees', () => {
  const sql = readFileSync('prisma/migrations/20261024120100_purge_summaries/migration.sql', 'utf8').replace(/--[^\n]*/g, '');
  const list = (name: string) => {
    const at = sql.indexOf(name);
    expect(at, name).toBeGreaterThan(-1);
    const text = sql.slice(at, sql.indexOf(';', at));
    return [...text.slice(text.indexOf(' IN (')).matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
  };

  it('the CHECK constraints name exactly the rule ids and actions', () => {
    expect(list('"PurgeSummary_rule_check"')).toEqual([...RETENTION_RULE_IDS].sort());
    expect(list('"PurgeSummary_action_check"')).toEqual(['CLEAR_PAYLOAD', 'DELETE']);
    expect(sql).toContain('CHECK ("rows" > 0)');
  });

  it('a ledger: stamped, append-only, insert-only for the runtime role', () => {
    expect(sql).toContain('CREATE TRIGGER purgesummary_stamp_context');
    expect(sql).toContain('EXECUTE FUNCTION nmwc_auditlog_stamp_context()');
    expect(sql).toContain(
      'CREATE TRIGGER purgesummary_append_only BEFORE UPDATE OR DELETE ON "PurgeSummary" FOR EACH ROW EXECUTE FUNCTION nmwc_forbid_audit_mutation()'
    );
    expect(sql).toContain('GRANT SELECT, INSERT ON "PurgeSummary" TO nmwc_app');
    expect(sql).toContain('GRANT USAGE, SELECT ON SEQUENCE "PurgeSummary_id_seq" TO nmwc_app');
    expect(sql).toContain('REVOKE UPDATE ON SEQUENCE "PurgeSummary_id_seq" FROM nmwc_app');
  });
});
