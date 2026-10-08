/**
 * A salesman's lists fit his phone (launch browser suite, 8 Oct). With
 * real-length customer names /customers was 52 px and /today 12 px wider than a
 * 360 px phone, so the page scrolled sideways or zoomed out, and the right end
 * of the fixed tab bar left the screen.
 *
 * The card lists were a `grid` with no columns named, so their one column was
 * an implicit `auto` track. A grid item's automatic minimum is its min-content
 * width, and a card's name and code are `truncate` (one line, no wrapping): the
 * min-content of such a line is the whole line. So the column took the full
 * name and nothing was ever cut. `grid-cols-1` is `repeat(1, minmax(0, 1fr))`:
 * a column that may be narrower than what it holds, so the card is the
 * screen's width and the name ends in an ellipsis.
 *
 * Measured on CSS compiled with the repo's Tailwind config: at a phone's width
 * every grid on these pages names its columns, and no column has a minimum
 * sized by its content (`auto`, a bare `fr`, `min-content`, `max-content`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import postcss, { type AtRule } from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';
import { jsxElements, type JsxAttr } from '../support/jsx-ast';

/** The two phone widths the launch suite runs at. */
const PHONES = [360, 412];

/** The lists of cards a salesman or a manager opens on a phone. */
const FILES = [
  'app/(app)/customers/page.tsx',
  // The "More filters" panel above the customer cards.
  'app/(app)/customers/CustomerFiltersClient.tsx',
  'app/(app)/today/page.tsx',
  'app/(app)/work/page.tsx',
  'app/(app)/notifications/page.tsx',
  'app/(app)/rejected/page.tsx',
  'app/(app)/reactivations/page.tsx',
  'app/(app)/duplicates/page.tsx',
  // Already one zero-minimum column: kept that way.
  'app/(app)/approvals/BulkApprovalQueue.tsx',
];

/** An element's classes: a plain string, or every string inside a `cn(…)` or template. */
function classesOf(attr: JsxAttr | undefined): string[] {
  if (!attr || attr.kind === 'bare') return [];
  const text =
    attr.kind === 'string'
      ? attr.value
      : Array.from(attr.text.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g), (m) => m[1] ?? m[2] ?? m[3]).join(' ');
  return text.split(/\s+/).filter(Boolean);
}

type ColsRule = { order: number; value: string; minWidth: number };

/** A CSS class selector's name, unescaped (`\[`, `\(`, and `\2c ` for a comma). */
function unescapeClass(sel: string): string | null {
  const m = /^\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)$/.exec(sel);
  if (!m) return null;
  return m[1]!.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch!
  );
}

/** Class → its grid-template-columns rule, from CSS compiled for exactly these classes. */
async function columnRules(classes: string[]): Promise<Map<string, ColsRule>> {
  const out = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: `<div class="${classes.join(' ')}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  const map = new Map<string, ColsRule>();
  let order = 0;
  out.root.walkRules((rule) => {
    order += 1;
    let minWidth = 0;
    if (rule.parent?.type === 'atrule') {
      const m = /^\(min-width:\s*(\d+)px\)$/.exec((rule.parent as AtRule).params.trim());
      if (!m) return;
      minWidth = Number(m[1]);
    }
    rule.walkDecls('grid-template-columns', (d) => {
      for (const sel of rule.selectors) {
        const name = unescapeClass(sel);
        if (name) map.set(name, { order, value: d.value, minWidth });
      }
    });
  });
  return map;
}

/** The columns an element's own classes give it at this width; null is the implicit auto column. */
function columnsAt(classes: string[], rules: Map<string, ColsRule>, width: number): string | null {
  let best: ColsRule | null = null;
  for (const c of classes) {
    const r = rules.get(c);
    if (r && width >= r.minWidth && (!best || r.order > best.order)) best = r;
  }
  return best?.value ?? null;
}

/** A template's tracks, split at the top level, each `repeat(n, …)` opened once. */
function tracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.flatMap((t) =>
    t.startsWith('repeat(') ? tracks(t.slice(t.indexOf(',') + 1, -1)) : [t]
  );
}

const FIXED = /^(0|[\d.]+(px|rem|em))$/;
/** A track whose minimum grows with what it holds. */
function contentSizedMinimum(track: string): boolean {
  if (track.startsWith('minmax(')) return !FIXED.test(track.slice('minmax('.length, track.indexOf(',')).trim());
  return !FIXED.test(track);
}

/** Each grid of the file whose phone columns can grow with what they hold. */
async function wideGrids(file: string, src = readFileSync(file, 'utf8')): Promise<string[]> {
  const grids = jsxElements(src, file)
    .map((el) => ({ line: el.line, classes: classesOf(el.attrs.className) }))
    .filter((g) => g.classes.includes('grid'));
  expect(grids.length, `${file} has a grid`).toBeGreaterThan(0);
  const rules = await columnRules(grids.flatMap((g) => g.classes));
  const wrong: string[] = [];
  for (const g of grids) {
    for (const width of PHONES) {
      const cols = columnsAt(g.classes, rules, width);
      if (cols === null) wrong.push(`${file}:${g.line} at ${width} px: an implicit auto column`);
      else if (tracks(cols).some(contentSizedMinimum)) wrong.push(`${file}:${g.line} at ${width} px: ${cols}`);
    }
  }
  return wrong;
}

describe('the measure', () => {
  it('finds the old list markup too wide, and grid-cols-1 not', async () => {
    const page = (cls: string) => `export const P = () => <ul className="${cls}"><li /></ul>;`;
    expect(await wideGrids('old.tsx', page('grid gap-3'))).toEqual([
      'old.tsx:1 at 360 px: an implicit auto column',
      'old.tsx:1 at 412 px: an implicit auto column',
    ]);
    expect(await wideGrids('fixed.tsx', page('grid grid-cols-1 gap-3'))).toEqual([]);
    // Two columns from md up are not a phone's.
    expect(await wideGrids('md.tsx', page('grid gap-3 md:grid-cols-[1fr_auto]'))).toHaveLength(2);
    expect(await wideGrids('md.tsx', page('grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]'))).toEqual([]);
    // A bare 1fr is minmax(auto, 1fr): sized by its content after all.
    expect(await wideGrids('fr.tsx', page('grid grid-cols-[80px_1fr]'))).toHaveLength(2);
    expect(await wideGrids('fr.tsx', page('grid grid-cols-[80px_minmax(0,1fr)]'))).toEqual([]);
  });
});

describe('the lists a salesman or a manager opens on a phone are no wider than it', () => {
  it.each(FILES)('%s', async (file) => {
    expect(await wideGrids(file)).toEqual([]);
  });
});
