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
import { reportLines } from '../../scripts/ops/db-rules-report';
import { DB_RULES } from '@/lib/db-rules';
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
