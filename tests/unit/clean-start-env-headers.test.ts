// @vitest-environment node
/**
 * Go-live clean start: a step's `env:` header is printed in the PUBLIC Actions
 * log, with every job-level value and every value an earlier step wrote to
 * GITHUB_ENV. Each such value must be declared in
 * tests/support/clean-start/public-log.ts with the only shape it may have, or be
 * masked before it is written (review 2026-11-11, flow-and-secrets minor).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { ENV_HEADER_SHAPES, MASKED_ENV, envHeaderViolations } from '../support/clean-start/public-log';

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { env?: Record<string, string>; steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

const read = (f: string) => readFileSync(f, 'utf8');
const FILES = ['.github/workflows/clean-start.yml', '.github/workflows/clean-start-photos.yml'];
const declared = new Set<string>([...Object.keys(ENV_HEADER_SHAPES), ...MASKED_ENV]);
const isMasked = (n: string) => (MASKED_ENV as readonly string[]).includes(n);
const GH_ENV_WRITE = /echo "([A-Z_0-9]+)=([^"]*)" >> "\$GITHUB_ENV"/g;

describe('step env headers (public): only declared values, or masked ones', () => {
  it('every GITHUB_ENV write in the workflows is declared; a masked one is masked first, in the same step', () => {
    let writes = 0;
    for (const f of FILES) {
      const w = load(read(f)) as Workflow;
      for (const job of Object.values(w.jobs))
        for (const s of job.steps) {
          const run = s.run ?? '';
          for (const m of run.matchAll(GH_ENV_WRITE)) {
            writes++;
            expect(declared.has(m[1]!), `${f} ${s.name}: ${m[1]}`).toBe(true);
            if (isMasked(m[1]!)) {
              // the value is a shell variable ($a), masked before this write
              const v = /^\$([a-z_]+)$/.exec(m[2]!);
              expect(v, `${m[1]} is written from a variable`).not.toBeNull();
              const mask = run.indexOf(`echo "::add-mask::$${v![1]}"`);
              expect(mask, `${m[1]} masked`).toBeGreaterThanOrEqual(0);
              expect(mask).toBeLessThan(run.indexOf(m[0]));
            }
          }
        }
    }
    expect(writes).toBeGreaterThan(10);
  });

  it('every env value taken from a job or step output is declared', () => {
    let n = 0;
    for (const f of FILES) {
      const w = load(read(f)) as Workflow;
      for (const job of Object.values(w.jobs))
        for (const e of [job.env ?? {}, ...job.steps.map((s) => s.env ?? {})])
          for (const [k, v] of Object.entries(e))
            if (/\$\{\{\s*(needs|steps)\./.test(String(v))) {
              n++;
              expect(declared.has(k), `${f}: ${k}`).toBe(true);
            }
    }
    expect(n).toBeGreaterThan(5);
  });

  it('every set_env in the scripts is declared, and the connection strings are masked before they are handed on', () => {
    let n = 0;
    for (const sh of ['run.sh', 'seal-archive.sh', 'photo-delete.sh'])
      for (const m of read(`scripts/ops/clean-start/${sh}`).matchAll(/\bset_env ([A-Z_0-9]+) /g)) {
        n++;
        expect(declared.has(m[1]!), `${sh}: ${m[1]}`).toBe(true);
      }
    expect(n).toBeGreaterThan(5);
    const run = read('scripts/ops/clean-start/run.sh');
    expect(run.indexOf('echo "::add-mask::$clean"')).toBeGreaterThan(0);
    expect(run.indexOf('echo "::add-mask::$clean"')).toBeLessThan(run.indexOf('set_env DIRECT_URL "$clean"'));
    expect(run.indexOf('echo "::add-mask::$uri"')).toBeGreaterThan(0);
    expect(run.indexOf('echo "::add-mask::$uri"')).toBeLessThan(run.indexOf('set_env CS_BRANCH_URL "$uri"'));
  });

  it('the shape rule can fail', () => {
    expect(envHeaderViolations('PLAN_ID=' + 'a'.repeat(64) + '\nOLD_CHAIN=none\n')).toEqual([]);
    expect(envHeaderViolations('PLAN_ID=12\n')).not.toEqual([]);
    expect(envHeaderViolations('CS_BACKUP_KEY=db/../x\n')).not.toEqual([]);
    expect(envHeaderViolations('A_NEW_ONE=x\n')).not.toEqual([]);
  });
});
