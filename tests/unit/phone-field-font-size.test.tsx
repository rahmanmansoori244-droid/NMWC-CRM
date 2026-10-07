/**
 * iOS Safari zooms the whole page in when a field whose text is under 16 px
 * takes focus, and leaves it zoomed after the keyboard closes: the salesman
 * pinches back out before he can tap anything else.
 *
 * The forced first-sign-in page (ChangePasswordForm) set `text-sm` on its
 * <form>, and Tailwind's preflight makes every field inherit its font size
 * (`font-size: 100%`), so all three password boxes were 14 px. The customers
 * filter bar a salesman searches his route with had the same: the channel
 * search box, the score boxes, the dates, the selects and the saved-view name
 * were all `text-sm`. Each is now 16 px below Tailwind's `sm` breakpoint and
 * keeps its old size from `sm` up, so the desktop look does not change.
 *
 * Measured on rendered markup against CSS compiled with the repo's Tailwind
 * config: a field's size is the last font-size rule among its own classes that
 * applies at the width, else its parent's, up to the 16 px root
 * (tests/unit/mobile-quick-wins.test.tsx pins the root at 16 px).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import postcss, { type AtRule } from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';
import { jsxElements } from '../support/jsx-ast';

const h = vi.hoisted(() => ({ fn: () => {} }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.fn, push: h.fn, refresh: h.fn }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));
vi.mock('@/services/password', () => ({ changeOwnPasswordAction: vi.fn() }));
vi.mock('@/app/actions/auth', () => ({ loginAction: vi.fn() }));
vi.mock('@/services/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
}));
vi.mock('@/services/customer-export', () => ({ exportFilteredCustomersAction: vi.fn() }));

import { ChangePasswordForm } from '@/app/(app)/profile/change-password/ChangePasswordForm';
import { LoginForm } from '@/components/nmwc/LoginForm';
import { LabeledField } from '@/components/nmwc/LabeledField';
import { StepperInput } from '@/components/nmwc/StepperInput';
import { GpsCaptureButton } from '@/components/nmwc/GpsCaptureButton';
import { MultiSelectFilter } from '@/components/nmwc/MultiSelectFilter';
import { CreateCustomerForm } from '@/app/(app)/customers/new/CreateCustomerForm';
import {
  CustomerFiltersClient,
  type CustomerFiltersClientProps,
} from '@/app/(app)/customers/CustomerFiltersClient';

const PHONE = 375;
const DESKTOP = 1280;

type SizeRule = { order: number; px: number; minWidth: number };

function toPx(value: string): number {
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * 16;
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`font-size ${value} is not in rem or px`);
}

/** Class → its font-size rule, from CSS compiled for exactly these classes. */
async function sizeRules(classes: string): Promise<Map<string, SizeRule>> {
  const out = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  const map = new Map<string, SizeRule>();
  let order = 0;
  out.root.walkRules((rule) => {
    order += 1;
    let minWidth = 0;
    if (rule.parent?.type === 'atrule') {
      const m = /^\(min-width:\s*(\d+)px\)$/.exec((rule.parent as AtRule).params.trim());
      if (!m) return;
      minWidth = Number(m[1]);
    }
    rule.walkDecls('font-size', (d) => {
      for (const sel of rule.selectors) {
        // A bare class only: `.sm\:text-sm`, `.text-\[15px\]`; never `:focus` and the like.
        const m = /^\.((?:\\.|[\w-])+)$/.exec(sel);
        if (m) map.set(m[1]!.replace(/\\(.)/g, '$1'), { order, px: toPx(d.value), minWidth });
      }
    });
  });
  return map;
}

function fontPx(el: Element, rules: Map<string, SizeRule>, width: number): number {
  for (let n: Element | null = el; n; n = n.parentElement) {
    let best: SizeRule | null = null;
    for (const c of Array.from(n.classList)) {
      const r = rules.get(c);
      if (r && width >= r.minWidth && (!best || r.order > best.order)) best = r;
    }
    if (best) return best.px;
  }
  return 16;
}

/** Every field a person types into or picks from (not ticks, uploads or hides). */
function typedFields(root: ParentNode = document.body): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('input, textarea, select')).filter(
    (el) => !(el instanceof HTMLInputElement) || !['checkbox', 'radio', 'file', 'hidden', 'submit', 'button'].includes(el.type)
  );
}

const fieldName = (el: HTMLElement) =>
  `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.id ?? ''}]`;

/** Each field's size at the width, by name, from the CSS for what is on screen. */
async function sizes(width: number, fields = typedFields()): Promise<Record<string, number>> {
  const classes = Array.from(document.querySelectorAll('[class]'))
    .map((e) => e.getAttribute('class'))
    .join(' ');
  const rules = await sizeRules(classes);
  return Object.fromEntries(fields.map((el, i) => [`${i}:${fieldName(el)}`, fontPx(el, rules, width)]));
}

function under16(s: Record<string, number>) {
  return Object.entries(s).filter(([, px]) => px < 16);
}

afterEach(() => cleanup());

