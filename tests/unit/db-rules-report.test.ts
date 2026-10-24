// @vitest-environment node
/**
 * Gap 31: scripts/ops/db-rules-report.ts, the operator's count before the rules
 * merge and before any VALIDATE. It prints rule names, counts and states only —
 * never an id — reads inside a READ ONLY transaction with a statement timeout,
 * and names its database first (the production guard covers it: see
 * tests/unit/scripts-production-guard.test.ts, which reads every script).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AWAITING_MARK_LOADED_SQL,
  TEMIX_QUEUE_SQL,
  reportLines,
  temixPathCountSql,
  temixPathLines,
} from '../../scripts/ops/db-rules-report';
import { DB_RULES, brokenChecks, checkColumnsOf, checkRulesOf } from '@/lib/db-rules';
import { stripComments } from '../support/strip-comments';

describe('db-rules-report', () => {
  it('one line per rule: its count and whether it is there and validated; which are ready', () => {
    const [a, b, c] = DB_RULES as [(typeof DB_RULES)[0], (typeof DB_RULES)[0], (typeof DB_RULES)[0]];
    const r = reportLines(
      [
        { rule: a.name, n: 3 },
        { rule: b.name, n: 0 },
      ],
      [
        { name: a.name, validated: false },
        { name: b.name, validated: false },
        { name: c.name, validated: true },
      ]
    );
    expect(r.lines).toHaveLength(DB_RULES.length);
    expect(r.lines[0]).toMatch(new RegExp(`${a.name}\\s+\\w+\\s+3\\s+not valid$`));
    expect(r.lines[1]).toMatch(/\s0\s+not valid$/);
    expect(r.lines[2]).toMatch(/\s0\s+validated$/);
    expect(r.lines[3]).toMatch(/MISSING$/);
    expect(r.violations).toBe(3);
    expect(r.missing).toBe(DB_RULES.length - 3);
    expect(r.ready).toEqual([b.name]);
  });

  it('reads only, under a timeout, and prints no id', () => {
    const src = stripComments(readFileSync('scripts/ops/db-rules-report.ts', 'utf8'), 'db-rules-report.ts');
    expect(src).toContain("SET TRANSACTION READ ONLY");
    expect(src).toMatch(/SET LOCAL statement_timeout/);
    expect(src).toContain('requireExpectedHost(args, url, host)');
    expect(src).toContain('new PrismaClient({ datasourceUrl: url })');
    // The count query takes no samples (0), and only rule and n are selected.
    expect(src).toContain('dbRulesCountSql(DB_RULES, 0)');
    expect(src).toContain('SELECT x.rule, x.n FROM');
    expect(src).not.toMatch(/\b(INSERT INTO|UPDATE "|DELETE FROM|TRUNCATE|ALTER TABLE|VALIDATE CONSTRAINT)\b/);
  });
});

/**
 * Review of gap 31 (2026-10-25): one row that breaks a CHECK fails a whole
 * multi-row statement, so the Customer rules are also counted where the Temix
 * batch paths write many customers at once, and a batch writer can test its
 * rows first (lib/db-rules.ts brokenChecks; services/temix.ts).
 */
describe('the Temix batch paths', () => {
  const customerChecks = DB_RULES.filter((r) => r.kind === 'check' && r.table === 'Customer').map((r) => r.name);

  it('checkRulesOf / checkColumnsOf / brokenChecks: the Customer CHECKs, the columns they read, the ones a row breaks', () => {
    expect(checkRulesOf('Customer').map((r) => r.name)).toEqual(customerChecks);
    expect(customerChecks).toEqual([
      'Customer_credit_terms_only_credit',
      'Customer_subChannel_needs_channel',
      'Customer_primaryPhoneNorm_shape',
      'Customer_crNumberNorm_shape',
    ]);
    expect(checkColumnsOf('Customer').sort()).toEqual(
      ['channelId', 'creditLimit', 'crNumberNorm', 'paymentTermDays', 'paymentTerms', 'primaryPhoneNorm', 'subChannelId'].sort()
    );
    const ok = { paymentTerms: 'CASH', creditLimit: null, paymentTermDays: null, subChannelId: null, channelId: null, primaryPhoneNorm: null, crNumberNorm: null };
    expect(brokenChecks('Customer', ok)).toEqual([]);
    expect(brokenChecks('Customer', { ...ok, creditLimit: 5, crNumberNorm: 'cr 1' }).map((r) => r.name)).toEqual([
      'Customer_credit_terms_only_credit',
      'Customer_crNumberNorm_shape',
    ]);
    expect(brokenChecks('Customer', { ...ok, paymentTerms: 'CREDIT', creditLimit: 5, paymentTermDays: 30 })).toEqual([]);
    // Only CHECKs: a foreign key is checked when its own columns change, which no batch write does.
    expect(checkRulesOf('Customer').every((r) => r.kind === 'check')).toBe(true);
  });

  it('counts, per Customer CHECK, the queued rows and the rows awaiting Mark loaded, in one read', () => {
    const sql = temixPathCountSql();
    expect(sql.split('UNION ALL')).toHaveLength(customerChecks.length);
    for (const r of checkRulesOf('Customer')) {
      expect(sql).toContain(`'${r.name}'::text AS rule`);
      expect(sql).toContain(`NOT COALESCE((${r.sql}), TRUE)`);
    }
    expect(sql).not.toMatch(/\b(INSERT INTO|UPDATE "|DELETE FROM|TRUNCATE|ALTER TABLE|VALIDATE CONSTRAINT)\b/);
    expect(AWAITING_MARK_LOADED_SQL).toContain(`b."markedLoadedAt" IS NULL`);
  });

  it('the queue is the one Generate locks (lib/locks.ts lockTemixQueue, pinned to TEMIX_QUEUE_WHERE elsewhere)', () => {
    const locks = stripComments(readFileSync('lib/locks.ts', 'utf8'), 'locks.ts');
    const lockTemixQueue = locks.slice(locks.indexOf('export async function lockTemixQueue'));
    const lockPredicate = /FROM "Customer" WHERE (.+?) ORDER BY "id"/.exec(lockTemixQueue)?.[1];
    expect(lockPredicate).toBeTruthy();
    expect(TEMIX_QUEUE_SQL.replace(/\bt\./g, '')).toBe(lockPredicate);
  });

  it('one line per Customer CHECK, with both counts and their totals', () => {
    const [a, b] = customerChecks as [string, string];
    const t = temixPathLines([
      { rule: a, queued: 2, settling: 0 },
      { rule: b, queued: 0, settling: 1 },
    ]);
    expect(t.lines).toHaveLength(customerChecks.length);
    expect(t.lines[0]).toMatch(new RegExp(`${a}\\s+2\\s+0$`));
    expect(t.lines[1]).toMatch(new RegExp(`${b}\\s+0\\s+1$`));
    expect(t.lines[2]).toMatch(/\s0\s+0$/);
    expect(t).toMatchObject({ queued: 2, settling: 1 });
  });

  it('the script reads the Temix-path count in the same READ ONLY transaction, and prints the precondition', () => {
    const src = stripComments(readFileSync('scripts/ops/db-rules-report.ts', 'utf8'), 'db-rules-report.ts');
    expect(src).toContain('SELECT x.rule, x.queued, x.settling FROM (${Prisma.raw(temixPathCountSql())}) x');
    expect(src).toContain('DEPLOY PRECONDITION');
  });
});
