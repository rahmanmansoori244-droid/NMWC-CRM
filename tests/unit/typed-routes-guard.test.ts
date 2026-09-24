// @vitest-environment node
/**
 * Typed routes were switched on and enforced nothing (found 2026-09-24).
 *
 * next.config.ts sets `typedRoutes: true`, yet a probe holding
 * `<Link href="/definitely-not-a-route">` passed both `tsc --noEmit` and
 * `next build`. tsconfig.json listed ".next" in `exclude`, and `exclude` filters
 * the `include` globs, so .next/types/link.d.ts (the augmentation of next/link
 * and next/navigation that does the checking) never entered the program, and
 * neither did validator.ts. Nothing failed: the feature was simply absent. Twelve
 * hrefs had meanwhile been widened to `string`, three of them behind an
 * `as string` cast.
 *
 * A textual check of tsconfig.json cannot see the next way this goes inert: a
 * Next upgrade that moves the generated types, `typedRoutes` dropped from the
 * config, next-env.d.ts rewritten. So this asks the compiler. It generates the
 * route types from clean, writes a probe with bad routes INSIDE the project,
 * runs the project's own typecheck, and requires exactly the bad lines to be
 * rejected, with a control file of real routes that must pass.
 *
 * Dropping ".next/types/**" from `include` leaves this green, correctly: `next
 * typegen` re-adds it to tsconfig.json (and says so) every time it runs, which
 * is before every typecheck. It never touches `exclude`, which is how the
 * original defect lasted.
 *
 * ci-gates-guard.test.ts pins the other half: that the build and CI generate
 * the types before they typecheck.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = process.cwd();
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const NEXT = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const TYPES_DIR = join(ROOT, '.next', 'types');

/**
 * Under tests/: inside the project, so tsconfig's include globs pick it up the way
 * they pick up real code; outside app/, so it is not a route; outside every linted
 * directory. The name must not start with a dot, because those globs skip
 * dot-directories. Gitignored, so a directory left by a killed run cannot be
 * committed.
 */
const PROBE_PARENT = join(ROOT, 'tests');
const PROBE_PREFIX = 'typed-routes-probe-';

/** Marks each line the compiler must reject. */
const MUST_FAIL = '/* must fail */';

const HEADER = `// Written and deleted by tests/unit/typed-routes-guard.test.ts. If this file
// is still here, a run was killed part-way: delete its directory.
import Link from 'next/link';
import { redirect } from 'next/navigation';
`;

// Three shapes, each checked by a different part of link.d.ts: a static href, a
// dynamic one (a typo of /customers/[id]), and redirect(), which is typed apart
// from <Link>.
const BAD_PROBE = `${HEADER}
export function StaticHref() {
  return <Link href="/definitely-not-a-route">x</Link>; ${MUST_FAIL}
}
export function DynamicHref({ id }: { id: string }) {
  return <Link href={\`/customer/\${id}\`}>x</Link>; ${MUST_FAIL}
}
export function leave() {
  redirect('/also-not-a-route'); ${MUST_FAIL}
}
`;

// The control: the same three shapes, pointed at real pages. If this file fails,
// the errors in the bad probe prove nothing, because the probe itself is broken.
const GOOD_PROBE = `${HEADER}
export function StaticHref() {
  return <Link href="/customers">x</Link>;
}
export function DynamicHref({ id }: { id: string }) {
  return <Link href={\`/customers/\${id}\`}>x</Link>;
}
export function leave() {
  redirect('/login');
}
`;

/** 1-based line numbers of `source` that carry the marker. */
function markedLines(source: string): number[] {
  return source.split('\n').flatMap((line, i) => (line.includes(MUST_FAIL) ? [i + 1] : []));
}

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 170_000,
  });
}

type Diagnostic = { file: string; line: number; code: string; message: string };

const result = {
  typegenStatus: -1 as number | null,
  typegenOutput: '',
  linkTypesWritten: false,
  tscStatus: -1 as number | null,
  tscOutput: '',
  programFiles: [] as string[],
  diagnostics: [] as Diagnostic[],
  probeDir: '',
};

