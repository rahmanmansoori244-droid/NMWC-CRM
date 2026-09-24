// @vitest-environment node
/**
 * GAP-06/07/08 (re-benchmark 2026-09-24) — three gates that did not exist, pinned
 * so a later edit cannot quietly take them away again.
 *
 * What was true the day this file was written:
 *   - `npm run build` ran `prisma migrate deploy` before anything typechecked, so
 *     a type error surfaced only AFTER the migrations had been applied to the
 *     production database, leaving it migrated and undeployed.
 *   - The workflow named neither the browser suite nor the smoke suite. Both ran
 *     only when a person typed the command, and login.spec.ts had asserted a
 *     health-probe field that response has never carried — for months, green,
 *     because nothing ran it.
 *
 * Every assertion below compares two real files to each other: the workflow to the
 * spec and the script it invokes, the build script to its own step order. The one
 * list this file owns, JOBS, is compared against ci.yml's own job ids, because a
 * deleted job is the failure it exists to catch. Nothing here checks only itself —
 * this project has already found four guards that passed vacuously, one of them a
 * completeness list that only ever checked its own entries.
 *
 * ADDED 2026-09-24, second pass. The first version of this file matched the TEXT
 * of the retry loop — `for ATTEMPT in $(seq 1 24)` and `sleep 15` — and was green
 * while the loop provably could not retry: GitHub invokes every `run:` block as
 * `bash -e {0}`, `set -uo pipefail` does not clear an inherited `-e`, and the
 * first failing smoke attempt aborted the whole step. A guard that reads the
 * spelling of a loop cannot see that. So the two `run:` blocks that carry a
 * retry or a teardown are now EXECUTED here, by the same `bash -e` Actions uses,
 * with `npx` and `sleep` stubbed — the shell decides, not a regular expression.
 * Three mutations that used to keep this file green now fail it: dropping the
 * `|| CODE=$?`, turning the missing-bearer `exit 1` into `exit 0`, and putting
 * `if: vars.RUN_E2E == 'true'` on the browser job.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const CI_PATH = '.github/workflows/ci.yml';
const SMOKE_PATH = 'scripts/ops/smoke.ts';

/** The workflow exactly as GitHub reads it — comments included, because bash runs them. */
const RAW = readFileSync(CI_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * Comment lines are removed before anything is asserted TEXTUALLY. Each string
 * matched below also appears in the prose above the job that implements it, and a
 * comment that satisfies an assertion is a guard failing open while looking green.
 * The executed tests use RAW, since a shell comment is part of the script.
 */
const ci = RAW.split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

const jobsSection = ci.slice(ci.indexOf('\njobs:'));

/** Inside `jobs:` the only keys at two spaces are job ids; their properties sit at four. */
const jobIds = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);

