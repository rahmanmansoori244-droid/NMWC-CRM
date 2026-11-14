// @vitest-environment node
/**
 * Go-live clean start: the RUN FLOW's shell half, without a database
 * (scripts/ops/clean-start/run.sh, seal-archive.sh, photo-delete.sh,
 * compare-watch.ts), each against local stand-ins: a folder per bucket (aws),
 * GitHub, Neon and the app from local state (curl), age and jq. The database
 * steps and the whole workflow run end to end in
 * tests/integration/clean-start-flow.test.ts (RUN_CLEAN_START_FLOW=1).
 *
 * Production here is a host of the TEST's own list (tests/support/clean-start/sandbox.ts):
 * the shared guard has no switch, so the scripts are copied beside that list.
 *
 * Every line any of these commands prints is also held to the public log rule
 * (tests/support/clean-start/public-log.ts) at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sandbox, type Sandbox } from '../support/clean-start/sandbox';
import { envHeaderViolations, publicLogViolations } from '../support/clean-start/public-log';
import { compareFirstRun, parseReadBack } from '../../scripts/ops/clean-start/compare-watch';
import { foreignSignature, loadExpected } from '../../scripts/ops/clean-start/rehearse-watch';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const MARKER = 'csprodsim-zq7';
const PROD_URL = `postgresql://owner_zq:pw-zq-secret@${MARKER}-pooler.example.invalid/neondb?sslmode=require`;
const COPY_URL = 'postgresql://ci:ci@localhost:5432/cs_restore';
const RUN = '987654321';
const ALL_LINES: string[] = [];
const FORBIDDEN = ['pw-zq-secret', 'owner_zq', 'bk-secret-zq', 'ro-secret-zq', 'rw-secret-zq', 'example.invalid', 'secret-name-zq'];

let sb: Sandbox;
const sh = (cmd: string, env: Record<string, string> = {}) => {
  const r = sb.run(cmd, env);
  ALL_LINES.push(...r.lines);
  return r;
};
const run = (args: string, env: Record<string, string> = {}) => sh(`bash scripts/ops/clean-start/run.sh ${args}`, env);
const ghState = (o: unknown) => writeFileSync(join(sb.state, 'github.json'), JSON.stringify(o));
const neonState = (o: unknown) => writeFileSync(join(sb.state, 'neon.json'), JSON.stringify(o));
const envFile = () => join(sb.root, 'github_env');
const readEnvFile = () => (existsSync(envFile()) ? readFileSync(envFile(), 'utf8') : '');

beforeAll(() => {
  sb = sandbox(MARKER);
});
afterAll(() => sb?.done());

describe('run.sh sql: a database step by exit code and SQLSTATE only', () => {
  it('prints ok on success', () => {
    writeFileSync(join(sb.csDir, 'ok.out'), 'clean-start: reset committed\n');
    const r = run(`sql reset 0 "$CS_DIR/ok.out"`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['reset: ok']);
  });

  it('prints the code, never the server text, and keeps the exit code', () => {
    writeFileSync(
      join(sb.csDir, 'bad.out'),
      'psql:scripts/ops/clean-start/reset.sql:141: ERROR:  CS013\nDETAIL:  Failing row contains (secret-name-zq, +968 9123)\n'
    );
    const r = run(`sql reset 3 "$CS_DIR/bad.out"`);
    expect(r.code).toBe(3);
    expect(r.lines).toEqual(['reset: refused, rolled back', 'reset: SQLSTATE CS013']);
  });

  it('a lost connection is "unknown", exit 2, with no host in it', () => {
    writeFileSync(join(sb.csDir, 'conn.out'), `psql: error: connection to server at "${MARKER}.example.invalid" failed\n`);
    const r = run(`sql reset 2 "$CS_DIR/conn.out"`);
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(['reset: no connection (the outcome is unknown)']);
  });
});

describe('run.sh exports: the plan files are the ones the plan id binds', () => {
  const planDir = () => join(sb.csDir, 'plan');
  const writePlan = (keys: string, seals: string, tamper = false) => {
    mkdirSync(planDir(), { recursive: true });
    // As the Windows client writes them: CRLF.
    writeFileSync(join(planDir(), 'photo-keys.txt'), keys.replace(/\n/g, '\r\n'));
    writeFileSync(join(planDir(), 'seals.jsonl'), seals.replace(/\n/g, '\r\n'));
    writeFileSync(join(planDir(), 'plan.json'), '{"counts":{"Customer":12}}\r\n');
    const id = sha('plan');
    writeFileSync(
      join(planDir(), 'plan-id.txt'),
      `plan_id=${id}\r\nphoto_keys_sha256=${tamper ? sha('x') : sha(keys)}\r\nseals_sha256=${sha(seals)}\r\nmigrations_sha256=${sha('m')}\r\nold_chain=none\r\n`
    );
    return id;
  };

  it('normalises line ends, checks both hashes and prints the plan id short', () => {
    const id = writePlan('2026/11/01/u1/CR/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg\n', '');
    const r = run(`exports "$CS_DIR/plan" ${id} "backup equals production"`, { GITHUB_OUTPUT: join(sb.root, 'out') });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['exports match the plan: yes', `plan id: ${id.slice(0, 12)}`, 'backup equals production: yes']);
    expect(readFileSync(join(sb.root, 'out'), 'utf8')).toContain(`plan_id=${id}`);
  });

  it('refuses files that are not the plan id\'s', () => {
    writePlan('a\n', '', true);
    const r = run(`exports "$CS_DIR/plan"`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/exports match the plan: no/);
  });

  it('a different plan id refuses, unless only recorded', () => {
    writePlan('a\n', '');
    expect(run(`exports "$CS_DIR/plan" ${sha('other')} "backup equals production"`).code).toBe(1);
    const r = run(`exports "$CS_DIR/plan" ${sha('other')} "branch equals production's plan" record`);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("branch equals production's plan: no");
  });
});

describe('run.sh prod-target: production now, named by the owner (the shared host list)', () => {
  it('accepts production named, and hands on the cleaned URL', () => {
    const r = run('prod-target read', { PROD_URL_RAW: `  ${PROD_URL}\r\n`, CONFIRM_HOST: MARKER.toUpperCase(), GITHUB_ENV: envFile() });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([`::add-mask::${PROD_URL}`, 'connection is production, named by the owner: yes']);
    expect(readEnvFile()).toContain(`DIRECT_URL=${PROD_URL}\n`);
  });

  it.each([
    ['another host', COPY_URL, MARKER],
    ['a host parameter', `${PROD_URL}&host=localhost`, MARKER],
    ['an unnamed host', PROD_URL, ''],
    ['a wrong name', PROD_URL, 'csprodsim'],
    ['not a URL', 'host=x dbname=y', MARKER],
  ])('refuses %s', (_why, url, confirm) => {
    const r = run('prod-target read', { PROD_URL_RAW: url, CONFIRM_HOST: confirm });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::clean start refused/);
  });

  it('apply needs the phrase of today in Oman (target-guard.sh), photos its own', () => {
    const base = { PROD_URL_RAW: PROD_URL, CONFIRM_HOST: MARKER };
    expect(run('prod-target apply', { ...base, CONFIRM_PHRASE: 'REMOVE ALL TEST DATA' }).code).toBe(1);
    const today = run('oman-date').out.trim();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run('prod-target apply', { ...base, CONFIRM_PHRASE: `REMOVE ALL TEST DATA ${today}` }).code).toBe(0);
    expect(run('prod-target photos', { ...base, CONFIRM_PHRASE: 'delete test photos' }).code).toBe(1);
    expect(run('prod-target photos', { ...base, CONFIRM_PHRASE: 'DELETE TEST PHOTOS' }).code).toBe(0);
  });

  it('rehearse-target refuses production, plain or percent-escaped, and accepts a copy', () => {
    expect(run('rehearse-target X', { X: COPY_URL }).code).toBe(0);
    expect(run('rehearse-target X', { X: PROD_URL }).code).toBe(1);
    expect(run('rehearse-target X', { X: `${COPY_URL}?host=${MARKER.replace(/-/g, '%2D')}.x` }).code).toBe(1);
  });
});

describe('run.sh: release, approval rule, backups, rehearsal, window', () => {
  const app = { APP_BASE_URL: 'https://app.example.invalid', HEALTH_BEARER: 'hb-zq', FAKE_HEALTH_BEARER: 'hb-zq', GITHUB_SHA: 'abcdef1234567890abcdef1234567890abcdef12' };

  it('health: the commit production serves is this run\'s', () => {
    expect(run('health', { ...app, FAKE_COMMIT: 'abcdef1' }).lines).toEqual(["production serves this run's commit: yes"]);
    const r = run('health', { ...app, FAKE_COMMIT: '1234567' });
    expect(r.code).toBe(1);
    expect(run('health', { ...app, FAKE_COMMIT: 'abcdef1', FAKE_HEALTH_BEARER: 'other' }).code).toBe(1);
  });

  const gh = { GH_TOKEN: 'ght-zq', GITHUB_REPOSITORY: 'owner/repo' };
  it('github-env: refuses an environment without a required reviewer', () => {
    ghState({});
    expect(run('github-env', gh).code).toBe(1);
    ghState({ environment: { protection_rules: [{ type: 'branch_policy' }] } });
    expect(run('github-env', gh).code).toBe(1);
    ghState({ environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] } });
    expect(run('github-env', gh).code).toBe(1);
    ghState({ environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] } });
    expect(run('github-env', gh).lines).toEqual(['environment production-reset has a required reviewer: yes']);
  });

  it('backup-idle: refuses while a DB Backup run is queued or running', () => {
    ghState({ backupRuns: { queued: 1 } });
    expect(run('backup-idle', gh).code).toBe(1);
    ghState({ backupRuns: {} });
    expect(run('backup-idle', gh).lines).toEqual(['no DB Backup run in progress: yes']);
  });

  it('backup-pick: the newest dump, with its manifest, young enough', () => {
    // "Now" is pinned to a morning instant (the date stand-in answers `date -u +%s`
    // from FAKE_UTC_EPOCH): with the real clock this test failed every evening from
    // 15:00 UTC, when the evening-dump rule (tested on its own below) refuses first.
    const nowMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T11:00:00Z`);
    const clock = { FAKE_UTC_EPOCH: String(nowMs / 1000) };
    const pick = (args: string, env: Record<string, string> = {}) => run(`backup-pick ${args}`, { ...clock, ...env });
    rmSync(join(sb.s3, 'backups', 'db'), { recursive: true, force: true });
    expect(pick('4').code).toBe(1); // none
    const stamp = (msAgo: number) => new Date(nowMs - msAgo).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
    const old = stamp(5 * 3600_000);
    sb.put('backups', `db/${old}.sql.gz.age`, 'x');
    sb.put('backups', `db/${old}.manifest.json`, '{}');
    expect(pick('4').out).toMatch(/newest backup at most 4 h old: no/);
    expect(pick('6').code).toBe(0);
    const fresh = stamp(600_000);
    sb.put('backups', `db/${fresh}.sql.gz.age`, 'x');
    expect(pick('4').out).toMatch(/newest backup has a manifest: no/);
    sb.put('backups', `db/${fresh}.manifest.json`, '{}');
    const r = pick('4', { GITHUB_OUTPUT: join(sb.root, 'out2') });
    expect(r.code).toBe(0);
    expect(readFileSync(join(sb.root, 'out2'), 'utf8')).toContain(`backup_key=db/${fresh}.sql.gz.age`);
    expect(pick(`6 db/${old}.sql.gz.age`).out).toMatch(/the rehearsed backup is still the newest: no/);
  });

  it('neon-green: a green neon-rehearsal of these exact scripts AND workflow, on the default branch, within 14 days', () => {
    mkdirSync(join(sb.root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(sb.root, '.github', 'workflows', 'clean-start.yml'), readFileSync('.github/workflows/clean-start.yml'));
    sh('git init -q . && git -c user.name=t -c user.email=t@t add scripts/ops/clean-start .github/workflows/clean-start.yml && git -c user.name=t -c user.email=t@t commit -qm t');
    const tree = sh('git rev-parse HEAD:scripts/ops/clean-start').out.trim();
    const yml = sh('git rev-parse HEAD:.github/workflows/clean-start.yml').out.trim();
    const head = 'f'.repeat(40);
    const g = { ...gh, DEFAULT_BRANCH: 'main' };
    const ok = { 11: [{ name: 'Neon rehearsal', conclusion: 'success' }] };
    ghState({ cleanStartRuns: [] });
    expect(run('neon-green', g).code).toBe(1);
    const runs = [{ id: 11, head_sha: head, head_branch: 'main', display_title: 'Clean start neon-rehearsal' }];
    ghState({ cleanStartRuns: runs, jobs: ok, trees: { [head]: 'e'.repeat(40) }, workflowBlobs: { [head]: yml } });
    expect(run('neon-green', g).code).toBe(1); // other scripts
    ghState({ cleanStartRuns: runs, jobs: { 11: [{ name: 'Neon rehearsal', conclusion: 'failure' }] }, trees: { [head]: tree }, workflowBlobs: { [head]: yml } });
    expect(run('neon-green', g).code).toBe(1); // not green
    ghState({ cleanStartRuns: runs, jobs: ok, trees: { [head]: tree }, workflowBlobs: { [head]: 'd'.repeat(40) } });
    expect(run('neon-green', g).code).toBe(1); // the same scripts, another (edited) workflow file
    ghState({ cleanStartRuns: [{ ...runs[0], head_branch: 'feature' }], jobs: ok, trees: { [head]: tree }, workflowBlobs: { [head]: yml } });
    expect(run('neon-green', g).code).toBe(1); // a run from another branch
    // In a dry run it is only recorded.
    const rec = run('neon-green record', g);
    expect([rec.code, rec.lines]).toEqual([0, ['green Neon rehearsal of these scripts within 14 days: no']]);
    ghState({ cleanStartRuns: runs, jobs: ok, trees: { [head]: tree }, workflowBlobs: { [head]: yml } });
    expect(run('neon-green', g).lines).toEqual(['green Neon rehearsal of these scripts within 14 days: yes']);
  });

  it.each([
    ['1529', 1],
    ['1530', 0],
    ['2330', 0],
    ['2331', 1],
    ['0300', 1],
  ])('window at %s UTC', (hhmm, code) => {
    expect(run('window', { FAKE_UTC_HHMM: hhmm }).code).toBe(code);
  });

  it('preflight names a missing setting, and refuses off the default branch', () => {
    const r = run('preflight seal-restore', { PROD_URL_RAW: 'x', CONFIRM_HOST: 'x', DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/main', PROD_CRON_SECRET: '' });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('setting PROD_CRON_SECRET present: no');
    const all = Object.fromEntries(
      ['PROD_URL_RAW', 'CONFIRM_HOST', 'PROD_CRON_SECRET', 'BACKUP_AGE_RECIPIENTS', 'BACKUP_AGE_IDENTITY', 'GH_TOKEN'].map((k) => [k, 'x'])
    );
    expect(run('preflight seal-restore', { ...all, DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/feature' }).code).toBe(1);
    expect(run('preflight seal-restore', { ...all, DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/main' }).code).toBe(0);
    expect(run('preflight nonsense').code).toBe(1);
  });
});

describe('run.sh settle: did the reset commit?', () => {
  const out = (t: string) => {
    writeFileSync(join(sb.csDir, 'v.out'), t);
    return '"$CS_DIR/v.out"';
  };
  it('committed and verified', () => {
    const r = run(`settle 0 ${out('clean-start: verify ok\n')}`, { GITHUB_ENV: envFile() });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe('reset committed: yes');
    expect(readEnvFile()).toContain('CS_COMMITTED=yes');
  });
  it('CS301 alone: not committed, nothing changed', () => {
    const r = run(`settle 3 ${out('psql:verify.sql:37: ERROR:  CS301\n')}`);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe('reset committed: no (nothing changed)');
  });
  it('another check failing: committed, but not verified', () => {
    const r = run(`settle 3 ${out('psql:verify.sql:113: ERROR:  CS304\n')}`);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(['reset committed: yes', 'kept accounts, routes and regions verified after the reset: no', 'verify: SQLSTATE CS304']);
  });
  it('no connection: unknown, to be settled by mode finish', () => {
    const r = run(`settle 2 ${out('psql: error: connection refused\n')}`);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^reset committed: unknown/);
  });
  it('an error before CS301 was decided (a timeout, a cancelled statement) is unknown, never "yes"', () => {
    for (const text of ['psql:verify.sql:27: ERROR:  57014\n', 'psql:verify.sql:30: ERROR:  25006\n', 'psql:verify.sql:30: ERROR:  CS304\npsql: ERROR:  57014\n', '']) {
      const r = run(`settle 3 ${out(text)}`, { GITHUB_ENV: envFile() });
      expect(r.code, text).toBe(1);
      expect(r.lines[0], text).toBe('reset committed: unknown (the check did not finish); run mode finish with this run id');
      expect(readFileSync(join(sb.csDir, 'committed'), 'utf8').trim()).toBe('unknown');
    }
    // Two later checks (only reachable once CS301 passed) still mean committed.
    expect(run(`settle 3 ${out('ERROR:  CS303\nERROR:  CS306\n')}`).lines[0]).toBe('reset committed: yes');
  });
});

describe('run.sh bool, status-lines, owner-facts: a "no" that matters is a refusal the owner can find', () => {
  const f = (t: string) => {
    writeFileSync(join(sb.csDir, 'b.out'), t);
    return '"$CS_DIR/b.out"';
  };
  it('bool refuses with the bold refused line, unless it is only asked', () => {
    const summary = join(sb.root, 'summary.md');
    writeFileSync(summary, '');
    const r = run(`bool "DB Backup heartbeat ok within 4 h" ${f('f\n')}`, { GITHUB_STEP_SUMMARY: summary });
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(['DB Backup heartbeat ok within 4 h: no', '::error::clean start refused: DB Backup heartbeat ok within 4 h: no']);
    expect(readFileSync(summary, 'utf8')).toContain('- **refused: DB Backup heartbeat ok within 4 h: no**');
    const a = run(`bool "the first watch after the reset already ran" ${f('f\n')} ask`);
    expect([a.code, a.lines]).toEqual([1, ['the first watch after the reset already ran: no']]);
    expect(run(`bool "x y" ${f('t\r\n')}`).code).toBe(0);
  });
  it('status-lines refuses in seal-restore when a check fails or errs, or nothing came back', () => {
    writeFileSync(join(sb.csDir, 'ok.tsv'), 'seal-written\tpass\t\nseal-chain-intact\tinfo\t\n');
    expect(run('status-lines "$CS_DIR/ok.tsv" refuse').code).toBe(0);
    writeFileSync(join(sb.csDir, 'bad.tsv'), 'seal-written\tpass\t\nhistory-matches-master\terror\t\n');
    const r = run('status-lines "$CS_DIR/bad.tsv" refuse');
    expect(r.code).toBe(1);
    expect(r.lines).toContain('a check failing or in error: yes');
    writeFileSync(join(sb.csDir, 'none.tsv'), '');
    expect(run('status-lines "$CS_DIR/none.tsv" refuse').code).toBe(1);
    // seal-offsite-copies alone (other environments' objects under seals/; the restore
    // step hash-checked the old chain itself) is shown and recorded, not a refusal...
    writeFileSync(join(sb.csDir, 'off.tsv'), 'seal-written\tpass\t\nseal-offsite-copies\tfail\t\n');
    const off = run('status-lines "$CS_DIR/off.tsv" refuse');
    expect(off.code).toBe(0);
    expect(off.lines).toContain('seal-offsite-copies: fail');
    expect(off.lines).toContain('seal-offsite-copies failing only for objects outside the old chain (checked above): yes');
    // ...but in error it is, and so is any other check failing beside it.
    writeFileSync(join(sb.csDir, 'offe.tsv'), 'seal-offsite-copies\terror\t\n');
    expect(run('status-lines "$CS_DIR/offe.tsv" refuse').code).toBe(1);
    writeFileSync(join(sb.csDir, 'off2.tsv'), 'seal-offsite-copies\tfail\t\nseal-chain-intact\tfail\t\n');
    expect(run('status-lines "$CS_DIR/off2.tsv" refuse').code).toBe(1);
  });
  it('owner-facts: three recorded yes/no lines, never a refusal', () => {
    const r = run(`owner-facts ${f('t\r\nf\nt\n')}`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      'job runs recorded for yesterday in Oman: yes',
      'job runs recorded for today in Oman: no',
      'a windowed job ran outside 03:00-15:00 UTC in the last 3 days: yes',
    ]);
  });
  it('preflight of finish, seal-restore and photos needs the GitHub token (the approval-rule check)', () => {
    const base = Object.fromEntries(['PROD_URL_RAW', 'CONFIRM_HOST', 'PROD_CRON_SECRET', 'BACKUP_AGE_RECIPIENTS', 'BACKUP_AGE_IDENTITY'].map((k) => [k, 'x']));
    const r = run('preflight seal-restore', { ...base, GH_TOKEN: '', DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/main' });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('setting GH_TOKEN present: no');
  });
});

describe('run.sh started / safety-cleanup: the safety branch survives a cancelled reset step', () => {
  const neon = {
    NEON_API_KEY: 'neon-key-zq',
    NEON_PROJECT_ID: 'proj-zq',
    FAKE_NEON_API_KEY: 'neon-key-zq',
    FAKE_NEON_PROJECT_ID: 'proj-zq',
    CS_COMMITTED: '',
    CS_RESET_RC: '',
  };
  const names = () => (JSON.parse(readFileSync(join(sb.state, 'neon.json'), 'utf8')) as { branches: Array<{ name: string }> }).branches.map((b) => b.name);
  const fresh = (files: Record<string, string>) => {
    neonState({ seq: 0, branches: [{ id: 'br-main-1', name: 'main', default: true }, { id: 'br-s-9', name: 'pre-clean-start-2026-11-18-1' }] });
    for (const f of ['reset-started', 'reset-rc', 'committed', 'neon-branches']) rmSync(join(sb.csDir, f), { force: true });
    writeFileSync(join(sb.csDir, 'neon-branches'), '- pre-clean-start-2026-11-18-1\n');
    for (const [k, v] of Object.entries(files)) writeFileSync(join(sb.csDir, k), v);
  };

  it('started leaves a marker on disk and prints the time in UTC and in Oman', () => {
    rmSync(join(sb.csDir, 'reset-started'), { force: true });
    const r = run('started');
    expect(r.lines[0]).toMatch(/^reset started at \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(r.lines[1]).toMatch(/^reset started at \(Oman time\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const utc = new Date(r.lines[0]!.split(': ')[1]!);
    const oman = new Date(utc.getTime() + 4 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
    expect(r.lines[1]!.endsWith(oman)).toBe(true);
    expect(existsSync(join(sb.csDir, 'reset-started'))).toBe(true);
  });

  it.each([
    ['the step was cancelled after the marker (GITHUB_ENV lost)', { 'reset-started': 'x' }, {}, true],
    ['the connection was lost (exit 2)', { 'reset-started': 'x', 'reset-rc': '2\n' }, {}, true],
    ['committed and verified', { 'reset-started': 'x', 'reset-rc': '0\n', committed: 'yes\n' }, {}, true],
    ['never started', {}, {}, false],
    ['Postgres refused it (exit 3, from the file)', { 'reset-started': 'x', 'reset-rc': '3\n' }, {}, false],
    ['Postgres refused it (exit 3, from GITHUB_ENV)', { 'reset-started': 'x' }, { CS_RESET_RC: '3' }, false],
    ['settle read CS301 (from the file)', { 'reset-started': 'x', 'reset-rc': '0\n', committed: 'no\n' }, {}, false],
  ] as const)('%s', (_why, files, env, kept) => {
    fresh(files);
    const r = run('safety-cleanup', { ...neon, ...env });
    expect(r.code).toBe(0);
    expect(names().includes('pre-clean-start-2026-11-18-1')).toBe(kept);
    expect(r.lines).toContain(kept ? 'Neon safety branch kept: yes' : 'temporary Neon branches deleted: yes');
  });
});

describe('run.sh chain-id / chain-id-fetch / finish-may: production\'s new chain is named, never inferred', () => {
  let identity = '';
  let recipient = '';
  beforeAll(() => {
    const kg = sh('age-keygen');
    recipient = /age1[0-9a-f]+/.exec(kg.out)![0];
    identity = /AGE-SECRET-KEY-1[0-9a-f]+/.exec(kg.out)![0];
  });
  it('records the new chain id encrypted, and seal-restore reads it back', () => {
    writeFileSync(join(sb.csDir, 'chain-id.out'), '0f1e2d3c4b5a6978\r\n');
    const r = run(`chain-id "$CS_DIR/chain-id.out" ${RUN}`, { BACKUP_AGE_RECIPIENTS: recipient, GITHUB_ENV: envFile() });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['encrypted copies stored (chain): yes', 'new seal chain id recorded: yes']);
    expect(readEnvFile()).toContain('NEW_CHAIN=0f1e2d3c4b5a6978');
    expect(sb.read('backups', `cleanstart/${RUN}/chain/new-chain.txt.age`).toString('latin1')).not.toContain('0f1e2d3c');
    rmSync(join(sb.csDir, 'new-chain'), { force: true });
    const back = run(`chain-id-fetch ${RUN}`, { BACKUP_AGE_IDENTITY: identity, GITHUB_ENV: envFile() });
    expect([back.code, back.lines]).toEqual([0, ['new seal chain id of that run found: yes']]);
    expect(readFileSync(join(sb.csDir, 'new-chain'), 'utf8')).toBe('0f1e2d3c4b5a6978');
  });
  it('no genesis yet: recorded as no; a run with nothing recorded refuses seal-restore', () => {
    writeFileSync(join(sb.csDir, 'chain-id.out'), 'none\n');
    expect(run(`chain-id "$CS_DIR/chain-id.out" ${RUN}`, { BACKUP_AGE_RECIPIENTS: recipient }).lines).toEqual(['new seal chain id recorded: no']);
    const r = run('chain-id-fetch 1234', { BACKUP_AGE_IDENTITY: identity });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/the new seal chain's id of that run was not recorded, so no seal file is moved; tell Claude/);
  });
  it('finish-may: everything under seals/ that verify listed now, minus the new chain', () => {
    writeFileSync(join(sb.csDir, 'seal-keys-foreign.txt'), 'seals/v1/0f1e2d3c4b5a6978/00000000.json\nseals/v1/8888888888888888/00000003.json\n');
    writeFileSync(join(sb.csDir, 'seal-keys-own.txt'), 'seals/v1/a1b2c3d4e5f60718/00000000.json\n');
    writeFileSync(join(sb.csDir, 'new-chain'), '0f1e2d3c4b5a6978');
    expect(run('finish-may "$CS_DIR/may.txt"').code).toBe(0);
    expect(readFileSync(join(sb.csDir, 'may.txt'), 'utf8').trim().split('\n')).toEqual([
      'seals/v1/8888888888888888/00000003.json',
      'seals/v1/a1b2c3d4e5f60718/00000000.json',
    ]);
  });
});

describe('run.sh backup-pick: an evening run needs an evening dump', () => {
  const today = new Date().toISOString().slice(0, 10);
  /** "now" for run.sh, as the date stand-in answers it: today at hh:mm UTC. */
  const at = (hhmm: string) => ({
    FAKE_UTC_EPOCH: String(Date.parse(`${today}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) / 1000),
  });
  const put = (hhmm: string) => {
    rmSync(join(sb.s3, 'backups', 'db'), { recursive: true, force: true });
    const stamp = `${today}T${hhmm.slice(0, 2)}-${hhmm.slice(2)}-00Z`;
    sb.put('backups', `db/${stamp}.sql.gz.age`, 'x');
    sb.put('backups', `db/${stamp}.manifest.json`, '{}');
  };
  it('from 15:00 UTC, a dump taken earlier that day is refused (the rehearsal would see a gap production does not have)', () => {
    put('1330');
    const r = run('backup-pick 4', { ...at('1700'), MODE: 'apply' });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('newest backup taken after 15:00 UTC (19:00 Oman): no');
    expect(r.out).toMatch(/run DB Backup again now/);
    // Not for the Neon rehearsal, which reads a branch of production, not the dump.
    const n = run('backup-pick 4', { ...at('1700'), MODE: 'neon-rehearsal' });
    expect(n.code).toBe(0);
    expect(n.out).not.toMatch(/taken after 15:00 UTC/);
    // Before 15:00 UTC the rule does not apply (the rehearsal then reports, not asserts, the jobs check).
    const early = run('backup-pick 4', { ...at('1400'), MODE: 'dry-run' });
    expect(early.code).toBe(0);
    expect(early.out).not.toMatch(/taken after 15:00 UTC/);
    put('1530');
    const ok = run('backup-pick 4', { ...at('1700'), MODE: 'dry-run' });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.lines).toContain('newest backup taken after 15:00 UTC (19:00 Oman): yes');
    // The rule reads the same clock as the age check, never the window's HHMM answer alone.
    expect(run('backup-pick 4', { ...at('1700'), FAKE_UTC_HHMM: '1000', MODE: 'dry-run' }).lines).toContain(
      'newest backup taken after 15:00 UTC (19:00 Oman): yes'
    );
  });
});

describe('run.sh neon: a timeout after the create, and old failures elsewhere, do not strand a branch', () => {
  const neon = {
    NEON_API_KEY: 'neon-key-zq',
    NEON_PROJECT_ID: 'proj-zq',
    FAKE_NEON_API_KEY: 'neon-key-zq',
    FAKE_NEON_PROJECT_ID: 'proj-zq',
    FAKE_NEON_URI_BASE: 'postgresql://postgres@localhost:5432',
  };
  const names = () => (JSON.parse(readFileSync(join(sb.state, 'neon.json'), 'utf8')) as { branches: Array<{ name: string }> }).branches.map((b) => b.name);
  it('Neon made the branch but the answer was lost: the cleanup still finds it by name', () => {
    neonState({ seq: 0, branches: [{ id: 'br-main-1', name: 'main', default: true }] });
    rmSync(join(sb.csDir, 'neon-branches'), { force: true });
    const r = run('neon-create pre-clean-start-2026-11-18-77 none', { ...neon, FAKE_NEON_CREATE_TIMEOUT: '1' });
    expect(r.code).toBe(1);
    expect(names()).toContain('pre-clean-start-2026-11-18-77');
    const c = run('neon-cleanup', neon);
    expect(c.lines).toContain('temporary Neon branches deleted: yes');
    expect(names()).toEqual(['main']);
  });
  it('a failed operation of ANOTHER branch blocks neither a create nor the cleanup; one of this branch refuses', () => {
    neonState({ seq: 0, branches: [{ id: 'br-main-1', name: 'main', default: true }], pending: [{ id: 'op-old', branch_id: 'br-gone-1', status: 'failed' }] });
    rmSync(join(sb.csDir, 'neon-branches'), { force: true });
    expect(run('neon-create pre-clean-start-2026-11-18-78 none', neon).code).toBe(0);
    expect(run('neon-cleanup', neon).lines).toContain('temporary Neon branches deleted: yes');
    neonState({ seq: 4, branches: [{ id: 'br-main-1', name: 'main', default: true }], pending: [{ id: 'op-x', branch_id: 'br-fake-5', status: 'failed' }] });
    rmSync(join(sb.csDir, 'neon-branches'), { force: true });
    const r = run('neon-create pre-clean-start-2026-11-18-79 none', neon);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/a Neon operation failed/);
    // The name was recorded first, so the cleanup deletes what was made.
    expect(run('neon-cleanup', neon).lines).toContain('temporary Neon branches deleted: yes');
    expect(names()).toEqual(['main']);
  });
});

describe('run.sh neon: branches of production, never production, always cleaned up', () => {
  const neon = {
    NEON_API_KEY: 'neon-key-zq',
    NEON_PROJECT_ID: 'proj-zq',
    FAKE_NEON_API_KEY: 'neon-key-zq',
    FAKE_NEON_PROJECT_ID: 'proj-zq',
    FAKE_NEON_URI_BASE: 'postgresql://postgres@localhost:5432',
    GITHUB_ENV: '',
  };
  const fresh = () => neonState({ seq: 0, retention: 604800, branches: [{ id: 'br-main-1', name: 'main', default: true }] });

  it('a safety branch without compute is created, confirmed, and deleted only by cleanup', () => {
    fresh();
    const env = { ...neon, GITHUB_ENV: envFile() };
    const r = run('neon-create pre-clean-start-2026-11-18-42 none', env);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['Neon branch created and confirmed: yes']);
    expect(run('neon-retention', env).lines).toEqual(['Neon history kept at least 7 days: yes']);
    const st = () => JSON.parse(readFileSync(join(sb.state, 'neon.json'), 'utf8')) as { branches: Array<{ name: string }> };
    expect(st().branches.map((b) => b.name)).toContain('pre-clean-start-2026-11-18-42');
    expect(run('neon-cleanup', env).lines).toContain('temporary Neon branches deleted: yes');
    expect(st().branches.map((b) => b.name)).toEqual(['main']);
  });

  it('neon-uri refuses a branch whose connection string names production', () => {
    fresh();
    const env = { ...neon, GITHUB_ENV: envFile(), FAKE_NEON_URI_BASE: `postgresql://u:p@${MARKER}-x.example.invalid` };
    expect(run('neon-create cleanstart-rehearsal-1 compute', env).code).toBe(0);
    const id = /CS_NEON_BRANCH_ID=(\S+)/.exec(readEnvFile())![1]!;
    const r = run('neon-uri', { ...env, CS_NEON_BRANCH_ID: id });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/host is a production host/);
    expect(run('neon-cleanup', env).code).toBe(0);
  });

  it('never restores or deletes the default branch', () => {
    fresh();
    const r = run('neon-restore 2026-11-18T16:00:00Z keep-me', { ...neon, CS_NEON_BRANCH_ID: 'br-main-1' });
    expect(r.code).toBe(1);
    writeFileSync(join(sb.csDir, 'neon-branches'), 'br-main-1 main\n');
    expect(run('neon-cleanup', neon).code).toBe(1);
  });

  it('neon-delete-safety finds the safety branch of a run by name', () => {
    neonState({
      seq: 5,
      branches: [
        { id: 'br-main-1', name: 'main', default: true },
        { id: 'br-s-2', name: `pre-clean-start-2026-11-18-${RUN}` },
        { id: 'br-s-3', name: 'pre-clean-start-2026-11-18-1' },
      ],
    });
    expect(run(`neon-delete-safety ${RUN}`, neon).code).toBe(0);
    const names = (JSON.parse(readFileSync(join(sb.state, 'neon.json'), 'utf8')) as { branches: Array<{ name: string }> }).branches.map((b) => b.name);
    expect(names).toEqual(['main', 'pre-clean-start-2026-11-18-1']);
  });
});