describe('the forced first-sign-in page', () => {
  it('its three password boxes are 16 px on a phone', async () => {
    render(<ChangePasswordForm />);
    const s = await sizes(PHONE);
    expect(Object.keys(s)).toHaveLength(3);
    expect(under16(s)).toEqual([]);
  });

  it('and 14 px from the sm breakpoint up, as before', async () => {
    render(<ChangePasswordForm />);
    expect(Object.values(await sizes(DESKTOP))).toEqual([14, 14, 14]);
  });
});

describe('the other fields a salesman types into', () => {
  it('sign in', async () => {
    render(<LoginForm />);
    const s = await sizes(PHONE);
    expect(Object.keys(s)).toHaveLength(2);
    expect(under16(s)).toEqual([]);
  });

  it('the labelled fields, the count steppers and the typed GPS point', async () => {
    render(
      <div>
        <LabeledField label="Shop name" value="" onChange={() => {}} />
        <LabeledField label="CR number" value="" onChange={() => {}} mono />
        <LabeledField label="Notes" value="" onChange={() => {}} textarea />
        <StepperInput name="coolers" label="Coolers" value={0} onChange={() => {}} />
        <GpsCaptureButton onCapture={() => {}} />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: /Enter coordinates manually/ }));
    const s = await sizes(PHONE);
    expect(Object.keys(s).length).toBeGreaterThanOrEqual(7);
    expect(under16(s)).toEqual([]);
  });

  it('the new-customer form', async () => {
    const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];
    render(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    const s = await sizes(PHONE);
    expect(Object.keys(s).length).toBeGreaterThan(5);
    expect(under16(s)).toEqual([]);
  });

  // Too many server props to render here; every field in them names its own size.
  it.each(['app/(app)/customers/[id]/edit/EnrichmentForm.tsx', 'components/nmwc/BranchStatusActions.tsx'])(
    '%s',
    async (file) => {
      const els = jsxElements(readFileSync(file, 'utf8'), file).filter(
        (el) =>
          ['input', 'textarea', 'select'].includes(el.tag) &&
          !(el.attrs.type?.kind === 'string' && ['checkbox', 'radio', 'file', 'hidden'].includes(el.attrs.type.value))
      );
      expect(els.length).toBeGreaterThan(0);
      const classes = els.map((el) => (el.attrs.className?.kind === 'string' ? el.attrs.className.value : ''));
      const rules = await sizeRules(classes.join(' '));
      els.forEach((el, i) => {
        const div = document.createElement('div');
        div.className = classes[i]!;
        expect(fontPx(div, rules, PHONE), `${file}:${el.line}`).toBeGreaterThanOrEqual(16);
      });
    }
  );
});

describe('the customers filter bar, as a salesman sees it', () => {
  const props: CustomerFiltersClientProps = {
    initial: {
      q: '',
      status: '',
      region: [],
      route: [],
      channel: [],
      subChannel: [],
      supervisor: '',
      salesman: '',
      paymentTerms: '',
      minScore: '',
      maxScore: '',
      createdAfter: '',
      createdBefore: '',
      editedAfter: '',
      editedBefore: '',
    },
    flags: { showRegion: false, showRoute: false, showSupervisor: false, showSalesman: false, canExport: false },
    regions: [],
    routes: [],
    // Eight or more, so the channel popover has its search box.
    channels: Array.from({ length: 9 }, (_, i) => ({ id: `ch-${i}`, label: `Channel ${i}` })),
    subChannels: [],
    supervisors: [],
    salesmen: [],
    savedViews: [],
  };

  function renderAll() {
    render(<CustomerFiltersClient {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    // Last: opening anything else closes the popover.
    fireEvent.click(screen.getByRole('button', { name: /^Channels/ }));
  }

  it('every field is 16 px on a phone', async () => {
    renderAll();
    const s = await sizes(PHONE);
    // Search, status, the channel search, two scores, payment terms, four dates, the view name.
    expect(Object.keys(s).length).toBeGreaterThanOrEqual(11);
    expect(under16(s)).toEqual([]);
  });

  it('and the same size as before from the sm breakpoint up', async () => {
    renderAll();
    const s = await sizes(DESKTOP);
    // The search box was already text-base everywhere; the rest were text-sm.
    const [search, ...rest] = Object.values(s);
    expect(search).toBe(16);
    expect(rest.every((px) => px === 14), JSON.stringify(s)).toBe(true);
  });
});

describe('the channel and route pickers on their own', () => {
  it('the search box is 16 px on a phone and 14 px from sm up', async () => {
    render(
      <MultiSelectFilter
        label="Routes"
        value={[]}
        onChange={() => {}}
        options={Array.from({ length: 9 }, (_, i) => ({ value: `r${i}`, label: `Route ${i}` }))}
        allLabel="All routes"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    const box = screen.getByRole('textbox', { name: 'Search routes' });
    expect(Object.values(await sizes(PHONE, [box]))).toEqual([16]);
    expect(Object.values(await sizes(DESKTOP, [box]))).toEqual([14]);
  });
});
