// @vitest-environment node
/**
 * Go-live clean start: the two workflows the owner runs
 * (.github/workflows/clean-start.yml, clean-start-photos.yml), parsed with a
 * real YAML parser, and the small SQL files they call. What is pinned:
 *
 *   - dispatch only; least permissions; one concurrency group that never cancels;
 *   - every job that can change production, or holds the Neon key or the photo
 *     write token, waits for environment production-reset (the owner's Approve);
 *   - no artifact is uploaded; actions are pinned as the other workflows pin them;
 *   - every run: block is valid bash and holds no ${{ … }} (inputs reach the shell
 *     through env: only);
 *   - every database command writes its output to a file under $CS_DIR (the
 *     public log rule: run.sh prints what may be printed);
 *   - production is checked (run.sh prod-target) before its URL is used, and a
 *     copy (run.sh rehearse-target) before reset.sql or a write runs on it; the
 *     reset on production is preceded by `prod-target apply` (the typed phrase);
 *   - production is only READ outside the reset and the photo record;
 *   - the plaintext is removed at the end of every job, always.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  environment?: string;
  env?: Record<string, string>;
  steps: Step[];
  services?: unknown;
};
type Workflow = {
  name: string;
  'run-name'?: string;
  on: Record<string, { inputs?: Record<string, { options?: string[] }> }>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};

const read = (f: string) => readFileSync(f, 'utf8');
const MAIN = load(read('.github/workflows/clean-start.yml')) as Workflow;
const PHOTOS = load(read('.github/workflows/clean-start-photos.yml')) as Workflow;
const BOTH: Array<[string, Workflow]> = [
  ['clean-start.yml', MAIN],
  ['clean-start-photos.yml', PHOTOS],
];
const allJobs = (): Array<[string, string, Job]> =>
  BOTH.flatMap(([f, w]) => Object.entries(w.jobs).map(([id, j]) => [f, id, j] as [string, string, Job]));
/** A run block's commands, continuation lines joined. */
const commands = (run: string) => run.replace(/\\\n\s*/g, ' ').split('\n').map((l) => l.trim());

