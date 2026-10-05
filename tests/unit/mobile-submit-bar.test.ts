/**
 * The salesman's Submit bar stands ON the phone tab bar, not under it.
 *
 * Production walk, 2026-10-05: below md the salesman's MobileTabBar is fixed to
 * the screen bottom (z-30), and the new-customer and Enrich forms pinned their
 * Submit bar with `sticky bottom-0`. Mid-page the bar sat under the tab bar:
 * 30 of the button's 44 px were covered, and a tap on its centre hit "Today",
 * which left the form. A never-saved new customer keeps only its typed text on
 * the phone, so the photos and the GPS point were lost with it.
 *
 * The contract: MobileTabBar is h-14; the app layout gives a salesman's page
 * --nmwc-tabbar-h = 3.5rem below md and 0px from md; every bottom-pinned bar a
 * salesman can see uses bottom-[var(--nmwc-tabbar-h,0px)]. Other roles have no
 * tab bar, so the variable is unset there and those bars stay at 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';
import { jsxElements, type JsxEl } from '../support/jsx-ast';

const OFFSET = 'bottom-[var(--nmwc-tabbar-h,0px)]';

/** Bottom-pinned bars on pages a salesman never reaches: MobileTabBar renders only for SALESMAN. */
const APPROVER_ONLY = new Map<string, string>([
  ['app/(app)/approvals/[id]/page.tsx', 'the approval review page: approvers only'],
  ['app/(app)/approvals/BulkApprovalQueue.tsx', 'the approval queue: approvers only'],
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith('.tsx') ? [p.replace(/\\/g, '/')] : [];
  });
}

const classText = (el: JsxEl): string => {
  const a = el.attrs.className;
  if (!a) return '';
  return a.kind === 'string' ? a.value : a.kind === 'expression' ? a.text : '';
};

const ELEMENTS = [...tsxFiles('app'), ...tsxFiles('components')].flatMap((f) =>
  jsxElements(readFileSync(f, 'utf8'), f).map((el) => ({ ...el, file: f, cls: classText(el) }))
);

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
  const tabBar = ELEMENTS.filter(
    (el) => el.file === 'components/nmwc/Sidebar.tsx' && el.tag === 'nav' && /\bfixed\b/.test(el.cls)
  );

  it('MobileTabBar is a fixed h-14 bar that hides from md', () => {
    expect(tabBar).toHaveLength(1);
    const cls = tabBar[0].cls.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['fixed', 'bottom-0', 'h-14', 'md:hidden']));
  });

  it("the app layout gives a salesman's page the tab bar height below md and 0 from md", () => {
    const layout = jsxElements(readFileSync('app/(app)/layout.tsx', 'utf8'), 'app/(app)/layout.tsx');
    const wrapper = layout
      .map((el) => ({ el, cls: classText(el) }))
      .filter(({ cls }) => cls.includes('--nmwc-tabbar-h'));
    expect(wrapper, 'one element sets the variable').toHaveLength(1);
    const { el, cls } = wrapper[0];
    expect(el.attrs.className?.kind, 'set per role, not for everyone').toBe('expression');
    expect(cls).toMatch(/role === 'SALESMAN' \?/);
    expect(cls).toContain('[--nmwc-tabbar-h:3.5rem]');
    expect(cls).toContain('md:[--nmwc-tabbar-h:0px]');
    // The page's own bottom padding still clears the bar at the end of the scroll.
    expect(cls).toContain('pb-16');
  });

  it('both salesman forms pin their Submit bar at the offset, not at bottom-0', () => {
    for (const f of [
      'app/(app)/customers/new/CreateCustomerForm.tsx',
      'app/(app)/customers/[id]/edit/EnrichmentForm.tsx',
    ]) {
      const bars = ELEMENTS.filter((el) => el.file === f && /\bsticky\b/.test(el.cls));
      expect(bars, f).toHaveLength(1);
      const cls = bars[0].cls.split(/\s+/);
      expect(cls, f).toContain(OFFSET);
      expect(cls, f).not.toContain('bottom-0');
    }
  });

  it('every other bottom-pinned bar is on an approver-only page', () => {
    const pinned = ELEMENTS.filter((el) => /\b(sticky|fixed)\b/.test(el.cls) && /(^|\s)bottom-/.test(el.cls));
    const offenders = pinned.filter(
      (el) => !el.cls.split(/\s+/).includes(OFFSET) && !APPROVER_ONLY.has(el.file) && el !== tabBar[0]
    );
    expect(offenders.map((el) => `${el.file}:${el.line}`)).toEqual([]);
    // Keep the allowlist honest: each entry still has a pinned bar to excuse.
    for (const f of APPROVER_ONLY.keys()) expect(pinned.some((el) => el.file === f), f).toBe(true);
  });

  it('compiles to a bar offset equal to the tab bar height, switched off from md', async () => {
    const height = (await css('h-14')).match(/\.h-14 \{ height: ([^;}\s]+)/)?.[1];
    const below = await css('[--nmwc-tabbar-h:3.5rem]');
    const fromMd = await css('md:[--nmwc-tabbar-h:0px]');
    const bar = await css(OFFSET);
    const md = (await css('md:hidden')).match(/@media \(min-width: ([^)]+)\)/)?.[1];

    expect(height).toBe('3.5rem');
    expect(below).toContain(`--nmwc-tabbar-h: ${height}`);
    expect(fromMd).toMatch(new RegExp(`@media \\(min-width: ${md}\\) \\{ [^}]*--nmwc-tabbar-h: 0px`));
    expect(bar).toContain('bottom: var(--nmwc-tabbar-h,0px)');
  });
});
