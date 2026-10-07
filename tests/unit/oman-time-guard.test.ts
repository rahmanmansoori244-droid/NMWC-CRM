// @vitest-environment node
/**
 * Launch fix: every date or time a user reads is Oman time, and the text is the
 * same wherever it is rendered. Vercel runs in UTC; this PC runs in Asia/Muscat,
 * so a page that formatted a Date with toLocaleString looked right here and was
 * four hours behind in production (15 call sites, the launch review counted).
 *
 * The rule, read with the TypeScript type checker so a Date is known by its
 * type, not by its variable's name:
 *   - no toLocaleString / toLocaleDateString / toLocaleTimeString on a Date in
 *     app/, components/ or lib/: use the lib/tz.ts helpers (omanDate,
 *     omanDateTime, omanDayTime, omanLongDate, omanStamp);
 *   - no Intl.DateTimeFormat without an explicit timeZone;
 *   - every number's toLocaleString names its locale: a client component is
 *     rendered on the server and again in the browser, and a browser in German
 *     or Arabic formats 1,234 differently (a hydration mismatch).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const DIRS = ['app', 'components', 'lib'];
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

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
    /toLocale(Date|Time)?String|DateTimeFormat/.test(readFileSync(f, 'utf8'))
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

function violations(files: string[]): string[] {
  const prog = program(files);
  const checker = prog.getTypeChecker();
  const out: string[] = [];
  for (const file of files) {
    const sf = prog.getSourceFile(file)!;
    const where = (n: ts.Node) =>
      `${relative(ROOT, file).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        if (LOCALE_METHODS.has(method)) {
          const recv = checker.getTypeAtLocation(n.expression.expression);
          if (isDateType(recv)) out.push(`${where(n)} ${method} on a Date — use the lib/tz.ts Oman helpers`);
          else if (n.arguments.length === 0) out.push(`${where(n)} ${method}() with no locale`);
        }
      }
      if (
        (ts.isNewExpression(n) || ts.isCallExpression(n)) &&
        n.expression.getText(sf).replace(/\s/g, '') === 'Intl.DateTimeFormat' &&
        !/\btimeZone\s*:/.test(n.arguments?.map((a) => a.getText(sf)).join(',') ?? '')
      ) {
        out.push(`${where(n)} Intl.DateTimeFormat without a timeZone`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe('dates and numbers on screen (launch fix: Oman time, one text on server and client)', () => {
  it('formats no Date with toLocale*, no Intl.DateTimeFormat without a zone, no number without a locale', () => {
    const files = candidates();
    // The guard reads real files: if the scan finds nothing, it is broken, not passing.
    expect(files.length).toBeGreaterThan(5);
    expect(violations(files)).toEqual([]);
  }, 120_000);

  it('catches the shapes it bans', () => {
    // A fixture under lib/ so the repo tsconfig applies; never written to disk.
    const name = join(ROOT, 'lib', '__oman-time-guard-fixture.ts');
    const src = [
      "export const a = (d: Date) => d.toLocaleString('en-GB');",
      "export const b = (d: Date | null) => d?.toLocaleDateString('en-GB');",
      "export const c = (s: string) => new Date(s).toLocaleTimeString('en-GB', { timeZone: 'Asia/Muscat' });",
      "export const d = new Intl.DateTimeFormat('en-GB', { hour: '2-digit' });",
      'export const e = (n: number) => n.toLocaleString();',
      // Allowed: a number with a locale, and a zoned formatter.
      "export const f = (n: number) => n.toLocaleString('en-US');",
      "export const g = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Muscat' });",
    ].join('\n');
    const host = ts.sys;
    const readFile = host.readFile;
    const fileExists = host.fileExists;
    host.readFile = (p, enc) => (p.replace(/\\/g, '/') === name.replace(/\\/g, '/') ? src : readFile(p, enc));
    host.fileExists = (p) => p.replace(/\\/g, '/') === name.replace(/\\/g, '/') || fileExists(p);
    try {
      const found = violations([name]).map((v) => v.replace(/^.*?:(\d+) /, '$1 '));
      expect(found).toEqual([
        '1 toLocaleString on a Date — use the lib/tz.ts Oman helpers',
        '2 toLocaleDateString on a Date — use the lib/tz.ts Oman helpers',
        '3 toLocaleTimeString on a Date — use the lib/tz.ts Oman helpers',
        '4 Intl.DateTimeFormat without a timeZone',
        '5 toLocaleString() with no locale',
      ]);
    } finally {
      host.readFile = readFile;
      host.fileExists = fileExists;
    }
  }, 120_000);
});
