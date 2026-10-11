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
 *     PrismaClient (under any name), imports one as a value, or imports a pg driver
 *     must call the guard: assertNotProduction() directly, or requireExpectedHost()
 *     from scripts/ops/requeue-untracked.ts, which is checked below to end in
 *     assertNotProduction();
 *   - the client must be given its URL explicitly, and that URL must be the one the
 *     guard checked, before the client is built — a bare `new PrismaClient()` reads
 *     DATABASE_URL from the schema behind the guard's back, and so does a client
 *     handed some other variable;
 *   - no file there may import, directly or through other modules, a module outside
 *     scripts/ and prisma/ that opens its own database (lib/db.ts, the app's client).
 *
 * The behaviour half pins what the guard refuses and what it is allowed to print,
 * and that scripts/qa/run-with-env.mjs refuses production (review of d02cb27). The
 * scripts that sign in to the live site refuse unless production is named, and
 * prisma/seed.ts refuses production outright (owner decisions 2026-10-11).
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';
import { callArguments } from '../support/call-args';
import {
  PRODUCTION_HOST_PREFIX,
  ProductionGuardRefusal,
  assertNotProduction,
  expectHostArg,
  liveSiteNamed,
  withoutExpectHost,
} from '../../scripts/lib/assert-not-production';
import { OperatorRefusal, operatorErrorLabel } from '../../scripts/ops/error-label';
import { GUIDE_ACCOUNT_VARS, guideAccountsFromEnv } from '../../scripts/lib/guide-accounts';

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

  it('treats a percent-escaped marker as production too — the drivers decode it', () => {
    // Review of d02cb27: libpq, node-postgres and Prisma decode the query, and a
    // `host` parameter overrides the URL's host, so this reached production while
    // the guard printed "localhost".
    const escaped = urlFor('localhost:5432', '?host=ep%2Dsweet%2Dhaze-fake9q7.neon.invalid');
    for (const args of [[], ['--expect-host', PRODUCTION_HOST_PREFIX]]) {
      const r = run(escaped, args);
      expect(r.thrown, JSON.stringify(args)).toBeInstanceOf(ProductionGuardRefusal);
      expect(r.out.log).not.toHaveBeenCalled();
    }
    expect(run(urlFor('localhost:5432', '?host=%65p-sweet-haze-fake9q7.neon.invalid'), []).thrown).toBeInstanceOf(
      ProductionGuardRefusal
    );
    // A stray `%` that is not an escape neither throws nor counts as production.
    expect(run(urlFor('localhost:5432', '?application_name=at-100%'), []).thrown).toBeUndefined();
  });

  it('refuses a named host that is not the one in the connection string, on UAT too', () => {
    const r = run(UAT_URL, ['--expect-host', PRODUCTION_HOST_PREFIX]);
    expect(r.thrown).toBeInstanceOf(ProductionGuardRefusal);
    expect(r.printed).toMatch(/you asked for "ep-sweet-haze…" but this connection points at ep-uat-branch-1/);
    expectNoSecrets(r.printed);
  });

  it('does not echo a full production endpoint id given as --expect-host', () => {
    // Review of d02cb27: the mismatch refusal printed the value as typed, though
    // the guard never prints the endpoint id anywhere else.
    const r = run(UAT_URL, ['--expect-host', PROD_ENDPOINT]);
    expect(r.thrown).toBeInstanceOf(ProductionGuardRefusal);
    expect(r.printed).toMatch(/you asked for "ep-sweet-haze…"/);
    expectNoSecrets(r.printed);
    // A value that does not name production is the operator's own words: shown.
    expect(run(UAT_URL, ['--expect-host', 'ep-other-branch']).printed).toMatch(/you asked for "ep-other-branch"/);
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
//
// Review of d02cb27: the first version matched the literal `new PrismaClient(`
// and accepted any guard call earlier in the file, so an aliased import, the
// app's own client reached through an import, or a client handed a different
// variable from the one the guard checked all passed. So the files are parsed
// (TypeScript's parser, which reads the .cjs/.mjs files too) and the URL each
// client is given is traced back to the guard.

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

/**
 * Shell scripts that reach a database. The guard is TypeScript, so a shell script
 * cannot call it: each one is listed here with what stands in its place, so a new
 * one is a decision someone wrote down rather than a gap nobody saw.
 */
const SHELL_OUTSIDE_GUARD: Record<string, string> = {
  'scripts/ops/restore-load.sh':
    'Loads a backup into RESTORE_TARGET_URL with psql (CI, the restore drill, OPERATIONS §6.5). ' +
    'Owner decisions 2026-10-11: it refuses, before psql or pg_restore starts, a target with the ' +
    'production marker anywhere in it (raw or percent-decoded) and a PGHOST / PGHOSTADDR with ' +
    'it; tests/unit/restore-load-guard.test.ts executes that. The dump is plain, made without ' +
    '--clean (db-backup.yml), and psql runs with ON_ERROR_STOP=1.',
};

function walk(dir: string, ext: RegExp = EXT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(p, ext);
    return ext.test(name) ? [p.replace(/\\/g, '/')] : [];
  });
}

/** Memoised per file: the import walk below reads the same lib/ modules for every script. */
const memo = <T,>(fn: (file: string) => T) => {
  const cache = new Map<string, T>();
  return (file: string) => {
    if (!cache.has(file)) cache.set(file, fn(file));
    return cache.get(file)!;
  };
};
/** Comment-stripped source; parsed as TypeScript, which reads plain JS too. */
const code = memo((file) => stripComments(readFileSync(file, 'utf8'), file.replace(EXT, '.ts')));
const parse = memo((file) =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
);

// A raw Postgres driver counts as opening a database the moment it is imported:
// its Client / Pool is what connects, and nothing else would be imported it for.
const PG_IMPORT =
  /(?:from\s*|require\(\s*|import\(\s*)['"](?:pg|postgres|@neondatabase\/serverless)['"]/;
const GUARD_IMPORT = /import\s*\{[^}]*\bassertNotProduction\b[^}]*\}\s*from\s*['"][./]+(?:scripts\/)?lib\/assert-not-production(?:\.js)?['"]/;
const HOST_GUARD_IMPORT = /import\s*\{[^}]*\brequireExpectedHost\b[^}]*\}\s*from\s*['"]\.\/requeue-untracked['"]/;
const GUARD_CALL = /\b(?:assertNotProduction|requireExpectedHost)\s*\(/g;
const IMPORT_SPEC = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

const all = (sf: ts.SourceFile): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) ||
  ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e)
    ? unwrap(e.expression)
    : e;

const calleeName = (call: ts.CallExpression) => {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : null;
};

/** An identifier sitting in a type (`client: PrismaClient`, `typeof PrismaClient`): not a value use. */
function inTypePosition(node: ts.Node): boolean {
  let p = node.parent;
  while (p && ts.isQualifiedName(p)) p = p.parent;
  return !!p && (ts.isTypeNode(p) || ts.isExpressionWithTypeArguments(p));
}

/** The names a binding declares (`a`, or every name in `{ a, b: [c] }`). */
function boundNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
}

