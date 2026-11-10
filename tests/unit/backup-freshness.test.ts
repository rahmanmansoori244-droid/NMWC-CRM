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
import { resolveBash, runScriptOf, runStep, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';

const HOUR = 3600;

function freshness(seconds: string, event: string, from?: string) {
  const { bash, extraPath } = resolveBash();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.PATH = extraPath ? `${extraPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` : process.env.PATH;
  const r = spawnSync(bash, ['scripts/ops/backup-freshness.sh', seconds, event, ...(from === undefined ? [] : [from])], { env, encoding: 'utf8', timeout: 60_000 });
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
    // Third round: the script cannot know when the caller measured the age, so
    // without being told it claims neither "when checked" nor "the dumped database".
    expect(r.out).toMatch(/newest record in this database: 50 h ago/);
    expect(r.out).not.toMatch(/when checked/);
    expect(r.out).not.toMatch(/dumped database/);
  }, STEP_TEST_TIMEOUT_MS);

  it.each([
    ['checked after the upload'],
    ['from the manifest, taken before the dump'],
  ])('the age line repeats where the caller says the value came from — %s', (from) => {
    const r = freshness(String(3 * HOUR), 'schedule', from);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`newest record in this database (${from}): 3 h ago (limit 24 h)`);
    expect(r.out).not.toMatch(/when checked/);
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

  it('hands the script the age from its own query (the manifest as the fallback) and the event that started the run', () => {
    expect(check?.env?.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(check?.run).toContain('-f scripts/ops/backup-newest-write.sql');
    expect(check?.run).toContain(`jq -r '.secondsSinceNewestWrite // empty' "\${STAMP}.manifest.json"`);
    expect(check?.run).toContain('bash scripts/ops/backup-freshness.sh "$SINCE" "$EVENT_NAME"');
    // ...and where the age came from, so a manifest (pre-dump) value is not printed
    // as one read after the upload.
    expect(check?.run).toContain('bash scripts/ops/backup-freshness.sh "$SINCE" "$EVENT_NAME" "${FROM:-not known}"');
  });

  it('the nightly trigger is the schedule the rule fails on', () => {
    const raw = readFileSync('.github/workflows/db-backup.yml', 'utf8');
    expect(raw).toMatch(/\n {2}schedule:\n/);
    expect(raw).toMatch(/\n {2}workflow_dispatch:\n/);
  });

  it('the run summary shows the newest record, labelled by when it was measured (third round)', () => {
    const summary = steps[at('Summary')]?.run ?? '';
    expect(summary).toContain('newest record in this database (UTC, ${NEWEST_WRITE_FROM:-not known}): ${NEWEST_WRITE_AT:-unknown}');
    expect(summary).toContain('newest record before the dump (UTC, from the manifest; the backup holds at least this): ${BEFORE:-unknown}');
    expect(summary).toContain(`jq -r '.newestWriteAt // empty' "\${STAMP}.manifest.json"`);
    // The value the check measures after the upload is never called what the dump holds.
    expect(summary).not.toContain('newest record in the dumped database');
  });
});

/**
 * Second round (code review 2026-11-10, finding 14 minor finding): a manifest query
 * that failed said "continuing without row counts", and then the freshness check
 * found no age and failed every scheduled run — one failed count turned a backup
 * that had been taken and uploaded red. The age now comes from its own small
 * query (scripts/ops/backup-newest-write.sql), the manifest is the fallback, and a
 * database the app no longer writes to still fails loudly. The step is executed
 * here under bash, with psql and jq stubbed; the SQL itself ran on a throwaway
 * Postgres 17 while this was written, and CI's restore chain runs it on every push.
 */
