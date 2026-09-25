/**
 * Benchmark items 36–40: the field app on a phone.
 *
 *   36  phone fields opened a QWERTY keyboard, not the dial pad
 *   37  the approver's review screen collapsed on a phone
 *   38  every table was clipped or panned the whole page on a phone
 *   39  the cooler −/+ buttons were 26×26 px
 *   40  no tap-to-call and no directions link anywhere
 *
 * Where it can, this file proves behaviour on real markup: the approval review
 * page and the customer profile are rendered here, with their database and
 * session mocked, so the layout rules are checked on what the pages actually
 * emit rather than on their source text. Tailwind is compiled with the repo's
 * own config where a class only matters if it produces the CSS it is meant to.
 * Structural guards read elements through the TypeScript parser
 * (tests/support/jsx-ast.ts), never line by line.
 *
 * What only a real browser proves — pixel widths — was measured in Chromium on
 * this same rendered markup and compiled CSS, inside the app layout's wrapper,
 * at 320/360/412/768/800/1024/1280 px: no page wider than the viewport, the
 * Approve bar edge to edge, 44×44 stepper buttons, the three-up stepper grid
 * only from lg. It also showed why TableScroll needs contain:inline-size:
 * under a block parent, a 651 px table without it widened a 360 px page to
 * 683 px. This file pins the rules those measurements depend on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { stripComments } from '../support/strip-comments';
import { jsxElements, type JsxEl } from '../support/jsx-ast';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';
import { LabeledField } from '@/components/nmwc/LabeledField';
import { StepperInput } from '@/components/nmwc/StepperInput';
import { TableScroll, TABLE_SCROLL_CLASSES } from '@/components/nmwc/TableScroll';
import { LocationLinks, PhoneLink } from '@/components/nmwc/ContactLinks';
import { directionsHref, mapPinHref, telHref } from '@/lib/contact-links';
import { manualGpsMarker, markManualGps, type FieldChange } from '@/lib/gps-manual';

/* ------------------------------------------------------------------------- *
 * Mocks for rendering the approval review page and the customer profile (37, 40).
 * ------------------------------------------------------------------------- */
const db = vi.hoisted(() => ({
  role: 'GM',
  edit: null as unknown,
  branches: [] as unknown[],
  customer: null as unknown,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u-gm', role: db.role, username: 'gm.nmwc' } }),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ managedRegionIds: [] }),
  canSeeCustomer: () => true,
  filterBranchesByScope: (_u: unknown, branches: unknown[]) => branches,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customer: { findFirst: async () => db.customer },
    customerEdit: { findUnique: async () => db.edit },
    branch: { findMany: async () => db.branches },
    attachment: { findMany: async () => [] },
    channel: { findMany: async () => [] },
    subChannel: { findMany: async () => [] },
  },
}));
vi.mock('@/app/(app)/approvals/[id]/ApproveRejectActions', () => ({
  ApproveRejectActions: () => <div data-testid="actions">actions</div>,
}));
vi.mock('@/app/(app)/customers/[id]/ArchiveCustomerButton', () => ({
  ArchiveCustomerButton: () => <button type="button">Archive</button>,
}));
vi.mock('@/components/nmwc/BranchStatusActions', () => ({ BranchStatusActions: () => null }));

afterEach(() => {
  cleanup();
  db.role = 'GM';
});

const LONG = 'https://example.org/a-very-long-unbreakable-token-pasted-by-a-salesman-0123456789';
const AT = new Date('2026-09-24T08:15:00.000Z');

