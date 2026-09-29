/**
 * Adversarial pass after phase 2, finding 4: `s.replace(/<[^>]+>/g, '')` took
 * quadratic time on a run of '<' with no '>' after it — from each '<' the regex
 * read to the end looking for one — and the edit payload ran it over every text
 * field of an unbounded list of branches: about 12 s of CPU for one 4.5 MB body.
 * stripHtml (lib/validation/fields.ts) now runs the regex only up to the last '>'
 * and is the one copy; lib/gps-manual.ts and lib/import-row-check.ts call it. The
 * branch cap on the edit payload is in edit-schema.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import { fastestMs, seededStrings } from '../support/seeded-strings';
import { stripHtml } from '@/lib/validation/fields';
import { stripHtml as stripImportCell } from '@/lib/import-row-check';
import { gpsManualReasonSchema } from '@/lib/gps-manual';

/** What every copy did before: the output the linear version must keep. */
const before = (s: string) => s.replace(/<[^>]+>/g, '').trim();

describe('stripHtml returns what the old expression returned', () => {
  const EDGES = [
    '',
    '   ',
    '<',
    '>',
    '<>',
    '<<>>',
    '<b></b>',
    '  <b>Shop</b>  ',
    // The linear rewrite a reviewer first proposed, /<[^<>]*>/g, gives
    // '<script>' for this one; the old expression gives 'script>'.
    '<<script>script>',
    'a <> b',
    '<a<b>c',
    'x > y < z',
    'tail <b',
    '<b>x</b> and < after',
    '> then <<<<',
    '\t<i>tab</i>\n',
    'Al Noor <Trading> LLC',
    'متجر <b>النور</b>',
  ];

  it('on the edge cases', () => {
    for (const s of EDGES) {
      expect(stripHtml(s), JSON.stringify(s)).toBe(before(s));
      expect(stripImportCell(s), JSON.stringify(s)).toBe(before(s));
    }
    expect(stripHtml('<<script>script>')).toBe('script>');
  });

  it('on a seeded random corpus of 100,000 strings', () => {
    const corpus = seededStrings(
      41,
      100_000,
      ['<', '>', 'a', 'b', ' ', '/', '\t', '\n', '<b>', '</b>', '<<', '>>', '<a'],
      16
    );
    const wrong: string[] = [];
    let tagsRemoved = 0;
    let afterLastClose = 0;
    for (const s of corpus) {
      const want = before(s);
      if (want !== s.trim()) tagsRemoved++;
      if (s.slice(s.lastIndexOf('>') + 1).includes('<')) afterLastClose++;
      if (stripHtml(s) !== want || stripImportCell(s) !== want) wrong.push(s);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    // Not vacuous: most strings lose a tag (72,339 with this seed), and over a
    // third hold a '<' after the last '>', the part the rewrite no longer scans.
    expect(tagsRemoved).toBeGreaterThan(60_000);
    expect(afterLastClose).toBeGreaterThan(30_000);
  });

  it('an import cell still takes any value', () => {
    expect(stripImportCell(null)).toBe('');
    expect(stripImportCell(undefined)).toBe('');
    expect(stripImportCell(42)).toBe('42');
  });

  it('the typed-in GPS reason is stripped by the same function', () => {
    expect(gpsManualReasonSchema.parse('  <b>No</b> signal inside ')).toBe('No signal inside');
    expect(gpsManualReasonSchema.safeParse('<b></b><i></i>').success).toBe(false);
  });
});

describe('stripHtml is linear', () => {
  // Each took 0.2 to 1.5 s through the old expression in local runs (Node 24);
  // linear, each takes well under a millisecond, so 50 ms leaves room for a
  // slow CI runner and the quadratic version still fails it.
  const HOSTILE: Array<[string, string]> = [
    ['20,000 × <', '<'.repeat(20_000)],
    ['<a to 20,000 characters', '<a'.repeat(10_000)],
    ['> then 20,000 × <', '>' + '<'.repeat(20_000)],
    ['< a to 20,000 characters', '< a'.repeat(6_667)],
  ];
  it.each(HOSTILE)('%s strips in under 50 ms', (_name, s) => {
    expect(fastestMs(() => stripHtml(s))).toBeLessThan(50);
    expect(fastestMs(() => stripImportCell(s))).toBeLessThan(50);
  });
});

describe('one copy of the tag regex (structural)', () => {
  const NEEDLE = '<[^>]+>';
  const SKIP = new Set(['node_modules', '.next', 'golive-data']);
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('only lib/validation/fields.ts holds it; the GPS reason and the import cells call that one', () => {
    const holders = ['app', 'components', 'lib', 'services', 'scripts', 'prisma']
      .flatMap(sources)
      .filter((f) => {
        const raw = readFileSync(f, 'utf8');
        return raw.includes(NEEDLE) && stripComments(raw, f).includes(NEEDLE);
      })
      .map((f) => f.replace(/\\/g, '/'));
    expect(holders).toEqual(['lib/validation/fields.ts']);

    const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
    expect(read('lib/gps-manual.ts')).toMatch(
      /import \{ stripHtml \} from '\.\/validation\/fields'/
    );
    expect(read('lib/gps-manual.ts')).toMatch(/\.transform\(stripHtml\)/);
    expect(read('lib/import-row-check.ts')).toMatch(
      /import \{ stripHtml as stripTags \} from '@\/lib\/validation\/fields'/
    );
    expect(read('lib/import-row-check.ts')).toMatch(/return stripTags\(/);
  });
});
