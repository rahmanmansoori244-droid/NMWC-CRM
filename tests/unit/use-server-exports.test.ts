/**
 * A 'use server' file may export only async functions. Next.js refuses the
 * build otherwise ("Only async functions are allowed to be exported in a
 * 'use server' file"), but typecheck, lint and the unit suite all pass, so the
 * mistake reaches the deploy before anyone sees it (follow-up 1: H11 exported a
 * sentence from services/temix.ts and `next build` stopped).
 *
 * This guard reads every .ts/.tsx file under app/, services/ and lib/ whose
 * first statement is 'use server' (found on disk, never a hand-kept list),
 * parses it with the TypeScript compiler and fails on any export that is not an
 * async function. Type-only exports (types, interfaces, `export type {...}`)
 * are fine: they are erased before Next.js sees the file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOTS = ['app', 'services', 'lib'];

/**
 * The one export that is not an async function and is let through, pinned by
 * name: services/imports.ts re-exports the pure code formatter from
 * lib/codes.ts (`export { formatCustomerCode }`, since before follow-up 1).
 * Next.js cannot see through a re-exported binding at build time and checks
 * only that it is a function at run time, so it builds and deploys today;
 * tests/unit/password-change-required.test.ts holds it to "touches no
 * database". It is named here so that no other one can join it unnoticed.
 */
const ALLOWED = new Set(['services/imports.ts:formatCustomerCode']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

function parse(file: string, code: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
}

/** The file's first statement is the 'use server' directive (comments before it are fine). */
function isUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

const has = (node: ts.Node, kind: ts.SyntaxKind) =>
  (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);

const isAsyncFn = (e: ts.Expression | undefined): boolean => {
  if (!e) return false;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && has(e, ts.SyntaxKind.AsyncKeyword);
};

/** What a local name refers to, for `export { name }`. */
function localKind(sf: ts.SourceFile, name: string): 'async' | 'type' | 'other' {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) {
      if (!s.body) continue; // an overload signature
      return has(s, ts.SyntaxKind.AsyncKeyword) ? 'async' : 'other';
    }
    if ((ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === name) return 'type';
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return isAsyncFn(d.initializer) ? 'async' : 'other';
      }
    }
    if (ts.isImportDeclaration(s) && s.importClause) {
      const c = s.importClause;
      const named = c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : [];
      for (const el of named) {
        if (el.name.text === name) return c.isTypeOnly || el.isTypeOnly ? 'type' : 'other';
      }
      if (c.name?.text === name) return c.isTypeOnly ? 'type' : 'other';
    }
  }
  return 'other';
}

/** Every export of the file that is not an async function or a type, as "name (what it is)". */
function badExports(file: string, code: string): string[] {
  const sf = parse(file, code);
  const bad: string[] = [];
  for (const s of sf.statements) {
    const exported = has(s, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(s) && exported) {
      if (s.body && !has(s, ts.SyntaxKind.AsyncKeyword)) bad.push(`${s.name?.text ?? 'default'} (a function that is not async)`);
    } else if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) {
        if (!isAsyncFn(d.initializer)) bad.push(`${d.name.getText(sf)} (a value, not an async function)`);
      }
    } else if ((ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && exported) {
      bad.push(`${s.name?.text ?? 'default'} (a ${ts.isClassDeclaration(s) ? 'class' : 'enum'})`);
    } else if (ts.isModuleDeclaration(s) && exported && !has(s, ts.SyntaxKind.DeclareKeyword)) {
      bad.push(`${s.name.getText(sf)} (a namespace)`);
    } else if (ts.isExportAssignment(s)) {
      if (!isAsyncFn(s.expression)) bad.push('default (not an async function)');
    } else if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      if (!s.exportClause) {
        bad.push(`* (a re-export of everything in ${s.moduleSpecifier?.getText(sf)})`);
        continue;
      }
      if (!ts.isNamedExports(s.exportClause)) {
        bad.push(`${s.exportClause.name.text} (a namespace re-export)`);
        continue;
      }
      for (const el of s.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const local = (el.propertyName ?? el.name).text;
        const kind = s.moduleSpecifier ? 'other' : localKind(sf, local);
        if (kind !== 'async' && kind !== 'type') bad.push(`${el.name.text} (re-exported; not an async function)`);
      }
    }
  }
  return bad;
}