describe('run.sh encrypt-upload / fetch-decrypt / dump-gates / watch-lines / counter', () => {
  it('stores age-encrypted copies under cleanstart/<run>/ and reads them back', () => {
    const kg = sh('age-keygen');
    const recipient = /age1[0-9a-f]+/.exec(kg.out)![0];
    const identity = /AGE-SECRET-KEY-1[0-9a-f]+/.exec(kg.out)![0];
    writeFileSync(join(sb.csDir, 'plan.json'), '{"counts":{"Customer":12}}');
    const r = run(`encrypt-upload cleanstart/${RUN}/plan "$CS_DIR/plan.json"`, { BACKUP_AGE_RECIPIENTS: recipient });
    expect(r.code).toBe(0);
    expect(sb.has('backups', `cleanstart/${RUN}/plan/plan.json.age`)).toBe(true);
    expect(sb.read('backups', `cleanstart/${RUN}/plan/plan.json.age`).toString('latin1')).not.toContain('Customer');
    expect(run(`encrypt-upload elsewhere/${RUN} "$CS_DIR/plan.json"`, { BACKUP_AGE_RECIPIENTS: recipient }).code).toBe(1);
    expect(run(`encrypt-upload cleanstart/${RUN}/plan "$CS_DIR/plan.json"`, { BACKUP_AGE_RECIPIENTS: '' }).code).toBe(1);
    const back = run(`fetch-decrypt cleanstart/${RUN}/plan/plan.json.age "$CS_DIR/back.json"`, { BACKUP_AGE_IDENTITY: identity });
    expect(back.code).toBe(0);
    expect(readFileSync(join(sb.csDir, 'back.json'), 'utf8')).toContain('Customer');
    expect(existsSync(join(sb.csDir, 'age.key'))).toBe(false);
  });

  it('dump-gates: the nightly backup\'s table gate and the size floors, yes/no only', () => {
    const DONE = '-- PostgreSQL database dump complete\n';
    const copy = (t: string, rows: number) =>
      `COPY public."${t}" (id) FROM stdin;\n${Array.from({ length: rows }, (_, i) => `${t}-${i}\n`).join('')}\\.\n`;
    writeFileSync(join(sb.csDir, 'd.sql.gz'), gzipSync(['Customer', 'Branch', 'User', 'AuditLog'].map((t) => copy(t, t === 'User' ? 3 : 0)).join('') + DONE));
    const r = run('dump-gates "$CS_DIR/d.sql.gz"');
    expect(r.code).toBe(0);
    expect(r.lines).toContain("the nightly backup's table gate passes on the reset copy: yes");
    expect(r.lines).toContain('dump of the reset copy at least 80000 bytes: no');
    expect(r.lines).toContain('first nightly backup would be below the size floor: yes; even 20000 bytes is too high, ask before the reset');
    writeFileSync(join(sb.csDir, 'd2.sql.gz'), gzipSync(copy('Customer', 1) + DONE));
    expect(run('dump-gates "$CS_DIR/d2.sql.gz"').code).toBe(1);
  });

  it('watch-lines: only the status table reaches the log', () => {
    writeFileSync(
      join(sb.csDir, 'w.out'),
      [' RUN  v3.2.4 C:/somewhere', 'stdout | tests/integration/clean-start-watch.test.ts > x', 'night 1:', '  seal-written: info', 'night 2:', '  scheduled-jobs-on-time: info (not asserted)', 'first integrity checks as expected: yes', ' Test Files  1 passed (1)'].join('\n')
    );
    const r = run('watch-lines "$CS_DIR/w.out" 0');
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['night 1:', 'seal-written: info', 'night 2:', 'scheduled-jobs-on-time: info (not asserted)', 'first integrity checks as expected: yes']);
    expect(run('watch-lines "$CS_DIR/w.out" 1').code).toBe(1);
  });

  it('counter: next = 2 or refuse', () => {
    writeFileSync(join(sb.csDir, 'c.out'), '2\n');
    expect(run('counter "$CS_DIR/c.out"').code).toBe(0);
    writeFileSync(join(sb.csDir, 'c.out'), '7\n');
    expect(run('counter "$CS_DIR/c.out"').code).toBe(1);
  });

  it('status-lines: check ids and statuses only, and whether any failed', () => {
    writeFileSync(join(sb.csDir, 's.tsv'), 'seal-written\tpass\t\nseal-offsite-copies\tfail\tabc\nbad id!\tpass\t\n');
    const r = run('status-lines "$CS_DIR/s.tsv"');
    expect(r.lines).toEqual(['seal-written: pass', 'seal-offsite-copies: fail', 'a check failing or in error: yes']);
  });
});

