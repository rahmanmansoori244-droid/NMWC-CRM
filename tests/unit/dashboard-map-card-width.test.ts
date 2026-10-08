/**
 * The dashboard's map card fits a tablet (launch browser suite, 8 Oct). At
 * 768 px, the sidebar shown, /dashboard scrolled 3 px sideways for every
 * dashboard role.
 *
 * "Where the located branches are" put the map and the coverage side by side
 * from md up: `md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]`. A fixed maximum
 * is filled before any `fr` track is given a pixel, so the map took its full
 * 26rem of a card ~455 px wide, and the coverage column was left ~15 px: its
 * "GPS COVERAGE BY …" heading and the big percentage spilled out of the card.
 * The two now sit side by side only from lg, where the card spans the page.
 *
 * Measured on CSS compiled with the repo's Tailwind config, and the card's width
 * worked out from the layout around it, at every width from a phone to the
 * widest screen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import postcss, { type AtRule } from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';

const FILE = 'app/(app)/dashboard/cards.tsx';

/** Where the map sits, and the narrowest coverage column that still holds its heading and figures. */
const COVERAGE_MIN = 240;
const MAP_MAX = 26 * 16;

/**
 * The card's own content width at a screen width (px). From the layout around it:
 *   app/(app)/layout.tsx       max-w-screen-2xl; Sidebar `w-56 border-r` (225 px), from md
 *   dashboard/page.tsx         `p-4 sm:p-6` around the cards' grid, and the map card spans it
 *   insights/InsightCard.tsx   `p-4 sm:p-5`
 */
function cardContentWidth(screen: number): number {
  const sidebar = screen >= 768 ? 225 : 0;
  const page = screen >= 640 ? 24 : 16;
  const card = screen >= 640 ? 20 : 16;
  return Math.min(screen, 1536) - sidebar - 2 * page - 2 * card;
}

/** The className of the grid that holds <OmanHeatMap>. */
function mapGridClasses(src: string): string[] {
  const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: string[] | null = null;
  const classOf = (el: ts.JsxElement): string[] => {
    for (const a of el.openingElement.attributes.properties) {
      if (ts.isJsxAttribute(a) && a.name.getText(sf) === 'className' && a.initializer && ts.isStringLiteral(a.initializer)) {
        return a.initializer.text.split(/\s+/).filter(Boolean);
      }
    }
    return [];
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === 'OmanHeatMap') {
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isJsxElement(p) && classOf(p).includes('grid')) {
          found = classOf(p);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  expect(found, 'the map sits in a grid').not.toBeNull();
  return found!;
}

type Rule = { order: number; value: string; minWidth: number };

/** A CSS class selector's name, unescaped (`\[`, `\(`, and `\2c ` for a comma). */
function unescapeClass(sel: string): string | null {
  const m = /^\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)$/.exec(sel);
  if (!m) return null;
  return m[1]!.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch!
  );
}

