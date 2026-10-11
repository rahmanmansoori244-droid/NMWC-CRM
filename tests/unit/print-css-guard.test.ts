// @vitest-environment node
/**
 * Owner decisions 2026-10-11, part C — what a print depends on, pinned in the
 * source (CLAUDE.md: structural guards where the defect is "nobody called it"):
 *   - app/(print)/print.css: A4 portrait with 12 mm margins, colours printed as
 *     on screen, no app chrome, nothing split across a page that should not be,
 *     and the guard — the sheet prints only while <html data-print-ok> is set,
 *     and the notice prints otherwise;
 *   - components/print/PrintButton.tsx: the photos are in, THEN the print is
 *     recorded, THEN data-print-ok is set and the dialog opened; afterprint
 *     clears it; nothing else in the code sets it.
 * Comments are stripped first: a comment quoting a rule is not the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type Rule, type AtRule } from 'postcss';
import { stripComments } from '../support/strip-comments';

const CSS_FILE = 'app/(print)/print.css';
const root = postcss.parse(readFileSync(CSS_FILE, 'utf8'));

/** Declarations of every rule with exactly this selector, inside `media` (or at the top level). */
function decls(selector: string, media: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  root.walkRules((r: Rule) => {
    const parent = r.parent as AtRule | undefined;
    const inMedia = parent?.type === 'atrule' && parent.name === 'media' ? parent.params : null;
    if (inMedia !== media) return;
    const selectors = r.selectors.map((s) => s.replace(/\s+/g, ' ').trim());
    if (!selectors.includes(selector)) return;
    r.walkDecls((d) => {
      out[d.prop] = d.value + (d.important ? ' !important' : '');
    });
  });
  return out;
}

describe('app/(print)/print.css', () => {
  it('the page is A4 portrait with 12 mm margins', () => {
    const pages: Record<string, string>[] = [];
    root.walkAtRules('page', (a) => {
      const d: Record<string, string> = {};
      a.walkDecls((x) => {
        d[x.prop] = x.value;
      });
      pages.push(d);
    });
    expect(pages).toEqual([{ size: 'A4 portrait', margin: '12mm' }]);
  });

  it('prints colours exactly, hides .no-print and keeps blocks whole', () => {
    expect(decls('.print-page *', 'print')).toMatchObject({ 'print-color-adjust': 'exact' });
    expect(decls('.no-print', 'print')).toEqual({ display: 'none !important' });
    expect(decls('.print-keep', 'print')).toMatchObject({ 'break-inside': 'avoid' });
    expect(decls('.print-sheet figure', 'print')).toMatchObject({ 'break-inside': 'avoid' });
    expect(decls('.print-new-page', 'print')).toMatchObject({ 'break-before': 'page' });
    // The sheet has no shadow on paper, and the page behind it prints white.
    expect(decls('.print-sheet', 'print')).toMatchObject({ 'box-shadow': 'none' });
    expect(decls('body', 'print')).toMatchObject({ background: '#ffffff !important' });
  });

  it('the guard: without data-print-ok the sheet does not print and the notice does', () => {
    expect(decls('html:not([data-print-ok]) .print-sheet', 'print')).toEqual({ display: 'none !important' });
    expect(decls('html:not([data-print-ok]) .print-blocked', 'print')).toMatchObject({ display: 'block !important' });
    // On screen the notice is hidden, and nothing hides the sheet.
    expect(decls('.print-blocked', null)).toEqual({ display: 'none' });
    expect(decls('.print-sheet', null).display).toBeUndefined();
  });

  it('on screen the sheet is A4 wide, never wider than a phone', () => {
    expect(decls('.print-sheet', null)).toMatchObject({ width: '210mm', 'max-width': 'calc(100% - 16px)' });
  });
});

describe('components/print/PrintButton.tsx', () => {
  const src = stripComments(readFileSync('components/print/PrintButton.tsx', 'utf8'), 'components/print/PrintButton.tsx');
  const onPrint = src.slice(src.indexOf('async function onPrint('), src.indexOf('return (', src.indexOf('async function onPrint(')));
  const at = (needle: string) => {
    const i = onPrint.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('waits for the photos, then records, then sets data-print-ok, then prints', () => {
    const decoded = at('img.decode()');
    const recorded = at('await recordPrintAction({ printout, id })');
    const refused = at('if (!res.ok)');
    const listened = at("window.addEventListener('afterprint'");
    const set = at("html.setAttribute('data-print-ok', '')");
    const printed = at('window.print()');
    expect(decoded).toBeLessThan(recorded);
    expect(recorded).toBeLessThan(refused);
    expect(refused).toBeLessThan(set);
    expect(listened).toBeLessThan(set);
    expect(set).toBeLessThan(printed);
    // A refusal returns before anything is printed.
    expect(onPrint.slice(refused, set)).toMatch(/return;/);
    expect(onPrint).toMatch(/removeAttribute\('data-print-ok'\)/);
    expect(src.match(/window\.print\(\)/g)).toHaveLength(1);
  });

  it('nothing else in the app sets data-print-ok or opens the print dialog', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name).replace(/\\/g, '/');
        return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
      });
    const offenders = ['app', 'components', 'lib', 'services']
      .flatMap(files)
      .filter((f) => f !== 'components/print/PrintButton.tsx')
      .filter((f) => /data-print-ok|window\.print\s*\(/.test(stripComments(readFileSync(f, 'utf8'), f)));
    expect(offenders).toEqual([]);
  });
});
