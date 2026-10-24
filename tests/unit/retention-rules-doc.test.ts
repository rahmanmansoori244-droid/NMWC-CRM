// @vitest-environment node
/**
 * Gap 25 (data audit 2026-10-10): lib/retention-rules.ts is the single source of
 * the clean-up periods, and it says what docs/compliance/DATA-RETENTION-SCHEDULE.md
 * says. The periods were not changed by the purge summaries (the owner accepted
 * them on 11 October 2026, and the schedule says so); this holds every rule to
 * the schedule row that names it, and the routes to the list, so neither can
 * drift on its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RETENTION_RULES, RETENTION_RULE_IDS, type RetentionRuleId } from '@/lib/retention-rules';
import { IMPORT_PAYLOAD_DAYS } from '@/lib/import-row-fix';

const doc = readFileSync('docs/compliance/DATA-RETENTION-SCHEDULE.md', 'utf8');
const schedule = doc.slice(doc.indexOf('## Schedule'), doc.indexOf('\n## ', doc.indexOf('## Schedule') + 5));
const rows = schedule
  .split('\n')
  .filter((l) => l.startsWith('| ') && !l.startsWith('| Data |'))
  .map((l) => l.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim()));

/** How the schedule words each period. */
const WORDED: Record<RetentionRuleId, string> = {
  'rate-limit-1d': '1 day',
  'import-payload-90d': '90 days',
  'notification-unread-180d': '180 days',
  'cron-run-90d': '90 days',
  'notification-read-90d': '90 days',
  'photo-detached-30d': '30 days',
  'password-history-last-5': 'Last 5',
};

describe('the schedule’s status', () => {
  it('is the accepted one (owner, 11 October 2026), no longer a draft', () => {
    const status = doc.split('\n').find((l) => l.startsWith('**Status:'));
    expect(status).toMatch(/^\*\*Status: Accepted by the owner on 11 October 2026\.\*\*/);
    expect(status).not.toMatch(/DRAFT/);
  });
});

describe('the schedule names every rule, with the rule’s own period', () => {
  it('has a Summary kept column on every row', () => {
    expect(schedule).toContain('| Data | Kept for | Enforced by | Proven by | Summary kept (gap 25) |');
    expect(rows.length).toBeGreaterThan(15);
    for (const r of rows) expect(r.length, r[0]).toBe(5);
  });

  it.each(RETENTION_RULE_IDS)('%s', (id) => {
    const named = rows.filter((r) => r[4] === `\`${id}\``);
    expect(named, `one schedule row names ${id} as its summary`).toHaveLength(1);
    const [row] = named;
    expect(row![1]).toContain(WORDED[id]);
    const rule = RETENTION_RULES[id];
    if (rule.days !== null) expect(WORDED[id]).toBe(rule.days === 1 ? '1 day' : `${rule.days} days`);
    else expect(WORDED[id]).toBe(`Last ${rule.keep}`);
    // The job named in "Enforced by" is the one the rule says runs it.
    const where = row![2];
    const expected = {
      'retention-sweep': 'retention-sweep',
      'sla-escalate': 'sla-escalate',
      'photo-gc': 'photo-gc',
      'password-policy': 'password-policy',
    }[rule.job];
    expect(where).toContain(expected);
  });

  it('no row names a rule the list does not have', () => {
    const named = new Set(rows.flatMap((r) => [...r[4]!.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]!)));
    for (const id of named) expect(RETENTION_RULE_IDS as string[]).toContain(id);
  });
});

describe('the code reads the list', () => {
  it('the Steward’s in-app import fix closes at the same 90 days the sweep clears at', () => {
    expect(RETENTION_RULES['import-payload-90d'].days).toBe(IMPORT_PAYLOAD_DAYS);
  });

  it('the routes and the password policy take their periods from it', () => {
    const read = (f: string) => readFileSync(f, 'utf8');
    expect(read('app/api/cron/retention-sweep/route.ts')).toMatch(/from '@\/lib\/retention-rules'/);
    expect(read('app/api/cron/photo-gc/route.ts')).toMatch(/retentionCutoff\(RETENTION_RULES\['photo-detached-30d'\]/);
    expect(read('lib/password-policy.ts')).toMatch(/RETENTION_RULES\['password-history-last-5'\]\.keep/);
    expect(read('lib/purge-summary.ts')).toMatch(/RETENTION_RULES\['notification-read-90d'\]/);
  });
});