/** Class → its rule for each property, from CSS compiled for exactly these classes. */
async function compiled(classes: string[]): Promise<Record<'grid-template-columns' | 'column-gap', Map<string, Rule>>> {
  const out = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: `<div class="${classes.join(' ')}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  const maps = { 'grid-template-columns': new Map<string, Rule>(), 'column-gap': new Map<string, Rule>() };
  let order = 0;
  out.root.walkRules((rule) => {
    order += 1;
    let minWidth = 0;
    if (rule.parent?.type === 'atrule') {
      const m = /^\(min-width:\s*(\d+)px\)$/.exec((rule.parent as AtRule).params.trim());
      if (!m) return;
      minWidth = Number(m[1]);
    }
    rule.walkDecls((d) => {
      const prop = d.prop === 'gap' ? 'column-gap' : d.prop;
      if (prop !== 'grid-template-columns' && prop !== 'column-gap') return;
      for (const sel of rule.selectors) {
        const name = unescapeClass(sel);
        if (name) maps[prop].set(name, { order, value: d.value, minWidth });
      }
    });
  });
  return maps;
}

/** The value an element's own classes give it at this width; null when none does. */
function valueAt(classes: string[], rules: Map<string, Rule>, width: number): string | null {
  let best: Rule | null = null;
  for (const c of classes) {
    const r = rules.get(c);
    if (r && width >= r.minWidth && (!best || r.order > best.order)) best = r;
  }
  return best?.value ?? null;
}

/** A template's tracks, split at the top level. */
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
  return out;
}

function px(len: string): number {
  const m = /^([\d.]+)(px|rem)?$/.exec(len.trim());
  if (!m) throw new Error(`not a fixed length: ${len}`);
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
}

/**
 * Each column's width (px) in a container this wide, for tracks with a fixed
 * minimum: fixed maximums are filled first, then the `fr` tracks share what is
 * left (CSS Grid §12.6–12.7). null is one implicit column: the whole width.
 */
function columnWidths(template: string | null, gap: number, width: number): number[] {
  if (template === null) return [width];
  const defs = tracks(template).map((t) => {
    const [min, max] = t.startsWith('minmax(') ? t.slice(7, -1).split(',') : [t, t];
    const fr = /^([\d.]+)fr$/.exec(max!.trim());
    return { base: px(min!), limit: fr ? null : px(max!), fr: fr ? Number(fr[1]) : 0 };
  });
  const free0 = width - gap * (defs.length - 1) - defs.reduce((s, t) => s + t.base, 0);
  let free = Math.max(0, free0);
  const sizes = defs.map((t) => t.base);
  for (;;) {
    const growing = defs.map((_, i) => i).filter((i) => defs[i]!.limit !== null && sizes[i]! < defs[i]!.limit!);
    if (free <= 0 || growing.length === 0) break;
    const share = free / growing.length;
    for (const i of growing) {
      const add = Math.min(share, defs[i]!.limit! - sizes[i]!);
      sizes[i] = sizes[i]! + add;
      free -= add;
    }
  }
  const frs = defs.reduce((s, t) => s + t.fr, 0);
  return sizes.map((s, i) => (defs[i]!.fr ? s + (free * defs[i]!.fr) / frs : s));
}

/** Every screen width the card is cramped at: two columns, the coverage one too narrow. */
async function crampedWidths(src: string): Promise<string[]> {
  const classes = mapGridClasses(src);
  const rules = await compiled(classes);
  const wrong: string[] = [];
  for (let screen = 320; screen <= 1920; screen += 1) {
    const template = valueAt(classes, rules['grid-template-columns'], screen);
    const gap = px(valueAt(classes, rules['column-gap'], screen) ?? '0');
    const cols = columnWidths(template, gap, cardContentWidth(screen));
    const coverage = cols[cols.length - 1]!;
    if (cols.length > 1 && coverage < COVERAGE_MIN) wrong.push(`${screen} px: coverage ${Math.round(coverage)} px`);
  }
  return wrong;
}

async function columnsAt(src: string, screen: number): Promise<number[]> {
  const classes = mapGridClasses(src);
  const rules = await compiled(classes);
  const template = valueAt(classes, rules['grid-template-columns'], screen);
  const gap = px(valueAt(classes, rules['column-gap'], screen) ?? '0');
  return columnWidths(template, gap, cardContentWidth(screen)).map(Math.round);
}

const src = readFileSync(FILE, 'utf8');

describe('the measure', () => {
  const withGrid = (cls: string) =>
    `export const C = () => <div className="${cls}"><OmanHeatMap cells={[]} cellDeg={1} zoom={false} /><div /></div>;`;

  it('finds the old md layout cramped on a tablet', async () => {
    const old = withGrid('grid gap-6 md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]');
    // 768 − 225 sidebar − 48 page − 40 card = 455: 416 map, 24 gap, 15 left.
    expect(await columnsAt(old, 768)).toEqual([416, 15]);
    expect(await crampedWidths(old)).toContain('768 px: coverage 15 px');
  });

  it('sizes fixed maximums before fr, and one column takes the card', async () => {
    expect(columnWidths('minmax(0,26rem) minmax(0,1fr)', 24, 711)).toEqual([416, 271]);
    expect(columnWidths('minmax(0,26rem) minmax(0,1fr)', 24, 300)).toEqual([276, 0]);
    expect(columnWidths(null, 24, 455)).toEqual([455]);
  });
});

describe('the "Where the located branches are" card', () => {
  it('never leaves the coverage column too narrow to read, at any width', async () => {
    expect(await crampedWidths(src)).toEqual([]);
  });

  it('stacks the map over the coverage on a tablet with the sidebar shown', async () => {
    expect(await columnsAt(src, 768)).toEqual([455]);
    expect(await columnsAt(src, 1000)).toHaveLength(1);
  });

  it('keeps the phone stacked and the desktop side by side, the map at 26rem', async () => {
    expect(await columnsAt(src, 360)).toHaveLength(1);
    expect(await columnsAt(src, 412)).toHaveLength(1);
    for (const screen of [1024, 1280, 1440, 1920]) {
      const cols = await columnsAt(src, screen);
      expect(cols, `${screen} px`).toHaveLength(2);
      expect(cols[0], `${screen} px`).toBe(MAP_MAX);
    }
  });
});
