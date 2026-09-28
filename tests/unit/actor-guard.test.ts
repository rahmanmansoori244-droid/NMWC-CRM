// @vitest-environment node
/**
 * F15 / X-AUTH-1 — the structure that keeps a session with mustChangePassword
 * (AUTH-09) out of everything except the password change and sign-out.
 *
 * What was wrong: the forced change was enforced only by the Edge middleware's
 * path check, which lets /profile/change-password through. Fourteen per-module
 * guards each read auth() themselves and none looked at the flag, and that page's
 * form imported its action from services/users.ts — so Next registered every
 * user-admin action of that module in the page's worker, and a flagged Manager or
 * Steward could POST createUser / resetPassword / toggleUserActive /
 * updateUserRole to that path.
 *
 * tests/unit/password-change-required.test.ts proves today's BEHAVIOUR: every
 * action and user route refuses a flagged session. It cannot see the next guard
 * someone writes with a bare auth(), the next route handler that forgets the
 * check, or a second action added to services/password.ts. The defect was
 * "nobody called it", so this file pins who must call what. Every source check
 * reads comment-stripped text, and each detector is run against a mutant first so
 * it cannot pass on nothing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { load } from 'js-yaml';
import { stripComments } from '../support/strip-comments';
import {
  ALLOWED_ON_CHANGE_PASSWORD,
  CHANGE_PASSWORD_WORKER,
  actionWorkerProblems,
  type ServerReferenceManifest,
} from '../../scripts/ci/check-action-workers';

const ROOT = process.cwd();
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
const src = (file: string) => stripComments(readFileSync(file, 'utf8'), file);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(rel(full));
  }
  return out;
}

/** The repo-relative file an import specifier names, without its extension. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2);
  if (spec.startsWith('.')) return path.posix.join(path.posix.dirname(fromFile), spec);
  return null;
}

/** Non-type imports of a file: [resolved target, imported names]. */
function importsOf(file: string, code: string): Array<{ target: string | null; names: string[]; star: boolean }> {
  const out: Array<{ target: string | null; names: string[]; star: boolean }> = [];
  for (const m of code.matchAll(/import\s+(type\s+)?([^'";]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const clause = m[2]!;
    const braces = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
    const names = braces
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('type '))
      .map((s) => s.split(/\s+as\s+/)[0]!.trim());
    out.push({ target: resolveImport(file, m[3]!), names, star: /\*\s+as\s+\w+/.test(clause) });
  }
  return out;
}

/** A session read that skips requireActor/checkActor: a call to auth(), or importing it. */
function readsSessionDirectly(file: string, code: string): boolean {
  if (/(?<![\w.$])auth\s*\(/.test(code)) return true;
  return importsOf(file, code).some(
    (i) => i.target === 'lib/auth' && (i.star || i.names.includes('auth') || i.names.includes('cachedAuth'))
  );
}

const isServerModule = (file: string) => /^\s*['"]use server['"]/.test(src(file));

describe('no action, route handler or service reads the session except through lib/session.ts', () => {
  const SCOPE = ['services', 'app/api', 'app/actions', 'lib'].flatMap((d) => walk(d));
  /** Where auth() is defined and the one place allowed to read it for everyone else. */
  const OWNERS = new Set(['lib/auth.ts', 'lib/session.ts']);
  /** Sign-out must work for a flagged session and a dead one: the one exception, pinned below. */
  const LOGOUT = 'app/actions/auth.ts';

  it('the detector catches a bare read and ignores a comment, a signIn import and the session helpers', () => {
    const f = 'services/x.ts';
    expect(readsSessionDirectly(f, 'const s = await auth();')).toBe(true);
    expect(readsSessionDirectly(f, "import { auth } from '@/lib/auth';")).toBe(true);
    expect(readsSessionDirectly('lib/x.ts', "import { auth as a } from './auth';")).toBe(true);
    expect(readsSessionDirectly(f, "import * as A from '@/lib/auth';")).toBe(true);
    expect(readsSessionDirectly(f, stripComments('// const s = await auth();\nconst x = 1;'))).toBe(false);
    expect(readsSessionDirectly(f, "import { signIn } from '@/lib/auth';")).toBe(false);
    expect(readsSessionDirectly(f, "import { requireActor } from '@/lib/session';\nawait requireActor();")).toBe(false);
    expect(readsSessionDirectly(f, 'await checkActor(); oauth(); x.auth();')).toBe(false);
  });

  it('found the files to check — the guard cannot pass on an empty tree', () => {
    for (const f of ['services/users.ts', 'services/password.ts', 'app/api/forms/[form]/route.ts', 'lib/export-scope.ts']) {
      expect(SCOPE).toContain(f);
    }
  });

  it('nothing in services/, app/api/, app/actions/ or lib/ calls or imports auth() itself', () => {
    const offenders = SCOPE.filter((f) => !OWNERS.has(f) && f !== LOGOUT).filter((f) => readsSessionDirectly(f, src(f)));
    expect(offenders, 'use requireActor() / checkActor() from lib/session.ts').toEqual([]);
  });

  it('the per-module guards now come from lib/session.ts — every services/ module that acts for a user imports it', () => {
    const missing = walk('services')
      .filter(isServerModule)
      .filter((f) => !/\b(requireActor|checkActor|requireExportUser)\s*\(/.test(src(f)));
    expect(missing).toEqual([]);
  });

  it('sign-out reads auth() exactly once, inside logoutAction, and never through requireActor', () => {
    const s = src(LOGOUT);
    const calls = [...s.matchAll(/(?<![\w.$])auth\s*\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(1);
    const decl = 'export async function logoutAction(';
    const logout = s.indexOf(decl);
    expect(logout).toBeGreaterThan(-1);
    expect(calls[0]!).toBeGreaterThan(logout);
    // No other function starts between the declaration and the call.
    expect(s.slice(logout + decl.length, calls[0]).match(/\bfunction\s+\w+\s*\(/)).toBeNull();
    // A flagged user has to be able to leave: requireActor would refuse them.
    expect(s).not.toMatch(/\b(requireActor|checkActor)\s*\(/);
  });

  it('pages and layouts do not use the action guard — a refusal there would loop with the middleware redirect', () => {
    const pages = walk('app').filter((f) => /\/(page|layout)\.tsx$/.test(f));
    expect(pages.length).toBeGreaterThan(20);
    expect(pages.filter((f) => /\b(requireActor|checkActor)\s*\(/.test(src(f)))).toEqual([]);
  });
});

describe('only the password change itself may pass a flagged session', () => {
  it('allowPasswordChange is set in exactly one place: changeOwnPasswordCore in services/password.ts', () => {
    const users = ['services', 'app', 'lib', 'components']
      .flatMap((d) => walk(d))
      .filter((f) => f !== 'lib/session.ts')
      .filter((f) => /\ballowPasswordChange\b/.test(src(f)));
    expect(users).toEqual(['services/password.ts']);
    const s = src('services/password.ts');
    expect(s.match(/\ballowPasswordChange\b/g)).toHaveLength(1);
    const core = s.indexOf('async function changeOwnPasswordCore(');
    const use = s.indexOf('requireActor({ allowPasswordChange: true })');
    expect(core).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(core);
  });

  it('lib/session.ts refuses the flag unless that option is set', () => {
    const s = src('lib/session.ts');
    expect(s).toMatch(/session\.user\.mustChangePassword === true && !opts\.allowPasswordChange/);
    // requireActor is checkActor plus a throw — not a second, diverging check.
    const require = s.slice(s.indexOf('export async function requireActor('));
    expect(require).toMatch(/await checkActor\(opts\)/);
  });
});

describe('X-AUTH-1: the change-password page can carry only its own action', () => {
  /** The exported names of a module, read by the TypeScript parser. */
  function exportedNames(file: string): string[] {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) names.push(`<re-export at ${st.pos}>`);
      else if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text);
      else if (exported && ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) names.push(d.name.getText(sf));
      } else if (exported && !ts.isTypeAliasDeclaration(st) && !ts.isInterfaceDeclaration(st)) {
        names.push(`<export at ${st.pos}>`);
      }
    }
    return names;
  }

  it('services/password.ts is a server-action module with exactly one export', () => {
    expect(isServerModule('services/password.ts')).toBe(true);
    expect(exportedNames('services/password.ts')).toEqual(['changeOwnPasswordAction']);
  });

  it('the page directory imports no server-action module but services/password.ts', () => {
    const dir = 'app/(app)/profile/change-password';
    const files = walk(dir);
    expect(files).toContain(`${dir}/ChangePasswordForm.tsx`);
    const serverImports = files.flatMap((f) =>
      importsOf(f, src(f))
        .map((i) => i.target)
        .filter((t): t is string => t !== null)
        .map((t) => [`${t}.ts`, `${t}.tsx`, `${t}/index.ts`].find((c) => existsSync(c)))
        .filter((t): t is string => !!t && isServerModule(t))
    );
    expect(serverImports).toEqual(['services/password.ts']);
  });

  it('services/users.ts no longer exports the self-service change', () => {
    expect(exportedNames('services/users.ts')).not.toContain('changeOwnPasswordAction');
  });
});

describe('X-AUTH-1: the build-manifest check that CI runs after next build', () => {
  const entry = (name: string, workers: string[]) => ({
    exportedName: name,
    workers: Object.fromEntries(workers.map((w) => [w, { moduleId: 1, async: false }])),
  });
  const manifest = (extra: Array<[string, string[]]> = []): ServerReferenceManifest => ({
    node: Object.fromEntries(
      [
        ['changeOwnPasswordAction', [CHANGE_PASSWORD_WORKER]] as [string, string[]],
        ['loginAction', [CHANGE_PASSWORD_WORKER, 'app/(auth)/login/page']] as [string, string[]],
        ['logoutAction', [CHANGE_PASSWORD_WORKER, 'app/(app)/users/page']] as [string, string[]],
        ['createUserAction', ['app/(app)/users/page']] as [string, string[]],
        ...extra,
      ].map(([name, workers], i) => [`id${i}`, entry(name, workers)])
    ),
    edge: {},
  });

  it('passes the worker as the fixed build produces it', () => {
    expect(ALLOWED_ON_CHANGE_PASSWORD).toEqual(['changeOwnPasswordAction', 'loginAction', 'logoutAction']);
    expect(actionWorkerProblems(manifest())).toEqual([]);
  });

  it('fails when a user-admin action is registered on the page again (the May build had four)', () => {
    const bad = manifest([['resetPasswordAction', ['app/(app)/users/page', CHANGE_PASSWORD_WORKER]]]);
    expect(actionWorkerProblems(bad)).toEqual([
      `resetPasswordAction is callable from ${CHANGE_PASSWORD_WORKER}, which a session that must change its password can reach`,
    ]);
  });

  it('fails closed when the page or the manifest format moved and it can see nothing', () => {
    expect(actionWorkerProblems({ node: {}, edge: {} })).toHaveLength(1);
    const moved = manifest();
    for (const e of Object.values(moved.node!)) delete (e.workers as Record<string, unknown>)[CHANGE_PASSWORD_WORKER];
    expect(actionWorkerProblems(moved)[0]).toMatch(/holds no changeOwnPasswordAction/);
  });

  it('CI runs it, un-softened, after the production build in lint-test-build', () => {
    type Step = { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown };
    const wf = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    const steps = wf.jobs['lint-test-build']!.steps;
    const lines = (s: Step) =>
      String(s.run ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    const build = steps.findIndex((s) => lines(s).includes('npx next build'));
    const check = steps.findIndex((s) => lines(s).includes('npx tsx scripts/ci/check-action-workers.ts'));
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(steps[check]!.if).toBeUndefined();
    expect(steps[check]!['continue-on-error']).toBeUndefined();
  });
});

describe('every API route handler is either a user route behind the actor check, or named as something else', () => {
  /** Machine endpoints: a scheduler's CRON_SECRET bearer, checked by cronAuthorized. */
  const BEARER = /\bcronAuthorized\s*\(/;
  /** User routes: checkActor directly, or requireExportUser, which delegates to requireActor. */
  const ACTOR = /\b(checkActor|requireExportUser)\s*\(/;
  /** No session and no bearer gate of their own, by design. */
  const NAMED: Record<string, string> = {
    'app/api/auth/[...nextauth]/route.ts': 'Auth.js itself — sign-in and sign-out',
    'app/api/health/route.ts': 'the anonymous probe (a bearer only unlocks detail)',
  };

  it('each route.ts under app/api matches exactly one kind', () => {
    const routes = walk('app/api').filter((f) => f.endsWith('/route.ts'));
    expect(routes.length).toBeGreaterThan(12);
    for (const f of routes) {
      const s = src(f);
      const kinds = [ACTOR.test(s) && 'actor', BEARER.test(s) && 'bearer', f in NAMED && 'named'].filter(Boolean);
      expect(kinds, `${f}: a new route must check the actor (lib/session.ts), a bearer, or be named here`).toHaveLength(1);
    }
    for (const f of Object.keys(NAMED)) expect(routes).toContain(f);
  });
});