/**
 * The identifier that DECLARES the variable `id` refers to, found by walking out
 * through the enclosing scopes. Block scoping is assumed for every declaration; a
 * `var` this misses resolves to nothing, which fails closed.
 */
function declarationOf(id: ts.Identifier): ts.Identifier | null {
  const declaredIn = (scope: ts.Node): ts.Identifier[] => {
    const out: ts.Identifier[] = [];
    const fromStatements = (statements: readonly ts.Statement[]) => {
      for (const st of statements) {
        if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => out.push(...boundNames(d.name)));
        else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.push(st.name);
        else if (ts.isImportDeclaration(st) && st.importClause) {
          const c = st.importClause;
          if (c.name) out.push(c.name);
          const nb = c.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) out.push(nb.name);
          if (nb && ts.isNamedImports(nb)) nb.elements.forEach((el) => out.push(el.name));
        }
      }
    };
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      fromStatements(scope.statements);
    }
    if (ts.isFunctionLike(scope)) scope.parameters.forEach((p) => out.push(...boundNames(p.name)));
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer &&
        ts.isVariableDeclarationList(scope.initializer)) {
      scope.initializer.declarations.forEach((d) => out.push(...boundNames(d.name)));
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) out.push(...boundNames(scope.variableDeclaration.name));
    return out;
  };
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    const hit = declaredIn(scope).find((d) => d.text === id.text);
    if (hit) return hit;
  }
  return null;
}

/** The VariableDeclaration a declaring identifier belongs to, through any destructuring. */
function variableOf(decl: ts.Identifier): ts.VariableDeclaration | null {
  let n: ts.Node = decl.parent;
  while (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n = n.parent;
  return ts.isVariableDeclaration(n) ? n : null;
}

const isConst = (v: ts.VariableDeclaration) =>
  ts.isVariableDeclarationList(v.parent) && (v.parent.flags & ts.NodeFlags.Const) !== 0;

/** A function declared in this file under that name: `function f() {}` or `const f = () => …`. */
function localFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  for (const n of all(sf)) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) return n;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      return n.initializer;
    }
  }
  return null;
}

/** What a function returns: every `return` expression of its own body (not of nested functions). */
function returnsOf(fn: ts.FunctionLikeDeclaration): Array<{ expr: ts.Expression; at: number }> {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [{ expr: body as ts.Expression, at: body.getStart() }];
  const out: Array<{ expr: ts.Expression; at: number }> = [];
  let bare = false;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      if (n.expression) out.push({ expr: n.expression, at: n.getStart() });
      else bare = true;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return bare ? [] : out;
}

/**
 * Is this the URL the guard checked? True for `assertNotProduction(…)` itself;
 * for a call to a function in this file that returns only such URLs; and for a
 * variable that was assigned one, or that was handed to the guard
 * (`assertNotProduction(url, …)` / `requireExpectedHost(args, url, …)`) before
 * position `at`, and is never assigned again. Anything else is not traced, and
 * fails: an unproven URL is treated as an unchecked one.
 */
function checkedUrl(sf: ts.SourceFile, expr: ts.Expression, at: number, depth = 0): boolean {
  if (depth > 8) return false;
  const e = unwrap(expr);
  if (ts.isCallExpression(e)) {
    const name = calleeName(e);
    if (name === 'assertNotProduction') return true;
    const fn = name ? localFunction(sf, name) : null;
    const returns = fn ? returnsOf(fn) : [];
    return returns.length > 0 && returns.every((r) => checkedUrl(sf, r.expr, r.at, depth + 1));
  }
  if (!ts.isIdentifier(e)) return false;
  const decl = declarationOf(e);
  if (!decl) return false;
  const variable = variableOf(decl);

  if (variable && isConst(variable) && variable.initializer) {
    if (ts.isIdentifier(variable.name) && checkedUrl(sf, variable.initializer, variable.getStart(), depth + 1)) {
      return true;
    }
    // `const { url } = prepare(…)`, where prepare returns `{ url, … }` it has checked.
    const init = unwrap(variable.initializer);
    const element = decl.parent;
    if (ts.isObjectBindingPattern(variable.name) && ts.isBindingElement(element) && ts.isCallExpression(init)) {
      const key = (element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName : decl).text;
      const name = calleeName(init);
      const fn = name ? localFunction(sf, name) : null;
      const returns = fn ? returnsOf(fn) : [];
      const field = (r: { expr: ts.Expression }) => {
        const obj = unwrap(r.expr);
        if (!ts.isObjectLiteralExpression(obj)) return null;
        for (const p of obj.properties) {
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key) return p.initializer;
        }
        return null;
      };
      if (returns.length > 0 && returns.every((r) => {
        const value = field(r);
        return value !== null && checkedUrl(sf, value, r.at, depth + 1);
      })) {
        return true;
      }
    }
  }

  const nodes = all(sf);
  const sameVariable = (n: ts.Node | undefined) =>
    !!n && ts.isIdentifier(unwrap(n as ts.Expression)) && declarationOf(unwrap(n as ts.Expression) as ts.Identifier) === decl;
  const reassigned = nodes.some(
    (n) =>
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      sameVariable(n.left)
  );
  if (reassigned) return false;
  return nodes.some((n) => {
    if (!ts.isCallExpression(n) || n.getStart() >= at) return false;
    const name = calleeName(n);
    if (name === 'assertNotProduction') return sameVariable(n.arguments[0]);
    if (name === 'requireExpectedHost') return sameVariable(n.arguments[1]);
    return false;
  });
}