/** One job's block, or '' when there is no such job. */
function jobBlock(id: string): string {
  const start = jobsSection.indexOf(`\n  ${id}:\n`);
  if (start < 0) return '';
  const rest = jobsSection.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The steps of one job, split on the `- ` that opens each list item. */
function stepBlocks(id: string): string[] {
  const block = jobBlock(id);
  const steps = block.slice(block.indexOf('\n    steps:'));
  return steps
    .split(/\n {6}- /)
    .slice(1)
    .map((s) => s.trimEnd());
}

/**
 * The `run:` script of one step, dedented exactly as GitHub hands it to bash.
 * Returns '' when the step or its script is not there, which the tests assert
 * against before running anything — an empty script would "pass" every scenario.
 */
function runScriptOf(stepName: string): string {
  const lines = RAW.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start < 0) return '';
  let at = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s+- name: /.test(lines[i]!)) break;
    if (/^\s+run: \|\s*$/.test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return '';
  const body: string[] = [];
  let indent = -1;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const own = line.length - line.trimStart().length;
    if (indent < 0) indent = own;
    if (own < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};
const build = pkg.scripts.build ?? '';
const smokeJob = jobBlock('post-deploy-smoke');
const e2eJob = jobBlock('e2e');
const smokeSrc = readFileSync(SMOKE_PATH, 'utf8');

/** The gates. Dropping any one of these jobs is what this list detects. */
const JOBS = [
  'lint-test-build',
  'db-tests',
  'restore-chain',
  'secrets-scan',
  'e2e',
  'post-deploy-smoke',
];

/**
 * bash, the way Actions has it. On Linux it is on PATH; on a Windows developer
 * box it ships with git, together with the coreutils the scripts use (`seq`,
 * `cut`, `grep`), so that directory is prepended to PATH for the child. There is
 * deliberately no skip-if-missing branch: a guard that quietly does not run is
 * the failure mode this whole file exists to end.
 */
let cachedBash: { bash: string; extraPath: string | null } | null = null;
function resolveBash(): { bash: string; extraPath: string | null } {
  if (cachedBash) return cachedBash;
  if (process.platform !== 'win32') {
    cachedBash = { bash: 'bash', extraPath: null };
    return cachedBash;
  }
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim().replace(/\\/g, '/');
  let dir = execPath;
  for (let up = 0; up < 6 && dir.includes('/'); up++) {
    const bin = `${dir}/usr/bin`;
    if (existsSync(`${bin}/bash.exe`)) {
      cachedBash = { bash: `${bin}/bash.exe`, extraPath: bin };
      return cachedBash;
    }
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
  throw new Error(
    'no bash found beside git: this guard executes the workflow step for real and cannot assert anything without one'
  );
}

type Outcome = { status: number; output: string; calls: string[] };

/**
 * Run a workflow `run:` script the way GitHub Actions does — `bash -e <file>` —
 * with `stubs` prepended. The inherited `-e` is the whole point: it is what made
 * the retry loop exit on its first iteration.
 */
function runStep(
  script: string,
  stubs: string,
  env: Record<string, string>,
  files: Record<string, string> = {}
): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'nmwc-ci-gate-'));
  try {
    writeFileSync(join(dir, 'step.sh'), `${stubs}\n${script}`, 'utf8');
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
    const { bash, extraPath } = resolveBash();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, STUB_DIR: dir.replace(/\\/g, '/') };
    // Windows spells it `Path`; two spellings in one environment block is a
    // coin toss for which one the child resolves commands with.
    for (const k of Object.keys(childEnv)) if (k.toLowerCase() === 'path') delete childEnv[k];
    childEnv.PATH = extraPath
      ? extraPath + delimiter + (process.env.PATH ?? '')
      : (process.env.PATH ?? '');
    Object.assign(childEnv, env);
    const res = spawnSync(bash, ['-e', 'step.sh'], {
      cwd: dir,
      env: childEnv,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const callsFile = join(dir, 'calls');
    return {
      status: res.status ?? -1,
      output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
      calls: existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
        : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------- *
 * Fabricated smoke output. The two check NAMES and the line format are
 * asserted against scripts/ops/smoke.ts below, so a rename there turns this
 * file red instead of silently breaking the workflow's grep.
 * ------------------------------------------------------------------------- */
const COMMIT_CHECK = 'production is running the commit you think it is';
const CRON_CHECK = 'monitor bearer unlocks the detail, and no cron job is alarming';
const SHA = 'abc1234def567890abc1234def567890abc1234d';

function checkLine(ok: boolean, name: string, detail: string): string {
  return `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`;
}

/** One run's stdout, as smoke.ts prints it. */
function smokeOutput(opts: {
  serving: boolean;
  cron: 'quiet' | 'alarming' | 'probe-failed' | 'probe-errored';
  alsoBroken?: boolean;
}): string {
  const rows = [
    checkLine(true, 'health (anonymous)', '200 {"status":"ok"} keys=1'),
    checkLine(!opts.alsoBroken, 'login page renders', '200, 41234 bytes'),
    checkLine(
      opts.serving,
      COMMIT_CHECK,
      opts.serving ? 'running abc1234, expected abc1234' : 'running 0ffee12, expected abc1234'
    ),
    opts.cron === 'quiet'
      ? checkLine(true, CRON_CHECK, '200 alarms=[] failed=[]')
      : opts.cron === 'alarming'
        ? checkLine(false, CRON_CHECK, '503 alarms=[db-backup,retention-sweep] failed=[]')
        : opts.cron === 'probe-failed'
          ? // R2 unreachable AND a job that has not run: the excuse must not
            // swallow the first because of the second.
            checkLine(false, CRON_CHECK, '503 alarms=[db-backup] failed=[r2]')
          : // The probe itself answered 500, or refused the bearer: nothing alarms
            // and nothing is named, and this is NOT a job that has not run yet.
            checkLine(false, CRON_CHECK, '500 alarms=[] failed=[]'),
  ];
  const failed = rows.filter((r) => r.startsWith('FAIL')).length;
  return [
    '',
    'Smoke test — https://nmwc-cm.vercel.app',
    'with the monitor bearer',
    '='.repeat(72),
    ...rows,
    '='.repeat(72),
    failed ? `${failed} of ${rows.length} FAILED` : `all ${rows.length} checks passed`,
    '',
  ].join('\n');
}

type Attempt = { code: number; out: string };

const SMOKE_STEP = 'Wait for production to serve this commit, then smoke it';
const smokeScript = runScriptOf(SMOKE_STEP);

/** Run the smoke step with `npx` answering each attempt in turn and `sleep` instant. */
function runSmokeStep(attempts: Attempt[], env: Record<string, string> = {}): Outcome {
  const stubs = [
    'CALLS=0',
    'npx() {',
    '  CALLS=$((CALLS + 1))',
    '  echo "npx $*" >> "$STUB_DIR/calls"',
    '  if [ -f "$STUB_DIR/out-$CALLS" ]; then',
    '    cat "$STUB_DIR/out-$CALLS"',
    '    return "$(cat "$STUB_DIR/code-$CALLS")"',
    '  fi',
    `  cat "$STUB_DIR/out-${attempts.length}"`,
    `  return "$(cat "$STUB_DIR/code-${attempts.length}")"`,
    '}',
    'sleep() { echo "sleep $*" >> "$STUB_DIR/calls"; }',
  ].join('\n');
  const files: Record<string, string> = {};
  attempts.forEach((a, i) => {
    files[`out-${i + 1}`] = a.out;
    files[`code-${i + 1}`] = String(a.code);
  });
  return runStep(
    smokeScript,
    stubs,
    {
      GITHUB_SHA: SHA,
      HEALTH_BEARER: 'a-monitor-bearer-long-enough-to-be-usable',
      ...env,
    },
    files
  );
}

/** How many times the stub smoke script was invoked. */
function smokeRuns(o: Outcome): number {
  return o.calls.filter((c) => c.includes('smoke.ts')).length;
}

describe('the build cannot migrate production before it typechecks', () => {
  it('still generates the client, still migrates, still builds', () => {
    // Anchors. If any of the three steps is renamed the ordering assertions below
    // would compare -1 against -1 and pass on nothing at all.
    expect(build).toContain('prisma generate');
    expect(build).toContain('prisma migrate deploy');
    expect(build).toContain('next build');
  });

  it('typechecks BEFORE the migrate step', () => {
    // `next build` typechecks too, but it runs last — which is the whole defect:
    // the migrations are already applied by the time it says no.
    const tsc = build.indexOf('tsc --noEmit');
    expect(tsc, 'the build script must typecheck').toBeGreaterThan(-1);
    expect(tsc).toBeLessThan(build.indexOf('prisma migrate deploy'));
  });

  it('still migrates ahead of the build, which is why the order matters', () => {
    // Not decoration: this coupling is the reason a late failure is expensive.
    // Remove the migrate step and the app stops deploying its own schema.
    expect(build.indexOf('prisma migrate deploy')).toBeLessThan(build.indexOf('next build'));
  });
});

describe('every gate in ci.yml is still wired', () => {
  it('found the workflow and its jobs at all', () => {
    expect(ci.length).toBeGreaterThan(2000);
    expect(jobIds.length).toBeGreaterThanOrEqual(JOBS.length);
  });

  it('declares every gate job', () => {
    expect(jobIds).toEqual(expect.arrayContaining(JOBS));
  });

  it('cannot be switched off by a repository variable', () => {
    // A job id that EXISTS is not a job that RUNS. `if: vars.RUN_E2E == 'true'`
    // added to the browser job left all fourteen of this file's assertions green
    // while disabling the Playwright gate the same change had just added — and in
    // the Actions UI a job skipped behind a variable is indistinguishable from a
    // gate that is working. That is the restore drill's 127 skipped runs exactly.
    for (const id of JOBS) {
      const block = jobBlock(id);
      expect(block.length, `${id} has a body`).toBeGreaterThan(100);
      expect(block, `${id} must not consult vars.`).not.toMatch(/vars\./);
    }
  });

  it('cannot be made to pass while failing', () => {
    // `continue-on-error: true` is the other way to keep a green tick over a red
    // gate. Nothing read it before this line existed.
    for (const id of JOBS) {
      const soft = [...jobBlock(id).matchAll(/continue-on-error:\s*(\S+)/g)].map((m) => m[1]!);
      expect(soft.filter((v) => v !== 'false'), `${id} fails when it fails`).toEqual([]);
    }
  });

  it('the browser gate carries no condition at all', () => {
    // Job-level keys sit at four spaces; step-level `if: failure()` at eight.
    // e2e must run on every push — it has nothing to be conditional on.
    expect(e2eJob.length).toBeGreaterThan(100);
    expect(/^ {4}if:/m.test(e2eJob), 'the e2e job must not be conditional').toBe(false);
  });
});

describe('the browser suite runs in CI, and not by pointing at the directory', () => {
  const invocations = [...ci.matchAll(/playwright test ([^\n]*)/g)].map((m) => m[1]!);
  const named = invocations.flatMap((args) => args.match(/tests\/e2e\/[\w.-]+\.spec\.ts/g) ?? []);

  it('invokes playwright at all', () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  it('names spec files that exist', () => {
    // Both halves matter. An invocation with no spec path runs the whole
    // directory — which drags in the spec that skips itself. A path that no
    // longer exists is a rename that left the gate pointing at nothing.
    expect(named.length).toBeGreaterThan(0);
    for (const spec of named) expect(existsSync(spec), `${spec} exists`).toBe(true);
    for (const args of invocations) {
      expect(args, 'playwright is given a spec path, never the directory').toMatch(
        /tests\/e2e\/[\w.-]+\.spec\.ts/
      );
    }
  });

  it('does not wire the spec that skips itself', () => {
    // golive-update-flow.spec.ts needs live Cloudflare R2 credentials — the
    // browser PUTs three photographs to a presigned URL — and the only bucket
    // that exists holds real customers' shopfronts. It gates itself off, so
    // wiring it would add a job step that reports "skipped" for ever: the shape
    // of the restore drill that reported skipped for 127 consecutive runs.
    //
    // If that gate is ever removed this goes red, so making the spec CI-runnable
    // is a decision someone takes deliberately rather than by accident.
    const golive = 'tests/e2e/golive-update-flow.spec.ts';
    expect(existsSync(golive), `${golive} is the spec being reasoned about`).toBe(true);
    expect(readFileSync(golive, 'utf8')).toMatch(/test\.skip\(/);
    expect(readFileSync(golive, 'utf8')).toMatch(/RUN_GOLIVE_E2E/);
    expect(named).not.toContain(golive);
  });

  it('is bounded by a STEP budget below the job budget, so the traces survive', () => {
    // A job cancelled by its own timeout-minutes does not run `if: failure()`
    // steps: the trace upload would be skipped in the one case it exists for.
    // A step that exceeds ITS budget fails the step and the job carries on.
    const jobBudget = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(e2eJob)?.[1] ?? NaN);
    const suite = stepBlocks('e2e').find((s) => s.includes('playwright test'));
    expect(suite, 'the step that runs the suite').toBeTruthy();
    const stepBudget = Number(/timeout-minutes: (\d+)/.exec(suite ?? '')?.[1] ?? NaN);
    expect(jobBudget, 'the job keeps a backstop budget').toBeGreaterThan(0);
    expect(stepBudget, 'the suite step has its own budget').toBeGreaterThan(0);
    expect(stepBudget, 'the step budget must fire first').toBeLessThan(jobBudget);
    // And the upload it protects is still the failure-only one.
    const upload = stepBlocks('e2e').find((s) => s.includes('upload-artifact'));
    expect(upload ?? '', 'the trace upload runs on failure').toMatch(/if: failure\(\)/);
  });
});

describe('the smoke suite runs after a deploy to main', () => {
  it('has the job at all', () => {
    expect(smokeJob.length).toBeGreaterThan(200);
  });

  it('invokes the smoke script, at the path that exists', () => {
    expect(smokeJob).toContain(SMOKE_PATH);
    expect(existsSync(SMOKE_PATH)).toBe(true);
  });

  it('asserts the commit that was just pushed', () => {
    // Without --expect-commit the suite passes against whatever build happens to
    // be live, which is how production served a four-month-old build for weeks.
    // The sha has to come from the push, not from a literal somebody updates.
    expect(smokeJob).toMatch(/--expect-commit "\$GITHUB_SHA"/);
  });

  it('runs on main, behind no variable anybody has to create', () => {
    const cond = /^\s+if: (.+)$/m.exec(smokeJob)?.[1] ?? '';
    expect(cond).toContain("github.ref == 'refs/heads/main'");
    // The 127-skipped-runs lesson: `&& vars.SOMETHING == 'true'` in a condition
    // is indistinguishable, in the Actions UI, from a gate that is working.
    expect(cond).not.toMatch(/vars\./);
  });

  it('fails loudly without the monitor bearer instead of skipping', () => {
    // keep-warm.yml warns and exits 0 when its secret is absent, which is right
    // for a warming ping and wrong here: the commit production runs is readable
    // only with this bearer, so no bearer means the deploy went unverified.
    expect(smokeJob).toMatch(/HEALTH_BEARER/);
    expect(smokeJob).toMatch(/::error::[^\n]*HEALTH_BEARER/);
    expect(smokeJob).not.toMatch(/::warning::[^\n]*HEALTH_BEARER/);
  });

  it('greps for lines scripts/ops/smoke.ts actually prints', () => {
    // The workflow reads smoke's own output to tell "the deploy has not landed"
    // from "a scheduled job has not run". Both facts live in two files, so pin
    // them to each other: renaming a check or the line format in smoke.ts turns
    // this red instead of quietly making the workflow's grep match nothing —
    // which would look like a deploy that never arrived.
    expect(smokeSrc).toContain(`name: '${COMMIT_CHECK}'`);
    expect(smokeSrc).toContain(`name: '${CRON_CHECK}'`);
    expect(smokeSrc).toContain(
      "`${line.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(46)} ${line.detail}`"
    );
    expect(smokeSrc).toMatch(/alarms=\[/);
    expect(smokeSrc).toMatch(/failed=\[/);
    expect(smokeJob).toContain(COMMIT_CHECK);
    expect(smokeJob).toContain('monitor bearer unlocks the detail');
  });
});

/**
 * The retry is EXECUTED, not read. `bash -e step.sh` is exactly how Actions
 * invokes a `run:` block, and the previous version of this section matched
 * `for ATTEMPT in $(seq 1 24)` while that inherited `-e` made the loop exit on
 * its first iteration.
 */
describe('the smoke step really does wait for the deploy', () => {
  it('found the step and its script', () => {
    // Without this the scenarios below would run an empty script and pass.
    expect(smokeScript.length, `${SMOKE_STEP} has a run: block`).toBeGreaterThan(500);
    expect(smokeScript).toContain('--expect-commit');
  });

  it('a failing attempt is followed by another attempt', () => {
    // THE finding. Three attempts find the previous build — which is the normal
    // case, because Vercel deploys in parallel with this workflow — and the
    // fourth finds this commit. Under an inherited -e the step died on the first.
    const o = runSmokeStep([
      { code: 1, out: smokeOutput({ serving: false, cron: 'quiet' }) },
      { code: 1, out: smokeOutput({ serving: false, cron: 'quiet' }) },
      { code: 1, out: smokeOutput({ serving: false, cron: 'quiet' }) },
      { code: 0, out: smokeOutput({ serving: true, cron: 'quiet' }) },
    ]);
    expect(smokeRuns(o), o.output).toBe(4);
    expect(o.status, o.output).toBe(0);
    expect(o.output).toContain('every check passed');
    expect(o.calls.filter((c) => c.startsWith('sleep')).length).toBe(3);
  });

  it('goes red, after retrying, when production never serves the commit', () => {
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: false, cron: 'quiet' }) }]);
    expect(o.status, o.output).toBe(1);
    // The budget is not pinned, the mechanism is: more than one attempt was made.
    expect(smokeRuns(o)).toBeGreaterThan(1);
    expect(o.output).toContain('still not serving');
  });

  it('does not retry a refusal, because waiting cannot fix it', () => {
    // Exit 2 is smoke saying the bearer is unusable or the flag lost its value.
    const o = runSmokeStep([{ code: 2, out: 'refusing to run\n' }]);
    expect(o.status, o.output).toBe(1);
    expect(smokeRuns(o)).toBe(1);
    expect(o.output).toContain('Not retrying');
  });

  it('exits NON-ZERO without the monitor bearer, and runs nothing', () => {
    // ::error:: plus exit 0 is a SUCCESS in GitHub Actions: the annotation is
    // decoration, the exit code is the gate. A reviewer changed this `exit 1` to
    // `exit 0` and the old assertion on the ::error:: string stayed green.
    const o = runSmokeStep([{ code: 0, out: smokeOutput({ serving: true, cron: 'quiet' }) }], {
      HEALTH_BEARER: '',
    });
    expect(o.status, o.output).not.toBe(0);
    expect(o.output).toMatch(/::error::[^\n]*HEALTH_BEARER/);
    expect(smokeRuns(o), 'nothing is smoked without a bearer').toBe(0);
  });
});

/**
 * What this job gates on. Presenting the bearer also adds smoke's cron dead-man
 * check, which alarms on a scheduled job that has NO recorded run — `never` in
 * lib/heartbeat.ts, the state of every heartbeat until its job has run once. Left
 * gating, this job would be red on every push for a reason that has nothing to do
 * with the deploy, and a gate that is red for an unrelated reason gets switched
 * off: that is how this project collected 127 vacuous drill runs.
 */
describe('the smoke step is red for the DEPLOY, not for a job that has not run yet', () => {
  it('a cron heartbeat alarm alone does not fail the deploy gate', () => {
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron: 'alarming' }) }]);
    expect(o.status, o.output).toBe(0);
    expect(smokeRuns(o), 'it recognises this immediately').toBe(1);
    expect(o.output).toMatch(/::notice::/);
    // And it says out loud what it did not assert.
    expect(o.output).toContain('does not gate');
  });

  it('a FAILED probe inside that same check is not excused', () => {
    // `failed=[…]` is the database, R2 or heartbeat-readability probe — things a
    // bad deploy does break. Only `alarms=[…]` is about a job that has not run,
    // and here both are true at once: the alarm must not carry the probe through.
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron: 'probe-failed' }) }]);
    expect(o.status, o.output).toBe(1);
    expect(o.output).toContain('about the DEPLOY');
    // And it says so at once: waiting cannot mend a deploy that landed broken.
    expect(smokeRuns(o)).toBe(1);
  });

  it('the dead-man check failing with NO alarm named is not excused', () => {
    // `500 alarms=[] failed=[]` is the bearer probe erroring or refusing the
    // credential, not a scheduled job that has not run. Only a named alarm is
    // excused, so the excuse cannot swallow a broken /api/health.
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron: 'probe-errored' }) }]);
    expect(o.status, o.output).toBe(1);
    expect(o.output).toContain('about the DEPLOY');
  });

  it('a second failing check is not excused either', () => {
    const o = runSmokeStep([
      { code: 1, out: smokeOutput({ serving: true, cron: 'alarming', alsoBroken: true }) },
    ]);
    expect(o.status, o.output).toBe(1);
    expect(o.output).toContain('about the DEPLOY');
    expect(smokeRuns(o)).toBe(1);
  });

  it('a clean run still gates on everything', () => {
    // The excuse is a fallback, not the normal path: with nothing alarming the
    // job still requires smoke's own exit 0.
    const o = runSmokeStep([{ code: 0, out: smokeOutput({ serving: true, cron: 'quiet' }) }]);
    expect(o.status, o.output).toBe(0);
    expect(o.output).toContain('every check passed');
    expect(o.output).not.toMatch(/::notice::/);
  });
});

