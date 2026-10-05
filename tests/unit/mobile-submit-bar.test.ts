/**
 * The salesman's Submit bar stands ON the phone tab bar, and nothing in the
 * form paints over it.
 *
 * Production walk, 2026-10-05: below md the salesman's MobileTabBar is fixed to
 * the screen bottom (z-30), and the new-customer and Enrich forms pinned their
 * Submit bar with `sticky bottom-0`. Mid-page 30 of the button's 44 px sat
 * under the tab bar, and a tap on its centre hit "Today", which left the form.
 * A never-saved new customer keeps only its typed text on the phone, so the
 * photos and the GPS point were lost with it.
 *
 * The review of that fix found the second half: PhotoCaptureSlot's z-10/z-20/
 * z-30 layers sat in the page's stacking context and painted over the sticky
 * bar whenever a photo row scrolled behind it, so a tap on Submit hit Retake or
 * Remove photo. That one was older than the tab bar fix and hit every width.
 *
 * The contract pinned here:
 *   - MobileTabBar is h-14 (3.5rem) and hides from md;
 *   - the app layout sets --nmwc-tabbar-h to 3.5rem below md and 0px from md,
 *     on the SALESMAN branch only — other roles have no tab bar;
 *   - every bottom-pinned bar a salesman can see sits at that offset;
 *   - inside the two forms and the components they use, every z-indexed layer
 *     is contained by an `isolate` ancestor in its own file.
 * Class names are read from the className expression through the TypeScript
 * parser (string literals and template parts), so a comment never counts and
 * a class inside cn(), a template or a ternary does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';

const OFFSET = 'bottom-[var(--nmwc-tabbar-h,0px)]';
const FORMS = [
  'app/(app)/customers/new/CreateCustomerForm.tsx',
  'app/(app)/customers/[id]/edit/EnrichmentForm.tsx',
];

/** Bottom-pinned bars on pages a salesman never reaches: MobileTabBar renders only for SALESMAN. */
const APPROVER_ONLY = new Map<string, string>([
  ['app/(app)/approvals/[id]/page.tsx', 'the approval review page: approvers only'],
  ['app/(app)/approvals/BulkApprovalQueue.tsx', 'the approval queue: approvers only'],
]);

type El = {
  file: string;
  line: number;
  tag: string;
  tokens: string[];
  ancestors: string[][];
  classNode?: ts.Node;
};

/** Every class-like word in a className initializer: string literals and template parts, at any depth. */
function tokensOf(node: ts.Node | undefined): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(...n.text.split(/\s+/).filter(Boolean));
    }
    ts.forEachChild(n, visit);
  };
  if (node) visit(node);
  return out;
}

/**
 * The utility a token applies, without its variant prefixes: `md:bottom-0` →
 * `bottom-0`, `md:[--x:0px]` → `[--x:0px]`. A colon inside brackets belongs to
 * the arbitrary value, not to a variant.
 */
function base(t: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '[') depth++;
    else if (t[i] === ']') depth--;
    else if (t[i] === ':' && depth === 0) cut = i + 1;
  }
  return t.slice(cut);
}
const hasBase = (tokens: string[], re: RegExp) => tokens.some((t) => re.test(base(t)));

function elements(file: string): El[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: El[] = [];
  const walk = (n: ts.Node, ancestors: string[][]): void => {
    let next = ancestors;
    const opening = ts.isJsxElement(n)
      ? n.openingElement
      : ts.isJsxSelfClosingElement(n)
        ? n
        : null;
    if (opening) {
      const attr = opening.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === 'className'
      );
      const tokens = tokensOf(attr?.initializer);
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1,
        tag: opening.tagName.getText(sf),
        tokens,
        ancestors,
        classNode: attr?.initializer,
      });
      next = [...ancestors, tokens];
    }
    ts.forEachChild(n, (c) => walk(c, next));
  };
  walk(sf, []);
  return out;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith('.tsx') ? [p.replace(/\\/g, '/')] : [];
  });
}

const ALL = [...tsxFiles('app'), ...tsxFiles('components')].flatMap(elements);
const pinnedToBottom = (el: El) =>
  hasBase(el.tokens, /^(sticky|fixed)$/) && hasBase(el.tokens, /^bottom-/);

async function css(classes: string): Promise<string> {
  const out = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  return out.css.replace(/\s+/g, ' ');
}

