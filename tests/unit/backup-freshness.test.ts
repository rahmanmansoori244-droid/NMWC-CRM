// @vitest-environment node
/**
 * Code review 2026-11-10, finding 14 (second half): after a restore to a new host
 * the nightly backup kept dumping the OLD database — the GitHub DIRECT_URL secret
 * still pointed there — and reported "backup ok", every light green.
 *
 * The manifest now records the newest write (the newest audit row or scheduled-job
 * heartbeat) and how long ago it was (scripts/ops/backup-manifest.sql), and
 * scripts/ops/backup-freshness.sh decides: a SCHEDULED run fails, with a plain
 * message, when that is more than a day old; a run by hand only warns. The app's
 * own scheduled jobs write heartbeats to the database it uses many times a day
 * even when nobody signs in, so a quiet database (before launch) is not a stale
 * one. Executed here under bash; the SQL ran on a throwaway Postgres 17 while
 * this was written, and CI's restore chain runs the manifest query on every push.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { resolveBash, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';

const HOUR = 3600;

function freshness(seconds: string, event: string) {
  const { bash, extraPath } = resolveBash();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.PATH = extraPath ? `${extraPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` : process.env.PATH;
  const r = spawnSync(bash, ['scripts/ops/backup-freshness.sh', seconds, event], { env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('the rule (scripts/ops/backup-freshness.sh)', () => {
  it.each([
    ['a few hours (a live database, nobody signed in)', 3 * HOUR],
    ['11 hours (the oldest a live database gets at a 02:00 UTC backup)', 11 * HOUR],
    ['exactly a day', 24 * HOUR],
    ['a clock a little ahead of the database', -30],
  ])('fresh — %s — passes on the nightly run and says so', (_label, s) => {
    const r = freshness(String(s), 'schedule');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/::notice::the newest record in this database is \d+ h old/);
  }, STEP_TEST_TIMEOUT_MS);

  it.each([
    ['a day and a second', 24 * HOUR + 1],
    ['50 hours (the old host, two nights after a restore)', 50 * HOUR],
  ])('stale — %s — fails the nightly run, in plain words', (_label, s) => {
    const r = freshness(String(s), 'schedule');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::The newest record in the database this backup dumped is \d+ hours old/);
    expect(r.out).toMatch(/the OLD host after a restore/);
    expect(r.out).toMatch(/GitHub DIRECT_URL secret and the first line of config\/production-hosts\.txt/);
  }, STEP_TEST_TIMEOUT_MS);

  it('stale on a run by hand only warns (the runbook step reads the age right after a restore)', () => {
    const r = freshness(String(50 * HOUR), 'workflow_dispatch');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/::warning::The newest record/);
    expect(r.out).toMatch(/newest record in the dumped database: 50 h ago/);
  }, STEP_TEST_TIMEOUT_MS);

  it.each([['no value', ''], ['not a number', 'null']])('%s: the nightly run fails (it cannot show the database is live); by hand it warns', (_label, v) => {
    const nightly = freshness(v, 'schedule');
    expect(nightly.status).toBe(1);
    expect(nightly.out).toMatch(/::error::The backup could not tell how old the newest record/);
    const byHand = freshness(v, 'workflow_dispatch');
    expect(byHand.status).toBe(0);
    expect(byHand.out).toMatch(/::warning::/);
  }, STEP_TEST_TIMEOUT_MS);

  it('the limit is one named number: a day', () => {
    expect(readFileSync('scripts/ops/backup-freshness.sh', 'utf8')).toMatch(/^MAX_QUIET_HOURS=24$/m);
  });
});

describe('the manifest records it (scripts/ops/backup-manifest.sql)', () => {
  const sql = readFileSync('scripts/ops/backup-manifest.sql', 'utf8');
  it('the newest audit row, the newest heartbeat, the newer of the two, and its age in seconds', () => {
    expect(sql).toMatch(/'newestAuditAt'/);
    expect(sql).toMatch(/'newestHeartbeatAt', \(SELECT to_char\(max\("lastRunAt"\)/);
    expect(sql).toMatch(/'newestWriteAt', \(SELECT to_char\(greatest\(\(SELECT max\("at"\) FROM "AuditLog"\), \(SELECT max\("lastRunAt"\) FROM "CronHeartbeat"\)\)/);
    // Against now() in UTC: the columns hold UTC without a zone, whatever the session's zone.
    expect(sql).toMatch(/'secondsSinceNewestWrite', \(SELECT floor\(extract\(epoch FROM \(now\(\) AT TIME ZONE 'UTC'\) - greatest\(/);
  });
});

describe('the backup job runs it (.github/workflows/db-backup.yml)', () => {
  type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };
  const wf = load(readFileSync('.github/workflows/db-backup.yml', 'utf8')) as { jobs: { backup: { steps: Step[] } } };
  const steps = wf.jobs.backup.steps;
  const at = (prefix: string) => steps.findIndex((s) => (s.name ?? '').startsWith(prefix));
  const check = steps[at('Is this the database the app writes to?')];

  it('after the upload (nothing is lost) and before the dead-man report (which then says it failed)', () => {
    expect(at('Is this the database the app writes to?')).toBeGreaterThan(at('Upload to R2'));
    expect(at('Is this the database the app writes to?')).toBeLessThan(at('Report the outcome to the app'));
    expect(check?.if, 'skipped when an earlier step failed: that run is red already').toBeUndefined();
  });

  it('hands the script the age from the manifest and the event that started the run', () => {
    expect(check?.env?.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(check?.run).toContain(`jq -r '.secondsSinceNewestWrite // empty' "\${STAMP}.manifest.json"`);
    expect(check?.run).toContain('bash scripts/ops/backup-freshness.sh "$SINCE" "$EVENT_NAME"');
  });

  it('the nightly trigger is the schedule the rule fails on', () => {
    const raw = readFileSync('.github/workflows/db-backup.yml', 'utf8');
    expect(raw).toMatch(/\n {2}schedule:\n/);
    expect(raw).toMatch(/\n {2}workflow_dispatch:\n/);
  });

  it('the run summary shows the newest record', () => {
    expect(steps[at('Summary')]?.run).toContain('newest record in the dumped database (UTC): ${NEWEST_WRITE_AT:-unknown}');
  });
});
