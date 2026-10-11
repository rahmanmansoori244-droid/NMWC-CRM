// @vitest-environment node
/**
 * Every script that opens a database checks which database first.
 *
 * Data audit 2026-10-10, gap 3: scripts in this repository could delete or rewrite
 * history on production and nothing stopped them — none of them looked at the host
 * it had been handed. The owner's decision of 2026-10-11 deleted the worst of them
 * and put scripts/lib/assert-not-production.ts in front of the rest. A guard that a
 * new script simply forgets to call fails OPEN, silently, which is the defect class
 * this repository's *-guard tests exist for — so the rule is derived from the tree
 * on every run rather than remembered:
 *
 *   - every file under scripts/ and prisma/ (ts, cjs, mjs and friends) that builds a
 *     PrismaClient or a pg client must call the guard: assertNotProduction()
 *     directly, or requireExpectedHost() from scripts/ops/requeue-untracked.ts,
 *     which is checked below to end in assertNotProduction();
 *   - the call must come before the client is built (or be inside its arguments);
 *   - the client must be given its URL explicitly, so the URL the guard checked is
 *     the URL it uses — a bare `new PrismaClient()` reads DATABASE_URL from the
 *     schema behind the guard's back.
 *
 * The behaviour half pins what the guard refuses and what it is allowed to print.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import { callArguments, objectAfter } from '../support/call-args';
import {
  PRODUCTION_HOST_PREFIX,
  ProductionGuardRefusal,
  assertNotProduction,
  expectHostArg,
  withoutExpectHost,
} from '../../scripts/lib/assert-not-production';
import { OperatorRefusal, operatorErrorLabel } from '../../scripts/ops/error-label';

// Built from pieces so no connection-string-shaped literal sits in the source. All
// fake: `.invalid` never resolves.
const PASSWORD = 'synthetic-pw-zq81';
const USER = 'synthetic_owner_zq';
const PROD_ENDPOINT = `${PRODUCTION_HOST_PREFIX}-fake9q7`;
const urlFor = (host: string, query = '') =>
  ['postgresql://', USER, ':', PASSWORD, '@', host, '/neondb', query].join('');
const PROD_URL = urlFor(`${PROD_ENDPOINT}.us-east-1.aws.neon.invalid`);
const UAT_URL = urlFor('ep-uat-branch-1.us-east-1.aws.neon.invalid');

function run(url: string | undefined, args: string[]) {
  const out = { log: vi.fn(), error: vi.fn() };
  let result: string | undefined;
  let thrown: unknown;
  try {
    result = assertNotProduction(url, args, out);
  } catch (e) {
    thrown = e;
  }
  const printed = [...out.log.mock.calls, ...out.error.mock.calls].flat().join('\n');
  return { out, result, thrown, printed };
}

/** Nothing the guard prints may carry a credential or the full production endpoint id. */
function expectNoSecrets(printed: string) {
  expect(printed).not.toContain(PASSWORD);
  expect(printed).not.toContain(USER);
  expect(printed).not.toContain(PROD_ENDPOINT);
  expect(printed).not.toMatch(/postgres(ql)?:\/\//);
}

describe('assertNotProduction: what it refuses', () => {
  it('refuses production without --expect-host, says why, and connects nothing', () => {
    const r = run(PROD_URL, []);
    expect(r.thrown).toBeInstanceOf(ProductionGuardRefusal);
    // An OperatorRefusal, so the ops scripts' redacting label keeps the message.
    expect(r.thrown).toBeInstanceOf(OperatorRefusal);
    expect(operatorErrorLabel(r.thrown)).toMatch(/production guard/);
    expect(r.out.log).not.toHaveBeenCalled();
    expect(r.printed).toMatch(/refusing: this connection points at PRODUCTION/);
    expect(r.printed).toContain(`--expect-host ${PRODUCTION_HOST_PREFIX}`);
    expectNoSecrets(r.printed);
  });

  it.each([
    [['--expect-host']],
    [['--expect-host', '--apply']],
    // Part of the host, but it does not NAME production.
    [['--expect-host', 'sweet-haze']],
    [['--expect-host', 'ep']],
    [['--expect-host', 'neon.invalid']],
    // The flag only counts in its documented form.
    [[`--expect-host=${PRODUCTION_HOST_PREFIX}`]],
  ])('refuses production with %j', (args) => {
    const r = run(PROD_URL, args);
    expect(r.thrown).toBeInstanceOf(ProductionGuardRefusal);
    expect(r.out.log).not.toHaveBeenCalled();
    expectNoSecrets(r.printed);
  });

  it('treats the marker in any case, or anywhere in the string, as production', () => {
    expect(run(urlFor(`${PROD_ENDPOINT.toUpperCase()}.neon.invalid`), []).thrown).toBeInstanceOf(
      ProductionGuardRefusal
    );
    expect(run(urlFor('localhost:5432', `?host=${PROD_ENDPOINT}.neon.invalid`), []).thrown).toBeInstanceOf(
      ProductionGuardRefusal
    );
    // Even when named: the host it would really use is not the one named.
    expect(
      run(urlFor('localhost:5432', `?host=${PROD_ENDPOINT}.neon.invalid`), ['--expect-host', PRODUCTION_HOST_PREFIX])
        .thrown
    ).toBeInstanceOf(ProductionGuardRefusal);
  });

  it('refuses a missing or unreadable connection string — it cannot rule production out', () => {
    for (const url of [undefined, '', 'not a url', 'postgresql:///neondb']) {
      const r = run(url, []);
      expect(r.thrown, String(url)).toBeInstanceOf(ProductionGuardRefusal);
      expect(r.out.log).not.toHaveBeenCalled();
    }
  });

  it('refuses a named host that is not the one in the connection string, on UAT too', () => {
    const r = run(UAT_URL, ['--expect-host', PRODUCTION_HOST_PREFIX]);
    expect(r.thrown).toBeInstanceOf(ProductionGuardRefusal);
    expect(r.printed).toMatch(/you asked for "ep-sweet-haze" but this connection points at ep-uat-branch-1/);
    expectNoSecrets(r.printed);
  });
});

describe('assertNotProduction: what it lets through, and what it prints', () => {
  it('lets production through when the command names it, printing only the marker', () => {
    for (const named of [PRODUCTION_HOST_PREFIX, PROD_ENDPOINT]) {
      const r = run(PROD_URL, ['--apply', '--expect-host', named, '--actor', 'someone']);
      expect(r.thrown).toBeUndefined();
      expect(r.result).toBe(PROD_URL);
      expect(r.out.error).not.toHaveBeenCalled();
      expect(r.out.log).toHaveBeenCalledOnce();
      expect(r.printed).toBe(
        `[db-guard] database host: ${PRODUCTION_HOST_PREFIX}… (PRODUCTION) — named with --expect-host`
      );
      expectNoSecrets(r.printed);
    }
  });

  it('lets any other host through, printing the host and nothing else from the URL', () => {
    const r = run(UAT_URL, []);
    expect(r.result).toBe(UAT_URL);
    expect(r.printed).toBe('[db-guard] database host: ep-uat-branch-1.us-east-1.aws.neon.invalid');
    expectNoSecrets(r.printed);
    expect(run(UAT_URL, ['--expect-host', 'ep-uat-branch-1']).result).toBe(UAT_URL);
    expect(run(urlFor('localhost:5432'), []).result).toBe(urlFor('localhost:5432'));
  });
});

describe('the --expect-host argument helpers', () => {
  it('reads the value, and tells a missing value from a missing flag', () => {
    expect(expectHostArg(['--apply'])).toBeNull();
    expect(expectHostArg(['--expect-host', 'ep-x', '--apply'])).toBe('ep-x');
    expect(expectHostArg(['--expect-host'])).toBe('');
    expect(expectHostArg(['--expect-host', '--apply'])).toBe('');
  });

  it('takes the flag out of positional arguments, and only the flag', () => {
    expect(withoutExpectHost(['a.xlsx', '--expect-host', 'ep-x', 'b.json'])).toEqual(['a.xlsx', 'b.json']);
    expect(withoutExpectHost(['--expect-host', 'ep-x'])).toEqual([]);
    expect(withoutExpectHost(['--expect-host', '--reset'])).toEqual(['--reset']);
    expect(withoutExpectHost(['--reset'])).toEqual(['--reset']);
  });
});

// ---------------------------------------------------------------------------
// The structural half.

const ROOTS = ['scripts', 'prisma'];
const SKIP_DIRS = new Set(['migrations', 'node_modules']);
const EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;
const HELPER = 'scripts/lib/assert-not-production.ts';

/**
 * Files that look like they open a database but provably never connect. Each needs
 * its reason. Empty today: comments are stripped before matching, so a script that
 * only DISCUSSES `new PrismaClient(` in prose (scripts/dev/prod-run.cjs) is not
 * listed by the scan in the first place.
 */
const NEVER_CONNECTS: Record<string, string> = {};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(p);
    return EXT.test(name) ? [p.replace(/\\/g, '/')] : [];
  });
}

