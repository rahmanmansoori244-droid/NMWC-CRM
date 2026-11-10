/**
 * A small GitHub Actions runner for the clean-start END-TO-END test
 * (tests/integration/clean-start-flow.test.ts): it runs the REAL workflow file,
 * job by job and step by step, with bash, the way a hosted runner would, so
 * the test exercises the YAML the owner will press and not a copy of it.
 *
 * What it models: workflow_dispatch inputs, secrets, vars, the github/runner/
 * env/inputs/needs/steps/job contexts, ${{ }} in env:, outputs:, if: and
 * environment:, the expression operators the clean-start files use (== != && ||
 * ! and parentheses, string and number literals, always() success() failure()
 * cancelled()), needs: with job results, GITHUB_ENV / GITHUB_OUTPUT /
 * GITHUB_STEP_SUMMARY files, `defaults.run.shell: bash` (bash -eo pipefail),
 * and a fresh RUNNER_TEMP per job.
 *
 * What it does not: `uses:` steps (checkout, setup-node: the test runs in a
 * checkout already) and the steps the caller names to skip (installing
 * packages, the smoke test against the live site) — each skip is reported, so
 * the test can pin exactly which steps did not run. Services are not started:
 * the caller points the job's database URLs at its own local cluster
 * (jobEnvOverride). Environment approvals are not modelled: the test is the
 * owner pressing Approve.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { jobs: Record<string, Job> };

export type JobResult = { result: 'success' | 'failure' | 'skipped'; outputs: Record<string, string>; summary: string };
export type StepRecord = { job: string; step: string; outcome: 'success' | 'failure' | 'skipped' | 'not run here'; lines: string[] };
export type RunResult = { jobs: Record<string, JobResult>; steps: StepRecord[]; lines: string[] };

export type RunOptions = {
  file: string;
  cwd: string;
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  vars: Record<string, string>;
  github: { run_id: string; sha: string; ref: string; repository: string; default_branch: string; token: string };
  baseEnv: NodeJS.ProcessEnv & Record<string, string>;
  /** Per job: env values replaced after the YAML's (the service containers' URLs). */
  jobEnvOverride?: Record<string, Record<string, string>>;
  /** Steps that do not run here (reported as 'not run here'). */
  skip: (job: string, step: Step) => boolean;
};

// ── expressions ─────────────────────────────────────────────────────────

type Ctx = Record<string, unknown> & { __status: { success: boolean } };

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`expression not understood here: ${src}`);
    out.push(m[1]!);
    i = re.lastIndex;
  }
  return out;
}

function evaluate(src: string, ctx: Ctx): unknown {
  const t = tokenize(src);
  let p = 0;
  const peek = () => t[p];
  const next = () => t[p++];
  const truthy = (v: unknown) => !(v === '' || v === null || v === undefined || v === false || v === 0);
  const lookup = (path: string): unknown => {
    let v: unknown = ctx;
    for (const part of path.split('.')) {
      if (v === null || v === undefined || typeof v !== 'object') return undefined;
      v = (v as Record<string, unknown>)[part];
    }
    return v;
  };
  function primary(): unknown {
    const tok = next();
    if (tok === undefined) throw new Error(`unexpected end: ${src}`);
    if (tok === '(') {
      const v = or();
      if (next() !== ')') throw new Error(`missing ): ${src}`);
      return v;
    }
    if (tok === '!') return !truthy(primary());
    if (tok.startsWith("'")) return tok.slice(1, -1).replace(/''/g, "'");
    if (/^[0-9]/.test(tok)) return Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (peek() === '(') {
      next();
      const args: unknown[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') next();
      }
      next();
      if (tok === 'always') return true;
      if (tok === 'success') return ctx.__status.success;
      if (tok === 'failure') return !ctx.__status.success;
      if (tok === 'cancelled') return false;
      throw new Error(`function not modelled: ${tok}`);
    }
    return lookup(tok);
  }
  function cmp(): unknown {
    let l = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = next();
      const r = primary();
      const eq = String(l ?? '').toLowerCase() === String(r ?? '').toLowerCase();
      l = op === '==' ? eq : !eq;
    }
    return l;
  }
  function and(): unknown {
    let l = cmp();
    while (peek() === '&&') {
      next();
      const r = cmp();
      l = truthy(l) ? r : l;
    }
    return l;
  }
  function or(): unknown {
    let l = and();
    while (peek() === '||') {
      next();
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  }
  const v = or();
  if (p !== t.length) throw new Error(`trailing tokens: ${src}`);
  return v;
}

const usesStatusFn = (e: string) => /\b(always|success|failure|cancelled)\s*\(/.test(e);
const truthy = (v: unknown) => !(v === '' || v === null || v === undefined || v === false || v === 0);
const stripBraces = (e: string) => e.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');

function subst(s: string, ctx: Ctx): string {
  return s.replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_m, e: string) => {
    const v = evaluate(e, ctx);
    return v === undefined || v === null ? '' : String(v);
  });
}

function parseKv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.replace(/\r$/, '');
    if (!l) continue;
    const h = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(l);
    if (h) {
      const buf: string[] = [];
      for (i++; i < lines.length && lines[i]!.replace(/\r$/, '') !== h[2]; i++) buf.push(lines[i]!.replace(/\r$/, ''));
      out[h[1]!] = buf.join('\n');
      continue;
    }
    const e = l.indexOf('=');
    if (e > 0) out[l.slice(0, e)] = l.slice(e + 1);
  }
  return out;
}

// ── the run ─────────────────────────────────────────────────────────────