/** The `datasourceUrl` (or `datasources.<name>.url`) a client's options give it, or null. */
function clientUrl(construction: ts.NewExpression): ts.Expression | null {
  const opts = construction.arguments?.[0] && unwrap(construction.arguments[0]);
  if (!opts || !ts.isObjectLiteralExpression(opts)) return null;
  const prop = (obj: ts.ObjectLiteralExpression, key: string): ts.Expression | null => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key) {
        return p.initializer;
      }
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
    }
    return null;
  };
  const direct = prop(opts, 'datasourceUrl');
  if (direct) return direct;
  const sources = prop(opts, 'datasources');
  if (!sources || !ts.isObjectLiteralExpression(unwrap(sources))) return null;
  const urls = (unwrap(sources) as ts.ObjectLiteralExpression).properties.flatMap((p) => {
    const inner = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null;
    const url = inner && ts.isObjectLiteralExpression(inner) ? prop(inner, 'url') : null;
    return url ? [url] : [];
  });
  return urls.length === 1 ? urls[0]! : null;
}

type ClientScan = {
  /** Every `new PrismaClient(…)`, under any name it was imported as. */
  constructions: ts.NewExpression[];
  /** PrismaClient used as a value other than `new …(…)`: it could be built where this cannot see. */
  escapes: number[];
  /** A value import of PrismaClient (not `import type`), aliases included. */
  valueImport: boolean;
};

function scanClients(sf: ts.SourceFile): ClientScan {
  const names = new Set(['PrismaClient']);
  let valueImport = false;
  const fromPrisma = (spec: ts.Node | undefined) =>
    !!spec && ts.isStringLiteral(spec) && /^@prisma\/client(\/|$)/.test(spec.text);
  for (const n of all(sf)) {
    if (ts.isImportDeclaration(n) && fromPrisma(n.moduleSpecifier) && n.importClause && !n.importClause.isTypeOnly) {
      const nb = n.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (!el.isTypeOnly && (el.propertyName ?? el.name).text === 'PrismaClient') {
            names.add(el.name.text);
            valueImport = true;
          }
        }
      }
    }
    // const { PrismaClient: P } = require('@prisma/client')
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) &&
        calleeName(n.initializer) === 'require' && fromPrisma(n.initializer.arguments[0]) &&
        ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : (el.name as ts.Identifier).text;
        if (key === 'PrismaClient' && ts.isIdentifier(el.name)) {
          names.add(el.name.text);
          valueImport = true;
        }
      }
    }
  }
  const constructions: ts.NewExpression[] = [];
  const escapes: number[] = [];
  for (const n of all(sf)) {
    const isClientRef =
      (ts.isIdentifier(n) && names.has(n.text)) ||
      // `new Prisma.PrismaClient(…)`, `new pc.PrismaClient(…)` from a namespace import.
      (ts.isPropertyAccessExpression(n) && n.name.text === 'PrismaClient');
    if (!isClientRef) continue;
    const parent = n.parent;
    if (ts.isNewExpression(parent) && parent.expression === n) constructions.push(parent);
    else if (ts.isIdentifier(n)) {
      const declaring =
        ts.isImportSpecifier(parent) || ts.isBindingElement(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === n);
      if (!declaring && !inTypePosition(n)) escapes.push(n.getStart());
    } else if (!inTypePosition(n)) escapes.push(n.getStart());
  }
  return { constructions, escapes, valueImport };
}

/**
 * A module outside scripts/ and prisma/ that this file imports, directly or through
 * other modules, and that opens a database itself — lib/db.ts, the app's client,
 * reads DATABASE_URL behind the guard's back, and every services/* module uses it.
 * Returns the import chain, or null. Modules under scripts/ and prisma/ are not
 * followed: they are scanned on their own.
 */