// ── seal-archive.sh ──────────────────────────────────────────────────────

const OLD = 'a1b2c3d4e5f60718';
const NEW = '0f1e2d3c4b5a6978';
type Seal = { seq: number; day: string; hash: string; r2Key: string; bodyText: string };
function chain(n: number, breakAt = -1): Seal[] {
  const out: Seal[] = [];
  let prev: string | null = null;
  for (let s = 0; s < n; s++) {
    const bodyText = JSON.stringify({ v: 1, seq: s, day: `2026-11-0${s + 1}`, prev: s === breakAt ? 'f'.repeat(64) : prev, tables: [] });
    const hash = sha(bodyText);
    out.push({ seq: s, day: `2026-11-0${s + 1}`, hash, r2Key: `seals/v1/${OLD}/${String(s).padStart(8, '0')}.json`, bodyText });
    prev = hash;
  }
  return out;
}
const writeSeals = (seals: Seal[]) => {
  writeFileSync(join(sb.csDir, 'seals.jsonl'), seals.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return '"$CS_DIR/seals.jsonl"';
};
const sa = (args: string) => sh(`bash scripts/ops/clean-start/seal-archive.sh ${args}`);

describe('seal-archive.sh: the old chain archived, retired, restored — against a folder bucket', () => {
  const seals = chain(3);
  const FOREIGN = [`seals/v1/${'9'.repeat(16)}/00000000.json`, 'seals/README.txt'];

  beforeAll(() => {
    // seq 0 and 2 have their copies; seq 1's copy is MISSING; two foreign objects.
    sb.put('photos', seals[0]!.r2Key, seals[0]!.bodyText);
    sb.put('photos', seals[2]!.r2Key, seals[2]!.bodyText);
    for (const k of FOREIGN) sb.put('photos', k, '{}');
  });

  it('verify: the copies that exist match, one is missing, the foreign objects are listed apart', () => {
    const before = sb.s3Calls().length;
    const r = sa(`verify ${writeSeals(seals)} ${OLD}`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      'old seal chain present: yes',
      'every old seal copy that exists matches its seal: yes',
      'an old seal copy is missing (its body is archived from the export): yes',
      'other objects under seals/ (reported once on the first night): yes',
    ]);
    expect(readFileSync(join(sb.csDir, 'seal-keys-foreign.txt'), 'utf8').trim().split('\n').sort()).toEqual([...FOREIGN].sort());
    // Read-only: the read-only token only.
    expect(sb.s3Calls().slice(before).every((c) => c.accessKeyId === 'ro-key')).toBe(true);
  });

  it('verify refuses a copy that differs from its seal, and an export that does not hash', () => {
    sb.put('photos', seals[2]!.r2Key, seals[2]!.bodyText + ' ');
    expect(sa(`verify ${writeSeals(seals)} ${OLD}`).code).toBe(1);
    sb.put('photos', seals[2]!.r2Key, seals[2]!.bodyText);
    const bad = chain(3);
    bad[1]!.bodyText += ' ';
    expect(sa(`verify ${writeSeals(bad)} ${OLD}`).code).toBe(1);
    expect(sa(`verify ${writeSeals(seals)} ${'b'.repeat(16)}`).code).toBe(1); // keys of another chain
  });

  it('archive: every old seal to the backups bucket, re-read, chained — additive only', () => {
    expect(sa(`verify ${writeSeals(seals)} ${OLD}`).code).toBe(0);
    const r = sa(`archive ${writeSeals(seals)} ${OLD} ${RUN}`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['old seals archived, re-read and chained: yes']);
    for (const s of seals) {
      const k = `cleanstart/${RUN}/seal-archive/${s.r2Key}`;
      expect(sha(sb.read('backups', k))).toBe(s.hash);
    }
    // Again: nothing overwritten, still yes.
    expect(sa(`archive ${writeSeals(seals)} ${OLD} ${RUN}`).code).toBe(0);
    // An archive object with other bytes is never overwritten.
    sb.put('backups', `cleanstart/1/seal-archive/${seals[0]!.r2Key}`, 'other');
    expect(sa(`archive ${writeSeals(seals)} ${OLD} 1`).code).toBe(1);
    expect(sb.read('backups', `cleanstart/1/seal-archive/${seals[0]!.r2Key}`).toString()).toBe('other');
  });

  it('archive refuses a chain whose links do not hold', () => {
    const broken = chain(3, 2);
    expect(sa(`verify ${writeSeals(broken)} ${OLD}`).code).toBe(1); // copy of seq 2 now differs
    expect(sa(`archive ${writeSeals(broken)} ${OLD} 55`).code).toBe(1);
  });

  it('retire: removes only listed old keys with a verified archive copy; foreign objects stay', () => {
    expect(sa(`verify ${writeSeals(seals)} ${OLD}`).code).toBe(0);
    const before = sb.s3Calls().length;
    const r = sa(`retire ${writeSeals(seals)} ${OLD} ${RUN}`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['old seal files removed from the live folder, each with a verified archive copy: yes']);
    for (const s of seals) expect(sb.has('photos', s.r2Key)).toBe(false);
    for (const k of FOREIGN) expect(sb.has('photos', k)).toBe(true);
    const deletes = sb.s3Calls().slice(before).filter((c) => c.op === 'delete');
    expect(deletes.map((c) => c.key).sort()).toEqual([seals[0]!.r2Key, seals[2]!.r2Key]);
    expect(deletes.every((c) => c.accessKeyId === 'rw-key' && c.bucket === 'photos')).toBe(true);
  });

  it('retire touches nothing whose archive copy is not there', () => {
    sb.put('photos', seals[0]!.r2Key, seals[0]!.bodyText);
    expect(sa(`verify ${writeSeals(seals)} ${OLD}`).code).toBe(0);
    const r = sa(`retire ${writeSeals(seals)} ${OLD} 777`);
    expect(r.code).toBe(1);
    expect(sb.has('photos', seals[0]!.r2Key)).toBe(true);
  });

  it('restore: the old files back from the archive, ONLY the recorded new chain moved aside', () => {
    // After a rollback: the live folder holds the NEW chain's genesis and seal 1, the
    // foreign objects of plan time, seq 0 still, AND objects another environment wrote
    // after the plan (its own chain grows nightly in the shared bucket).
    sb.put('photos', `seals/v1/${NEW}/00000000.json`, '{"new":true}');
    sb.put('photos', `seals/v1/${NEW}/00000001.json`, '{"new":1}');
    const LATER = [`seals/v1/${'8'.repeat(16)}/00000003.json`, `seals/v1/${'9'.repeat(16)}/00000001.json`, 'seals/notes.txt'];
    for (const k of LATER) sb.put('photos', k, '{"uat":true}');
    const before = sb.s3Calls().length;
    // Without the recorded id it refuses before touching anything.
    expect(sa(`restore ${writeSeals(seals)} ${OLD} ${RUN} ""`).code).toBe(1);
    expect(sa(`restore ${writeSeals(seals)} ${OLD} ${RUN} ${OLD}`).code).toBe(1);
    expect(sb.s3Calls().slice(before).filter((c) => c.op === 'delete' || c.op === 'put')).toEqual([]);
    const r = sa(`restore ${writeSeals(seals)} ${OLD} ${RUN} ${NEW}`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      'old seal files back in the live folder, hash-checked: yes',
      'other objects under seals/ left where they are: yes',
      'the abandoned new chain moved out of the live folder: yes',
    ]);
    for (const s of seals) expect(sha(sb.read('photos', s.r2Key))).toBe(s.hash);
    for (const n of ['00000000', '00000001']) {
      expect(sb.has('photos', `seals/v1/${NEW}/${n}.json`)).toBe(false);
      expect(sb.has('backups', `cleanstart/${RUN}/abandoned-chain/seals/v1/${NEW}/${n}.json`)).toBe(true);
    }
    for (const k of [...FOREIGN, ...LATER]) expect(sb.has('photos', k), k).toBe(true);
    const deleted = sb.s3Calls().slice(before).filter((c) => c.op === 'delete').map((c) => c.key as string);
    expect(deleted.every((k) => k.startsWith(`seals/v1/${NEW}/`))).toBe(true);
  });

  it('a HEAD that fails for another reason than "not found" never counts as removed', () => {
    for (const s of seals) sb.put('photos', s.r2Key, s.bodyText);
    sb.put('photos', seals[1]!.r2Key, seals[1]!.bodyText);
    expect(sa(`verify ${writeSeals(seals)} ${OLD}`).code).toBe(0);
    expect(sa(`archive ${writeSeals(seals)} ${OLD} 4321`).code).toBe(0);
    const r = sh(`bash scripts/ops/clean-start/seal-archive.sh retire ${writeSeals(seals)} ${OLD} 4321`);
    expect(r.code).toBe(0); // the stand-in answers every HEAD
    for (const s of seals) sb.put('photos', s.r2Key, s.bodyText);
    expect(sa(`verify ${writeSeals(seals)} ${OLD}`).code).toBe(0);
    const forbidden = sb.run(`bash scripts/ops/clean-start/seal-archive.sh retire ${writeSeals(seals)} ${OLD} 4321`, {
      FAKE_S3_HEAD_FORBIDDEN: '00000001.json',
    });
    ALL_LINES.push(...forbidden.lines);
    expect(forbidden.code).toBe(1);
    expect(forbidden.lines).toContain('old seal files removed from the live folder, each with a verified archive copy: no');
  });

  it('no old chain: nothing to archive or retire', () => {
    writeFileSync(join(sb.csDir, 'empty.jsonl'), '');
    expect(sa(`verify "$CS_DIR/empty.jsonl" none`).lines).toContain('old seal chain present: no');
    expect(sa(`archive "$CS_DIR/empty.jsonl" none ${RUN}`).lines).toEqual(['old seals to archive: no']);
  });
});

