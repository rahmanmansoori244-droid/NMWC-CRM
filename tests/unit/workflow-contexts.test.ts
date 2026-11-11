// @vitest-environment node
/**
 * GitHub's "context availability" rule, checked locally for every workflow file.
 *
 * On 2026-11-11 GitHub refused BOTH clean-start workflow files before running a
 * single step: each job's env: held `CS_DIR: ${{ runner.temp }}/clean-start`,
 * and the runner context is not offered in a job's env: block. The repository's
 * own tests and its workflow emulator did not know the rule, so the local
 * rehearsal passed while the owner could not have started either workflow.
 *
 * This file holds every `${{ }}` expression (and every bare if: condition) of
 * every .github/workflows/*.yml to the table in GitHub's documentation
 * (docs.github.com, Actions reference, "Contexts" > "Context availability",
 * read 2026-11-11), by the place the expression sits: which contexts it may
 * name, and where the special functions (always, cancelled, success, failure,
 * hashFiles) may be called. A place the table does not list takes no
 * expression at all ("The listed contexts are only available for the given
 * workflow key, and may not be used anywhere else").
 *
 * The other workflow files are accepted by GitHub today, so they must pass
 * unchanged: if this test flags one of them, the TABLE below is wrong, not the
 * file. The mutations at the end prove it can fail (the rejected line put back,
 * a secret in a job's if:, ...), and that the emulator used by
 * tests/integration/clean-start-flow.test.ts refuses the same line.
 *
 * What it does not check: whether a named property exists (secrets.FOO), the
 * types inside an expression, or the shell of a run: block. The workflow-lint
 * job in ci.yml runs actionlint (with shellcheck) over the clean-start files.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { runWorkflow } from '../support/clean-start/emulator';

const DIR = '.github/workflows';
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();

// ── GitHub's table (Workflow key → Context, Special functions) ────────────────
const STATUS = ['always', 'cancelled', 'success', 'failure'] as const;
const STEP_ALL = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs'] as const;
type Rule = { contexts: readonly string[]; fns: readonly string[] };
const r = (contexts: readonly string[], fns: readonly string[] = []): Rule => ({ contexts, fns });

const TABLE: Record<string, Rule> = {
  'run-name': r(['github', 'inputs', 'vars']),
  concurrency: r(['github', 'inputs', 'vars']),
  env: r(['github', 'secrets', 'inputs', 'vars']),
  'jobs.<job_id>.concurrency': r(['github', 'needs', 'strategy', 'matrix', 'inputs', 'vars']),
  'jobs.<job_id>.container': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.container.credentials': r(['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'secrets', 'inputs']),
  'jobs.<job_id>.container.env.<env_id>': r(['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'inputs']),
  'jobs.<job_id>.container.image': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.continue-on-error': r(['github', 'needs', 'strategy', 'vars', 'matrix', 'inputs']),
  'jobs.<job_id>.defaults.run': r(['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'inputs']),
  'jobs.<job_id>.env': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs']),
  'jobs.<job_id>.environment': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.environment.url': r(['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs']),
  'jobs.<job_id>.if': r(['github', 'needs', 'vars', 'inputs'], STATUS),
  'jobs.<job_id>.name': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.outputs.<output_id>': r(STEP_ALL),
  'jobs.<job_id>.runs-on': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.secrets.<secrets_id>': r(['github', 'needs', 'strategy', 'matrix', 'secrets', 'inputs', 'vars']),
  'jobs.<job_id>.services': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.services.<service_id>.credentials': r(['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'secrets', 'inputs']),
  'jobs.<job_id>.services.<service_id>.env.<env_id>': r(['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'inputs']),
  'jobs.<job_id>.steps.continue-on-error': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.steps.env': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.steps.if': r(['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs'], [...STATUS, 'hashFiles']),
  'jobs.<job_id>.steps.name': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.steps.run': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.steps.timeout-minutes': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.steps.with': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.steps.working-directory': r(STEP_ALL, ['hashFiles']),
  'jobs.<job_id>.strategy': r(['github', 'needs', 'vars', 'inputs']),
  'jobs.<job_id>.timeout-minutes': r(['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs']),
  'jobs.<job_id>.with.<with_id>': r(['github', 'needs', 'strategy', 'matrix', 'inputs', 'vars']),
  'on.workflow_call.inputs.<inputs_id>.default': r(['github', 'inputs', 'vars']),
  'on.workflow_call.outputs.<output_id>.value': r(['github', 'jobs', 'vars', 'inputs']),
};
const CONTEXTS = new Set(['github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy', 'matrix', 'needs', 'inputs']);
const SPECIAL = new Set<string>([...STATUS, 'hashFiles']);
const LITERALS = new Set(['true', 'false', 'null', 'NaN', 'Infinity']);
const STEP_KEYS = new Set(['continue-on-error', 'env', 'if', 'name', 'run', 'timeout-minutes', 'with', 'working-directory']);

/**
 * The table row for a value at `path` (YAML keys and array indexes), or null
 * where GitHub takes no expression. `if` rows are conditions: the whole string
 * is an expression even without ${{ }}.
 */