describe('shape', () => {
  it('dispatch only, with the five modes', () => {
    for (const [, w] of BOTH) expect(Object.keys(w.on)).toEqual(['workflow_dispatch']);
    expect(MAIN.on.workflow_dispatch!.inputs!.mode!.options).toEqual(['dry-run', 'neon-rehearsal', 'apply', 'finish', 'seal-restore']);
    expect(MAIN.jobs.plan!.if).toMatch(/inputs\.mode/);
  });

  it('least permissions, one concurrency group that never cancels', () => {
    expect(MAIN.permissions).toEqual({ contents: 'read', actions: 'read' });
    // actions: read lets the photo job read its own environment's protection rules (run.sh github-env).
    expect(PHOTOS.permissions).toEqual({ contents: 'read', actions: 'read' });
    for (const [, w] of BOTH) expect(w.concurrency).toEqual({ group: 'clean-start', 'cancel-in-progress': false });
  });

  it('the jobs the modes run, and their order', () => {
    expect(Object.keys(MAIN.jobs)).toEqual(['plan', 'rehearse', 'neon_rehearsal', 'apply', 'finish', 'seal_restore']);
    expect(MAIN.jobs.rehearse!.needs).toBe('plan');
    expect(MAIN.jobs.neon_rehearsal!.needs).toBe('plan');
    expect(MAIN.jobs.apply!.needs).toEqual(['plan', 'rehearse']);
    // run.sh neon-green finds the rehearsal by these two names.
    expect(MAIN['run-name']).toBe('Clean start ${{ inputs.mode }}');
    expect(MAIN.jobs.neon_rehearsal!.name).toBe('Neon rehearsal');
    expect(read('scripts/ops/clean-start/run.sh')).toContain('select(.name == "Neon rehearsal" and .conclusion == "success")');
  });

  it('every job that can change production, or holds the Neon key or the write token, waits for the owner\'s approval', () => {
    const gated = new Set(['neon_rehearsal', 'apply', 'finish', 'seal_restore', 'photos']);
    for (const [f, id, j] of allJobs()) {
      const holds = JSON.stringify(j.env ?? {});
      if (gated.has(id)) expect(j.environment, `${f} ${id}`).toBe('production-reset');
      else expect(j.environment, `${f} ${id}`).toBeUndefined();
      if (/NEON_API_KEY|CLEANSTART_R2_RW_|PROD_CRON_SECRET/.test(holds)) expect(gated.has(id), `${f} ${id} holds a gated secret`).toBe(true);
    }
  });

  it('every job sets its work folder (CS_DIR) in its FIRST step, from RUNNER_TEMP; no job env: names it', () => {
    // GitHub refused both files on 2026-11-11 for `CS_DIR: ${{ runner.temp }}/clean-start`
    // in a job's env: (the runner context exists in steps only). Every step that
    // reads $CS_DIR, the always() ones included, comes after this one.
    for (const [f, id, j] of allJobs()) {
      expect(j.env?.CS_DIR, `${f} ${id}`).toBeUndefined();
      const first = j.steps[0]!;
      expect(first.name, `${f} ${id}`).toBe('The private work folder');
      expect(first.env, `${f} ${id}: reads nothing of its own`).toBeUndefined();
      expect(first.run, `${f} ${id}`).toMatch(/if \[ -z "\$\{RUNNER_TEMP:-\}" \]; then echo "::error::clean start refused: [^"]+"; exit 1; fi\n\s*echo "CS_DIR=\$RUNNER_TEMP\/clean-start" >> "\$GITHUB_ENV"\n?$/);
      expect(first.run, `${f} ${id}: runs no script`).not.toMatch(/scripts\//);
      for (const s of j.steps.slice(1)) expect(s.run ?? '', `${f} ${id}: ${s.name}`).not.toMatch(/CS_DIR=/);
    }
  });

  it('no artifacts; actions pinned the way the other workflows pin them', () => {
    const others = readdirSync('.github/workflows')
      .filter((f) => !f.startsWith('clean-start'))
      .flatMap((f) => [...read(`.github/workflows/${f}`).matchAll(/uses: ([\w./-]+@[\w.-]+)/g)].map((m) => m[1]!));
    for (const [f, id, j] of allJobs())
      for (const s of j.steps)
        if (s.uses) {
          expect(s.uses, `${f} ${id}`).not.toMatch(/upload-artifact|cache@/);
          expect(others, `${f} ${id} ${s.uses}`).toContain(s.uses);
        }
  });
});

describe('every run: block', () => {
  const blocks = allJobs().flatMap(([f, id, j]) => j.steps.filter((s) => s.run).map((s) => [f, id, s] as [string, string, Step]));

  it('there are blocks to check', () => {
    expect(blocks.length).toBeGreaterThan(40);
  });

  it.each(blocks.map(([f, id, s]) => [`${f} ${id}: ${s.name ?? '(unnamed)'}`, s] as const))('%s is valid bash with no expression in it', (_n, s) => {
    const r = spawnSync('bash', ['-n'], { input: s.run, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(s.run).not.toMatch(/\$\{\{/);
  });

  it('every database command writes to a file under $CS_DIR, never to the log', () => {
    for (const [f, id, s] of blocks)
      for (const c of commands(s.run!)) {
        if (/(^|\s)psql\s/.test(c)) expect(c, `${f} ${id}`).toMatch(/> "\$CS_DIR\/[^"]+" 2>&1/);
        if (/(^|\s)pg_dump\s/.test(c)) expect(c, `${f} ${id}`).toMatch(/2> "\$CS_DIR\/[^"]+"/);
      }
  });

  it('npm, tsx and vitest output never reaches the log either', () => {
    for (const [f, id, s] of blocks)
      for (const c of commands(s.run!))
        if (/\b(npm|npx)\b/.test(c)) expect(c, `${f} ${id}`).toMatch(/> (\/dev\/null|"\$CS_DIR\/[^"]+")/);
  });
});

describe('targets', () => {
  const urlOf = (c: string) => /psql "\$(\w+)"/.exec(c)?.[1];

  it('production is named (prod-target) before its URL is used, in every job that uses it', () => {
    for (const [f, id, j] of allJobs()) {
      let named = false;
      for (const s of j.steps) {
        if (!s.run) continue;
        for (const c of commands(s.run)) {
          if (/run\.sh prod-target (read|apply|photos)/.test(c)) named = true;
          if (urlOf(c) === 'DIRECT_URL') expect(named, `${f} ${id}: ${s.name}`).toBe(true);
        }
      }
    }
  });

  it('a copy is checked (rehearse-target) before anything runs on it', () => {
    for (const [f, id, j] of allJobs()) {
      const checked = new Set<string>();
      for (const s of j.steps) {
        if (!s.run) continue;
        for (const c of commands(s.run)) {
          const m = /run\.sh rehearse-target (\w+)/.exec(c);
          if (m) checked.add(m[1]!);
          const u = urlOf(c);
          if (u && u !== 'DIRECT_URL' && u !== 'CS_PG_ADMIN_URL') expect(checked.has(u), `${f} ${id}: ${s.name} on ${u}`).toBe(true);
        }
      }
    }
  });

  it('the reset runs on production in APPLY only, right after prod-target apply (the typed phrase)', () => {
    for (const [f, id, j] of allJobs())
      for (const s of j.steps) {
        if (!s.run) continue;
        const cs = commands(s.run);
        cs.forEach((c, i) => {
          if (urlOf(c) === 'DIRECT_URL' && /reset\.sql/.test(c)) {
            expect(`${f} ${id}`).toBe('clean-start.yml apply');
            expect(cs.slice(0, i).some((x) => /run\.sh prod-target apply/.test(x))).toBe(true);
          }
        });
      }
  });

  it('production is otherwise only READ: read-only transactions, plan.sql, verify.sql, facts.sql; one audit row for the photos', () => {
    for (const [f, id, j] of allJobs())
      for (const s of j.steps) {
        if (!s.run) continue;
        for (const c of commands(s.run)) {
          if (urlOf(c) !== 'DIRECT_URL') continue;
          const file = /-f scripts\/ops\/clean-start\/([\w.-]+)/.exec(c)?.[1];
          if (file === 'reset.sql' || file === 'photos-record.sql') continue;
          expect(['plan.sql', 'verify.sql', 'facts.sql'], `${f} ${id}: ${s.name}`).toContain(file);
          const ro = /default_transaction_read_only=on/.test(`${JSON.stringify(s.env ?? {})} ${c}`);
          expect(ro, `${f} ${id}: ${s.name} reads production outside a read-only session`).toBe(true);
        }
      }
    expect(read('.github/workflows/clean-start.yml')).not.toMatch(/photos-record\.sql/);
    expect(read('.github/workflows/clean-start.yml')).not.toMatch(/"\$DIRECT_URL"[^\n]*counter\.sql/);
  });

  it('every job removes its plaintext at the end, always; Neon branches are always cleaned up', () => {
    for (const [f, id, j] of allJobs()) {
      const last = j.steps[j.steps.length - 1]!;
      expect(last.run, `${f} ${id}`).toMatch(/run\.sh shred/);
      expect(last.if, `${f} ${id}`).toBe('always()');
    }
    const cleanup = (job: string) => MAIN.jobs[job]!.steps.find((s) => /neon-cleanup|safety-cleanup/.test(s.run ?? ''));
    expect(cleanup('neon_rehearsal')?.if).toBe('always()');
    expect(cleanup('apply')?.if).toBe('always()');
    // The safety branch is deleted ONLY when it is certain the reset did not commit
    // (run.sh safety-cleanup, which also reads the marker and exit code on disk).
    expect(cleanup('apply')?.run).toBe('bash scripts/ops/clean-start/run.sh safety-cleanup');
    const reset = MAIN.jobs.apply!.steps.find((s) => /reset\.sql/.test(s.run ?? ''))!.run!;
    expect(reset.indexOf('run.sh started')).toBeLessThan(reset.indexOf('psql "$DIRECT_URL"'));
    expect(reset).toMatch(/printf '%s\\n' "\$rc" > "\$CS_DIR\/reset-rc"/);
  });

  it('every job that relies on the approval gate first checks the gate is real (github-env)', () => {
    const jobs: Array<[Workflow, string]> = [
      [MAIN, 'apply'],
      [MAIN, 'finish'],
      [MAIN, 'seal_restore'],
      [PHOTOS, 'photos'],
    ];
    for (const [w, id] of jobs) {
      const runs = w.jobs[id]!.steps.filter((s) => s.run).map((s) => s.run!);
      const all = runs.join('\n');
      const gate = all.indexOf('run.sh github-env');
      expect(gate, id).toBeGreaterThan(-1);
      // Before any storage, Neon or database step.
      for (const later of ['fetch-decrypt', 'seal-archive.sh', 'photo-delete.sh', 'neon-', 'psql '])
        if (all.includes(later)) expect(all.indexOf(later), `${id}: ${later}`).toBeGreaterThan(gate);
      expect(w.jobs[id]!.env?.GH_TOKEN, id).toBe('${{ github.token }}');
    }
  });

  it('no secret is in scope while dependencies install (their lifecycle scripts run then)', () => {
    let seen = 0;
    for (const [f, id, j] of allJobs())
      for (const s of j.steps) {
        if (!/\bnpm ci\b/.test(s.run ?? '')) continue;
        seen++;
        for (const [k, v] of Object.entries(j.env ?? {}))
          if (/secrets\.|github\.token/.test(String(v))) expect(s.env?.[k], `${f} ${id}: ${k}`).toBe('');
      }
    expect(seen).toBe(4);
  });

  it('mode finish verifies in finish scope and compares with what the first run MAY have seen; seal-restore moves the recorded new chain only', () => {
    const run = (job: string) => MAIN.jobs[job]!.steps.map((s) => s.run ?? '').join('\n');
    expect(run('finish')).toMatch(/-v scope=finish -f scripts\/ops\/clean-start\/verify\.sql/);
    expect(run('apply')).not.toMatch(/scope=finish/);
    expect(run('finish')).toMatch(/run\.sh finish-may "\$CS_DIR\/may-keys\.txt"\n\s*bash scripts\/ops\/clean-start\/run\.sh compare-watch "\$CS_DIR\/watch-results\.tsv" "" "\$CS_DIR\/may-keys\.txt"/);
    for (const job of ['apply', 'finish']) expect(run(job), job).toMatch(/run\.sh chain-id "\$CS_DIR\/chain-id\.out"/);
    const sr = run('seal_restore');
    expect(sr.indexOf('run.sh chain-id-fetch')).toBeGreaterThan(-1);
    expect(sr.indexOf('run.sh chain-id-fetch')).toBeLessThan(sr.indexOf('seal-archive.sh restore'));
    expect(sr).toMatch(/seal-archive\.sh restore "\$CS_DIR\/exports\/seals\.jsonl" "\$OLD_CHAIN" "\$TARGET_RUN" "\$NEW_CHAIN" \\\s+"\$CS_DIR\/exports\/seal-keys-foreign\.txt"/);
    expect(sr).toMatch(/run\.sh status-lines "\$CS_DIR\/watch-latest\.tsv" refuse/);
  });

  it('the photo run probes the read-write token before it deletes the Neon safety branch (its first irreversible step)', () => {
    const steps = PHOTOS.jobs.photos!.steps;
    const names = steps.map((s) => s.name ?? '');
    const probe = names.findIndex((n) => /read-write photo token can write and delete/.test(n));
    const neon = names.findIndex((n) => /Neon safety branch/.test(n));
    expect(probe).toBeGreaterThan(0);
    expect(neon).toBe(probe + 1);
    expect(steps[probe]!.if).toBeUndefined();
    expect(steps[probe]!.run).toMatch(/photo-delete\.sh probe "\$GITHUB_RUN_ID"/);
  });

  it('age is installed on its own with one retry (the universe mirror flakes; db-backup.yml), in every job that needs it', () => {
    let n = 0;
    for (const [f, id, j] of allJobs()) {
      for (const s of j.steps) {
        const lines = commands(s.run ?? '').filter((l) => /apt-get install/.test(l));
        if (!lines.some((l) => /\bage\b/.test(l))) continue;
        n++;
        const ages = lines.filter((l) => /\bage\b/.test(l));
        expect(ages, `${f} ${id}`).toHaveLength(1);
        expect(ages[0], `${f} ${id}`).toMatch(/install -y --no-install-recommends age > \/dev\/null\s+\|\| \{ sleep \d+; sudo apt-get update -qq; sudo apt-get install -y --no-install-recommends age > \/dev\/null; \}$/);
        expect(ages[0]).not.toMatch(/postgresql-client/);
      }
    }
    expect(n).toBe(6);
  });

  it('apply settles "reset committed" also after a reset Postgres refused (exit 3), never after a cancel or another failure', () => {
    const steps = MAIN.jobs.apply!.steps;
    const d = steps.findIndex((s) => (s.name ?? '').startsWith('d. THE RESET'));
    const ef = steps.findIndex((s) => (s.name ?? '').startsWith('e-f.'));
    expect(d).toBeGreaterThan(0);
    expect(ef).toBe(d + 1);
    expect(steps[d]!.run).toMatch(/echo "CS_RESET_RC=\$rc" >> "\$GITHUB_ENV"\n[\s\S]*run\.sh sql "reset"/);
    expect(steps[ef]!.if).toBe("success() || (failure() && env.CS_RESET_RC == '3')");
    expect(steps[ef]!.run).toMatch(/run\.sh settle/);
  });

  it('every verify-seals call names its host (it refuses with exit 2 without --expect-host, so the recorded line could never say yes)', () => {
    const calls = allJobs().flatMap(([f, id, j]) =>
      j.steps.flatMap((s) => commands(s.run ?? '').filter((l) => /scripts\/ops\/verify-seals\.ts/.test(l)).map((l) => [`${f} ${id}`, l] as const))
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const [where, l] of calls) expect(l, where).toMatch(/ --expect-host [a-z0-9.-]+\b/);
    // The rehearsal's copy is the runner's own service container.
    expect(MAIN.jobs.rehearse!.env!.REHEARSE_URL).toMatch(/@localhost:/);
  });

  it('the shell scripts name no database client (the workflow holds those lines)', () => {
    for (const f of ['run.sh', 'seal-archive.sh', 'photo-delete.sh'])
      expect(read(`scripts/ops/clean-start/${f}`), f).not.toMatch(/\b(psql|pg_dump|pg_dumpall|pg_restore|prisma)\b/);
  });
});

describe('the small SQL files', () => {
  const strip = (s: string) => s.replace(/--[^\n]*/g, '');
  it('fingerprint.sql: the plan id takes the trigger text as a dump restores it; the before/after md5 the exact text', () => {
    // A trigger's WHEN clause of chained ORs prints nested on the database that
    // created it and flat on a restored dump (found by the flow test), so the
    // plan id, which REHEARSE compares across the two, drops the parentheses.
    const s = strip(read('scripts/ops/clean-start/fingerprint.sql'));
    expect(s).toMatch(/triggers_stable AS \([\s\S]*regexp_replace\(pg_catalog\.pg_get_triggerdef\(t\.oid\), '\[\(\)\]', '', 'g'\)/);
    expect(s).toMatch(/SELECT 'triggers', \(SELECT md5 FROM triggers_stable\)/);
    expect(s).toMatch(/\(SELECT md5 FROM triggers\) AS triggers_md5/);
    const nested = 'WHEN ((((a IS DISTINCT FROM b) OR (c IS DISTINCT FROM d)) OR (e IS DISTINCT FROM f)))';
    const flat = 'WHEN (((a IS DISTINCT FROM b) OR (c IS DISTINCT FROM d) OR (e IS DISTINCT FROM f)))';
    expect(nested.replace(/[()]/g, '')).toBe(flat.replace(/[()]/g, ''));
  });
  it('facts.sql only reads, in a READ ONLY transaction', () => {
    const s = strip(read('scripts/ops/clean-start/facts.sql'));
    expect(s).toMatch(/BEGIN READ ONLY;/);
    expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|SET ROLE)\b/i);
  });
  it('counter.sql is one INSERT on CodeSequence, always rolled back', () => {
    const s = strip(read('scripts/ops/clean-start/counter.sql'));
    expect(s.match(/\bINSERT\b/g)).toHaveLength(1);
    expect(s).toMatch(/INSERT INTO public\."CodeSequence"/);
    expect(s.trim().endsWith('ROLLBACK;')).toBe(true);
    expect(s).not.toMatch(/\bCOMMIT\b|\b(UPDATE|DELETE|TRUNCATE) (FROM |TABLE )?public/i);
  });
  it('photos-record.sql writes one AuditLog row and nothing else, with its checks first', () => {
    const s = strip(read('scripts/ops/clean-start/photos-record.sql'));
    expect(s.match(/\bINSERT INTO\b/g)).toHaveLength(1);
    expect(s).toMatch(/INSERT INTO public\."AuditLog"/);
    expect(s).not.toMatch(/\b(UPDATE public|DELETE FROM|TRUNCATE|ALTER|DROP)\b/);
    expect(s).not.toMatch(/audit_maintenance/);
    expect(s.indexOf('CS401')).toBeLessThan(s.indexOf('INSERT INTO'));
    expect(s.indexOf('CS402')).toBeLessThan(s.indexOf('INSERT INTO'));
  });
});