// ── photo-delete.sh ──────────────────────────────────────────────────────

describe('photo-delete.sh: refuses unless it is safe, then deletes only the right keys', () => {
  const key = (n: number, kind = 'CR') => `2026/10/0${(n % 9) + 1}/user${n}/${kind}/${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd.jpg`;
  const keys = [key(1), key(2), key(3, 'SHOP'), key(4), key(5), 'legacy/odd key.jpg', key(6)];
  const listText = keys.slice().sort().join('\n') + '\n';
  const listSum = sha(listText);
  const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
  const pd = (args: string, env: Record<string, string> = {}) => sh(`bash scripts/ops/clean-start/photo-delete.sh ${args}`, env);
  const files = (row: string, prod: string[], uat: string[] = []) => {
    writeFileSync(join(sb.csDir, 'list.txt'), listText);
    writeFileSync(join(sb.csDir, 'row.txt'), row);
    writeFileSync(join(sb.csDir, 'prod.txt'), prod.join('\n') + (prod.length ? '\n' : ''));
    writeFileSync(join(sb.csDir, 'uat.txt'), uat.join('\n') + '\n');
    return '"$CS_DIR/list.txt" "$CS_DIR/row.txt" "$CS_DIR/prod.txt"';
  };

  it('refuses before 7 days', () => {
    const r = pd(`check ${files(`${Math.floor(Date.now() / 1000) - 6 * 86400}\t${listSum}\tx\n`, [])}`, { LIST_SHA256: listSum });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('the reset is at least 7 days old: no');
  });

  it('refuses when the reset row is not there', () => {
    expect(pd(`check ${files('', [])}`, { LIST_SHA256: listSum }).code).toBe(1);
  });

  it('refuses when the typed value, the row and the list do not all agree', () => {
    expect(pd(`check ${files(`${eightDaysAgo}\t${listSum}\tx\n`, [])}`, { LIST_SHA256: sha('typo') }).code).toBe(1);
    expect(pd(`check ${files(`${eightDaysAgo}\t${sha('other')}\tx\n`, [])}`, { LIST_SHA256: listSum }).code).toBe(1);
  });

  it('refuses EVERYTHING when production still references one listed key (a rollback happened)', () => {
    const r = pd(`check ${files(`${eightDaysAgo}\t${listSum}\tx\n`, ['2026/12/01/new/CR/x.jpg', key(4)])}`, { LIST_SHA256: listSum });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('production references none of the listed photos: no');
  });

  it('passes when all hold', () => {
    const r = pd(`check ${files(`${eightDaysAgo}\t${listSum}\tx\n`, ['2026/12/01/new/CR/x.jpg'])}`, { LIST_SHA256: listSum });
    expect(r.code).toBe(0);
  });

  it('delete: skips keys without the photo shape and keys UAT uses; batches; each confirmed gone', () => {
    for (const k of keys) sb.put('photos', k, 'jpeg');
    sb.put('photos', '2026/10/01/unbound/CR/never-listed.jpg', 'jpeg'); // an upload no record points to
    files(`${eightDaysAgo}\t${listSum}\tx\n`, [], [key(5)]);
    const before = sb.s3Calls().length;
    const r = pd('delete "$CS_DIR/list.txt" "$CS_DIR/uat.txt"', { PHOTO_DELETE_BATCH: '2' });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      'test environment checked for shared photos: yes',
      'keys skipped because they do not have the photo shape: yes',
      'keys kept because the test environment uses them: yes',
      'every photo to delete is confirmed gone: yes',
    ]);
    for (const k of [key(1), key(2), key(3, 'SHOP'), key(4), key(6)]) expect(sb.has('photos', k)).toBe(false);
    expect(sb.has('photos', key(5))).toBe(true);
    expect(sb.has('photos', 'legacy/odd key.jpg')).toBe(true);
    expect(sb.has('photos', '2026/10/01/unbound/CR/never-listed.jpg')).toBe(true);
    const deletes = sb.s3Calls().slice(before).filter((c) => c.op === 'delete');
    expect(deletes).toHaveLength(5);
    expect(Math.max(...deletes.map((c) => Number(c.batch)))).toBe(2);
    expect(deletes.every((c) => c.accessKeyId === 'rw-key')).toBe(true);
    expect(readFileSync(join(sb.csDir, 'photo-delete.counts'), 'utf8').trim()).toBe('7 1 1 5');
    // Never listed by prefix.
    expect(sb.s3Calls().slice(before).some((c) => c.op === 'list')).toBe(false);
  });

  it('a HEAD answered 403 (not "not found") is "still there": the step fails, never reports gone', () => {
    const k = key(7);
    const one = `${k}\n`;
    writeFileSync(join(sb.csDir, 'one.txt'), one);
    sb.put('photos', k, 'jpeg');
    const r = pd('delete "$CS_DIR/one.txt"', { FAKE_S3_HEAD_FORBIDDEN: k });
    expect(r.code).toBe(1);
    expect(r.lines).toContain('every photo to delete is confirmed gone: no');
    expect(readFileSync(join(sb.csDir, 'photo-delete.counts'), 'utf8').trim()).toBe('1 0 0 0');
  });

  it('a batch size can only be made smaller, never above 1000', () => {
    const src = readFileSync('scripts/ops/clean-start/photo-delete.sh', 'utf8');
    expect(src).toMatch(/\[ "\$BATCH" -le 1000 \] \|\| BATCH=1000/);
  });
});

