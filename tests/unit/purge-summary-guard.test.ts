// @vitest-environment node
/**
 * Gap 25 (data audit 2026-10-10): no purge deletes evidence without a summary.
 *
 * A structural guard, because the defect is "a new delete that nobody routed
 * through the summary": outside lib/purge-summary.ts, nothing in app/, lib/ or
 * services/ deletes from RateLimit, Notification, CronRun, Attachment or
 * PasswordHistory, or empties an import row's payload. And each retention rule
 * is run by the job the rule names (lib/retention-rules.ts), so a rule cannot sit
 * in the list while nothing applies it.
 *
 * Operator scripts are outside it: their only such delete is app-role's verify
 * probe, inside a transaction it rolls back. Comments are stripped first
 * (CLAUDE.md).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import { RETENTION_RULES, RETENTION_RULE_IDS } from '@/lib/retention-rules';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name).replace(/\\/g, '/');
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const SOURCES = ['app', 'lib', 'services'].flatMap(files).filter((f) => f !== 'lib/purge-summary.ts');
const code = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a Prisma delete of a purged table', /\.(rateLimit|notification|cronRun|attachment|passwordHistory)\.(delete|deleteMany)\(/],
  ['a raw DELETE of a purged table', /DELETE\s+FROM\s+"(RateLimit|Notification|CronRun|Attachment|PasswordHistory)"/i],
  ['an import payload emptied', /"raw"\s*=\s*'\{\}'::jsonb/],
];

describe('every purge goes through lib/purge-summary.ts', () => {
  it('reads the tree it guards', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES).toContain('app/api/cron/retention-sweep/route.ts');
    expect(SOURCES).toContain('lib/password-policy.ts');
    // And the module it points at does what this guard forbids elsewhere.
    const purge = code('lib/purge-summary.ts');
    for (const [, re] of FORBIDDEN.slice(1)) expect(purge).toMatch(re);
  });

  it.each(FORBIDDEN)('nowhere else: %s', (_label, re) => {
    const hits = SOURCES.filter((f) => re.test(code(f)));
    expect(hits).toEqual([]);
  });
});

describe('every rule is applied by the job it names', () => {
  const RUNNERS: Record<string, string[]> = {
    'retention-sweep': ['app/api/cron/retention-sweep/route.ts', 'lib/job-run-day.ts'],
    'sla-escalate': ['app/api/cron/sla-escalate/route.ts'],
    'photo-gc': ['app/api/cron/photo-gc/route.ts'],
    'password-policy': ['lib/password-policy.ts'],
  };
  it.each(RETENTION_RULE_IDS)('%s', (id) => {
    const rule = RETENTION_RULES[id];
    const text = RUNNERS[rule.job]!.map(code).join('\n');
    expect(text, `${id} is never run`).toMatch(new RegExp(`runPurge\\([^,]+,\\s*'${id}'`));
  });

  it('the routes keep no period of their own', () => {
    for (const f of ['app/api/cron/retention-sweep/route.ts', 'app/api/cron/photo-gc/route.ts', 'app/api/cron/sla-escalate/route.ts']) {
      expect(code(f), f).not.toMatch(/_DAYS\s*=\s*\d+|GRACE_DAYS/);
    }
  });
});
