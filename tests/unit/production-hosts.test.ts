// @vitest-environment node
/**
 * Code review 2026-11-10, finding 14: the production host markers in ONE place.
 *
 * Production was recognised by a single fixed host name written into about a
 * hundred files. Every disaster-recovery runbook ends with production on a NEW
 * host, after which the guards in front of seeds, tests and clean-up scripts no
 * longer recognised it, prod-run refused the real production, and the nightly
 * backup kept dumping the old one. Now:
 *   - config/production-hosts.txt holds a LIST (production now first, older hosts
 *     kept so they stay protected);
 *   - scripts/lib/production-hosts.cjs (Node) and scripts/ops/production-hosts.sh
 *     (shell) read it by the same rules, and every guard uses one of them;
 *   - a missing, empty or malformed list refuses: a guard never becomes weaker.
 *
 * Pinned here: the list's rules, the two readers' agreement (the shell one is
 * executed under bash), the shared guard with several hosts and with a broken
 * list, and the backup's connection check executed with a two-host list.
 * tests/unit/scripts-production-guard.test.ts pins that no guard carries a marker
 * of its own.
 */
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProductionHostsError,
  hostMarker,
  loadProductionHosts,
  namesProduction,
  parseProductionHosts,
  productionMarkerIn,
} from '../../scripts/lib/production-hosts.cjs';
import {
  PRODUCTION_HOST_PREFIX,
  ProductionGuardRefusal,
  assertNotProduction,
  liveSiteNamed,
  pointsAtProduction,
} from '../../scripts/lib/assert-not-production';
import { resolveBash, runScriptOf, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';

// Synthetic markers: the test never needs the real one, except to check the repo's list loads.
const NEW = 'ep-fresh-meadow-a1b2c3';
const OLD = 'ep-old-harbour-d4e5f6';
const TWO = [NEW, OLD];
const PASSWORD = 'synthetic-pw-zq81';
const urlFor = (host: string, query = '') => ['postgresql://', 'synthetic_owner', ':', PASSWORD, '@', host, '/neondb', query].join('');
const quiet = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l) } };
};

describe('the list file and its rules (scripts/lib/production-hosts.cjs)', () => {
  it("the repository's list loads, and its first line is production now", () => {
    const hosts = loadProductionHosts();
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts[0]).toBe(PRODUCTION_HOST_PREFIX);
  });

  it('reads one marker a line, lower-cased, notes and blank lines ignored, repeats once', () => {
    expect(parseProductionHosts(`# production now\n${NEW.toUpperCase()}  \n\n  ${OLD} # kept after the restore\n${NEW}\n`)).toEqual(TWO);
  });

  it.each([
    ['an empty file', ''],
    ['notes only', '# nothing here\n\n'],
    ['a connection string pasted in', urlFor(`${NEW}.neon.invalid`)],
    ['a marker too short to be safe', 'ep-ab'],
    ['a space inside a marker', 'ep-fresh meadow'],
    ['a glob character', 'ep-fresh-*'],
    ['one good line and one bad', `${NEW}\nnot a host!`],
  ])('refuses %s', (_label, text) => {
    expect(() => parseProductionHosts(text)).toThrow(ProductionHostsError);
  });

  it('a refusal names the line, never its content (it may be a pasted secret)', () => {
    const text = `${NEW}\n${urlFor(`${OLD}.neon.invalid`)}`;
    let message = '';
    try {
      parseProductionHosts(text);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('line 2');
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(OLD);
  });

  it('a file that is not there refuses', () => {
    expect(() => loadProductionHosts(join(tmpdir(), 'no-such-dir-zq', 'production-hosts.txt'))).toThrow(ProductionHostsError);
  });

  it('every check refuses an empty or malformed list instead of answering "not production"', () => {
    for (const bad of [[], [''], ['ep']] as string[][]) {
      expect(() => productionMarkerIn('postgresql://u@localhost/db', bad)).toThrow(ProductionHostsError);
      expect(() => hostMarker('localhost', bad)).toThrow(ProductionHostsError);
      expect(() => namesProduction(NEW, bad)).toThrow(ProductionHostsError);
    }
  });

  it('finds any listed host: by the host, anywhere in the string, in any case, percent-escaped or not', () => {
    expect(hostMarker(`${OLD.toUpperCase()}-pooler.neon.invalid`, TWO)).toBe(OLD);
    expect(hostMarker('localhost', TWO)).toBeNull();
    expect(productionMarkerIn(urlFor('localhost:5432', `?host=${NEW.replace(/-/g, '%2D')}.neon.invalid`), TWO)).toBe(NEW);
    expect(productionMarkerIn(urlFor(`${OLD}.neon.invalid`), TWO)).toBe(OLD);
    expect(productionMarkerIn(urlFor('ep-uat-branch-1.neon.invalid'), TWO)).toBeNull();
    expect(namesProduction(OLD, TWO)).toBe(true);
    expect(namesProduction(`${NEW}-x9`, TWO)).toBe(true);
    expect(namesProduction('fresh-meadow', TWO)).toBe(false);
  });
});