// ── compare-watch.ts ─────────────────────────────────────────────────────

describe('compare-watch.ts: production\'s first run against night 1', () => {
  const exp = loadExpected();
  const rows = (over: Record<string, string> = {}, sigs: string[] = []) =>
    Object.entries(exp.night1).map(([id, st]) => ({ checkId: id, status: over[id] ?? st[0]!, sigs: id === 'seal-offsite-copies' ? sigs : [] }));

  it('the expected table passes; a wrong status or a missing check does not', () => {
    expect(compareFirstRun(rows(), []).ok).toBe(true);
    expect(compareFirstRun(rows({ 'history-matches-master': 'fail' }), []).ok).toBe(false);
    expect(compareFirstRun(rows().filter((r) => r.checkId !== 'seal-written'), []).ok).toBe(false);
  });

  it('foreign seals: seal-offsite-copies must fail with exactly the listed keys open', () => {
    const keys = ['seals/v1/9999999999999999/00000000.json'];
    const sig = foreignSignature(keys[0]!);
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, [sig]), keys).ok).toBe(true);
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, [sig, 'deadbeefdeadbeef']), keys).ok).toBe(false);
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'pass' }), keys).ok).toBe(false);
  });

  it('mode finish: findings that MAY be there (a scheduled first run before the old files went) pass; anything else does not', () => {
    const old = ['seals/v1/a1b2c3d4e5f60718/00000000.json', 'seals/v1/a1b2c3d4e5f60718/00000001.json'];
    const uat = 'seals/v1/8888888888888888/00000004.json';
    const may = [...old, uat];
    const sigs = (ks: string[]) => ks.map(foreignSignature);
    // The scheduled 02:30 run listed the old chain's files (still there) and another environment's.
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, sigs(may)), [], exp, may).ok).toBe(true);
    // Or only some of them.
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, sigs([uat])), [], exp, may).ok).toBe(true);
    // finish made its own first run after removing them, and nothing else is there.
    expect(compareFirstRun(rows(), [], exp, may).ok).toBe(true);
    // A finding outside the list is a mismatch; so is a fail with nothing open.
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, sigs([...may, 'seals/v1/7777777777777777/00000000.json'])), [], exp, may).ok).toBe(false);
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, []), [], exp, may).ok).toBe(false);
    // Before this fix, finish compared with PLAN's list only: the old chain's files made it red for good.
    expect(compareFirstRun(rows({ 'seal-offsite-copies': 'fail' }, sigs(old)), [uat]).ok).toBe(false);
  });

  it('reads the workflow\'s tab-separated read-back', () => {
    expect(parseReadBack('a-b\tpass\t\r\nc\tfail\tx,y\n\n')).toEqual([
      { checkId: 'a-b', status: 'pass', sigs: [] },
      { checkId: 'c', status: 'fail', sigs: ['x', 'y'] },
    ]);
  });
});

