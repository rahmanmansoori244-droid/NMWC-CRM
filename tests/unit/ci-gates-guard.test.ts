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
import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { runScriptOf as runScriptOfIn, runStep, type Outcome } from '../support/workflow-step';

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

/** The `run:` script of one step of ci.yml — see tests/support/workflow-step.ts. */
const runScriptOf = (stepName: string): string => runScriptOfIn(RAW, stepName);

/**
 * The workflow as GitHub reads it. The line-based helpers above stay for what bash
 * runs; anything about the workflow's STRUCTURE — which steps exist, which carry a
 * condition, what triggers it — is read from this, because a parser has no
 * spellings to miss (review, 2026-09-24).
 */
type Step = { name?: string; uses?: string; run?: string; [key: string]: unknown };
const workflow = load(RAW) as {
  on?: Record<string, unknown>;
  jobs?: Record<string, { if?: unknown; steps?: Step[] }>;
};
function stepsOf(id: string): Step[] {
  return workflow.jobs?.[id]?.steps ?? [];
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
  cron:
    | 'quiet'
    | 'alarming'
    | 'probe-failed'
    | 'probe-errored'
    | 'job-failed'
    | 'mixed'
    | 'stateless'
    | 'unknown'
    | 'refused';
  alsoBroken?: boolean;
}): string {
  /** The dead-man line for each case. Alarms are `job:state`, as smoke.ts prints them. */
  const CRON_DETAIL: Record<Exclude<typeof opts.cron, 'quiet'>, string> = {
    // Jobs that have simply not run: excused with a notice and no warning.
    alarming: '503 alarms=[db-backup:never,retention-sweep:stale] failed=[]',
    // R2 unreachable AND a job that has not run: the excuse must not swallow the
    // first because of the second.
    'probe-failed': '503 alarms=[db-backup:never] failed=[r2]',
    // The probe itself answered 500, or refused the bearer: nothing alarms and
    // nothing is named, and this is NOT a job that has not run yet.
    'probe-errored': '500 alarms=[] failed=[]',
    // A job whose last run FAILED. Excused, but as a ::warning:: — the step
    // cannot tell whether it predates this deploy (see the comment in ci.yml).
    'job-failed': '503 alarms=[keep-warm:failed] failed=[]',
    // One job idle, one failed: excused, and the failed one is still named.
    mixed: '503 alarms=[db-backup:never,keep-warm:failed] failed=[]',
    // An alarm with no readable state, in the two forms it can take: a bare key
    // (an older smoke) and `:unknown`, which is what smoke.ts prints when the
    // health payload has no state for that job. Neither is "has not run".
    stateless: '503 alarms=[db-backup] failed=[]',
    unknown: '503 alarms=[db-backup:unknown] failed=[]',
    // /api/health refused the bearer outright: what smoke prints on a 401.
    refused: '401 alarms=[] failed=[]',
  };
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
      : checkLine(false, CRON_CHECK, CRON_DETAIL[opts.cron]),
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
      // What Actions sets for this job, which only ever runs on a push to main
      // (runStep adds CI and GITHUB_ACTIONS). A step that branched on any of these
      // would otherwise be tested in an environment it never runs in (review,
      // 2026-09-24, on the R2 guard).
      GITHUB_JOB: 'post-deploy-smoke',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
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

  it('is one && chain, so a failing typecheck or lint STOPS the migrate', () => {
    // Every ordering assertion below compares positions, and positions say
    // nothing about what happens when a step fails: `next lint ; prisma migrate
    // deploy` or `next lint || true && prisma migrate deploy` keeps every position
    // and migrates production after a failed check (review, 2026-09-24). So the
    // script must be commands joined by `&&` and nothing else — no `;`, no `||`,
    // no pipe, no background `&`.
    // A NEWLINE is a separator too: sh runs `…next lint\nprisma migrate deploy`
    // as two lists, and the second migrates whatever the first said. And an
    // `npm run <x>` segment is only as safe as <x>, so those are followed and held
    // to the same rule (review, 2026-09-24).
    const plainChain = (script: string, seen: string[] = []): void => {
      expect(script, `"${script}" must be one line`).not.toMatch(/[\r\n]/);
      for (const seg of script.split(' && ')) {
        expect(seg.trim(), 'an empty command between two &&').not.toBe('');
        // `$(…)` and backticks run a command whose failure the chain never sees:
        // `echo $(tsc --noEmit)` passes whatever tsc said (review, 2026-09-24).
        expect(seg, `"${seg}" must be one plain command`).not.toMatch(/[;|&$`]/);
        // Followed with arguments too: `npm run lint --silent` runs the same script.
        const nested = /^\s*npm run (\S+)(?:\s|$)/.exec(seg)?.[1];
        if (nested && !seen.includes(nested)) {
          const body = pkg.scripts[nested];
          expect(body, `npm run ${nested} must exist`).toBeDefined();
          plainChain(body!, [...seen, nested]);
        }
      }
    };
    expect(build.split(' && ').length).toBeGreaterThanOrEqual(5);
    // Everything the deploy and CI run through npm: the build, and the three
    // scripts lint-test-build calls by name. `lint` and `test` were not held to
    // this, so `"test": "vitest run || true"` removed the unit gate (review,
    // 2026-09-24).
    for (const name of ['build', 'typecheck', 'lint', 'test']) {
      expect(pkg.scripts[name], `npm run ${name} must exist`).toBeDefined();
      plainChain(pkg.scripts[name]!);
      // npm runs `pre<name>` before and `post<name>` after, unasked: a `prebuild`
      // holding `prisma migrate deploy` would migrate before any check ran.
      expect(pkg.scripts[`pre${name}`], `no pre${name} script`).toBeUndefined();
      expect(pkg.scripts[`post${name}`], `no post${name} script`).toBeUndefined();
    }
  });

  it('typecheck clears the per-page route types first, so a deleted page cannot fail it', () => {
    // `next build` and `next dev` write .next/types/app/**/page.ts per page, and
    // `next typegen` never deletes one. Delete or rename a page and every later
    // typecheck failed on the orphan with TS2307 until someone cleared .next by
    // hand (review, 2026-09-24). Clearing them also makes the local typecheck the
    // one a fresh checkout — CI, Vercel — runs, which never has those files.
    const typecheck = pkg.scripts.typecheck ?? '';
    const clear = typecheck.search(/rmSync\('\.next\/types\/app'/);
    expect(clear, 'typecheck must clear .next/types/app').toBeGreaterThan(-1);
    expect(clear).toBeLessThan(typecheck.indexOf('next typegen'));
  });

  it('typechecks BEFORE the migrate step', () => {
    // `next build` typechecks too, but it runs last — which is the whole defect:
    // the migrations are already applied by the time it says no.
    const tsc = build.indexOf('tsc --noEmit');
    expect(tsc, 'the build script must typecheck').toBeGreaterThan(-1);
    expect(tsc).toBeLessThan(build.indexOf('prisma migrate deploy'));
  });

  it('lints BEFORE the migrate step, and does not rely on next build to do it', () => {
    // `next build` lints as well as typechecking, so a lint error was the other
    // half of the same hazard: migrations applied, then the build refuses.
    // Moving the lint ahead of the migrate and passing `--no-lint` to the build
    // keeps the total work the same (pre-flight review, 2026-09-24).
    const lint = build.search(/\b(next lint|npm run lint)\b/);
    expect(lint, 'the build script must lint').toBeGreaterThan(-1);
    expect(lint).toBeLessThan(build.indexOf('prisma migrate deploy'));
    // If the build's own lint pass is switched off, the explicit one above is the
    // only lint — which is exactly why it must come first.
    if (/next build[^&]*--no-lint/.test(build)) {
      expect(lint).toBeLessThan(build.indexOf('next build'));
    }
    // `npm run lint` must still BE the linter, or the step above lints nothing.
    if (/npm run lint/.test(build)) expect(pkg.scripts.lint).toMatch(/\bnext lint\b/);
  });

  it('generates route types BEFORE it typechecks, in the build and in CI', () => {
    // `typedRoutes` checks an href only through .next/types/link.d.ts, which
    // `next typegen` writes. A fresh checkout (Vercel, CI) has no .next, and tsc
    // says nothing about it: next-env.d.ts's reference to the missing routes.d.ts
    // is skipped, and `Route` from 'next' falls back to `string & {}`. Every href
    // goes unchecked and the typecheck is green (2026-09-24). Whether tsc then
    // actually rejects a bad href is typed-routes-guard.test.ts's job; this pins
    // that the types exist by the time it runs.
    const typegen = build.indexOf('next typegen');
    expect(typegen, 'the build script must generate route types').toBeGreaterThan(-1);
    expect(typegen).toBeLessThan(build.indexOf('tsc --noEmit'));
    // CI typechecks through `npm run typecheck`, not the build script.
    const typecheck = pkg.scripts.typecheck ?? '';
    expect(typecheck.indexOf('next typegen'), 'typecheck must generate route types').toBeGreaterThan(-1);
    expect(typecheck.indexOf('next typegen')).toBeLessThan(typecheck.indexOf('tsc --noEmit'));
    expect(stepBlocks('lint-test-build')).toContain('run: npm run typecheck');
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

  it('runs on every push, to every branch', () => {
    // A job that is wired but never TRIGGERED is the same gate switched off.
    // `on: push` → `on: workflow_dispatch` left every assertion in this file green
    // (adversarial review, 2026-09-24): nothing read the trigger at all.
    const on = /^on:\n((?: {2,}.*\n|\s*\n)*)/m.exec(ci)?.[1] ?? '';
    expect(on, 'ci.yml must have an on: block').not.toBe('');
    expect(on).toMatch(/^ {2}push:\s*$/m);
    // A filter under push narrows it: `branches: [main]` would take the gates off
    // every branch, which is where they run BEFORE anything reaches production.
    expect(on).not.toMatch(/\b(branches|branches-ignore|paths|paths-ignore|tags|tags-ignore):/);
  });

  it('no gate is conditional, except the smoke job on exactly main', () => {
    // `if: false` on db-tests left every assertion green, because the only
    // condition check rejected `vars.` — and `false` is not a variable. A gate job
    // carries NO job-level `if:` at all; job-level keys sit at four spaces, so a
    // step's `if: failure()` at eight is not what this reads.
    for (const id of JOBS) {
      const conds = [...jobBlock(id).matchAll(/^ {4}if:\s*(.+)$/gm)].map((m) => m[1]!.trim());
      if (id === 'post-deploy-smoke') {
        // Equality, not "contains": `github.ref == 'refs/heads/main' && false`
        // contains the ref and never runs.
        expect(conds, 'the smoke job runs on main and on nothing else').toEqual([
          "github.ref == 'refs/heads/main'",
        ]);
      } else {
        expect(conds, `${id} must not be conditional`).toEqual([]);
      }
    }
  });

  it('no step that runs a check is conditional — only evidence uploads may be', () => {
    // Job-level `if:` is covered above. A STEP-level `if: false` — or `if:
    // github.event_name == 'pull_request'` on a job that only runs on push — skips
    // that one step, and the job goes green having checked nothing: the smoke
    // step, `npm test`, the integration suites. The executed scenarios in this file
    // cannot see it either, because runScriptOf takes the `run:` block and not the
    // step's `if:`. Even `if: failure()` disables a check it sits on. So a
    // condition is allowed only on an artifact upload, which checks nothing.
    //
    // Read from the PARSED workflow, the way GitHub reads it. Two rounds of review
    // (2026-09-24) found spellings a line-based match missed: `- if:` as the first
    // key, then the flow style `- { if: false, run: npm test }`, a quoted `"if":`,
    // a list indented four spaces. A parser has no spellings.
    let conditional = 0;
    for (const id of JOBS) {
      for (const [i, step] of stepsOf(id).entries()) {
        if (!('if' in step)) continue;
        conditional += 1;
        const label = `${id} step ${i + 1} (${step.name ?? step.uses ?? step.run ?? '?'})`;
        expect(String(step.uses ?? ''), `${label}: only an upload may be conditional`).toMatch(
          /^actions\/upload-artifact@/
        );
        expect(step.run, `${label}: a conditional step must not run anything`).toBeUndefined();
      }
    }
    // The two uploads that exist today. Without this the loop can pass on nothing.
    expect(conditional).toBe(2);
  });

  it('every gate still runs its check — deleting the step is not a way to pass', () => {
    // Nothing required the checks to EXIST: deleting `- run: npm test`, or moving
    // it into a local composite action with its own `if:`, left lint-test-build
    // green with the unit suite gone (review, 2026-09-24). Each gate's defining
    // command must appear, verbatim, as a line of one of its own steps.
    const REQUIRED: Record<string, string[]> = {
      'lint-test-build': ['npm run typecheck', 'npm run lint', 'npm test', 'npx next build'],
      'db-tests': ['npx prisma migrate deploy', 'npx vitest run tests/integration'],
      e2e: ['npx next build', 'npx playwright test tests/e2e/login.spec.ts'],
      'restore-chain': ['npx tsx scripts/ops/restore-verify.ts'],
      'post-deploy-smoke': ['npx tsx scripts/ops/smoke.ts --expect-commit "$GITHUB_SHA"'],
    };
    for (const [id, commands] of Object.entries(REQUIRED)) {
      const lines = stepsOf(id).flatMap((s) =>
        String(s.run ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
      );
      for (const cmd of commands) {
        expect(
          lines.some((l) => l === cmd || l.startsWith(`${cmd} `)),
          `${id} must run: ${cmd}`
        ).toBe(true);
      }
    }
    expect(
      stepsOf('secrets-scan').some((s) => String(s.uses ?? '').startsWith('gitleaks/gitleaks-action@'))
    ).toBe(true);
    // And no gate hands its check to a local action, whose steps nothing here reads.
    for (const id of JOBS) {
      for (const s of stepsOf(id)) {
        expect(String(s.uses ?? ''), `${id}: no local composite action in a gate`).not.toMatch(/^\.{1,2}\//);
      }
    }
  });

  it('the parsed workflow agrees: triggered on every push, no gate job conditional', () => {
    // The same two facts the line-based tests above read, from GitHub's view of the
    // file, so a spelling those regular expressions miss cannot pass both.
    expect(Object.keys(workflow.on ?? {})).toEqual(['push']);
    expect(workflow.on?.push ?? null, 'push carries no branch or path filter').toBeNull();
    for (const id of JOBS) {
      const cond = workflow.jobs?.[id]?.if;
      if (id === 'post-deploy-smoke') expect(cond).toBe("github.ref == 'refs/heads/main'");
      else expect(cond, `${id} must not be conditional`).toBeUndefined();
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
    // Each alarm as `job:state`, with `unknown` when the payload has no state — the
    // exact shape the step's `(never|stale)` test reads.
    expect(smokeSrc).toContain("`${k}:${stateOf.get(k) ?? 'unknown'}`");
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

  /** What smoke prints while /api/health refuses the bearer: no commit to compare. */
  const refusedOutput = () => {
    const out = smokeOutput({ serving: false, cron: 'refused' }).replace(
      'running 0ffee12, expected abc1234',
      'running unknown, expected abc1234'
    );
    expect(out).toContain('running unknown,');
    return out;
  };

  it('waits through a refused bearer — the previous deployment right after a rotation', () => {
    // A Vercel variable reaches only deployments made after it, so the build still
    // live when a new bearer is set refuses it until this commit's deployment takes
    // over. That is a healthy deploy, and it happened on main on 2026-09-24;
    // failing fast on `unknown` (3b1632d) would have failed it (review, same day).
    const o = runSmokeStep([
      { code: 1, out: refusedOutput() },
      { code: 1, out: refusedOutput() },
      { code: 0, out: smokeOutput({ serving: true, cron: 'quiet' }) },
    ]);
    expect(o.status, o.output).toBe(0);
    expect(smokeRuns(o)).toBe(3);
  });

  it('names the bearer — and the deployment — when it is still refused at the end', () => {
    // Retrying for 12 minutes and then saying only "check the Vercel deployment"
    // sent the reader past the secret; saying only "it is the secret" sent them
    // past a deployment that predates it or broke its check. A 401 cannot tell
    // those apart from outside, so the error names both (review, 2026-09-24).
    const o = runSmokeStep([{ code: 1, out: refusedOutput() }]);
    expect(o.status, o.output).toBe(1);
    expect(smokeRuns(o)).toBeGreaterThan(1);
    expect(o.output).toMatch(/::error::[^\n]*REFUSED[^\n]*HEALTH_BEARER/);
    // And it sends the reader to the deployment as well — a message that merely
    // mentions one while concluding "this is the secret" is the misdirection.
    expect(o.output).toMatch(/::error::[^\n]*this commit's Vercel deployment as well as the secret/);
    expect(o.output).not.toMatch(/::error::[^\n]*This is the secret/);
    expect(o.output).not.toContain('still not serving');
  });

  it('does not let one blip on the LAST attempt hide every refusal before it', () => {
    // The cause was read from attempt 24 alone: 23 refusals then one network blip
    // printed "check the Vercel deployment" (review, 2026-09-24).
    const o = runSmokeStep([
      ...Array.from({ length: 23 }, () => ({ code: 1, out: refusedOutput() })),
      { code: 1, out: 'FAIL  health (anonymous)   threw: fetch failed\n1 of 1 FAILED\n' },
    ]);
    expect(o.status, o.output).toBe(1);
    expect(smokeRuns(o)).toBe(24);
    expect(o.output).toMatch(/::error::[^\n]*REFUSED/);
    expect(o.output).not.toContain('still not serving');
  });

  it('says the COMMIT is missing, not the secret, when the bearer was accepted', () => {
    // `running unknown` beside a dead-man line that answered 200 or 503 means the
    // bearer worked and VERCEL_GIT_COMMIT_SHA did not reach the deployment.
    const accepted = refusedOutput().replace('401 alarms=[] failed=[]', '503 alarms=[db-backup:never] failed=[]');
    expect(accepted).toContain('503 alarms=');
    const o = runSmokeStep([{ code: 1, out: accepted }]);
    expect(o.status, o.output).toBe(1);
    expect(o.output).toMatch(/::error::[^\n]*ACCEPTED[^\n]*VERCEL_GIT_COMMIT_SHA/);
    expect(o.output).not.toMatch(/::error::[^\n]*REFUSED/);
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

  it('a job whose last run FAILED does not gate the deploy, and is raised as a WARNING', () => {
    // Gated for a few hours on 2026-09-24, then reverted: the state smoke reads
    // was written by runs against the PREVIOUS deployment, and `failed` stands
    // until the next success — one failed nightly dump turned every merge red
    // for a day. Not gating is only acceptable if it is LOUD, so the job name
    // must reach a ::warning::, which the Actions summary shows, not a notice.
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron: 'job-failed' }) }]);
    expect(o.status, o.output).toBe(0);
    expect(o.output).toMatch(/::warning::[^\n]*LAST RUN FAILED[^\n]*keep-warm:failed/);
    expect(smokeRuns(o), 'the deploy has landed, so waiting cannot change it').toBe(1);
  });

  it('names the failed job when an idle one is alarming beside it', () => {
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron: 'mixed' }) }]);
    expect(o.status, o.output).toBe(0);
    expect(o.output).toMatch(/::warning::[^\n]*keep-warm:failed/);
    // Only the FAILED job is a warning; the idle one is not.
    expect(o.output).not.toMatch(/::warning::[^\n]*db-backup/);
  });

  it('raises no warning when every alarm is a job that simply has not run', () => {
    const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron: 'alarming' }) }]);
    expect(o.status, o.output).toBe(0);
    expect(o.output).not.toMatch(/::warning::/);
  });

  it('an alarm with no readable state is not excused, in either form', () => {
    // The `:unknown` form is the one smoke.ts actually prints; testing only the bare
    // key let `unknown` be added to the excused states with this file green.
    for (const cron of ['stateless', 'unknown'] as const) {
      const o = runSmokeStep([{ code: 1, out: smokeOutput({ serving: true, cron }) }]);
      expect(o.status, `${cron}: ${o.output}`).toBe(1);
      expect(o.output, cron).not.toMatch(/::notice::/);
    }
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
    const o = runStep(script, stubs, {
      GITHUB_JOB: 'e2e',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/claude/some-branch',
    });
    // Under an inherited -e the bare `npx playwright test` aborted here, so
    // neither of these was ever reached.
    expect(o.calls.some((c) => c.startsWith('kill')), o.output).toBe(true);
    expect(o.status, o.output).toBe(7);
  });
});
