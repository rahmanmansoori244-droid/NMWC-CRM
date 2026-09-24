/**
 * Run a GitHub Actions `run:` block the way Actions does — `bash -e <file>` —
 * with stubs prepended, and report what the SHELL decided.
 *
 * Moved here from tests/unit/ci-gates-guard.test.ts (2026-09-24) so every workflow
 * guard can execute its step instead of reading it. Reading was the failure: the
 * smoke retry loop was pinned by the spelling of `for ATTEMPT in $(seq 1 24)`
 * while an inherited `-e` made it exit on the first attempt, and the R2 check was
 * pinned by `RC=1` while `|| true` or a bare early `exit` would have turned a
 * broken bucket setting green with every assertion still passing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The `run:` script of one step, dedented exactly as GitHub hands it to bash.
 * Returns '' when the step or its script is not there, which the tests assert
 * against before running anything — an empty script would "pass" every scenario.
 */
export function runScriptOf(raw: string, stepName: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
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

/**
 * bash, the way Actions has it. On Linux it is on PATH; on a Windows developer
 * box it ships with git, together with the coreutils the scripts use (`seq`,
 * `cut`, `grep`), so that directory is prepended to PATH for the child. There is
 * deliberately no skip-if-missing branch: a guard that quietly does not run is
 * the failure mode this whole file exists to end.
 */
let cachedBash: { bash: string; extraPath: string | null } | null = null;
export function resolveBash(): { bash: string; extraPath: string | null } {
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

export type Outcome = { status: number; output: string; calls: string[] };

/**
 * Run a workflow `run:` script the way GitHub Actions does — `bash -e <file>` —
 * with `stubs` prepended. The inherited `-e` is the whole point: it is what made
 * the retry loop exit on its first iteration.
 */
export function runStep(
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