function placeOf(path: readonly (string | number)[]): string | null {
  const [top, a, b, c, d] = path;
  if (top === 'run-name') return 'run-name';
  if (top === 'concurrency') return 'concurrency';
  if (top === 'env') return 'env';
  if (top === 'on') {
    if (a === 'workflow_call' && b === 'inputs' && d === 'default') return 'on.workflow_call.inputs.<inputs_id>.default';
    if (a === 'workflow_call' && b === 'outputs' && d === 'value') return 'on.workflow_call.outputs.<output_id>.value';
    return null;
  }
  if (top !== 'jobs' || a === undefined) return null;
  const J = 'jobs.<job_id>';
  switch (b) {
    case 'if':
    case 'name':
    case 'runs-on':
    case 'timeout-minutes':
    case 'continue-on-error':
    case 'concurrency':
    case 'strategy':
    case 'env':
      return `${J}.${b}`;
    case 'environment':
      return c === 'url' ? `${J}.environment.url` : `${J}.environment`;
    case 'outputs':
      return `${J}.outputs.<output_id>`;
    case 'defaults':
      return `${J}.defaults.run`;
    case 'secrets':
      return `${J}.secrets.<secrets_id>`;
    case 'with':
      return `${J}.with.<with_id>`;
    case 'container':
      if (c === 'credentials') return `${J}.container.credentials`;
      if (c === 'env') return `${J}.container.env.<env_id>`;
      if (c === 'image') return `${J}.container.image`;
      return `${J}.container`;
    case 'services':
      if (d === 'credentials') return `${J}.services.<service_id>.credentials`;
      if (d === 'env') return `${J}.services.<service_id>.env.<env_id>`;
      return `${J}.services`;
    case 'steps':
      return typeof d === 'string' && STEP_KEYS.has(d) ? `${J}.steps.${d}` : null;
    default:
      return null;
  }
}

type Finding = { at: string; expr: string; why: string };

/** The context names and function calls of one expression (string literals removed). */
function namesIn(expr: string): { contexts: string[]; functions: string[]; unknown: string[] } {
  const src = expr.replace(/'(?:[^']|'')*'/g, "''");
  const toks = src.match(/[A-Za-z_][A-Za-z0-9_-]*|[0-9][0-9A-Za-z_.]*|\S/g) ?? [];
  const contexts: string[] = [];
  const functions: string[] = [];
  const unknown: string[] = [];
  toks.forEach((t, i) => {
    if (!/^[A-Za-z_]/.test(t)) return;
    if (toks[i - 1] === '.') return; // a property: github.event.inputs
    if (toks[i + 1] === '(') functions.push(t);
    else if (CONTEXTS.has(t)) contexts.push(t);
    else if (!LITERALS.has(t)) unknown.push(t);
  });
  return { contexts, functions, unknown };
}

function expressionsOf(value: string, isCondition: boolean): string[] {
  const inBraces = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!.trim());
  if (inBraces.length > 0 || !isCondition) return inBraces;
  return value.trim() === '' ? [] : [value.trim()];
}

/** Every expression of a parsed workflow that its place does not allow. */
function contextViolations(doc: unknown): { findings: Finding[]; checked: number } {
  const findings: Finding[] = [];
  let checked = 0;
  const visit = (node: unknown, path: (string | number)[]) => {
    if (Array.isArray(node)) return node.forEach((v, i) => visit(v, [...path, i]));
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (/\$\{\{/.test(k)) findings.push({ at: path.join('.'), expr: k, why: 'an expression in a key' });
        visit(v, [...path, k]);
      }
      return;
    }
    if (typeof node !== 'string') return;
    const place = placeOf(path);
    const isCondition = place === 'jobs.<job_id>.if' || place === 'jobs.<job_id>.steps.if';
    const exprs = expressionsOf(node, isCondition);
    if (exprs.length === 0) return;
    const at = path.join('.');
    if (place === null) {
      for (const e of exprs) findings.push({ at, expr: e, why: 'no expression is allowed here' });
      return;
    }
    const rule = TABLE[place]!;
    for (const e of exprs) {
      checked++;
      const n = namesIn(e);
      for (const c of n.contexts) if (!rule.contexts.includes(c)) findings.push({ at, expr: e, why: `context '${c}' is not available at ${place}` });
      for (const f of n.functions) if (SPECIAL.has(f) && !rule.fns.includes(f)) findings.push({ at, expr: e, why: `${f}() is not available at ${place}` });
      for (const u of n.unknown) findings.push({ at, expr: e, why: `'${u}' is not a context` });
    }
  };
  visit(doc, []);
  return { findings, checked };
}