describe('second round: a failed manifest no longer fails a backup that was taken', () => {
  const raw = readFileSync('.github/workflows/db-backup.yml', 'utf8');
  const repo = process.cwd().replace(/\\/g, '/');
  const script = runScriptOf(raw, 'Is this the database the app writes to? (newest record within a day)')
    // The runner's absolute psql path, as a name the stub can stand in for.
    .split('/usr/lib/postgresql/17/bin/psql')
    .join('psql')
    .split('bash scripts/ops/backup-freshness.sh')
    .join(`bash "${repo}/scripts/ops/backup-freshness.sh"`);
  // psql: prints PSQL_OUT, or fails as a broken connection would. jq: reads one
  // top-level field the way the step asks for it (`jq -r '.f // empty' file`).
  const stubs = [
    // What the step hands later steps, printed when it ends (pass or fail).
    `export GITHUB_ENV="$STUB_DIR/github_env"; trap 'cat "$GITHUB_ENV" 2>/dev/null || true' EXIT`,
    'psql() { echo "psql $*" >> "$STUB_DIR/calls"; if [ "${PSQL_FAIL:-}" = 1 ]; then echo "psql: error: connection refused" >&2; return 2; fi; printf "%s\\n" "$PSQL_OUT"; }',
    `jq() { local f="\${2#.}"; f="\${f%% *}"; node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=d[process.argv[2]];if(v!=null)console.log(String(v))' "$3" "$f"; }`,
  ].join('\n');
  const STAMP = 'nmwc-2026-11-11T02-00-00Z';
  const manifest = (seconds: number) =>
    JSON.stringify({ secondsSinceNewestWrite: seconds, newestWriteAt: '2026-11-10T23:00:00.000Z' });
  const run = (event: string, env: Record<string, string>, files: Record<string, string> = {}) =>
    runStep(script, stubs, { STAMP, EVENT_NAME: event, PGURL: 'postgresql://u@db.invalid/neondb', ...env }, files);

  it('the step script was found and rewritten for the stubs', () => {
    expect(script).toContain('psql "$PGURL" -At -v ON_ERROR_STOP=1 -f scripts/ops/backup-newest-write.sql');
    expect(script).toContain(`${repo}/scripts/ops/backup-freshness.sh`);
  });

  it('the manifest failed (no file), the database is live: the nightly run stays green, from its own query', () => {
    const r = run('schedule', { PSQL_OUT: `${3 * HOUR}|2026-11-10T23:00:00.000Z` });
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toEqual(['psql postgresql://u@db.invalid/neondb -At -v ON_ERROR_STOP=1 -f scripts/ops/backup-newest-write.sql']);
    expect(r.output).toContain('NEWEST_WRITE_AT=2026-11-10T23:00:00.000Z');
    expect(r.output).toContain('NEWEST_WRITE_FROM=checked after the upload');
    expect(r.output).toMatch(/::notice::the newest record in this database is 3 h old/);
  }, STEP_TEST_TIMEOUT_MS);

  it('the database the app no longer writes to still fails the nightly run loudly, manifest or not', () => {
    const r = run('schedule', { PSQL_OUT: `${50 * HOUR}|2026-11-09T00:00:00.000Z` });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/::error::The newest record in the database this backup dumped is 50 hours old/);
    const withManifest = run(
      'schedule',
      { PSQL_OUT: `${50 * HOUR}|2026-11-09T00:00:00.000Z` },
      { [`${STAMP}.manifest.json`]: manifest(HOUR) }
    );
    expect(withManifest.status, 'the live query wins over a fresher-looking manifest').toBe(1);
  }, STEP_TEST_TIMEOUT_MS);

  it('the query fails but the manifest has the age: that is used, with a warning', () => {
    const fresh = run('schedule', { PSQL_FAIL: '1' }, { [`${STAMP}.manifest.json`]: manifest(2 * HOUR) });
    expect(fresh.status, fresh.output).toBe(0);
    expect(fresh.output).toMatch(/::warning::the newest-record query failed; using the manifest's value/);
    expect(fresh.output).toContain('NEWEST_WRITE_AT=2026-11-10T23:00:00.000Z');
    expect(fresh.output).toContain('NEWEST_WRITE_FROM=from the manifest, taken before the dump');
    const stale = run('schedule', { PSQL_FAIL: '1' }, { [`${STAMP}.manifest.json`]: manifest(30 * HOUR) });
    expect(stale.status).toBe(1);
  }, STEP_TEST_TIMEOUT_MS);

  it('neither the query nor a manifest: the nightly run fails (it cannot show the database is live); by hand it warns', () => {
    const nightly = run('schedule', { PSQL_FAIL: '1' });
    expect(nightly.status).toBe(1);
    expect(nightly.output).toMatch(
      /::error::The backup could not tell how old the newest record .*the newest-record query failed and the manifest has no value/
    );
    expect(nightly.output).toContain('NEWEST_WRITE_AT=none');
    const byHand = run('workflow_dispatch', { PSQL_FAIL: '1' });
    expect(byHand.status, byHand.output).toBe(0);
    expect(byHand.output).toMatch(/::warning::The backup could not tell/);
  }, STEP_TEST_TIMEOUT_MS);

  it('an empty database (no audit row, no heartbeat: the query prints "|") fails the nightly run', () => {
    const r = run('schedule', { PSQL_OUT: '|' });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/::error::The backup could not tell/);
    expect(r.output).toContain('NEWEST_WRITE_AT=none');
  }, STEP_TEST_TIMEOUT_MS);

  it('third round: the summary labels each value by when it was measured, executed', () => {
    const summary = runScriptOf(raw, 'Summary').split('${{ job.status }}').join('success');
    expect(summary).not.toBe('');
    const stepSummary = `export GITHUB_STEP_SUMMARY="$STUB_DIR/summary"; trap 'cat "$GITHUB_STEP_SUMMARY" 2>/dev/null || true' EXIT`;
    const r = runStep(
      summary,
      `${stubs}
${stepSummary}`,
      { STAMP, NEWEST_WRITE_AT: '2026-11-11T02:05:00.000Z', NEWEST_WRITE_FROM: 'checked after the upload' },
      { [`${STAMP}.manifest.json`]: manifest(HOUR) }
    );
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('- newest record in this database (UTC, checked after the upload): 2026-11-11T02:05:00.000Z');
    expect(r.output).toContain(
      '- newest record before the dump (UTC, from the manifest; the backup holds at least this): 2026-11-10T23:00:00.000Z'
    );
    const noManifest = runStep(summary, `${stubs}
${stepSummary}`, { STAMP });
    expect(noManifest.status, noManifest.output).toBe(0);
    expect(noManifest.output).toContain('- newest record in this database (UTC, not known): unknown');
    expect(noManifest.output).toContain('the backup holds at least this): unknown');
  }, STEP_TEST_TIMEOUT_MS);

  it('the manifest warning says what now happens, and the manifest step itself still only warns', () => {
    const manifestStep = runScriptOf(raw, 'Row-count manifest (before the dump)');
    expect(manifestStep).toContain('manifest query failed — continuing without row counts');
    expect(manifestStep).toContain(
      'This alone does not fail the run: the freshness check after the upload asks the database for its newest record with its own query'
    );
  });

  it('the query is the manifest’s expression, on its own (scripts/ops/backup-newest-write.sql)', () => {
    const sql = readFileSync('scripts/ops/backup-newest-write.sql', 'utf8');
    const newest = 'greatest((SELECT max("at") FROM "AuditLog"), (SELECT max("lastRunAt") FROM "CronHeartbeat"))';
    expect(sql).toContain(newest);
    expect(readFileSync('scripts/ops/backup-manifest.sql', 'utf8')).toContain(newest);
    expect(sql).toContain("floor(extract(epoch FROM (now() AT TIME ZONE 'UTC') - w))::bigint");
    expect(sql).toContain(`to_char(w, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  });

  it('CI’s restore chain runs the query on Postgres 17 and checks it agrees with the manifest', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('ROW="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -f scripts/ops/backup-newest-write.sql)"');
    expect(ci).toContain(`test "\${ROW#*|}" = "$(jq -r '.newestWriteAt' manifest.json)"`);
    expect(ci).toContain('bash scripts/ops/backup-freshness.sh "${ROW%%|*}" schedule');
    // Each call says where its age came from: the first is the manifest's.
    expect(ci).toContain(`bash scripts/ops/backup-freshness.sh "$SINCE" schedule 'from the manifest, taken before the dump'`);
    expect(ci).toContain(`bash scripts/ops/backup-freshness.sh "\${ROW%%|*}" schedule 'from the newest-record query, checked now'`);
  });
});