beforeAll(() => {
  // A run killed part-way leaves a probe behind, and its bad hrefs would fail
  // every typecheck in this checkout until someone deleted it.
  for (const name of readdirSync(PROBE_PARENT)) {
    if (name.startsWith(PROBE_PREFIX)) {
      rmSync(join(PROBE_PARENT, name), { recursive: true, force: true });
    }
  }

  // From clean, as a fresh checkout has it: `next typegen` does not delete a
  // link.d.ts it no longer writes, so with `typedRoutes` switched off a stale copy
  // would keep this test green while CI checked nothing.
  rmSync(TYPES_DIR, { recursive: true, force: true });
  const typegen = run(NEXT, ['typegen']);
  result.typegenStatus = typegen.status;
  result.typegenOutput = `${typegen.stdout ?? ''}${typegen.stderr ?? ''}`;
  result.linkTypesWritten = existsSync(join(TYPES_DIR, 'link.d.ts'));

  const dir = mkdtempSync(join(PROBE_PARENT, PROBE_PREFIX));
  result.probeDir = basename(dir);
  try {
    writeFileSync(join(dir, 'bad.tsx'), BAD_PROBE, 'utf8');
    writeFileSync(join(dir, 'good.tsx'), GOOD_PROBE, 'utf8');
    // The project's own typecheck: same tsconfig, whole program. Incremental is
    // off so a cached result can neither hide the probe nor slow the next real run.
    const tsc = run(TSC, [
      '--noEmit',
      '-p',
      'tsconfig.json',
      '--incremental',
      'false',
      '--pretty',
      'false',
      '--listFiles',
    ]);
    result.tscStatus = tsc.status;
    result.tscOutput = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.replace(/\\/g, '/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const line of result.tscOutput.split(/\r?\n/)) {
    const d = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line);
    if (d) {
      result.diagnostics.push({ file: d[1]!, line: Number(d[2]), code: d[3]!, message: d[4]! });
    } else if (line.startsWith('/') || /^[A-Za-z]:\//.test(line)) {
      result.programFiles.push(line.trim());
    }
  }
}, 180_000);

/** Diagnostics reported against one of the probe files. */
function probeErrors(file: 'bad.tsx' | 'good.tsx'): Diagnostic[] {
  return result.diagnostics.filter((d) => d.file.endsWith(`${result.probeDir}/${file}`));
}

describe('typed routes are enforced by the typecheck', () => {
  it('generates the route types, including the ones that check an href', () => {
    expect(result.typegenStatus, result.typegenOutput).toBe(0);
    expect(
      result.linkTypesWritten,
      'next typegen wrote no .next/types/link.d.ts: is `typedRoutes` still on in next.config.ts?'
    ).toBe(true);
  });

  it('compiles the generated route types into the program', () => {
    // link.d.ts is what rejects a bad href; validator.ts checks route handler and
    // layout exports against their routes. `exclude: [".next"]` dropped both.
    const inProgram = (name: string) =>
      result.programFiles.some((f) => f.endsWith(`/.next/types/${name}`));
    expect(
      inProgram('link.d.ts'),
      'link.d.ts is not in the program: check tsconfig include/exclude'
    ).toBe(true);
    expect(inProgram('validator.ts'), 'validator.ts is not in the program').toBe(true);
  });

  it('rejects every bad route, and nothing else in the probe', () => {
    const lines = probeErrors('bad.tsx').map((d) => d.line);
    expect(
      [...new Set(lines)].sort((a, b) => a - b),
      result.tscOutput
    ).toEqual(markedLines(BAD_PROBE));
    expect(result.tscStatus, 'tsc must exit non-zero while a bad route exists').not.toBe(0);
  });

  it('accepts the same shapes pointed at real routes', () => {
    expect(probeErrors('good.tsx'), result.tscOutput).toEqual([]);
  });
});
