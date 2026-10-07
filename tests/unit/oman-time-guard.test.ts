// @vitest-environment node
/**
 * Launch fix: every date or time a user reads is Oman time, and the text is the
 * same wherever it is rendered. Vercel runs in UTC; this PC runs in Asia/Muscat,
 * so a page that formatted a Date with toLocaleString looked right here and was
 * four hours behind in production (15 call sites, the launch review counted).
 *
 * The rule, read with the TypeScript type checker so a Date is known by its
 * type, not by its variable's name, over app/, components/, lib/ and services/
 * (services build error messages and file names people read):
 *   - no toLocaleString / toLocaleDateString / toLocaleTimeString on a Date:
 *     use the lib/tz.ts helpers (omanDate, omanDateTime, omanDayTime,
 *     omanLongDate, omanStamp, omanISO);
 *   - no Intl.DateTimeFormat without an explicit timeZone;
 *   - no UTC calendar date cut from toISOString() (.slice(0, 10) and the
 *     like): between 00:00 and 03:59 Oman it is yesterday; use omanDateISO;
 *   - every number's toLocaleString names its locale: a client component is
 *     rendered on the server and again in the browser, and a browser in German
 *     or Arabic formats 1,234 differently (a hydration mismatch);
 *   - in a 'use client' file, stricter: no Intl.DateTimeFormat at all, even
 *     zoned (Node's ICU and each browser's differ: en-GB September is "Sept"
 *     in one and "Sep" in another), no toLocale* on anything but a number, and
 *     a number only in 'en-US', whose digit grouping (1,234) is the same in
 *     every ICU build; another locale's digits and separators are CLDR data
 *     that has changed between versions, so a server and a phone can disagree.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const DIRS = ['app', 'components', 'lib', 'services'];
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const CUT_METHODS = new Set(['slice', 'substring', 'substr']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Only the files that format anything: the checker then loads just what they import. */
function candidates(): string[] {
  return DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) =>
    /toLocale(Date|Time)?String|DateTimeFormat|toISOString/.test(readFileSync(f, 'utf8'))
  );
}

function program(files: string[]): ts.Program {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json')!;
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  return ts.createProgram(files, { ...parsed.options, noEmit: true, skipLibCheck: true });
}

function isDateType(t: ts.Type): boolean {
  if (t.isUnion()) return t.types.some(isDateType);
  return t.getSymbol()?.getName() === 'Date';
}

/** A number (or bigint) and nothing else: an `any` or a union with a Date is not one. */
function isNumberType(t: ts.Type): boolean {
  if (t.isUnion()) return t.types.every(isNumberType);
  return (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0;
}

/** A 'use client' directive in the file's prologue: the file is rendered on the server and again in the browser. */
function isClientFile(sf: ts.SourceFile): boolean {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === 'use client') return true;
  }
  return false;
}

/** `x.toISOString()` — the receiver of a cut that takes the UTC date. */
function isToISOString(n: ts.Expression): boolean {
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'toISOString';
}