export function runWorkflow(o: RunOptions): RunResult {
  const wf = load(readFileSync(o.file, 'utf8')) as Workflow;
  const results: Record<string, JobResult> = {};
  const steps: StepRecord[] = [];
  const lines: string[] = [];
  const order = Object.keys(wf.jobs);
  const done = new Set<string>();
  while (done.size < order.length) {
    const id = order.find((j) => !done.has(j) && [wf.jobs[j]!.needs ?? []].flat().every((n) => done.has(n)));
    if (!id) throw new Error('a needs: cycle');
    done.add(id);
    const job = wf.jobs[id]!;
    const needs = Object.fromEntries([job.needs ?? []].flat().map((n) => [n, { result: results[n]!.result, outputs: results[n]!.outputs }]));
    const needsOk = Object.values(needs).every((n) => n.result === 'success');
    const runnerTemp = mkdtempSync(join(tmpdir(), `nmwc-runner-${id}-`));
    const base: Ctx = {
      inputs: o.inputs,
      secrets: o.secrets,
      vars: o.vars,
      github: {
        ...o.github,
        workspace: o.cwd,
        event: { repository: { default_branch: o.github.default_branch } },
      },
      runner: { temp: runnerTemp },
      needs,
      env: {},
      steps: {},
      job: { status: 'success' },
      __status: { success: needsOk },
    };
    const jobIf = job.if ? stripBraces(job.if) : '';
    const runs = jobIf ? (usesStatusFn(jobIf) ? truthy(evaluate(jobIf, base)) : needsOk && truthy(evaluate(jobIf, base))) : needsOk;
    if (!runs) {
      results[id] = { result: 'skipped', outputs: {}, summary: '' };
      if (process.env.CS_FLOW_KEEP_WORK !== '1') rmSync(runnerTemp, { recursive: true, force: true });
      continue;
    }
    const jobEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.env ?? {})) jobEnv[k] = subst(String(v), base);
    Object.assign(jobEnv, o.jobEnvOverride?.[id] ?? {});
    const files = {
      env: join(runnerTemp, '_github_env'),
      summary: join(runnerTemp, '_step_summary'),
      path: join(runnerTemp, '_github_path'),
    };
    for (const f of Object.values(files)) writeFileSync(f, '');
    let ok = true;
    const stepCtx: Record<string, { outputs: Record<string, string>; outcome: string; conclusion: string }> = {};
    job.steps.forEach((s, i) => {
      const label = s.name ?? s.uses ?? `step ${i + 1}`;
      const fromFile = parseKv(files.env);
      const ctx: Ctx = { ...base, env: { ...jobEnv, ...fromFile }, steps: stepCtx, job: { status: ok ? 'success' : 'failure' }, __status: { success: ok } };
      const cond = s.if ? stripBraces(s.if) : '';
      const go = cond ? (usesStatusFn(cond) ? truthy(evaluate(cond, ctx)) : ok && truthy(evaluate(cond, ctx))) : ok;
      if (!go) {
        steps.push({ job: id, step: label, outcome: 'skipped', lines: [] });
        if (s.id) stepCtx[s.id] = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' };
        return;
      }
      if (s.uses || o.skip(id, s)) {
        steps.push({ job: id, step: label, outcome: 'not run here', lines: [] });
        if (s.id) stepCtx[s.id] = { outputs: {}, outcome: 'success', conclusion: 'success' };
        return;
      }
      const stepEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env ?? {})) stepEnv[k] = subst(String(v), ctx);
      const outFile = join(runnerTemp, `_output_${i}`);
      writeFileSync(outFile, '');
      const script = join(runnerTemp, `_step_${i}.sh`);
      writeFileSync(script, subst(s.run ?? '', ctx));
      const env = {
        ...o.baseEnv,
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: o.github.run_id,
        GITHUB_SHA: o.github.sha,
        GITHUB_REF: o.github.ref,
        GITHUB_REPOSITORY: o.github.repository,
        GITHUB_WORKSPACE: o.cwd,
        GITHUB_API_URL: 'https://api.github.com',
        GITHUB_SERVER_URL: 'https://github.com',
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: files.env,
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: files.summary,
        GITHUB_PATH: files.path,
        ...jobEnv,
        ...fromFile,
        ...stepEnv,
      };
      const r = spawnSync('bash', ['-c', `bash --noprofile --norc -eo pipefail "$0" 2>&1`, script], {
        cwd: o.cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const out = (r.stdout ?? '').split(/\r?\n/).filter((l) => l !== '');
      lines.push(...out);
      const success = r.status === 0;
      steps.push({ job: id, step: label, outcome: success ? 'success' : 'failure', lines: out });
      if (s.id) stepCtx[s.id] = { outputs: parseKv(outFile), outcome: success ? 'success' : 'failure', conclusion: success ? 'success' : 'failure' };
      if (!success) ok = false;
    });
    const endCtx: Ctx = { ...base, steps: stepCtx, env: { ...jobEnv, ...parseKv(files.env) }, __status: { success: ok } };
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.outputs ?? {})) outputs[k] = subst(String(v), endCtx);
    results[id] = { result: ok ? 'success' : 'failure', outputs, summary: readFileSync(files.summary, 'utf8') };
    if (process.env.CS_FLOW_KEEP_WORK !== '1') rmSync(runnerTemp, { recursive: true, force: true });
  }
  return { jobs: results, steps, lines };
}

/** For a failing test: the steps of one job with their outcome and printed lines. */
export function describeJob(r: RunResult, job: string): string {
  return r.steps
    .filter((s) => s.job === job)
    .map((s) => `[${s.outcome}] ${s.step}\n${s.lines.map((l) => `    ${l}`).join('\n')}`)
    .join('\n');
}

export function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}