describe('the shared guard with several production hosts (scripts/lib/assert-not-production.ts)', () => {
  it.each([
    ['production now', NEW],
    ['the old production host, kept in the list', OLD],
  ])('refuses %s without --expect-host, and takes it when named', (_label, marker) => {
    const url = urlFor(`${marker}-pooler.us-east-1.aws.neon.invalid`);
    const refused = quiet();
    expect(() => assertNotProduction(url, [], refused.out, TWO)).toThrow(ProductionGuardRefusal);
    expect(refused.lines.join('\n')).toContain(`--expect-host ${marker}`);
    expect(refused.lines.join('\n')).not.toContain(PASSWORD);

    const named = quiet();
    expect(assertNotProduction(url, ['--expect-host', marker], named.out, TWO)).toBe(url);
    expect(named.lines.join('\n')).toContain(`${marker}… (PRODUCTION) — named with --expect-host`);
  });

  it('naming the other production host does not open this one', () => {
    const url = urlFor(`${OLD}.neon.invalid`);
    expect(() => assertNotProduction(url, ['--expect-host', NEW], quiet().out, TWO)).toThrow(ProductionGuardRefusal);
  });

  it.each([
    ['an empty list', [] as string[]],
    ['a malformed list', ['ep']],
  ])('%s refuses everything, even a local database', (_label, hosts) => {
    const r = quiet();
    expect(() => assertNotProduction('postgresql://u@localhost:5432/db', [], r.out, hosts)).toThrow(ProductionGuardRefusal);
    expect(r.lines.join('\n')).toMatch(/production host list/);
    expect(() => pointsAtProduction('postgresql://u@localhost:5432/db', hosts)).toThrow();
    expect(() => liveSiteNamed('probe', ['--expect-host', NEW], quiet().out, hosts)).toThrow();
  });

  it('liveSiteNamed takes any listed host and says the current one when it refuses', () => {
    expect(liveSiteNamed('probe', ['--expect-host', OLD], quiet().out, TWO)).toBe(true);
    const r = quiet();
    expect(liveSiteNamed('probe', [], r.out, TWO)).toBe(false);
    expect(r.lines.join('\n')).toContain(`--expect-host ${NEW}`);
  });
});

/** Runs a bash snippet with scripts/ops/production-hosts.sh beside a list of our own. */
function withShellList(listText: string | null, script: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nmwc-hosts-'));
  try {
    mkdirSync(join(dir, 'scripts', 'ops'), { recursive: true });
    mkdirSync(join(dir, 'config'), { recursive: true });
    copyFileSync('scripts/ops/production-hosts.sh', join(dir, 'scripts', 'ops', 'production-hosts.sh'));
    if (listText !== null) writeFileSync(join(dir, 'config', 'production-hosts.txt'), listText, 'utf8');
    writeFileSync(join(dir, 'step.sh'), script, 'utf8');
    const { bash, extraPath } = resolveBash();
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) if (k.toLowerCase() === 'path') delete childEnv[k];
    childEnv.PATH = extraPath ? `${extraPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` : process.env.PATH;
    Object.assign(childEnv, env, { GITHUB_ENV: join(dir, 'github_env').replace(/\\/g, '/') });
    const res = spawnSync(bash, ['-e', 'step.sh'], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 120_000 });
    let githubEnv = '';
    try {
      githubEnv = readFileSync(join(dir, 'github_env'), 'utf8');
    } catch {
      /* not written */
    }
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, githubEnv };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the shell reader agrees with the Node one (scripts/ops/production-hosts.sh)', () => {
  const LISTS: Array<[string, string]> = [
    ['two hosts with notes', `# now\n${NEW.toUpperCase()}\n\n${OLD}   # kept\n${NEW}\n`],
    ['an empty file', ''],
    ['notes only', '# none\n'],
    ['a pasted connection string', urlFor(`${NEW}.neon.invalid`)],
    ['a short marker', 'ep-ab'],
    ['a space inside', 'ep-fresh meadow'],
    ['no final newline', OLD],
  ];

  it.each(LISTS)('%s', (_label, text) => {
    let node: string;
    try {
      node = parseProductionHosts(text).join(',');
    } catch {
      node = 'REFUSED';
    }
    const r = withShellList(
      text,
      '. scripts/ops/production-hosts.sh\nif production_hosts_load; then (IFS=,; echo "HOSTS=${PRODUCTION_HOSTS[*]}"); else echo HOSTS=REFUSED; fi\n'
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`HOSTS=${node}`);
    if (node === 'REFUSED') expect(r.out).toMatch(/::error::\[production-hosts\] refusing/);
    expect(r.out).not.toContain(PASSWORD);
  }, STEP_TEST_TIMEOUT_MS);

  it('a missing file refuses', () => {
    const r = withShellList(null, '. scripts/ops/production-hosts.sh\nproduction_hosts_load || echo REFUSED\n');
    expect(r.out).toContain('REFUSED');
  }, STEP_TEST_TIMEOUT_MS);

  it('finds a marker where Node does, and never answers "not production" before a list is loaded', () => {
    const values = [
      urlFor(`${OLD.toUpperCase()}.neon.invalid`),
      urlFor('localhost:5432', `?host=${NEW.replace(/-/g, '%2D')}.neon.invalid`),
      urlFor('ep-uat-branch-1.neon.invalid'),
      'localhost',
    ];
    const script = [
      '. scripts/ops/production-hosts.sh',
      'S=0; production_marker_in "x" >/dev/null || S=$?; echo "UNLOADED=$S"',
      'production_hosts_load',
      ...values.map((v, i) => `M=$(production_marker_in '${v}') || M=NONE; echo "V${i}=$M"`),
      `echo "HOST=$(pg_url_host '${urlFor(`${NEW.toUpperCase()}-pooler.neon.invalid:5432`)}')"`,
    ].join('\n');
    const r = withShellList(TWO.join('\n'), script);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('UNLOADED=2');
    values.forEach((v, i) => expect(r.out).toContain(`V${i}=${productionMarkerIn(v, TWO) ?? 'NONE'}`));
    expect(r.out).toContain(`HOST=${NEW}-pooler.neon.invalid`);
  }, STEP_TEST_TIMEOUT_MS);
});