// ── the public log rule, over everything printed above ──────────────────

describe('the work folder: no default, refused when missing (it was a job env: value GitHub refused)', () => {
  // Each job's first step sets CS_DIR from RUNNER_TEMP. A step that ran without
  // it (an always() step after that first step failed) must not invent a folder:
  // shred removes the folder, and the scripts write plaintext into it.
  const calls = [
    ['run.sh shred', 'bash scripts/ops/clean-start/run.sh shred', 'clean start refused'],
    ['run.sh safety-cleanup', 'bash scripts/ops/clean-start/run.sh safety-cleanup', 'clean start refused'],
    ['seal-archive.sh verify', 'bash scripts/ops/clean-start/seal-archive.sh verify x.jsonl none', 'seal archive refused'],
    ['photo-delete.sh check', 'bash scripts/ops/clean-start/photo-delete.sh check a b c', 'photo deletion refused'],
  ] as const;
  it.each(calls)('%s refuses an unset, empty, relative or root CS_DIR, before anything else', (_n, cmd, who) => {
    for (const v of ['', 'relative/work', '/', 'C:x', 'a:b']) {
      const before = readdirSync(sb.root).sort();
      const r = sh(`${v === '' ? 'unset CS_DIR; ' : ''}${cmd}`, { CS_DIR: v, RUNNER_TEMP: sb.root });
      expect(r.code, `CS_DIR=${JSON.stringify(v)}`).toBe(1);
      expect(r.lines).toEqual([`::error::${who}: the private work folder is not set, or not an absolute path`]);
      expect(readdirSync(sb.root).sort(), 'nothing created or removed').toEqual(before);
    }
    expect(existsSync(sb.csDir)).toBe(true);
  });

  // A drive path is for the local tests on Windows only: on Linux (the hosted
  // runner) "C:/x" is a relative folder. uname is replaced by an exported
  // function, so this holds on any host.
  it.each(calls)('%s refuses a drive path when bash does not run on Windows', (_n, cmd, who) => {
    for (const v of ['C:/work', 'C:' + String.fromCharCode(92) + 'work']) {
      const before = readdirSync(sb.root).sort();
      const r = sh(`uname() { echo Linux; }; export -f uname; ${cmd}`, { CS_DIR: v, RUNNER_TEMP: sb.root });
      expect(r.code, `CS_DIR=${JSON.stringify(v)}`).toBe(1);
      expect(r.lines).toEqual([`::error::${who}: the private work folder is not set, or not an absolute path`]);
      expect(readdirSync(sb.root).sort(), 'nothing created or removed').toEqual(before);
    }
  });
});