describe('the salesman Submit bar sits above the phone tab bar', () => {
  const tabBars = ALL.filter(
    (el) =>
      el.file === 'components/nmwc/Sidebar.tsx' && el.tag === 'nav' && el.tokens.includes('fixed')
  );

  it('MobileTabBar is a fixed h-14 bar that hides from md', () => {
    expect(tabBars).toHaveLength(1);
    expect(tabBars[0].tokens).toEqual(
      expect.arrayContaining(['fixed', 'bottom-0', 'h-14', 'md:hidden'])
    );
  });

  it('the app layout sets the offset on the SALESMAN branch, and nowhere else sets it', () => {
    const file = 'app/(app)/layout.tsx';
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const ternaries: ts.ConditionalExpression[] = [];
    const find = (n: ts.Node): void => {
      if (ts.isConditionalExpression(n) && /\.role === 'SALESMAN'$/.test(n.condition.getText(sf)))
        ternaries.push(n);
      ts.forEachChild(n, find);
    };
    find(sf);
    const setting = ternaries.filter((t) => tokensOf(t).some((x) => x.includes('--nmwc-tabbar-h')));
    expect(setting, 'one SALESMAN ternary carries the variable').toHaveLength(1);
    const yes = tokensOf(setting[0].whenTrue);
    const no = tokensOf(setting[0].whenFalse);
    expect(yes).toEqual(
      expect.arrayContaining(['[--nmwc-tabbar-h:3.5rem]', 'md:[--nmwc-tabbar-h:0px]', 'pb-16'])
    );
    expect(
      no.filter((x) => x.includes('--nmwc-tabbar-h')),
      'not set for other roles'
    ).toEqual([]);

    // Nothing else defines it: a second definition would move the bars for roles with no tab bar.
    const definers = ALL.filter((el) =>
      el.tokens.some((x) => base(x).startsWith('[--nmwc-tabbar-h:'))
    );
    expect(definers.map((el) => `${el.file}:${el.line}`)).toEqual([
      expect.stringMatching(/^app\/\(app\)\/layout\.tsx:/),
    ]);
  });

  it('both salesman forms pin their Submit bar at the offset, not at bottom-0', () => {
    for (const f of FORMS) {
      const bars = ALL.filter((el) => el.file === f && pinnedToBottom(el));
      expect(bars, f).toHaveLength(1);
      expect(bars[0].tokens, f).toContain(OFFSET);
      expect(
        bars[0].tokens.filter((t) => base(t) === 'bottom-0'),
        f
      ).toEqual([]);
    }
  });

  it('every other bottom-pinned bar is on an approver-only page', () => {
    const pinned = ALL.filter(pinnedToBottom);
    const offenders = pinned.filter(
      (el) => !el.tokens.includes(OFFSET) && !APPROVER_ONLY.has(el.file) && el !== tabBars[0]
    );
    expect(offenders.map((el) => `${el.file}:${el.line} ${el.tokens.join(' ')}`)).toEqual([]);
    // Keep the allowlist honest: each entry still has a pinned bar to excuse.
    for (const f of APPROVER_ONLY.keys())
      expect(
        pinned.some((el) => el.file === f),
        f
      ).toBe(true);
  });

  it('no layer inside the forms or their components can paint over the bar', () => {
    // The components the two forms render, read from their imports.
    const used = new Set<string>(FORMS);
    for (const f of FORMS) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from '@\/(components\/[^']+)'/g)) {
        const p = `${m[1]}.tsx`;
        if (existsSync(p)) used.add(p);
      }
    }
    expect(used.has('components/nmwc/PhotoCaptureSlot.tsx')).toBe(true);

    const layered = ALL.filter(
      (el) =>
        used.has(el.file) && hasBase(el.tokens, /^-?z-(?!0$|auto$)/) && !el.tokens.includes('fixed')
    );
    const loose = layered.filter(
      (el) => !el.tokens.includes('isolate') && !el.ancestors.some((a) => a.includes('isolate'))
    );
    expect(loose.map((el) => `${el.file}:${el.line} ${el.tokens.join(' ')}`)).toEqual([]);
    // The case that was live: the photo slot's layers exist and are contained.
    expect(layered.some((el) => el.file === 'components/nmwc/PhotoCaptureSlot.tsx')).toBe(true);
  });

  it('compiles to a bar offset equal to the tab bar height, switched off from md', async () => {
    const height = (await css('h-14')).match(/\.h-14 \{ height: ([^;}\s]+)/)?.[1];
    const below = await css('[--nmwc-tabbar-h:3.5rem]');
    const fromMd = await css('md:[--nmwc-tabbar-h:0px]');
    const bar = await css(OFFSET);
    const md = (await css('md:hidden')).match(/@media \(min-width: ([^)]+)\)/)?.[1];

    expect(height).toBe('3.5rem');
    expect(below).toContain(`--nmwc-tabbar-h: ${height}`);
    expect(fromMd).toMatch(
      new RegExp(`@media \\(min-width: ${md}\\) \\{ [^}]*--nmwc-tabbar-h: 0px`)
    );
    expect(bar).toContain('bottom: var(--nmwc-tabbar-h,0px)');
    expect(await css('isolate')).toContain('isolation: isolate');
  });
});