const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const check = (text: string) => contextViolations(load(text));

describe('every workflow file: each expression names only the contexts its place offers (GitHub\'s table)', () => {
  it('found the workflow files, the two clean-start files among them', () => {
    expect(FILES).toEqual(expect.arrayContaining(['ci.yml', 'clean-start.yml', 'clean-start-photos.yml']));
    expect(FILES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(FILES)('%s', (f) => {
    const { findings, checked } = check(read(f));
    expect(findings).toEqual([]);
    expect(checked, `${f} has expressions to check`).toBeGreaterThan(0);
  });

  it('the clean-start files: no runner context anywhere outside the steps', () => {
    for (const f of ['clean-start.yml', 'clean-start-photos.yml']) {
      const w = load(read(f)) as { jobs: Record<string, Record<string, unknown>> };
      for (const [id, job] of Object.entries(w.jobs)) {
        const jobLevel = Object.fromEntries(Object.entries(job).filter(([k]) => k !== 'steps'));
        expect(JSON.stringify(jobLevel), `${f} ${id}`).not.toMatch(/\brunner\./);
      }
    }
  });
});

describe('the check can fail (mutations of the real files)', () => {
  const main = read('clean-start.yml');
  const photos = read('clean-start-photos.yml');
  const once = (text: string, a: string, b: string) => {
    expect(text.split(a).length - 1, `exactly one "${a.trim()}"`).toBe(1);
    return text.replace(a, b);
  };
  // The plan job's line (apply's HEALTH_BEARER is followed by PROD_CRON_SECRET).
  const PLAN_BEARER = '      HEALTH_BEARER: ${{ secrets.HEALTH_BEARER }}\n      APP_BASE_URL';
  const whys = (text: string) => check(text).findings.map((x) => `${x.at}: ${x.why}`);

  it('the line GitHub rejected, put back in a job\'s env:, fails', () => {
    const m = once(main, "    env:\n      MODE: ${{ inputs.mode }}\n      CONFIRM_HOST: ${{ inputs.confirm_host }}\n      CONFIRM_PHRASE: ${{ inputs.confirm_phrase }}\n      DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}\n      PROD_URL_RAW",
      "    env:\n      CS_DIR: ${{ runner.temp }}/clean-start\n      MODE: ${{ inputs.mode }}\n      CONFIRM_HOST: ${{ inputs.confirm_host }}\n      CONFIRM_PHRASE: ${{ inputs.confirm_phrase }}\n      DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}\n      PROD_URL_RAW");
    expect(whys(m)).toContain("jobs.plan.env.CS_DIR: context 'runner' is not available at jobs.<job_id>.env");
    const p = once(photos, '    env:\n      TARGET_RUN:', '    env:\n      CS_DIR: ${{ runner.temp }}/clean-start\n      TARGET_RUN:');
    expect(whys(p)).toContain("jobs.photos.env.CS_DIR: context 'runner' is not available at jobs.<job_id>.env");
  });

  it('the same value in a STEP\'s env: is allowed', () => {
    const m = once(photos, '        env:\n          PGOPTIONS: -c default_transaction_read_only=on\n        run: |\n          set -euo pipefail\n          rc=0',
      '        env:\n          CS_DIR: ${{ runner.temp }}/clean-start\n          PGOPTIONS: -c default_transaction_read_only=on\n        run: |\n          set -euo pipefail\n          rc=0');
    expect(check(m).findings).toEqual([]);
  });

  it('a secret in a job\'s if:, or in a step\'s if:, fails', () => {
    const j = once(main, "    if: inputs.mode == 'finish'\n", "    if: inputs.mode == 'finish' && secrets.DIRECT_URL != ''\n");
    expect(whys(j)).toContain("jobs.finish.if: context 'secrets' is not available at jobs.<job_id>.if");
    const s = once(main, "        if: failure() && env.CS_COMMITTED == 'no'\n", "        if: failure() && secrets.NEON_API_KEY != ''\n");
    expect(whys(s).some((w) => /steps\.\d+\.if: context 'secrets' is not available at jobs\.<job_id>\.steps\.if/.test(w))).toBe(true);
  });

  it('env and steps in a job\'s env:, a step output in a job\'s if:, secrets in run-name, fail', () => {
    expect(whys(once(main, PLAN_BEARER, '      HEALTH_BEARER: ${{ env.X }}\n      APP_BASE_URL'))).toContain(
      "jobs.plan.env.HEALTH_BEARER: context 'env' is not available at jobs.<job_id>.env"
    );
    expect(whys(once(main, "    if: inputs.mode == 'seal-restore'\n", "    if: steps.x.outputs.y == 'a'\n"))).toContain(
      "jobs.seal_restore.if: context 'steps' is not available at jobs.<job_id>.if"
    );
    expect(whys(once(main, 'run-name: Clean start ${{ inputs.mode }}', 'run-name: Clean start ${{ secrets.DIRECT_URL }}'))).toContain(
      "run-name: context 'secrets' is not available at run-name"
    );
    expect(whys(once(main, '  group: clean-start\n', '  group: clean-start-${{ runner.os }}\n'))).toContain(
      "concurrency.group: context 'runner' is not available at concurrency"
    );
  });

  it('the special functions only where the table lists them; no expression where none is allowed', () => {
    expect(whys(once(main, PLAN_BEARER, '      HEALTH_BEARER: ${{ always() }}\n      APP_BASE_URL'))).toContain(
      'jobs.plan.env.HEALTH_BEARER: always() is not available at jobs.<job_id>.env'
    );
    expect(whys(once(main, "    if: inputs.mode == 'finish'\n", "    if: hashFiles('x') != ''\n"))).toContain(
      'jobs.finish.if: hashFiles() is not available at jobs.<job_id>.if'
    );
    expect(whys(once(photos, '      - uses: actions/checkout@v7\n', '      - uses: actions/checkout@${{ github.sha }}\n'))).toContain(
      'jobs.photos.steps.1.uses: no expression is allowed here'
    );
    expect(whys(once(main, '  contents: read\n  actions: read\n', '  contents: ${{ inputs.mode }}\n  actions: read\n'))).toContain(
      'permissions.contents: no expression is allowed here'
    );
  });

  it('reads names correctly: properties, string literals and functions are not contexts', () => {
    expect(namesIn("github.event.inputs.runner == 'secrets.x' && contains(env.A, 'b')")).toEqual({ contexts: ['github', 'env'], functions: ['contains'], unknown: [] });
    expect(namesIn("secrets['X'] || vars.Y")).toEqual({ contexts: ['secrets', 'vars'], functions: [], unknown: [] });
    expect(namesIn('foo.bar').unknown).toEqual(['foo']);
  });
});

describe('the workflow emulator refuses what GitHub refuses', () => {
  const tryRun = (yml: string) => {
    const d = mkdtempSync(join(tmpdir(), 'nmwc-wfctx-'));
    try {
      const file = join(d, 'w.yml');
      writeFileSync(file, yml);
      return runWorkflow({
        file,
        cwd: d,
        inputs: {},
        secrets: { S: 'x' },
        vars: {},
        github: { run_id: '1', sha: 'a'.repeat(40), ref: 'refs/heads/x', repository: 'o/r', default_branch: 'main', token: '' },
        baseEnv: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
        skip: () => false,
      });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  const job = (jobEnv: string, stepEnv: string) =>
    `on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n${jobEnv}    steps:\n      - name: one\n${stepEnv}        run: test -n "$X"\n`;

  it('runner.temp in a job\'s env: throws; in a step\'s env: it runs', () => {
    expect(() => tryRun(job('    env:\n      X: ${{ runner.temp }}/clean-start\n', ''))).toThrow(/context 'runner' is not available here/);
    expect(tryRun(job('', '        env:\n          X: ${{ runner.temp }}/clean-start\n')).jobs.a!.result).toBe('success');
  });

  it('a secret in a job\'s if: or a step\'s if: throws', () => {
    expect(() => tryRun(job('    if: secrets.S == \'x\'\n    env:\n      X: y\n', ''))).toThrow(/context 'secrets' is not available here/);
    const stepIf = `on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: one\n        if: secrets.S == 'x'\n        run: 'true'\n`;
    expect(() => tryRun(stepIf)).toThrow(/context 'secrets' is not available here/);
  });
});