describe('the public log rule', () => {
  it('everything these commands printed is a step, yes/no, SQLSTATE, check status, duration or hash — and nothing secret', () => {
    expect(ALL_LINES.length).toBeGreaterThan(80);
    const v = publicLogViolations(
      ALL_LINES.filter((l) => !/^(?:age1|AGE-SECRET|# |Public key:)|^[0-9a-f]{40}$|^\d{4}-\d{2}-\d{2}$/.test(l)),
      FORBIDDEN
    );
    expect(v).toEqual([]);
  });

  it('every GITHUB_ENV value the commands above wrote is declared, of its shape, or masked (step env headers are public)', () => {
    const text = readEnvFile();
    for (const name of ['DIRECT_URL', 'CS_COMMITTED', 'NEW_CHAIN', 'CS_NEON_BRANCH_ID']) expect(text).toContain(`${name}=`);
    expect(envHeaderViolations(text)).toEqual([]);
    // and the rule can fail
    expect(envHeaderViolations('BACKUP_KEY=db/x\n')).not.toEqual([]);
    expect(envHeaderViolations('SOMETHING_NEW=1\n')).not.toEqual([]);
  });

  it('prod-target masks the cleaned connection string before handing it on (it can differ from the secret GitHub masks)', () => {
    const r = run('prod-target read', { PROD_URL_RAW: `  ${PROD_URL}\r\n`, CONFIRM_HOST: MARKER, GITHUB_ENV: envFile() });
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`::add-mask::${PROD_URL}`);
    expect(r.out.indexOf('::add-mask::')).toBeLessThan(r.out.indexOf('connection is production'));
  });

  it('the rule would catch a count, a key, a URL and a name (it can fail)', () => {
    expect(publicLogViolations(['customers removed: 12'])).not.toEqual([]);
    expect(publicLogViolations(['plan id: 12'])).not.toEqual([]);
    expect(publicLogViolations(['upload: ./x to s3://b/k'])).not.toEqual([]);
    expect(publicLogViolations(['seal: seals/v1/aaaa/00000001.json: yes'])).not.toEqual([]);
    expect(publicLogViolations(['owner: yes'], ['owner'])).not.toEqual([]);
    expect(publicLogViolations(['photo 2026/10/01/u1/CR/x.jpg: yes'])).not.toEqual([]);
    expect(publicLogViolations(['reset: ok', 'history-open-interval: pass', 'restore took 3 s'])).toEqual([]);
  });
});