function updateEdit() {
  return {
    id: 'e1',
    process: 'UPDATE',
    state: 'SUBMITTED',
    currentStepIndex: 0,
    approvalChain: [{ role: 'MANAGER' }, { role: 'GM' }],
    decisionReason: null,
    reviewedAt: null,
    reviewedBy: null,
    submittedBy: { id: 'u1', fullName: 'Salesman One', supervisorId: null },
    customerDraft: null,
    branchDrafts: [],
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    steps: [
      {
        id: 's1',
        decision: 'APPROVED',
        role: 'MANAGER',
        actor: { fullName: 'Manager One' },
        reason: LONG,
        at: AT,
        cycle: 1,
      },
    ],
    customer: {
      id: 'c1',
      legalName: 'Muscat Pearl Foodstuff Trading & Contracting Est.',
      nmwcCode: 'NMWC-000123',
      crPhotoId: null,
      branches: [
        {
          id: 'b1',
          branchName: 'Main',
          branchCode: 'B-01',
          address: 'Ruwi',
          gpsLat: 23.5,
          gpsLng: 58.3,
          gpsAccuracy: 8,
          gpsCapturedAt: AT,
          shopPhotoId: null,
          signboardPhotoId: null,
          routeId: 'r1',
          regionId: 'g1',
          deletedAt: null,
          route: { code: 'C4' },
        },
      ],
    },
    fieldChanges: [
      { field: 'customer.primaryPhone', before: '+96891234567', after: '+96895551234' },
      { field: 'customer.altPhone', before: '+96891112222', after: '+96893334444' },
      { field: 'customer.notes', before: null, after: LONG },
      { field: 'branch.b1.gpsLat', before: 23.5, after: 23.588123 },
      { field: 'branch.b1.gpsLng', before: 58.3, after: 58.3829 },
    ],
  };
}

function createEdit() {
  return {
    ...updateEdit(),
    process: 'CREATE',
    state: 'APPROVED',
    decisionReason: LONG,
    reviewedAt: AT,
    reviewedBy: { fullName: 'GM One' },
    customer: null,
    fieldChanges: [],
    customerDraft: {
      legalName: 'Al Noor Trading',
      crNumber: '1234567',
      paymentTerms: 'CASH',
      channel: { label: 'Retail' },
      subChannel: null,
      primaryPhone: '+968 9555 1234',
      altPhone: '+968 9123 4567',
      contactPerson: 'Ali',
      contactRole: null,
      notes: null,
      crPhotoAttachmentId: null,
    },
    branchDrafts: [
      {
        id: 'd1',
        branchName: 'Seeb',
        region: { name: 'Muscat' },
        route: { code: 'C7', regionId: 'g1' },
        address: 'Seeb souq',
        areaDescription: null,
        gpsLat: 23.67,
        gpsLng: 58.19,
        gpsAccuracy: 5,
        dayOfVisit: 'SUN',
        openingHours: null,
        deliveryWindow: null,
        coolersCount: 1,
        standsCount: 0,
        emptyBottlesCount: 2,
        shopPhotoAttachmentId: null,
        signboardPhotoAttachmentId: null,
        extraPhotoAttachmentIds: [],
      },
    ],
  };
}

async function renderReview(edit: unknown, branches: unknown[] = []) {
  db.edit = edit;
  db.branches = branches;
  const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
  return render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
}

/** Every class token on every element under `root`. */
function classTokens(root: Element): string[] {
  return [...root.querySelectorAll('[class]')].flatMap((el) =>
    (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  );
}

/* ------------------------------------------------------------------------- *
 * Tailwind, compiled with the repo's config, for the classes that must emit.
 * ------------------------------------------------------------------------- */
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

/* ------------------------------------------------------------------------- *
 * Source helpers for the structural guards. Comments are blanked by the
 * TypeScript parser (tests/support/strip-comments.ts), lines kept in place.
 * ------------------------------------------------------------------------- */
const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith('.tsx') ? [p.replace(/\\/g, '/')] : [];
  });
}
const UI_FILES = [...tsxFiles('app'), ...tsxFiles('components')];
/** Every JSX element in the UI, read by the parser — independent of line breaks and comments. */
const UI_ELEMENTS: Array<JsxEl & { file: string }> = UI_FILES.flatMap((f) =>
  jsxElements(readFileSync(f, 'utf8'), f).map((el) => ({ ...el, file: f }))
);
const str = (el: JsxEl, name: string) => (el.attrs[name]?.kind === 'string' ? el.attrs[name].value : undefined);