const names = (list: string[]) => list.map((b) => b.split(' ')[0]);

describe("'use server' files export only async functions (next build refuses anything else)", () => {
  const files = ROOTS.flatMap((r) => walk(r)).filter((f) => isUseServer(parse(f, readFileSync(f, 'utf8'))));

  it('found the files to check — the guard cannot pass on an empty tree', () => {
    for (const f of ['services/temix.ts', 'services/imports.ts', 'services/users.ts', 'app/actions/auth.ts']) {
      expect(files).toContain(f);
    }
  });

  it('the detector catches each kind of bad export and lets async functions and types through', () => {
    const f = 'services/x.ts';
    const ok = [
      "'use server';",
      'export async function a() {}',
      'export const b = async () => 1;',
      'export const c = async function () {};',
      'export type T = { x: 1 };',
      'export interface I { x: 1 }',
      "import type { U } from './u';",
      'async function d() {}',
      'export { d };',
      'export type { U };',
      'export { type U as V };',
      'function sig(x: string): Promise<void>;',
      'async function sig(x: unknown) {}',
      'export { sig };',
    ].join('\n');
    expect(badExports(f, ok)).toEqual([]);
    expect(names(badExports(f, "'use server';\nexport const MESSAGE =\n  'a sentence';"))).toEqual(['MESSAGE']);
    expect(names(badExports(f, "'use server';\nexport function sync() {}"))).toEqual(['sync']);
    expect(names(badExports(f, "'use server';\nexport const f = () => 1;"))).toEqual(['f']);
    expect(names(badExports(f, "'use server';\nexport class K {}"))).toEqual(['K']);
    expect(names(badExports(f, "'use server';\nexport enum E { A }"))).toEqual(['E']);
    expect(names(badExports(f, "'use server';\nexport default 3;"))).toEqual(['default']);
    expect(names(badExports(f, "'use server';\nconst n = 1;\nexport { n };"))).toEqual(['n']);
    expect(names(badExports(f, "'use server';\nexport { x } from './y';"))).toEqual(['x']);
    expect(names(badExports(f, "'use server';\nexport * from './y';"))).toEqual(['*']);
    expect(names(badExports(f, "'use server';\nimport { z } from './z';\nexport { z };"))).toEqual(['z']);
  });

  it("the detector knows a 'use server' file only by its first statement", () => {
    expect(isUseServer(parse('a.ts', "/** doc */\n'use server';\nexport const x = 1;"))).toBe(true);
    expect(isUseServer(parse('a.ts', "\"use server\";\nexport const x = 1;"))).toBe(true);
    expect(isUseServer(parse('a.ts', "import x from 'y';\n'use server';"))).toBe(false);
    expect(isUseServer(parse('a.ts', "export async function a() {\n  'use server';\n}"))).toBe(false);
    expect(isUseServer(parse('a.ts', "'use client';"))).toBe(false);
  });

  it("no 'use server' file exports anything but async functions and types", () => {
    const offenders = files.flatMap((f) =>
      badExports(f, readFileSync(f, 'utf8'))
        .filter((b) => !ALLOWED.has(`${f}:${b.split(' ')[0]}`))
        .map((b) => `${f}: ${b}`)
    );
    expect(offenders, "move it to a plain module (no 'use server') and import it from there").toEqual([]);
  });

  it('the one pinned exception is still there and still a plain function re-export (or the pin goes)', () => {
    const code = readFileSync('services/imports.ts', 'utf8');
    expect(names(badExports('services/imports.ts', code))).toEqual(['formatCustomerCode']);
    expect(readFileSync('lib/codes.ts', 'utf8')).toMatch(/export function formatCustomerCode\(/);
  });
});
