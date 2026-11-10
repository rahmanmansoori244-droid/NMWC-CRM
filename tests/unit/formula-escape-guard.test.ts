// @vitest-environment node
/**
 * Code review 2026-11-10, finding 30: the formula escape is switched off in ONE
 * place — the weekly Temix upload workbook (services/temix.ts), whose cells are
 * typed text that Temix stores as given. Every other export keeps the escape
 * (QA-021), and any CSV output would need it. Structural, per CLAUDE.md:
 * comments are stripped before the source is read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe('the formula escape is off only in the Temix upload workbook', () => {
  it('escapeFormulas: false appears in services/temix.ts and nowhere else', () => {
    const hits = ['app', 'lib', 'services', 'components', 'scripts']
      .flatMap(files)
      .filter((f) => /escapeFormulas:\s*false/.test(stripComments(readFileSync(f, 'utf8'), f)))
      .map((f) => f.split(String.fromCharCode(92)).join('/'));
    expect(hits).toEqual(['services/temix.ts']);
  });

  it('the Temix workbook is built with it', () => {
    const src = stripComments(readFileSync('services/temix.ts', 'utf8'), 'temix.ts');
    expect(src).toMatch(/buildWorkbook\(rows, 'Temix Upload', \{ escapeFormulas: false \}\)/);
  });

  it('the escape is still the default of buildWorkbook and of the streamed builder', () => {
    const src = stripComments(readFileSync('lib/excel.ts', 'utf8'), 'excel.ts');
    expect(src).toMatch(/options\.escapeFormulas === false \? typedTextCell : escapeFormulaCell/);
    expect(src).toMatch(/for \(const k of columns\) safe\[k\] = escapeFormulaCell\(r\[k\]\);/);
  });
});