/* ========================================================================= */

describe('36 — phone fields open the dial pad', () => {
  it('LabeledField passes type=tel and autocomplete=off to the input, and no inputmode', () => {
    render(<LabeledField label="Primary phone *" value="" onChange={() => {}} type="tel" autoComplete="off" />);
    const input = screen.getByLabelText('Primary phone *');
    expect(input.getAttribute('type')).toBe('tel');
    expect(input.getAttribute('autocomplete')).toBe('off');
    // inputmode=numeric or decimal would take the '+' away from the pad.
    expect(input.getAttribute('inputmode')).toBeNull();
  });

  it('every phone field in the app, and only those, is type="tel"', () => {
    // An EXACT list, not a floor: a new phone field must be added here, and a
    // renamed or moved one must be found again — a count would miss a regressed
    // field hidden behind a new correct one.
    const EXPECTED = [
      'app/(app)/customers/[id]/edit/EnrichmentForm.tsx|Alt phone',
      'app/(app)/customers/[id]/edit/EnrichmentForm.tsx|Primary phone *',
      'app/(app)/customers/new/CreateCustomerForm.tsx|Alt phone',
      'app/(app)/customers/new/CreateCustomerForm.tsx|Primary phone *',
      'app/(app)/users/CreateUserForm.tsx|Phone (optional)',
    ];
    const found: string[] = [];
    // Every *Field element, from the parser: a regex stopped at the `>` of any
    // `onChange={(v) => …}` and never saw 10 of the 29 fields.
    const fields = UI_ELEMENTS.filter((el) => /Field$/.test(el.tag));
    expect(fields.length, 'the parser found the form fields').toBeGreaterThan(25);
    for (const el of fields) {
      const where = `${el.file}:${el.line}`;
      const label = str(el, 'label');
      // A computed label could hide a phone field from this list.
      expect(el.attrs.label === undefined || label !== undefined, `${where} — give the Field a literal label`).toBe(true);
      if (!label || !/phone|mobile|whats\s*app/i.test(label)) continue;
      found.push(`${el.file}|${label}`);
      expect(str(el, 'type'), `${where} "${label}" must open the dial pad`).toBe('tel');
      expect(el.attrs.inputMode, `${where} "${label}"`).toBeUndefined();
      // The customer forms have no form-level opt-out; the admin form does
      // (users-autofill-guard.test.ts), so there the field-level one is optional.
      if (!el.file.includes('CreateUserForm')) {
        expect(str(el, 'autoComplete'), `${where} "${label}" must not offer the device owner's number`).toBe('off');
      }
    }
    expect(found.sort()).toEqual(EXPECTED);
  });
});