function reachesOutsideDatabase(file: string): string[] | null {
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = spec.slice(2);
    else if (spec.startsWith('.')) base = join(dirname(from), spec).replace(/\\/g, '/');
    else return null;
    if (/\.(ts|tsx|mts|cts)$/.test(base) && existsSync(base)) return base;
    base = base.replace(/\.(js|mjs|cjs)$/, '');
    for (const c of [`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  };
  const cameFrom = new Map<string, string | null>([[file, null]]);
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const m of code(current).matchAll(IMPORT_SPEC)) {
      const next = resolveSpec(current, m[1]!);
      if (!next || cameFrom.has(next) || /^(scripts|prisma|node_modules)\//.test(next)) continue;
      cameFrom.set(next, current);
      const src = code(next);
      if (/\bnew\s+PrismaClient\s*\(/.test(src) || PG_IMPORT.test(src)) {
        const chain: string[] = [];
        for (let c: string | null | undefined = next; c; c = cameFrom.get(c)) chain.unshift(c);
        return chain;
      }
      queue.push(next);
    }
  }
  return null;
}

function opensDatabase(file: string): boolean {
  const src = code(file);
  const scan = scanClients(parse(file));
  return scan.constructions.length > 0 || scan.valueImport || PG_IMPORT.test(src) || reachesOutsideDatabase(file) !== null;
}

const files = ROOTS.flatMap((r) => walk(r)).filter((f) => f !== HELPER);
const connecting = files.filter(opensDatabase);

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
        'scripts/ops/rescore-completeness.ts',
      ])
    );
  });

  it.each(connecting.filter((f) => !(f in NEVER_CONNECTS)))('%s', (file) => {
    const chain = reachesOutsideDatabase(file);
    expect(
      chain,
      `${file} reaches a module that opens its own database (${chain?.join(' → ')}); that client reads ` +
        'DATABASE_URL itself, behind the guard. Build the script its own client from a guarded URL instead.'
    ).toBeNull();

    const src = code(file);
    const imported = GUARD_IMPORT.test(src) || HOST_GUARD_IMPORT.test(src) || file === 'scripts/ops/requeue-untracked.ts';
    expect(imported, `${file} must import assertNotProduction from ${HELPER}`).toBe(true);

    const guardCalls = [...src.matchAll(GUARD_CALL)].map((m) => m.index!);
    // The declaration `export function requireExpectedHost(` is not a call.
    const calls = guardCalls.filter((i) => !/function\s+$/.test(src.slice(Math.max(0, i - 20), i)));
    expect(calls.length, `${file} must CALL the guard, not only import it`).toBeGreaterThan(0);

    const sf = parse(file);
    const scan = scanClients(sf);
    expect(
      scan.escapes,
      `${file}: PrismaClient is used as a value other than \`new PrismaClient({ datasourceUrl: … })\` ` +
        '(an alias, a factory, a re-export), so a client could be built where this test cannot see it'
    ).toEqual([]);
    for (const construction of scan.constructions) {
      const at = construction.getStart();
      const url = clientUrl(construction);
      expect(url, `${file}: give the client at offset ${at} its URL explicitly (datasourceUrl)`).not.toBeNull();
      expect(
        checkedUrl(sf, url!, at),
        `${file}: the client at offset ${at} must be given the URL the guard checked — ` +
          '`assertNotProduction(…)` itself, or a const assigned from it, or a variable handed to ' +
          'assertNotProduction / requireExpectedHost before the client is built'
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

  it('lists every shell script that reaches a database, with what stands in for the guard', () => {
    const shells = ROOTS.flatMap((r) => walk(r, /\.(sh|bash|ps1)$/)).filter((f) =>
      /\b(?:psql|pg_dump|pg_dumpall|pg_restore|prisma)\b/.test(readFileSync(f, 'utf8'))
    );
    expect(shells.sort()).toEqual(Object.keys(SHELL_OUTSIDE_GUARD).sort());
    for (const reason of Object.values(SHELL_OUTSIDE_GUARD)) expect(reason.trim().length).toBeGreaterThan(20);
  });
});

describe('the structural scan sees what it is meant to see', () => {
  // Each blind spot the review of d02cb27 named, as a file the scan must flag. Run
  // on throw-away source, so the scan is proven to fail when it should — a guard
  // test that can only pass passes for the wrong reason.
  const scanSource = (src: string) => {
    const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const scan = scanClients(sf);
    return {
      scan,
      checked: scan.constructions.map((c) => {
        const url = clientUrl(c);
        return url !== null && checkedUrl(sf, url, c.getStart());
      }),
    };
  };
  const GUARD = "import { assertNotProduction } from '../lib/assert-not-production';\n";

  it('finds a client under an alias, from a namespace, or from require()', () => {
    expect(scanSource(`import { PrismaClient as P } from '@prisma/client';\nconst c = new P({});`).scan.constructions).toHaveLength(1);
    expect(scanSource(`import * as pc from '@prisma/client';\nconst c = new pc.PrismaClient({});`).scan.constructions).toHaveLength(1);
    expect(scanSource(`import { Prisma } from '@prisma/client';\nconst c = new Prisma.PrismaClient({});`).scan.constructions).toHaveLength(1);
    expect(scanSource(`const { PrismaClient: P } = require('@prisma/client');\nconst c = new P({});`).scan.constructions).toHaveLength(1);
    expect(scanSource(`import { PrismaClient } from '@prisma/client';`).scan.valueImport).toBe(true);
    expect(scanSource(`import type { PrismaClient } from '@prisma/client';`).scan.valueImport).toBe(false);
    expect(scanSource(`import { type PrismaClient } from '@prisma/client';`).scan.valueImport).toBe(false);
  });

  it('flags PrismaClient handed around as a value, but not used as a type', () => {
    expect(scanSource(`import { PrismaClient } from '@prisma/client';\nconst C = PrismaClient;`).scan.escapes).toHaveLength(1);
    expect(
      scanSource(`import { PrismaClient } from '@prisma/client';\nfunction f(c: PrismaClient): InstanceType<typeof PrismaClient> { return c; }`)
        .scan.escapes
    ).toEqual([]);
  });

  it('accepts only the URL the guard checked', () => {
    const ok = [
      `${GUARD}new PrismaClient({ datasourceUrl: assertNotProduction(process.env.DIRECT_URL) });`,
      `${GUARD}const url = assertNotProduction(process.env.DIRECT_URL);\nnew PrismaClient({ datasourceUrl: url });`,
      `${GUARD}function main() { const url = process.env.DIRECT_URL ?? ''; requireExpectedHost(args, url, h); new PrismaClient({ datasourceUrl: url }); }`,
      `${GUARD}function owner(): string { return assertNotProduction(process.env.DIRECT_URL); }\nnew PrismaClient({ datasourceUrl: owner() });`,
      `${GUARD}function prepare() { const url = process.env.DIRECT_URL ?? ''; requireExpectedHost(a, url, h); return { url, h }; }\n` +
        `function main() { const { url } = prepare(); new PrismaClient({ datasourceUrl: url }); }`,
      `${GUARD}new PrismaClient({ datasources: { db: { url: assertNotProduction(process.env.DIRECT_URL) } } });`,
    ];
    for (const src of ok) expect(scanSource(src).checked, src).toEqual([true]);

    const refused = [
      // Checked one variable, handed the client another (the review's example).
      `${GUARD}assertNotProduction(process.env.DIRECT_URL);\nnew PrismaClient({ datasourceUrl: process.env.DATABASE_URL });`,
      `${GUARD}const a = process.env.DIRECT_URL; const b = process.env.DATABASE_URL;\nassertNotProduction(a);\nnew PrismaClient({ datasourceUrl: b });`,
      // The guard ran in an unrelated function, on its own variable of the same name.
      `${GUARD}function check() { const url = process.env.DIRECT_URL; assertNotProduction(url); }\n` +
        `function main() { const url = process.env.DATABASE_URL; new PrismaClient({ datasourceUrl: url }); }`,
      // Checked after the client was built.
      `${GUARD}const url = process.env.DIRECT_URL;\nconst c = new PrismaClient({ datasourceUrl: url });\nassertNotProduction(url);`,
      // Checked, then replaced.
      `${GUARD}let url = process.env.DIRECT_URL;\nassertNotProduction(url);\nurl = process.env.DATABASE_URL;\nnew PrismaClient({ datasourceUrl: url });`,
      // No URL at all: the client reads DATABASE_URL from the schema.
      `${GUARD}assertNotProduction(process.env.DATABASE_URL);\nnew PrismaClient();`,
      `${GUARD}const opts = { datasourceUrl: assertNotProduction(process.env.DIRECT_URL) };\nnew PrismaClient(opts);`,
    ];
    for (const src of refused) expect(scanSource(src).checked, src).toEqual([false]);
  });

  it('follows imports to a module that opens its own database', () => {
    // lib/audit.ts imports the app client: proves the walk resolves `./db`-style imports.
    expect(reachesOutsideDatabase('lib/audit.ts')).toEqual(['lib/audit.ts', 'lib/db.ts']);
  });
});

describe('the screenshot scripts refuse the live site unless production is named (owner decisions 2026-10-11)', () => {
  // Their browser part signs in to the live site (BASE), which is production,
  // whatever database the checkout names — so the database guard never sees them.
  // Pinned structurally, as the deleted load test was: running one in a test
  // would, if the refusal were broken, sign in to production.
  const CAPTURE = ['scripts/capture-guide-screenshots.ts', 'scripts/capture-steward-screenshots.ts'];

  it.each(CAPTURE)('%s refuses at the top, before Chromium, a page or a sign-in', (file) => {
    const src = code(file);
    expect(src).toMatch(/import\s*\{[^}]*\bliveSiteNamed\b[^}]*\}\s*from\s*'\.\/lib\/assert-not-production'/);
    expect(src).toMatch(/const BASE = LIVE_SITE;/);
    const refusal = src.search(new RegExp(`if \\(!liveSiteNamed\\('${file.replace(/[.]/g, '\\.')}'\\)\\) process\\.exit\\(2\\);`));
    expect(refusal, 'the refusal, naming the script').toBeGreaterThan(-1);
    for (const later of [/chromium\.launch\s*\(/, /\bawait\s+login\s*\(/, /page\.goto\s*\(/, /\bmkdir\s*\(/, /\bmain\(\)/]) {
      expect(refusal, String(later)).toBeLessThan(src.search(later));
    }
    // A top-level statement, so it runs when the module does, before main() is called.
    const top = parse(file).statements.findIndex((st) => ts.isIfStatement(st) && st.getText().includes('liveSiteNamed('));
    const mainCall = parse(file).statements.findIndex((st) => ts.isExpressionStatement(st) && /^main\(\)/.test(st.getText()));
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(mainCall);
  });

  it.each(CAPTURE)(
    '%s holds no credential: its accounts come from the environment, read after the refusal (owner item 20)',
    (file) => {
      const raw = readFileSync(file, 'utf8');
      // No username or password written as a literal, in code or in a comment.
      expect(raw).not.toMatch(/\b(username|password)\s*:\s*['"`]/i);
      const src = code(file);
      const refusal = src.search(/if \(!liveSiteNamed\(/);
      const accounts = src.search(/\bguideAccountsFromEnv\(/);
      const stop = src.search(/if \(!ACCOUNTS\) process\.exit\(2\);/);
      expect(refusal).toBeGreaterThan(-1);
      expect(accounts, 'read after the refusal').toBeGreaterThan(refusal);
      expect(stop, 'a missing variable stops it').toBeGreaterThan(accounts);
      for (const later of [/chromium\.launch\s*\(/, /\bawait\s+login\s*\(/, /page\.goto\s*\(/, /\bmkdir\s*\(/, /\bmain\(\)/]) {
        expect(stop, String(later)).toBeLessThan(src.search(later));
      }
      // Top-level statements, in that order, before main() is called.
      const statements = parse(file).statements;
      const at = (pred: (st: ts.Statement) => boolean) => statements.findIndex(pred);
      const top = at((st) => ts.isIfStatement(st) && st.getText().includes('liveSiteNamed('));
      const read = at((st) => ts.isVariableStatement(st) && st.getText().includes('guideAccountsFromEnv('));
      const exit = at((st) => ts.isIfStatement(st) && st.getText().includes('!ACCOUNTS'));
      const mainCall = at((st) => ts.isExpressionStatement(st) && /^main\(\)/.test(st.getText()));
      expect([top < read, read < exit, exit < mainCall, top > -1]).toEqual([true, true, true, true]);
    }
  );

  it('guideAccountsFromEnv names the variables that are missing, never a value, and hands back the accounts when all are set', () => {
    const out = { log: vi.fn(), error: vi.fn() };
    const partial = {
      GUIDE_SALESMAN_USERNAME: 'sales-user-x',
      GUIDE_SALESMAN_PASSWORD: 'sales-secret-x',
      GUIDE_SUPERVISOR_PASSWORD: 'sup-secret-x',
      GUIDE_MANAGER_USERNAME: '   ',
      GUIDE_MANAGER_PASSWORD: '',
    };
    expect(guideAccountsFromEnv('scripts/x.ts', ['salesman', 'supervisor', 'manager'], partial, out)).toBeNull();
    const printed = out.error.mock.calls.flat().join('\n');
    expect(printed).toMatch(/\[guide accounts\] refusing: scripts\/x\.ts needs /);
    for (const name of ['GUIDE_SUPERVISOR_USERNAME', 'GUIDE_MANAGER_USERNAME', 'GUIDE_MANAGER_PASSWORD']) {
      expect(printed).toContain(name);
    }
    for (const name of ['GUIDE_SALESMAN_USERNAME', 'GUIDE_SALESMAN_PASSWORD', 'GUIDE_SUPERVISOR_PASSWORD']) {
      expect(printed).not.toContain(name);
    }
    for (const value of Object.values(partial).filter((v) => v.trim())) expect(printed).not.toContain(value);
    expect(out.log).not.toHaveBeenCalled();

    const quiet = { log: vi.fn(), error: vi.fn() };
    const full = {
      GUIDE_STEWARD_USERNAME: '  steward-user-x ',
      GUIDE_STEWARD_PASSWORD: ' steward secret x ',
    };
    expect(guideAccountsFromEnv('scripts/y.ts', ['steward'], full, quiet)).toEqual({
      steward: { label: 'steward', username: 'steward-user-x', password: ' steward secret x ' },
    });
    expect(quiet.error).not.toHaveBeenCalled();
    expect(quiet.log).not.toHaveBeenCalled();
    // Each role has its own two variables, and the scripts' headers name them.
    expect(Object.values(GUIDE_ACCOUNT_VARS).flat()).toHaveLength(8);
    for (const [file, roles] of [
      ['scripts/capture-guide-screenshots.ts', ['salesman', 'supervisor', 'manager']],
      ['scripts/capture-steward-screenshots.ts', ['steward']],
    ] as const) {
      const raw = readFileSync(file, 'utf8');
      for (const role of roles) for (const name of GUIDE_ACCOUNT_VARS[role]) expect(raw, `${file} ${name}`).toContain(name);
    }
  });

  it('liveSiteNamed lets a script start only when --expect-host names production', () => {
    const run = (args: string[]) => {
      const out = { log: vi.fn(), error: vi.fn() };
      const ok = liveSiteNamed('scripts/x.ts', args, out);
      return { ok, printed: out.error.mock.calls.flat().join('\n'), out };
    };
    for (const args of [
      [],
      ['--expect-host'],
      ['--expect-host', '--apply'],
      ['--expect-host', 'sweet-haze'],
      ['--expect-host', 'ep-uat-branch-1'],
      [`--expect-host=${PRODUCTION_HOST_PREFIX}`],
    ]) {
      const r = run(args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.printed).toMatch(/\[live-site guard\] refusing: scripts\/x\.ts signs in to the PRODUCTION site/);
      expect(r.printed).toContain(`--expect-host ${PRODUCTION_HOST_PREFIX}`);
      expect(r.printed).not.toContain('ep-uat-branch-1');
    }
    for (const args of [
      ['--expect-host', PRODUCTION_HOST_PREFIX],
      ['--expect-host', PROD_ENDPOINT],
      ['--expect-host', PRODUCTION_HOST_PREFIX.toUpperCase()],
    ]) {
      const r = run(args);
      expect(r.ok, JSON.stringify(args)).toBe(true);
      expect(r.out.error).not.toHaveBeenCalled();
    }
  });
});

describe('scripts/qa/run-with-env.mjs refuses production', () => {
  // Review of d02cb27: it loads .env (production in the owner's main checkout) and
  // starts any command — integration suites with no production check of their own
  // among them. No command is passed here, so even a broken check starts nothing.
  const runner = join(process.cwd(), 'scripts/qa/run-with-env.mjs');
  const runIn = (envFile: string, env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'run-with-env-'));
    try {
      writeFileSync(join(dir, '.env'), envFile);
      // The developer's own connection strings are left out, so only this case's count.
      const clean = Object.fromEntries(
        Object.entries(process.env).filter(([k, v]) => v !== undefined && !/_URL$/.test(k))
      );
      const childEnv = { ...clean, ...env } as NodeJS.ProcessEnv;
      return spawnSync(process.execPath, [runner], { cwd: dir, env: childEnv, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each([
    ['DIRECT_URL in .env', `DIRECT_URL=${PROD_URL}\n`, {}],
    ['DATABASE_URL in .env, percent-escaped', `DATABASE_URL=${urlFor('localhost:5432', '?host=ep%2Dsweet%2Dhaze-x.invalid')}\n`, {}],
    ['DATABASE_URL set in the shell, which wins over .env', `DATABASE_URL=${UAT_URL}\n`, { DATABASE_URL: PROD_URL }],
    ['another connection string in the shell', `DATABASE_URL=${UAT_URL}\n`, { NMWC_APP_URL: PROD_URL }],
  ])('%s', (_label, envFile, env) => {
    const r = runIn(envFile, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\[run-with-env\] refusing: .* at PRODUCTION/);
    expectNoSecrets(r.stdout + r.stderr);
  });

  it('lets UAT through to the command', () => {
    const r = runIn(`DATABASE_URL=${UAT_URL}\nDIRECT_URL=${UAT_URL}\n`);
    expect(r.stderr).not.toMatch(/refusing/);
    expect(r.stderr).toMatch(/usage: run-with-env\.mjs/);
  });
});

describe('prisma/seed.ts never runs on production and never changes an existing row (owner decisions 2026-10-11)', () => {
  // The seed used to refuse production only until --expect-host named it, and then
  // upserted: it could create the default `admin` Manager there, and it refreshed
  // Channel.displayOrder on every run. Now production is refused whatever the
  // command line says, and the only writes are inserts that skip what exists.
  const src = code('prisma/seed.ts');

  it('writes only with createMany + skipDuplicates: no upsert, update, delete, single create or raw SQL', () => {
    for (const banned of [/\.upsert\s*\(/, /\.update\s*\(/, /\.updateMany\s*\(/, /\.delete\s*\(/, /\.deleteMany\s*\(/, /\.create\s*\(/, /\$executeRaw/, /\$queryRaw/]) {
      expect(src, String(banned)).not.toMatch(banned);
    }
    const inserts = callArguments(src, /\.createMany/);
    expect(inserts.length).toBe(4);
    for (const args of inserts) expect(args).toMatch(/\bskipDuplicates\s*:\s*true\b/);
  });

  it('refuses production before building a client, in main()', () => {
    const main = src.slice(src.indexOf('async function main('));
    expect(main.indexOf('refuseProductionSeed(url)')).toBeGreaterThan(-1);
    expect(main.indexOf('refuseProductionSeed(url)')).toBeLessThan(main.search(/new\s+PrismaClient\s*\(/));
  });

  it('refuseProductionSeed: production in any spelling is refused, whatever the arguments; nothing else is', async () => {
    const { refuseProductionSeed } = await import('../../prisma/seed');
    for (const url of [
      PROD_URL,
      urlFor(`${PROD_ENDPOINT.toUpperCase()}.neon.invalid`),
      urlFor('localhost:5432', `?host=${PROD_ENDPOINT}.neon.invalid`),
      urlFor('localhost:5432', '?host=ep%2Dsweet%2Dhaze-fake9q7.neon.invalid'),
    ]) {
      const out = { log: vi.fn(), error: vi.fn() };
      expect(() => refuseProductionSeed(url, out), url.replace(PASSWORD, '…')).toThrow(ProductionGuardRefusal);
      const printed = out.error.mock.calls.flat().join('\n');
      expect(printed).toMatch(/never runs there,\n {2}not even with --expect-host/);
      expectNoSecrets(printed);
    }
    const out = { log: vi.fn(), error: vi.fn() };
    expect(() => refuseProductionSeed(UAT_URL, out)).not.toThrow();
    expect(() => refuseProductionSeed(undefined, out)).not.toThrow(); // assertNotProduction refuses that next
    expect(out.error).not.toHaveBeenCalled();
  });

  /** A database that holds rows and has only the calls the seed may make: any other call throws. */
  function fakeDb(initial: {
    channels?: Array<{ key: string; label: string; displayOrder: number }>;
    subChannels?: Array<{ channelKey: string; key: string; label: string }>;
    regions?: Array<{ code: string; name: string }>;
    admin?: { passwordHash: string };
  }) {
    const channels = (initial.channels ?? []).map((c) => ({ id: `ch-${c.key}`, ...c }));
    const subChannels = (initial.subChannels ?? []).map((s) => ({ channelId: `ch-${s.channelKey}`, key: s.key, label: s.label }));
    const regions = [...(initial.regions ?? [])];
    const users = initial.admin ? [{ id: 'u-admin', username: 'admin', ...initial.admin }] : [];
    type Where = { key?: { in: string[] }; code?: { in: string[] }; channelId?: { in: string[] } };
    const db = {
      channel: {
        findMany: async ({ where }: { where: Where }) => channels.filter((c) => where.key!.in.includes(c.key)),
        createMany: async ({ data, skipDuplicates }: { data: Array<{ key: string; label: string; displayOrder: number }>; skipDuplicates: boolean }) => {
          expect(skipDuplicates).toBe(true);
          const fresh = data.filter((d) => !channels.some((c) => c.key === d.key));
          channels.push(...fresh.map((d) => ({ id: `ch-${d.key}`, ...d })));
          return { count: fresh.length };
        },
      },
      subChannel: {
        findMany: async ({ where }: { where: Where }) => subChannels.filter((s) => where.channelId!.in.includes(s.channelId)),
        createMany: async ({ data, skipDuplicates }: { data: Array<{ channelId: string; key: string; label: string }>; skipDuplicates: boolean }) => {
          expect(skipDuplicates).toBe(true);
          const fresh = data.filter((d) => !subChannels.some((s) => s.channelId === d.channelId && s.key === d.key));
          subChannels.push(...fresh);
          return { count: fresh.length };
        },
      },
      region: {
        findMany: async ({ where }: { where: Where }) => regions.filter((r) => where.code!.in.includes(r.code)),
        createMany: async ({ data, skipDuplicates }: { data: Array<{ code: string; name: string }>; skipDuplicates: boolean }) => {
          expect(skipDuplicates).toBe(true);
          // Both code and name are unique: a clash on either skips the row.
          const fresh = data.filter((d) => !regions.some((r) => r.code === d.code || r.name === d.name));
          regions.push(...fresh);
          return { count: fresh.length };
        },
      },
      user: {
        findUnique: async ({ where }: { where: { username: string } }) => users.find((u) => u.username === where.username) ?? null,
        createMany: async ({ data, skipDuplicates }: { data: Array<{ username: string; passwordHash: string; role: string }>; skipDuplicates: boolean }) => {
          expect(skipDuplicates).toBe(true);
          const fresh = data.filter((d) => !users.some((u) => u.username === d.username));
          users.push(...fresh.map((d) => ({ id: `u-${d.username}`, ...d })));
          return { count: fresh.length };
        },
      },
    };
    return { db, channels, subChannels, regions, users };
  }

  it('on an empty database: inserts every channel, sub-channel and region, and the admin Manager', async () => {
    const seed = await import('../../prisma/seed');
    const f = fakeDb({});
    const hash = vi.fn(async () => 'hash-1');
    const report = await seed.insertMissing(f.db as unknown as import('../../prisma/seed').SeedDb, hash);
    expect(report.inserted).toEqual({
      channels: seed.CHANNELS.length,
      subChannels: seed.CHANNELS.flatMap((c) => c.subs).length,
      regions: seed.REGIONS.length,
      admin: true,
    });
    expect(report.leftAsIs).toEqual([]);
    expect(hash).toHaveBeenCalledOnce();
    expect(f.users).toEqual([expect.objectContaining({ username: 'admin', passwordHash: 'hash-1', role: 'MANAGER' })]);
  });

  it('on a database that has them: changes nothing — names, labels, displayOrder, the admin account — and lists what differs', async () => {
    const seed = await import('../../prisma/seed');
    const [first, second] = seed.CHANNELS;
    const sub = first!.subs[0]!;
    const f = fakeDb({
      channels: [
        { key: first!.key, label: 'Renamed by the business', displayOrder: first!.order },
        { key: second!.key, label: second!.label, displayOrder: 99 },
      ],
      subChannels: [{ channelKey: first!.key, key: seed.subChannelKey(sub), label: 'Their own label' }],
      regions: [
        { code: 'MUSCAT', name: 'Muscat Governorate' },
        // A region another code already carries the seed's name for: skipped, not renamed.
        { code: 'BN', name: 'Batinah North' },
      ],
      admin: { passwordHash: 'their-hash' },
    });
    const before = JSON.stringify([f.channels, f.subChannels, f.regions, f.users]);
    const hash = vi.fn(async () => 'never');
    const report = await seed.insertMissing(f.db as unknown as import('../../prisma/seed').SeedDb, hash);

    // Every row that was there is exactly as it was: the inserts only appended.
    const after = [f.channels, f.subChannels, f.regions, f.users].map((rows, i) =>
      rows.slice(0, (JSON.parse(before) as unknown[][])[i]!.length)
    );
    expect(JSON.stringify(after)).toBe(before);
    expect(hash).not.toHaveBeenCalled();
    expect(report.inserted.admin).toBe(false);
    expect(report.inserted.channels).toBe(seed.CHANNELS.length - 2);
    expect(report.inserted.regions).toBe(seed.REGIONS.length - 2);
    expect(report.leftAsIs.sort()).toEqual(
      [`Channel ${first!.key}`, `Channel ${second!.key}`, `SubChannel ${first!.key}/${seed.subChannelKey(sub)}`, 'Region MUSCAT'].sort()
    );
  });

  // Run for real: the script, as `npm run db:seed` starts it, handed a fake
  // production-looking URL (`.invalid` never resolves, so even a broken refusal
  // could reach nothing). It must stop before it inserts anything, whatever
  // --expect-host says. DIRECT_URL is always given: the Prisma client loads a
  // checkout's .env when it is imported, and fills in any variable left unset.
  const runSeed = (env: Record<string, string>, args: string[]) => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => v !== undefined && !/_URL$/.test(k))
    );
    return spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts', ...args], {
      cwd: process.cwd(),
      env: { ...clean, ...env } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
  };

  it.each([
    ['DIRECT_URL, no flag', { DIRECT_URL: PROD_URL }, []],
    ['DIRECT_URL, --expect-host ep-sweet-haze', { DIRECT_URL: PROD_URL }, ['--expect-host', PRODUCTION_HOST_PREFIX]],
    ['DIRECT_URL, --expect-host naming the endpoint', { DIRECT_URL: PROD_URL }, ['--expect-host', PROD_ENDPOINT]],
    [
      'a percent-escaped host parameter, --expect-host ep-sweet-haze',
      { DIRECT_URL: urlFor('localhost:5432', '?host=ep%2Dsweet%2Dhaze-fake9q7.neon.invalid') },
      ['--expect-host', PRODUCTION_HOST_PREFIX],
    ],
  ] as const)('npm run db:seed on production refuses: %s', (_label, env, args) => {
    const r = runSeed(env, [...args]);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\[seed\] refusing: this connection points at PRODUCTION/);
    expect(r.stdout).not.toMatch(/Inserting|inserted|Seed complete/);
    expectNoSecrets(r.stdout + r.stderr);
  }, 150_000);
});

describe('the scripts the owner deleted on 2026-10-11 stay deleted', () => {
  // Git history keeps them. Bringing one back means bringing back a script that
  // opened the audit maintenance switch, or rewrote customers, against whatever
  // database it was handed — or, for synthetic-launch-test.ts, signed in to the
  // live site and uploaded a photo there whatever database it was given.
  it.each([
    'scripts/wipe-synthetic-data.ts',
    'scripts/cleanup-synthetic-test.ts',
    'scripts/flatten-customer-branches.ts',
    'scripts/seed-demo-edit.ts',
    'prisma/inject-test-edits.ts',
    'scripts/synthetic-launch-test.ts',
    'prisma/seed-muscat-customers.ts',
    'prisma/seed-muscat-payment-terms.ts',
  ])('%s', (file) => {
    expect(existsSync(file)).toBe(false);
  });

  it('prisma/test-*.ts', () => {
    expect(readdirSync('prisma').filter((f) => /^test-.*\.ts$/.test(f))).toEqual([]);
  });
});