/** Comment-stripped source; parsed as TypeScript, which reads plain JS too. */
const code = (file: string) => stripComments(readFileSync(file, 'utf8'), file.replace(EXT, '.ts'));

const PRISMA_CLIENT = /\bnew\s+PrismaClient\s*\(/g;
// A raw Postgres driver counts as opening a database the moment it is imported:
// its Client / Pool is what connects, and nothing else would be imported it for.
const PG_IMPORT =
  /(?:from\s*|require\(\s*|import\(\s*)['"](?:pg|postgres|@neondatabase\/serverless)['"]/;
const GUARD_IMPORT = /import\s*\{[^}]*\bassertNotProduction\b[^}]*\}\s*from\s*['"][./]+(?:scripts\/)?lib\/assert-not-production(?:\.js)?['"]/;
const HOST_GUARD_IMPORT = /import\s*\{[^}]*\brequireExpectedHost\b[^}]*\}\s*from\s*['"]\.\/requeue-untracked['"]/;
const GUARD_CALL = /\b(?:assertNotProduction|requireExpectedHost)\s*\(/g;

function opensDatabase(src: string): boolean {
  return new RegExp(PRISMA_CLIENT.source).test(src) || PG_IMPORT.test(src);
}

const files = ROOTS.flatMap(walk).filter((f) => f !== HELPER);
const connecting = files.filter((f) => opensDatabase(code(f)));

describe('every script that opens a database calls the production guard', () => {
  it('finds the scripts it is meant to police (the walk is not silently empty)', () => {
    expect(connecting).toEqual(
      expect.arrayContaining([
        'prisma/seed.ts',
        'prisma/synthetic.ts',
        'scripts/bulk-reset-credentials.ts',
        'scripts/golive/audit-accounts.ts',
        'scripts/ops/requeue-untracked.ts',
        'scripts/ops/verify-load.ts',
        'scripts/ops/app-role.ts',
      ])
    );
  });

  it.each(connecting.filter((f) => !(f in NEVER_CONNECTS)))('%s', (file) => {
    const src = code(file);
    const imported = GUARD_IMPORT.test(src) || HOST_GUARD_IMPORT.test(src) || file === 'scripts/ops/requeue-untracked.ts';
    expect(imported, `${file} must import assertNotProduction from ${HELPER}`).toBe(true);

    const guardCalls = [...src.matchAll(GUARD_CALL)].map((m) => m.index!);
    // The declaration `export function requireExpectedHost(` is not a call.
    const calls = guardCalls.filter((i) => !/function\s+$/.test(src.slice(Math.max(0, i - 20), i)));
    expect(calls.length, `${file} must CALL the guard, not only import it`).toBeGreaterThan(0);

    for (const m of src.matchAll(PRISMA_CLIENT)) {
      const at = m.index!;
      const [argText] = callArguments(src.slice(at), /\bnew\s+PrismaClient\b/);
      expect(
        calls.some((c) => c < at) || new RegExp(GUARD_CALL.source).test(argText ?? ''),
        `${file}: the guard must run before \`new PrismaClient(\` at offset ${at}`
      ).toBe(true);
      expect(
        /\bdatasourceUrl\b|\bdatasources\b/.test(argText ?? ''),
        `${file}: give the client its URL explicitly, so it uses the URL the guard checked`
      ).toBe(true);
    }
  });

  it('requireExpectedHost really ends in the shared guard', async () => {
    const src = code('scripts/ops/requeue-untracked.ts');
    const start = src.indexOf('export function requireExpectedHost(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nexport ', start + 1));
    expect(body).toMatch(/assertNotProduction\(\s*url\s*,\s*args\s*\)/);

    // And behaves so: its own check accepts any part of the host, the shared one
    // does not on production.
    const { requireExpectedHost } = await import('../../scripts/ops/requeue-untracked');
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    try {
      const host = `${PROD_ENDPOINT}.us-east-1.aws.neon.invalid`;
      expect(() => requireExpectedHost(['--expect-host', 'sweet-haze'], PROD_URL, host)).toThrow(ProductionGuardRefusal);
      expect(() => requireExpectedHost(['--expect-host', PRODUCTION_HOST_PREFIX], PROD_URL, host)).not.toThrow();
    } finally {
      quiet.forEach((spy) => spy.mockRestore());
    }
  });

  it('keeps its allow-list honest: each entry exists, opens nothing it can see, and says why', () => {
    for (const [file, reason] of Object.entries(NEVER_CONNECTS)) {
      expect(existsSync(file), `${file} is listed but gone — remove it`).toBe(true);
      expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe('prisma/seed.ts inserts what is missing and renames nothing', () => {
  // Owner decision 2026-10-11: the seed may still insert missing rows, but it must
  // never change an existing Region name or Channel / SubChannel label — its names
  // are placeholders, and a re-run used to overwrite whatever the business had set.
  const src = code('prisma/seed.ts');
  it.each([
    ['channel', /\blabel\b/],
    ['subChannel', /\blabel\b/],
    ['region', /\bname\b/],
  ] as const)('%s upsert writes no name on update', (model, field) => {
    const calls = callArguments(src, new RegExp(`prisma\\.${model}\\.upsert`));
    expect(calls.length, `the ${model} upsert must exist`).toBeGreaterThan(0);
    for (const args of calls) {
      const update = objectAfter(args, /\bupdate\s*:/);
      expect(update, `${model} upsert must spell out its update`).not.toBeNull();
      expect(update!).not.toMatch(field);
    }
  });
});

describe('the scripts the owner deleted on 2026-10-11 stay deleted', () => {
  // Git history keeps them. Bringing one back means bringing back a script that
  // opened the audit maintenance switch, or rewrote customers, against whatever
  // database it was handed.
  it.each([
    'scripts/wipe-synthetic-data.ts',
    'scripts/cleanup-synthetic-test.ts',
    'scripts/flatten-customer-branches.ts',
    'scripts/seed-demo-edit.ts',
    'prisma/inject-test-edits.ts',
  ])('%s', (file) => {
    expect(existsSync(file)).toBe(false);
  });

  it('prisma/test-*.ts', () => {
    expect(readdirSync('prisma').filter((f) => /^test-.*\.ts$/.test(f))).toEqual([]);
  });
});