describe('37 + 40 — the approval review page, rendered', () => {
  it('uses no fixed column template below 640px, no bare 1fr track, and no negative margin', async () => {
    const { container } = await renderReview(updateEdit(), [{ id: 'b1', branchName: 'Main', route: { code: 'C4' } }]);
    const tokens = classTokens(container);
    expect(tokens.length, 'the page rendered').toBeGreaterThan(50);
    // A fixed template only behind a breakpoint: on a phone every grid is fluid.
    expect(tokens.filter((c) => /^grid-cols-\[/.test(c))).toEqual([]);
    // Any arbitrary template, once minmax(0,1fr) is removed, has no bare 1fr:
    // a bare 1fr has an `auto` minimum, and the longest word sets the width.
    const bare = tokens.filter((c) => /grid-cols-\[/.test(c) && /1fr/.test(c.replace(/minmax\(0,1fr\)/g, '')));
    expect(bare).toEqual([]);
    // The action bar was -mx-4 inside a parent with no padding: wider than the screen.
    expect(tokens.filter((c) => /(^|:)-mx-/.test(c))).toEqual([]);
    expect(screen.getByTestId('actions')).toBeTruthy();
  });

  it('lets long values wrap instead of widening the page', async () => {
    const { container } = await renderReview(updateEdit(), [{ id: 'b1', branchName: 'Main', route: { code: 'C4' } }]);
    const sections = [...container.querySelectorAll('section')];
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) expect(s.className).toContain('[overflow-wrap:anywhere]');
    // The step history stacks on a phone instead of squeezing the reason.
    const step = screen.getByText(/at MANAGER step by Manager One/).closest('li')!;
    expect(step.className).toMatch(/\bflex-col\b/);
    expect(step.className).toMatch(/\bsm:flex-row\b/);
  });

  it('makes the phone numbers in a diff tap-to-call, showing the stored value exactly', async () => {
    await renderReview(updateEdit(), [{ id: 'b1', branchName: 'Main', route: { code: 'C4' } }]);
    const after = screen.getByRole('link', { name: '+96895551234' });
    expect(after.getAttribute('href')).toBe('tel:+96895551234');
    expect(screen.getByRole('link', { name: '+96891234567' }).getAttribute('href')).toBe('tel:+96891234567');
    // The alt phone dials too, before and after.
    expect(screen.getByRole('link', { name: '+96891112222' }).getAttribute('href')).toBe('tel:+96891112222');
    expect(screen.getByRole('link', { name: '+96893334444' }).getAttribute('href')).toBe('tel:+96893334444');
    // The go-live walk's strict text match still finds the value.
    expect(screen.getByText('+96895551234')).toBeTruthy();
  });

  it('gives the proposed location and the location on file a Directions link each', async () => {
    await renderReview(updateEdit(), [{ id: 'b1', branchName: 'Main', route: { code: 'C4' } }]);
    const directions = screen.getAllByRole('link', { name: /^directions$/i }).map((a) => a.getAttribute('href'));
    expect(directions.sort()).toEqual([
      'https://www.google.com/maps/dir/?api=1&destination=23.500000,58.300000',
      'https://www.google.com/maps/dir/?api=1&destination=23.588123,58.382900',
    ]);
    // The labels the go-live walk looks for are unchanged, and each pin goes to its
    // own point — the proposed one and the one on file, latitude first.
    expect(screen.getByRole('link', { name: /view proposed location on map/i }).getAttribute('href')).toBe(
      'https://www.google.com/maps?q=23.588123,58.382900'
    );
    expect(screen.getByRole('link', { name: /open in google maps/i }).getAttribute('href')).toBe(
      'https://www.google.com/maps?q=23.500000,58.300000'
    );
  });

  it('on a new-customer request: the phone dials, the branch has Directions, the decision wraps', async () => {
    const { container } = await renderReview(createEdit());
    expect(screen.getByRole('link', { name: '+968 9555 1234' }).getAttribute('href')).toBe('tel:+96895551234');
    expect(screen.getByRole('link', { name: '+968 9123 4567' }).getAttribute('href')).toBe('tel:+96891234567');
    const branch = screen.getByRole('heading', { name: /Branch 1: Seeb/ }).closest('section')!;
    expect(within(branch).getByRole('link', { name: /^directions$/i }).getAttribute('href')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=23.670000,58.190000'
    );
    expect(within(branch).getByRole('link', { name: /open in maps/i }).getAttribute('href')).toBe(
      'https://www.google.com/maps?q=23.670000,58.190000'
    );
    const banner = screen.getByText(/Decision:/).closest('div')!;
    expect(banner.className).toContain('[overflow-wrap:anywhere]');
    expect(classTokens(container).filter((c) => /^grid-cols-\[/.test(c))).toEqual([]);
  });

  it('emits the label/value columns from 640px, compiled from what the page renders', async () => {
    // The classes come from the rendered page, not from a list typed here: a
    // dropped or malformed sm: template shows up as missing CSS.
    const { container } = await renderReview(updateEdit(), [{ id: 'b1', branchName: 'Main', route: { code: 'C4' } }]);
    const out = await css([...new Set(classTokens(container))].join(' '));
    const from640 = out.slice(out.indexOf('@media (min-width: 640px)'));
    expect(out.indexOf('@media (min-width: 640px)'), 'sm: rules exist').toBeGreaterThan(0);
    const beforeMd = from640.split('@media (min-width: 768px)')[0]!;
    expect(beforeMd).toMatch(/grid-template-columns: 140px minmax\(0,1fr\);? \}/);
    expect(beforeMd).toContain('grid-template-columns: 140px minmax(0,1fr) minmax(0,1fr)');
    expect(out).toContain('overflow-wrap: anywhere');
    // On a phone the diff label spans both value columns, so Before and After share a row.
    const label = screen.getByText('primaryPhone');
    expect(label.className.split(/\s+/)).toEqual(expect.arrayContaining(['col-span-2', 'sm:col-span-1']));
    expect(label.parentElement!.className.split(/\s+/)).toContain('grid-cols-2');
  });
});

describe('37 — the approvals queue on a phone', () => {
  it('uses a minmax(0,1fr) track and moves the pills under the name', () => {
    const src = read('app/(app)/approvals/BulkApprovalQueue.tsx');
    // grid-cols-1 = repeat(1,minmax(0,1fr)); the implicit `auto` track let each
    // card's nowrap name set the page width (563px on a 360px phone).
    expect(src).toMatch(/<ul className="grid grid-cols-1 gap-3/);
    expect(src).toMatch(/className="flex min-w-0 flex-1 flex-wrap items-start gap-3 sm:flex-nowrap"/);
    expect(src).toMatch(/basis-\[calc\(100%-56px\)\] sm:basis-0/);
  });
});

describe('41 — the approver sees a point that was typed in by hand', () => {
  const REASON = 'Phone GPS broken; read the point off Google Maps.';
  const branches = [{ id: 'b1', branchName: 'Main', route: { code: 'C4' } }];

  it('UPDATE: a note with the reason beside the proposed location, and no raw marker rows', async () => {
    const edit = updateEdit();
    markManualGps(edit.fieldChanges as FieldChange[], REASON);
    const { container } = await renderReview(edit, branches);
    const note = screen.getByText(/Location typed in by hand/).closest('p')!;
    expect(note.textContent).toContain(REASON);
    // It sits in the branch's own section, with the proposed-location link.
    const section = note.closest('section')!;
    expect(within(section).getByRole('link', { name: /view proposed location on map/i })).toBeTruthy();
    // The marker's keys are data, not rows.
    expect(container.textContent).not.toMatch(/gpsSource|gpsManualReason|MANUAL/);
  });

  it('UPDATE, two branches: the note sits only in the section of the branch that was typed', async () => {
    const edit = updateEdit();
    const b2 = { ...edit.customer.branches[0]!, id: 'b2', branchName: 'Second shop', branchCode: 'B-02' };
    edit.customer.branches.push(b2);
    const second: FieldChange[] = [
      { field: 'branch.b2.gpsLat', before: 23.4, after: 23.41 },
      { field: 'branch.b2.gpsLng', before: 58.2, after: 58.21 },
    ];
    markManualGps(edit.fieldChanges as FieldChange[], REASON); // b1 typed; b2 a device fix
    edit.fieldChanges.push(...(second as typeof edit.fieldChanges));
    await renderReview(edit, [...branches, { id: 'b2', branchName: 'Second shop', route: { code: 'C4' } }]);
    const notes = screen.getAllByText(/Location typed in by hand/);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.closest('section')!.textContent).toContain('Branch: Main');
    expect(notes[0]!.closest('section')!.textContent).not.toContain('Second shop');
  });

  it('UPDATE: nothing when the point came from the device', async () => {
    await renderReview(updateEdit(), branches);
    expect(screen.queryByText(/Location typed in by hand/)).toBeNull();
  });

  it("CREATE: the note on the draft branch whose point it is, and not on another point's", async () => {
    const edit = { ...createEdit(), fieldChanges: [manualGpsMarker(0, 23.67, 58.19, REASON)] };
    await renderReview(edit);
    const branch = screen.getByRole('heading', { name: /Branch 1: Seeb/ }).closest('section')!;
    expect(within(branch).getByText(/Location typed in by hand/).closest('p')!.textContent).toContain(REASON);
    cleanup();
    await renderReview({ ...createEdit(), fieldChanges: [manualGpsMarker(0, 23.5, 58.19, REASON)] });
    expect(screen.queryByText(/Location typed in by hand/)).toBeNull();
  });
});

describe('38 — tables scroll inside themselves', () => {
  it('TableScroll is a named, focusable region that scrolls and contains its width', () => {
    render(
      <TableScroll label="Accounts" className="overflow-hidden rounded-lg">
        <table>
          <tbody>
            <tr>
              <td>x</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
    );
    const region = screen.getByRole('region', { name: 'Accounts' });
    expect(region.getAttribute('tabindex')).toBe('0');
    // A caller's overflow-hidden is dropped, not the scroller. tailwind-merge alone
    // keeps both (different groups) — this test caught that assumption.
    expect(region.className).toContain('overflow-x-auto');
    expect(region.className).not.toContain('overflow-hidden');
    expect(region.className).toContain('[contain:inline-size]');
    expect(region.className).toContain('w-full');
  });

  it('its classes compile to the CSS that does the work', async () => {
    const out = await css(TABLE_SCROLL_CLASSES);
    expect(out).toContain('overflow-x: auto');
    // Without this the table's width still reaches the layout column and the
    // whole page pans — the part overflow-x-auto alone does not fix.
    expect(out).toContain('contain: inline-size');
    expect(out).toContain('width: 100%');
  });

  it('every <table> in the app sits directly inside a TableScroll', () => {
    // From the parser: the nearest enclosing element, however `npm run format`
    // lays out the opening tag.
    const tables = UI_ELEMENTS.filter((el) => el.tag === 'table');
    for (const t of tables) {
      expect(t.parentTag, `${t.file}:${t.line} — wrap the table in <TableScroll>`).toBe('TableScroll');
    }
    // The seven that exist today. Without this the loop can pass on nothing.
    expect(tables).toHaveLength(7);
  });
});

describe('39 — the stepper buttons are 44×44', () => {
  it('both buttons and the number field carry the 44px size classes', () => {
    render(<StepperInput name="coolers" label="Coolers" value={1} onChange={() => {}} />);
    for (const name of ['Decrease Coolers', 'Increase Coolers']) {
      const b = screen.getByRole('button', { name });
      // flex, so the declared height and width apply (an inline box ignores them).
      for (const c of ['flex', 'h-11', 'w-11', 'shrink-0']) expect(b.className.split(/\s+/), `${name}: ${c}`).toContain(c);
      expect(b.className).not.toMatch(/\bp-1\b/);
    }
    expect(screen.getByRole('spinbutton', { name: 'Coolers' }).className.split(/\s+/)).toContain('h-11');
  });

  it('h-11 and w-11 are 44px in this config', async () => {
    const out = await css('h-11 w-11');
    expect(out).toContain('height: 2.75rem');
    expect(out).toContain('width: 2.75rem');
  });

  it('the root font size is left at 16px, so 2.75rem is 44px', async () => {
    // Compiled, not grepped: `:root { font-size }` or `html { @apply text-sm }`
    // both change rem without the words "html" and "font-size" being adjacent.
    const src = readFileSync('app/globals.css', 'utf8');
    const root = (
      await postcss([tailwindcss({ ...tailwindConfig, content: [{ raw: '<div class="h-11"></div>', extension: 'html' }] })]).process(
        src,
        { from: 'app/globals.css' }
      )
    ).root;
    const offenders: string[] = [];
    let rootRules = 0;
    root.walkRules((rule) => {
      if (!rule.selectors.some((s) => /(^|[\s,])(html|:root)\b/.test(s.trim()))) return;
      rootRules += 1;
      rule.walkDecls(/^font(-size)?$/, (d) => {
        offenders.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
      });
    });
    expect(rootRules, 'globals.css was compiled and its root rules seen').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    // Nor a text-size utility on the <html> element itself.
    const html = jsxElements(readFileSync('app/layout.tsx', 'utf8'), 'app/layout.tsx').find((el) => el.tag === 'html');
    expect(html, 'app/layout.tsx renders <html>').toBeTruthy();
    const htmlClass = html!.attrs.className;
    expect(htmlClass?.kind === 'expression' ? htmlClass.text : str(html!, 'className') ?? '').not.toMatch(
      /\btext-(xs|sm|base|lg|[0-9]*xl|\[)/
    );
  });

  it('three steppers share a row only from lg, where each cell can hold one', () => {
    for (const f of ['app/(app)/customers/[id]/edit/EnrichmentForm.tsx', 'app/(app)/customers/new/CreateCustomerForm.tsx']) {
      const src = read(f);
      const grid = /<div className="([^"]*)">\s*<StepperInput/.exec(src)?.[1] ?? '';
      expect(grid, f).toBe('grid gap-2 lg:grid-cols-3');
    }
  });
});