function violations(files: string[]): string[] {
  const prog = program(files);
  const checker = prog.getTypeChecker();
  const out: string[] = [];
  for (const file of files) {
    const sf = prog.getSourceFile(file)!;
    const where = (n: ts.Node) =>
      `${relative(ROOT, file).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const client = isClientFile(sf);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        if (LOCALE_METHODS.has(method)) {
          const recv = checker.getTypeAtLocation(n.expression.expression);
          const locale = n.arguments[0];
          if (isDateType(recv)) out.push(`${where(n)} ${method} on a Date — use the lib/tz.ts Oman helpers`);
          else if (n.arguments.length === 0) out.push(`${where(n)} ${method}() with no locale`);
          else if (client && !isNumberType(recv)) out.push(`${where(n)} ${method} in a client component on a non-number`);
          else if (client && !(locale && ts.isStringLiteralLike(locale) && locale.text === 'en-US')) {
            out.push(`${where(n)} ${method} in a client component in a locale other than 'en-US'`);
          }
        }
        // d.toISOString().slice(0, 10) and its spellings: the UTC calendar date.
        if (
          CUT_METHODS.has(method) &&
          isToISOString(n.expression.expression) &&
          n.arguments.map((a) => a.getText(sf).replace(/\s/g, '')).join(',') === '0,10'
        ) {
          out.push(`${where(n)} a UTC date cut from toISOString() — use omanDateISO`);
        }
      }
      // d.toISOString().split('T')[0]: the same UTC date.
      if (
        ts.isElementAccessExpression(n) &&
        n.argumentExpression.getText(sf) === '0' &&
        ts.isCallExpression(n.expression) &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === 'split' &&
        isToISOString(n.expression.expression.expression)
      ) {
        out.push(`${where(n)} a UTC date cut from toISOString() — use omanDateISO`);
      }
      if (
        (ts.isNewExpression(n) || ts.isCallExpression(n)) &&
        n.expression.getText(sf).replace(/\s/g, '') === 'Intl.DateTimeFormat'
      ) {
        // In a client component even a zoned formatter can print one thing on the
        // server and another in the browser, so none at all there.
        if (client) out.push(`${where(n)} Intl.DateTimeFormat in a client component — use the lib/tz.ts Oman helpers`);
        else if (!/\btimeZone\s*:/.test(n.arguments?.map((a) => a.getText(sf)).join(',') ?? '')) {
          out.push(`${where(n)} Intl.DateTimeFormat without a timeZone`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe('dates and numbers on screen (launch fix: Oman time, one text on server and client)', () => {
  it('formats no Date with toLocale*, no Intl.DateTimeFormat without a zone, no UTC date cut, no number without a locale', () => {
    const files = candidates();
    // The guard reads real files: if the scan finds nothing, it is broken, not passing.
    expect(files.length).toBeGreaterThan(5);
    expect(violations(files)).toEqual([]);
  }, 120_000);

  /** Scans one in-memory file under lib/ (so the repo tsconfig applies); never written to disk. */
  function scanFixture(base: string, src: string): string[] {
    const name = join(ROOT, 'lib', base);
    const same = (p: string) => p.replace(/\\/g, '/') === name.replace(/\\/g, '/');
    const host = ts.sys;
    const readFile = host.readFile;
    const fileExists = host.fileExists;
    host.readFile = (p, enc) => (same(p) ? src : readFile(p, enc));
    host.fileExists = (p) => same(p) || fileExists(p);
    try {
      return violations([name]).map((v) => v.replace(/^.*?:(\d+) /, '$1 '));
    } finally {
      host.readFile = readFile;
      host.fileExists = fileExists;
    }
  }

  it('catches the shapes it bans', () => {
    const src = [
      "export const a = (d: Date) => d.toLocaleString('en-GB');",
      "export const b = (d: Date | null) => d?.toLocaleDateString('en-GB');",
      "export const c = (s: string) => new Date(s).toLocaleTimeString('en-GB', { timeZone: 'Asia/Muscat' });",
      "export const d = new Intl.DateTimeFormat('en-GB', { hour: '2-digit' });",
      'export const e = (n: number) => n.toLocaleString();',
      'export const h = new Date().toISOString().slice(0, 10);',
      "export const i = (d: Date) => d.toISOString().split('T')[0];",
      'export const j = (d: Date) => `x-${d.toISOString().substring(0, 10)}`;',
      // Allowed outside a client component: a number with a locale, a zoned
      // formatter, and a full UTC instant (a storage key, a log line).
      "export const f = (n: number) => n.toLocaleString('en-GB');",
      "export const g = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Muscat' });",
      'export const k = (d: Date) => d.toISOString();',
    ].join('\n');
    expect(scanFixture('__oman-time-guard-fixture.ts', src)).toEqual([
      '1 toLocaleString on a Date — use the lib/tz.ts Oman helpers',
      '2 toLocaleDateString on a Date — use the lib/tz.ts Oman helpers',
      '3 toLocaleTimeString on a Date — use the lib/tz.ts Oman helpers',
      '4 Intl.DateTimeFormat without a timeZone',
      '5 toLocaleString() with no locale',
      '6 a UTC date cut from toISOString() — use omanDateISO',
      '7 a UTC date cut from toISOString() — use omanDateISO',
      '8 a UTC date cut from toISOString() — use omanDateISO',
    ]);
  }, 120_000);

  it('is stricter in a client component, which renders on the server and again in the browser', () => {
    const src = [
      "'use client';",
      "export const a = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Muscat' });",
      "export const b = (n: number) => n.toLocaleString('en-GB');",
      "export const c = (n: number) => n.toLocaleString('ar-OM');",
      "export const d = (v: number | string) => v.toLocaleString('en-US');",
      "export const e = (v: any) => v.toLocaleDateString('en-US');",
      // Allowed: a number in en-US, the same 1,234 in every ICU build.
      "export const f = (n: number) => n.toLocaleString('en-US');",
    ].join('\n');
    expect(scanFixture('__oman-time-guard-client-fixture.ts', src)).toEqual([
      '2 Intl.DateTimeFormat in a client component — use the lib/tz.ts Oman helpers',
      "3 toLocaleString in a client component in a locale other than 'en-US'",
      "4 toLocaleString in a client component in a locale other than 'en-US'",
      '5 toLocaleString in a client component on a non-number',
      '6 toLocaleDateString in a client component on a non-number',
    ]);
  }, 120_000);
});
