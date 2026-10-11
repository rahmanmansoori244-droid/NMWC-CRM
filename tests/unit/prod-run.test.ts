// @vitest-environment node
/**
 * scripts/dev/prod-run.cjs — the runner for every script run against production.
 *
 * Owner decisions 2026-10-11: every run, read-only or not, carries
 * `--expect-host ep-sweet-haze`. The runner reads it from the SCRIPT's own
 * arguments and passes every argument on unchanged, so the script's guard
 * (scripts/lib/assert-not-production.ts, requireExpectedHost) checks the same flag:
 * typed once, checked twice. It refuses without the flag before it reads the env
 * file, and it still masks every secret in what the script prints.
 *
 * Run for real, with a fake production env file (`.invalid` hosts never resolve)
 * and a probe script that records that it ran, what arguments it was given, and
 * prints the connection strings it was handed — which the runner must mask.
 *
 * The second half holds the documentation to the same rule: every prod-run
 * command shown in the runbooks and the scripts' headers carries the flag, and
 * the scripts with strict argument parsers accept the documented forms.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_HOST_PREFIX } from '../../scripts/lib/assert-not-production';
import { loadExpectations } from '../../scripts/ops/verify-load';
import { parseArgs as visitDaysArgs } from '../../scripts/ops/visitdays-from-sheets';

// Built from pieces so no connection-string-shaped literal sits in the source. All fake.
const PASSWORD = 'synthetic-pw-zq81';
const USER = 'synthetic_owner_zq';
const PROD_ENDPOINT = `${PRODUCTION_HOST_PREFIX}-fake9q7`;
const urlFor = (host: string) => ['postgresql://', USER, ':', PASSWORD, '@', host, '/neondb'].join('');
const PROD_URL = urlFor(`${PROD_ENDPOINT}.us-east-1.aws.neon.invalid`);
const UAT_URL = urlFor('ep-uat-branch-1.us-east-1.aws.neon.invalid');

function expectNoSecrets(printed: string) {
  expect(printed).not.toContain(PASSWORD);
  expect(printed).not.toContain(USER);
  expect(printed).not.toContain(PROD_ENDPOINT);
  expect(printed).not.toMatch(/postgres(ql)?:\/\//);
}

const RUNNER = join(process.cwd(), 'scripts/dev/prod-run.cjs');

/** Runs the runner on a probe script, with an env file holding `directUrl`. */
function run(args: string[], directUrl = PROD_URL) {
  const dir = mkdtempSync(join(tmpdir(), 'prod-run-'));
  try {
    const envFile = join(dir, 'prod.env');
    const marker = join(dir, 'probe-ran');
    const probe = join(dir, 'probe.cjs');
    writeFileSync(envFile, `DIRECT_URL=${directUrl}\n`);
    writeFileSync(
      probe,
      [
        "require('fs').writeFileSync(process.env.PROBE_MARKER, 'ran');",
        "console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));",
        "console.log('DIRECT ' + process.env.DIRECT_URL);",
        "console.log('DATABASE ' + process.env.DATABASE_URL);",
      ].join('\n')
    );
    // The developer's own connection strings are left out, so only this case's count.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/_URL$/.test(k)));
    const r = spawnSync(process.execPath, [RUNNER, ...args.map((a) => (a === '<probe>' ? probe : a))], {
      cwd: process.cwd(),
      env: { ...clean, NMWC_PROD_ENV_FILE: envFile, PROBE_MARKER: marker } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const forwarded = /^ARGS (.*)$/m.exec(out)?.[1];
    return { status: r.status, out, ran: existsSync(marker), forwarded: forwarded ? (JSON.parse(forwarded) as string[]) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('prod-run.cjs requires --expect-host ep-sweet-haze on every run (owner decisions 2026-10-11)', () => {
  it.each([
    ['no flag at all', ['<probe>']],
    ['a read-only question with no flag', ['<probe>', '--list']],
    ['the flag with no value', ['<probe>', '--expect-host']],
    ['the flag followed by another flag', ['<probe>', '--expect-host', '--apply']],
    ['a value that does not name production', ['<probe>', '--expect-host', 'sweet-haze']],
    ['a UAT value', ['<probe>', '--expect-host', 'ep-uat-branch-1']],
    ['the one-word form, which is not read', ['<probe>', `--expect-host=${PRODUCTION_HOST_PREFIX}`]],
  ])('refuses %s, before it reads the env file, and runs nothing', (_label, args) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.ran).toBe(false);
    expect(r.out).toMatch(/\[prod-run\] refusing: every run needs --expect-host ep-sweet-haze among the script's arguments/);
    expect(r.out).toMatch(/usage: node scripts\/dev\/prod-run\.cjs <script> --expect-host ep-sweet-haze/);
    expect(r.out).not.toContain('ep-uat-branch-1');
    expectNoSecrets(r.out);
  });

  it('refuses the flag before the script: the first argument is the script', () => {
    const r = run(['--expect-host', PRODUCTION_HOST_PREFIX, '<probe>']);
    expect(r.status).toBe(2);
    expect(r.ran).toBe(false);
    expect(r.out).toMatch(/^usage: /m);
  });

  it('refuses a value that names production but is not part of the env file’s host, printing neither', () => {
    const r = run(['<probe>', '--expect-host', `${PRODUCTION_HOST_PREFIX}-otherbranch`]);
    expect(r.status).toBe(2);
    expect(r.ran).toBe(false);
    expect(r.out).toMatch(/the --expect-host value is not part of the env file's production host/);
    expect(r.out).not.toContain('otherbranch');
    expectNoSecrets(r.out);
  });

  it('still refuses an env file that is not production, flag or not', () => {
    const r = run(['<probe>', '--expect-host', PRODUCTION_HOST_PREFIX], UAT_URL);
    expect(r.status).toBe(2);
    expect(r.ran).toBe(false);
    expect(r.out).toMatch(/that env file does not point at production — refusing/);
    expectNoSecrets(r.out);
  });

  it('runs the script with the flag, forwards every argument unchanged, and masks every secret', () => {
    const args = ['--expect-host', PRODUCTION_HOST_PREFIX, '--expected-branches', '5', '--expected-visit-days', '4'];
    const r = run(['<probe>', ...args]);
    expect(r.status).toBe(0);
    expect(r.ran).toBe(true);
    // Forwarded as typed: the script's own guard reads the same flag, and a strict
    // parser (verify-load reads flags in pairs) sees exactly the documented order.
    expect(r.forwarded).toEqual(args);
    expect(r.out).toMatch(/^DIRECT <masked>$/m);
    expect(r.out).toMatch(/^DATABASE <a connection string>$/m);
    expect(r.out).toMatch(/\[prod-run\] exit 0/);
    expectNoSecrets(r.out);
  });

  it('accepts the flag anywhere among the script’s arguments, and the full endpoint id as its value — masked in the output', () => {
    const r = run(['<probe>', '--apply', '--expect-host', PROD_ENDPOINT, '--actor', 'someone']);
    expect(r.status).toBe(0);
    expect(r.ran).toBe(true);
    expect(r.forwarded).toEqual(['--apply', '--expect-host', '<masked>', '--actor', 'someone']);
    expectNoSecrets(r.out);
  });
});

// ── the documentation ─────────────────────────────────────────────────────────

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p, ext);
    return ext.test(name) ? [p.replace(/\\/g, '/')] : [];
  });
}

/** Where prod-run commands are shown: the runbooks and the scripts' own headers. */
const DOC_FILES = [
  ...readdirSync('.').filter((f) => f.endsWith('.md')),
  ...walk('docs', /\.md$/),
  ...walk('scripts', /\.(ts|cjs|mjs)$/).filter((f) => f !== 'scripts/dev/prod-run.cjs'),
];

type Documented = { file: string; script: string; args: string[]; text: string };

/**
 * Every prod-run command in a file: `prod-run.cjs` followed by a script (a path, a
 * `<placeholder>` or a `*.tmp.ts`), up to the end of its inline code or its line,
 * with shell and comment line continuations joined. Prose that only names the
 * runner (`through prod-run.cjs`, `prod-run.cjs …`) is not a command.
 */
function documentedCommands(file: string): Documented[] {
  const text = readFileSync(file, 'utf8').replace(/\\\r?\n\s*(?:\*\s+|\/\/\s+)?/g, ' ');
  const out: Documented[] = [];
  for (const m of text.matchAll(/prod-run\.cjs([^`\n]*)/g)) {
    const tail = m[1]!;
    const head = /^\s+(<[^>]+>(?:\.tmp\.ts)?|[\w./-]+\.(?:ts|cjs|mjs))(?=[\s,;:)]|$)/.exec(tail);
    if (!head) continue;
    const rest = tail
      .slice(head[0].length)
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/<[^>]*>/g, 'x')
      .split(/\s+/)
      // Prose punctuation after the last word of an inline command is not part of it.
      .map((t) => t.replace(/[,;:)]+$/, ''))
      .filter((t) => t && t !== '…' && t !== '...');
    const end = rest.findIndex((t) => t.startsWith('#') || t === '&&' || t === ';' || t === '(PowerShell:');
    out.push({ file, script: head[1]!, args: end < 0 ? rest : rest.slice(0, end), text: `prod-run.cjs${tail}`.trim() });
  }
  return out;
}

const documented = DOC_FILES.flatMap(documentedCommands);

describe('every documented prod-run command names production (owner decisions 2026-10-11)', () => {
  it('finds the commands it is meant to check (the scan is not silently empty)', () => {
    expect(documented.length).toBeGreaterThan(20);
    const files = new Set(documented.map((d) => d.file));
    for (const f of [
      'docs/HANDOVER.md',
      'docs/OPERATIONS.md',
      'HANDOVER-START-HERE.md',
      'docs/handover/03-OPERATIONS-AND-DEPLOYMENT.md',
      'scripts/ops/verify-load.ts',
      'scripts/ops/customer-status-drift.ts',
    ]) {
      expect(files, f).toContain(f);
    }
  });

  it('each one carries --expect-host ep-sweet-haze among the script’s arguments', () => {
    const missing = documented
      .filter((d) => {
        const at = d.args.indexOf('--expect-host');
        return at < 0 || d.args[at + 1] !== PRODUCTION_HOST_PREFIX;
      })
      .map((d) => `${d.file}: ${d.text}`);
    expect(missing).toEqual([]);
  });

  it('verify-load’s strict parser accepts every documented form', () => {
    const forms = documented.filter((d) => d.script.endsWith('verify-load.ts'));
    expect(forms.length).toBeGreaterThan(0);
    for (const d of forms) {
      // Both expectation counts given, so the parser reads no manifest.
      const args = d.args.map((a) => (a === 'x' ? '1' : a));
      for (const flag of ['--expected-branches', '--expected-visit-days']) {
        if (!args.includes(flag)) args.push(flag, '1');
      }
      expect(() => loadExpectations(args, {}), `${d.file}: ${d.text}`).not.toThrow();
    }
  });

  it('visitdays-from-sheets’ strict parser accepts every documented form', () => {
    const forms = documented.filter((d) => d.script.endsWith('visitdays-from-sheets.ts'));
    expect(forms.length).toBeGreaterThan(0);
    for (const d of forms) expect(() => visitDaysArgs(d.args), `${d.file}: ${d.text}`).not.toThrow();
  });
});