/**
 * The same inherited-`-e` mistake was in the e2e block. It is cosmetic there —
 * the step goes red either way — but the two lines after the suite never ran, so
 * the server was left up and the spec's exit code was never the step's own.
 */
describe('the e2e step tears its server down and reports the suite exit code', () => {
  const E2E_STEP = 'Serve the build and run the login spec against it';
  const script = runScriptOf(E2E_STEP);

  it('found the step and its script', () => {
    expect(script.length, `${E2E_STEP} has a run: block`).toBeGreaterThan(300);
    expect(script).toContain('playwright test');
  });

  it('kills next start and exits with the suite code when the suite fails', () => {
    const stubs = [
      'npx() {',
      '  echo "npx $*" >> "$STUB_DIR/calls"',
      '  case "$*" in',
      '    *"next start"*) return 0 ;;',
      '    *playwright*) echo "1 failed"; return 7 ;;',
      '    *) return 0 ;;',
      '  esac',
      '}',
      'curl() { echo "curl $*" >> "$STUB_DIR/calls"; return 0; }',
      'kill() { echo "kill $*" >> "$STUB_DIR/calls"; return 0; }',
      'sleep() { :; }',
    ].join('\n');
    const o = runStep(script, stubs, {});
    // Under an inherited -e the bare `npx playwright test` aborted here, so
    // neither of these was ever reached.
    expect(o.calls.some((c) => c.startsWith('kill')), o.output).toBe(true);
    expect(o.status, o.output).toBe(7);
  });
});