describe('40 — tap-to-call and directions', () => {
  it('telHref normalises to E.164, and refuses what is not one Oman number', () => {
    expect(telHref('+968 9555 1234')).toBe('tel:+96895551234');
    expect(telHref('9555 1234')).toBe('tel:+96895551234');
    expect(telHref('00968 9555 1234')).toBe('tel:+96895551234');
    expect(telHref('12345')).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it('map links use six decimals and refuse impossible coordinates', () => {
    expect(mapPinHref(23.588123, 58.3829)).toBe('https://www.google.com/maps?q=23.588123,58.382900');
    expect(directionsHref(23.588123, 58.3829)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=23.588123,58.382900'
    );
    expect(directionsHref(null, 58)).toBeNull();
    expect(directionsHref(123, 58)).toBeNull();
    expect(directionsHref(Number.NaN, 58)).toBeNull();
  });

  it('PhoneLink shows the stored value exactly, and plain text when it cannot dial it', () => {
    render(<PhoneLink phone="+968 9555 1234" />);
    const a = screen.getByRole('link', { name: '+968 9555 1234' });
    expect(a.getAttribute('href')).toBe('tel:+96895551234');
    expect(a.getAttribute('target')).toBeNull();
    cleanup();
    render(<PhoneLink phone="ask the owner" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('ask the owner')).toBeTruthy();
  });

  it('LocationLinks gives a pin and Directions, both 44px, opening safely in a new tab', () => {
    render(<LocationLinks lat={23.5} lng={58.3} pinLabel="Open in Maps" />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Open in Maps', 'Directions']);
    // Each goes to the point it names, latitude first — (58.3, 23.5) is in Pakistan.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.google.com/maps?q=23.500000,58.300000',
      'https://www.google.com/maps/dir/?api=1&destination=23.500000,58.300000',
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.className).toContain('min-h-[44px]');
    }
    cleanup();
    const { container } = render(<LocationLinks lat={null} lng={58.3} />);
    expect(container.innerHTML).toBe('');
  });

  it('the customer profile, rendered: phones dial, and the map chips get a line of their own', async () => {
    const branch = (i: number) => ({
      id: `b${i}`, branchName: `Branch ${i}`, branchCode: `B-0${i}`, address: 'Way 3021, Al Khuwair',
      gpsLat: 23.5 + i / 10, gpsLng: 58.3, gpsAccuracy: 8, dayOfVisit: 'SUN', openingHours: null, deliveryWindow: null,
      coolersCount: 2, standsCount: 1, emptyBottlesCount: 12, completenessScore: 60, status: 'ACTIVE',
      region: { name: 'MCT GT' }, route: { name: 'C4' }, shopPhoto: null, signboardPhoto: null,
    });
    db.customer = {
      id: 'c1', legalName: 'Al Maha Foodstuff', nmwcCode: 'NMWC-018702', paymentTerms: 'CREDIT', status: 'ACTIVE',
      completenessScore: 72, crNumber: null, notes: LONG, crPhoto: null, channel: null, subChannel: null,
      primaryPhone: '+96891234567', altPhone: '+968 9555 1234', contactPerson: null, contactRole: null,
      branches: [branch(1), branch(2)], edits: [],
    };
    // A manager: the role that sees every header control, Archive included.
    db.role = 'MANAGER';
    const { default: Page } = await import('@/app/(app)/customers/[id]/page');
    const { container } = render(await Page({ params: Promise.resolve({ id: 'c1' }) }));

    expect(screen.getByRole('link', { name: '+96891234567' }).getAttribute('href')).toBe('tel:+96891234567');
    expect(screen.getByRole('link', { name: '+968 9555 1234' }).getAttribute('href')).toBe('tel:+96895551234');

    const articles = [...container.querySelectorAll('article')];
    expect(articles).toHaveLength(2);
    articles.forEach((article, i) => {
      const maps = [...article.querySelectorAll('a[href*="google.com/maps"]')];
      expect(maps.map((a) => a.getAttribute('href'))).toEqual([
        `https://www.google.com/maps?q=${(23.5 + (i + 1) / 10).toFixed(6)},58.300000`,
        `https://www.google.com/maps/dir/?api=1&destination=${(23.5 + (i + 1) / 10).toFixed(6)},58.300000`,
      ]);
      // Not inside a Row's value: from md the cards are two-up beside the sidebar
      // and that column is ~60px at 768, so the 44px chips spilled under the next card.
      for (const a of maps) expect(a.closest('dd'), 'chips outside the Row value').toBeNull();
    });

    // Every Row track is fluid: no bare 1fr, whose auto minimum lets a long value widen the page.
    const bare = classTokens(container).filter((c) => /grid-cols-\[/.test(c) && /1fr/.test(c.replace(/minmax\(0,1fr\)/g, '')));
    expect(bare).toEqual([]);
    // The header's actions wrap: a manager's five controls are wider than a 360px phone.
    const archive = screen.getByRole('button', { name: 'Archive' });
    expect(archive.parentElement!.className.split(/\s+/)).toContain('flex-wrap');
  });

  it('no page builds a maps URL by hand, and the phone displays use PhoneLink', () => {
    // UI, and the server code that writes links into workbooks: the data-residency
    // register says every Google Maps link is built in lib/contact-links.ts.
    const tsFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name).replace(/\\/g, '/');
        if (statSync(p).isDirectory()) return tsFiles(p);
        return /\.tsx?$/.test(p) ? [p] : [];
      });
    const files = [...UI_FILES, ...tsFiles('lib'), ...tsFiles('services')].filter((f) => f !== 'lib/contact-links.ts');
    expect(files).toContain('lib/change-report.ts');
    for (const f of files) {
      expect(read(f), `${f} — use lib/contact-links.ts`).not.toContain('google.com/maps');
    }
    expect(read('app/(app)/customers/[id]/page.tsx')).toMatch(/<PhoneLink phone=\{customer\.primaryPhone\}/);
    expect(read('app/(app)/customers/[id]/page.tsx')).toMatch(/<PhoneLink phone=\{customer\.altPhone\}/);
    expect(read('app/(app)/customers/[id]/page.tsx')).toMatch(/<LocationLinks lat=\{b\.gpsLat\} lng=\{b\.gpsLng\}/);
    expect(read('app/(app)/duplicates/page.tsx')).toMatch(/<PhoneLink phone=\{side\.primaryPhone\}/);
  });
});