describe("the nightly backup's connection check (.github/workflows/db-backup.yml), executed", () => {
  const STEP = runScriptOf(readFileSync('.github/workflows/db-backup.yml', 'utf8'), 'Validate the connection string');
  const run = (directUrl: string, list = TWO.join('\n')) => withShellList(list, STEP, { DIRECT_URL: directUrl });

  it('finds the step', () => {
    expect(STEP).toContain('production_hosts_load');
  });

  it('dumps the host on the first line of the list', () => {
    const r = run(urlFor(`${NEW}-pooler.us-east-1.aws.neon.invalid`));
    expect(r.status, r.out).toBe(0);
    expect(r.githubEnv).toContain('PGURL=postgresql://');
  }, STEP_TEST_TIMEOUT_MS);

  it('refuses the OLD production host — the DIRECT_URL secret left behind after a restore — and says so', () => {
    const r = run(urlFor(`${OLD}.us-east-1.aws.neon.invalid`));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/OLD production host/);
    expect(r.out).toMatch(/DIRECT_URL secret must be changed to the new host/);
    expect(r.githubEnv).not.toContain('PGURL=');
    expect(r.out).not.toContain(PASSWORD);
  }, STEP_TEST_TIMEOUT_MS);

  it.each([
    ['a UAT host', urlFor('ep-uat-branch-1.us-east-1.aws.neon.invalid')],
    ['a host parameter that would override the host', urlFor(`${NEW}.neon.invalid`, '?host=ep-uat-branch-1.neon.invalid')],
  ])('refuses %s', (_label, url) => {
    const r = run(url);
    expect(r.status).not.toBe(0);
    expect(r.githubEnv).not.toContain('PGURL=');
  }, STEP_TEST_TIMEOUT_MS);

  it('refuses everything when the list is empty or broken', () => {
    for (const list of ['', '# none', 'ep']) {
      const r = run(urlFor(`${NEW}.neon.invalid`), list);
      expect(r.status, list).not.toBe(0);
      expect(r.out).toMatch(/production-hosts\] refusing/);
      expect(r.githubEnv).not.toContain('PGURL=');
    }
  }, STEP_TEST_TIMEOUT_MS);
});

describe('the plain-node guards refuse when the list is broken', () => {
  /** A copy of one script beside the shared reader and a list of our own, run with node. */
  function runWithList(script: string, listText: string | null, args: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'nmwc-guard-list-'));
    try {
      const [folder] = script.split('/').slice(1, 2);
      mkdirSync(join(dir, 'scripts', folder!), { recursive: true });
      mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
      mkdirSync(join(dir, 'config'), { recursive: true });
      copyFileSync(script, join(dir, script));
      copyFileSync('scripts/lib/production-hosts.cjs', join(dir, 'scripts', 'lib', 'production-hosts.cjs'));
      if (listText !== null) writeFileSync(join(dir, 'config', 'production-hosts.txt'), listText, 'utf8');
      writeFileSync(join(dir, '.env'), 'NOTHING_HERE=1\n', 'utf8');
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DATABASE_URL;
      delete env.DIRECT_URL;
      const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // scripts/qa/run-with-env.mjs reads the same reader the same way (pinned by source in
  // scripts-production-guard.test.ts); it is not executed here, as it runs commands with a .env.
  it.each([
    ['scripts/dev/prod-run.cjs', ['probe.ts', '--expect-host', NEW]],
    ['scripts/dev/env-check.cjs', []],
  ])('%s', (script, args) => {
    for (const list of [null, '', '# none\n', 'ep']) {
      const r = runWithList(script, list, args);
      expect(r.status, `${script} with ${JSON.stringify(list)}: ${r.out}`).not.toBe(0);
      expect(r.out).toMatch(/\[production-hosts\] refusing/);
    }
    // …and with a good list they get past it (env-check: nothing here is production).
    if (script === 'scripts/dev/env-check.cjs') {
      const ok = runWithList(script, TWO.join('\n'), args);
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).toContain('ok: nothing here points at production.');
    }
  }, STEP_TEST_TIMEOUT_MS);
});
