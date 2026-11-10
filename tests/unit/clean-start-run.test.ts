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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sandbox, type Sandbox } from '../support/clean-start/sandbox';
import { publicLogViolations } from '../support/clean-start/public-log';
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
    expect(r.lines).toEqual(['connection is production, named by the owner: yes']);
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
    expect(run('backup-pick 4').code).toBe(1); // none
    const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
    const old = stamp(5 * 3600_000);
    sb.put('backups', `db/${old}.sql.gz.age`, 'x');
    sb.put('backups', `db/${old}.manifest.json`, '{}');
    expect(run('backup-pick 4').out).toMatch(/newest backup at most 4 h old: no/);
    expect(run('backup-pick 6').code).toBe(0);
    const fresh = stamp(600_000);
    sb.put('backups', `db/${fresh}.sql.gz.age`, 'x');
    expect(run('backup-pick 4').out).toMatch(/newest backup has a manifest: no/);
    sb.put('backups', `db/${fresh}.manifest.json`, '{}');
    const r = run('backup-pick 4', { GITHUB_OUTPUT: join(sb.root, 'out2') });
    expect(r.code).toBe(0);
    expect(readFileSync(join(sb.root, 'out2'), 'utf8')).toContain(`backup_key=db/${fresh}.sql.gz.age`);
    expect(run(`backup-pick 6 db/${old}.sql.gz.age`).out).toMatch(/the rehearsed backup is still the newest: no/);
  });

  it('neon-green: a green neon-rehearsal of these exact scripts within 14 days', () => {
    sh('git init -q . && git -c user.name=t -c user.email=t@t add scripts/ops/clean-start && git -c user.name=t -c user.email=t@t commit -qm t');
    const tree = sh('git rev-parse HEAD:scripts/ops/clean-start').out.trim();
    const head = 'f'.repeat(40);
    ghState({ cleanStartRuns: [] });
    expect(run('neon-green', gh).code).toBe(1);
    const runs = [{ id: 11, head_sha: head, display_title: 'Clean start neon-rehearsal' }];
    ghState({ cleanStartRuns: runs, jobs: { 11: [{ name: 'Neon rehearsal', conclusion: 'success' }] }, trees: { [head]: 'e'.repeat(40) } });
    expect(run('neon-green', gh).code).toBe(1); // other scripts
    ghState({ cleanStartRuns: runs, jobs: { 11: [{ name: 'Neon rehearsal', conclusion: 'failure' }] }, trees: { [head]: tree } });
    expect(run('neon-green', gh).code).toBe(1); // not green
    ghState({ cleanStartRuns: runs, jobs: { 11: [{ name: 'Neon rehearsal', conclusion: 'success' }] }, trees: { [head]: tree } });
    expect(run('neon-green', gh).lines).toEqual(['green Neon rehearsal of these scripts within 14 days: yes']);
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
      ['PROD_URL_RAW', 'CONFIRM_HOST', 'PROD_CRON_SECRET', 'BACKUP_AGE_RECIPIENTS', 'BACKUP_AGE_IDENTITY'].map((k) => [k, 'x'])
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

  it('restore: the old files back from the archive, the abandoned new chain moved aside', () => {
    // After a rollback: the live folder holds the NEW chain's genesis, the foreign objects, seq 0 still.
    sb.put('photos', `seals/v1/${NEW}/00000000.json`, '{"new":true}');
    writeFileSync(join(sb.csDir, 'foreign.txt'), FOREIGN.join('\n') + '\n');
    const r = sa(`restore ${writeSeals(seals)} ${OLD} ${RUN} "$CS_DIR/foreign.txt"`);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['old seal files back in the live folder, hash-checked: yes', 'the abandoned new chain moved out of the live folder: yes']);
    for (const s of seals) expect(sha(sb.read('photos', s.r2Key))).toBe(s.hash);
    expect(sb.has('photos', `seals/v1/${NEW}/00000000.json`)).toBe(false);
    expect(sb.read('backups', `cleanstart/${RUN}/abandoned-chain/seals/v1/${NEW}/00000000.json`).toString()).toBe('{"new":true}');
    for (const k of FOREIGN) expect(sb.has('photos', k)).toBe(true);
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

  it('reads the workflow\'s tab-separated read-back', () => {
    expect(parseReadBack('a-b\tpass\t\r\nc\tfail\tx,y\n\n')).toEqual([
      { checkId: 'a-b', status: 'pass', sigs: [] },
      { checkId: 'c', status: 'fail', sigs: ['x', 'y'] },
    ]);
  });
});

// ── the public log rule, over everything printed above ──────────────────

describe('the public log rule', () => {
  it('everything these commands printed is a step, yes/no, SQLSTATE, check status, duration or hash — and nothing secret', () => {
    expect(ALL_LINES.length).toBeGreaterThan(80);
    const v = publicLogViolations(
      ALL_LINES.filter((l) => !/^(?:age1|AGE-SECRET|# |Public key:)|^[0-9a-f]{40}$|^\d{4}-\d{2}-\d{2}$/.test(l)),
      FORBIDDEN
    );
    expect(v).toEqual([]);
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
