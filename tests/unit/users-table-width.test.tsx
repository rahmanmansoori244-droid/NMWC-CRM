/**
 * Production walk 2026-10-09: on /users the row actions were off screen.
 *
 * What was wrong: the accounts table sat in a scroll box beside the Create user
 * panel. At 1920 px the box was 888 px wide (the app layout stops growing at
 * 1536) and the table 958 px, so Edit, Enable and Reset password sat past the
 * box's right edge — the owner could not find Enable on the Disabled tab
 * without scrolling the table sideways. At 1280 the box was 632 px.
 *
 * The fix, measured in Chromium on this page's rendered markup and compiled CSS
 * (inside the app layout's wrapper, at 375/1280/1366/1440/1920 px, Active,
 * Disabled and All, with launch-e2e-length names and codes, and with an e-mail
 * and a reset box open): the panel sits below the table at every width, so the
 * table's box is 991 px at 1280 and 1264 from 1536; long names, usernames and
 * codes wrap inside their cells above a floor; the role and username break at
 * their separators; buttons never wrap inside themselves; an open box fits its
 * column. The narrowest the table then gets is 920 px (948 with a box open), so
 * it fits its box at 1280, 1366, 1440 and 1920; at 375 it scrolls inside its own
 * box, as before, and the page does not.
 *
 * jsdom has no layout, so this file pins the choices those measurements rest on
 * — and fails when one changes, so the change is measured again — and compiles
 * the arbitrary classes, which Tailwind drops silently when they are mistyped.
 * The browser check is in tests/e2e/launch/accounts-auth.spec.ts (section 20).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '@/tailwind.config';

const h = vi.hoisted(() => ({
  user: { id: 'stw', role: 'STEWARD', username: 'data.steward' },
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/services/users', () => ({
  updateUserAccountAction: vi.fn(),
  createUserAction: vi.fn(),
  toggleUserActiveAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  updateUserEmailAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g-mct'] }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
/** Prisma's `select`, applied: only the selected keys come back. */
function project(
  row: Record<string, unknown>,
  select: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const nested = row[k] as
        Record<string, unknown> | Array<Record<string, unknown>> | null | undefined;
      const inner = (v as { select: Record<string, unknown> }).select;
      out[k] =
        nested == null
          ? nested
          : Array.isArray(nested)
            ? nested.map((n) => project(n, inner))
            : project(nested, inner);
    }
  }
  return out;
}
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: async (args: { select: Record<string, unknown> }) =>
        h.rows.map((r) => project(r, args.select)),
    },
    route: { findMany: async () => [] },
    region: { findMany: async () => [] },
  },
}));

import UsersPage from '@/app/(app)/users/page';

vi.setConfig({ testTimeout: 30_000 });

const account = (id: string, role: string, over: Record<string, unknown> = {}) => ({
  id,
  username: id,
  fullName: `Person ${id}`,
  role,
  isActive: true,
  lastLoginAt: null,
  mustChangePassword: false,
  email: null,
  phone: null,
  ownedRouteId: null,
  supervisorId: null,
  supervisor: null,
  ownedRoute: null,
  reports: [],
  managedRegions: [],
  ...over,
});

// A launch e2e world's lengths: a 16-character suffix, a 20-character route code.
const SFX = 'auwk3j9x2m1q0p4d';
beforeEach(() => {
  h.user = { id: 'stw', role: 'STEWARD', username: 'data.steward' };
  h.rows = [
    account('stw', 'STEWARD', { username: 'data.steward' }),
    account('fm', 'FINANCE_MANAGER', { username: 'qa.finance.manager', isActive: false }),
    account('mgr', 'MANAGER', {
      username: `e2e.m1.${SFX}`,
      fullName: `Manager M1 ${SFX}`,
      managedRegions: [{ id: 'g-mct', code: `E2R${SFX.toUpperCase()}1` }],
    }),
    account('sal', 'SALESMAN', {
      username: `e2${SFX}1`,
      fullName: `Salesman SA ${SFX}`,
      supervisorId: 'mgr',
      supervisor: { fullName: `Manager M1 ${SFX}`, username: `e2e.m1.${SFX}`, isActive: true },
      ownedRouteId: 'r1',
      ownedRoute: {
        code: `E2${SFX.toUpperCase()}1`,
        name: 'Route',
        regionId: 'g-mct',
        region: { code: `E2R${SFX.toUpperCase()}1` },
      },
    }),
  ];
});
afterEach(cleanup);

const renderPage = async (status = 'all') =>
  render(await UsersPage({ searchParams: Promise.resolve({ status }) }));
const classes = (el: Element) => el.className.split(/\s+/).filter(Boolean);
const rowOf = (container: HTMLElement, username: string) =>
  [...container.querySelectorAll('tbody tr')].find(
    (tr) => tr.querySelectorAll('td')[1]?.textContent === username
  ) as HTMLElement;

/** Compiles `classes` with the repo's Tailwind config (utilities only). */
async function css(classList: string): Promise<string> {
  const out = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: `<div class="${classList}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  return out.css.replace(/\s+/g, ' ');
}

describe('/users — the Create user panel sits below the table at every width', () => {
  it('the grid has one column at every breakpoint, the table first and the panel after it', async () => {
    const { container } = await renderPage();
    const region = screen.getByRole('region', { name: 'Accounts' });
    const grid = region.parentElement!;
    expect(classes(grid)).toContain('grid');
    // Beside the table, at any breakpoint, the panel left the table 888 px at most.
    expect(classes(grid).filter((c) => /(^|:)grid-cols-/.test(c))).toEqual([]);
    const aside = container.querySelector('aside')!;
    expect(aside.parentElement).toBe(grid);
    expect(region.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(aside).getByRole('heading', { name: 'Create user' })).toBeTruthy();
  });

  it('the header links down to it, where the panel used to be seen', async () => {
    const { container } = await renderPage();
    const link = screen.getByRole('link', { name: 'Create user' });
    expect(link.getAttribute('href')).toBe('#create-user');
    expect(container.querySelector('aside')!.id).toBe('create-user');
    // Still one submit button of that name: the link is a link.
    expect(screen.getAllByRole('button', { name: 'Create user' })).toHaveLength(1);
  });
});

describe('/users — no value widens the table past its box', () => {
  it('names, usernames, Reports to, Route and Regions wrap above the measured floors; the rest keep theirs', async () => {
    const { container } = await renderPage();
    const cells = [...rowOf(container, `e2${SFX}1`).querySelectorAll('td')];
    expect(cells).toHaveLength(9);
    const floors = cells.map((td) => classes(td).find((c) => c.startsWith('min-w-')) ?? null);
    // These five, with px-3, are what the 920 px minimum was measured with
    // (page.tsx NAME_CELL). Widening one can push Enable off screen at 1280 again:
    // measure before changing this list.
    expect(floors).toEqual([
      'min-w-[7rem]', // Name
      'min-w-[8rem]', // Username
      null, // Role: breaks after its underscore
      'min-w-[7rem]', // Reports to
      'min-w-[4.5rem]', // Route
      'min-w-[4.5rem]', // Regions
      null, // Status: badges wrap between words
      null, // Last login: a date, never broken
      null, // the actions
    ]);
    for (const i of [0, 1, 3, 4, 5])
      expect(classes(cells[i]!), `cell ${i}`).toContain('[overflow-wrap:anywhere]');
    for (const i of [2, 6, 7, 8])
      expect(classes(cells[i]!), `cell ${i}`).not.toContain('[overflow-wrap:anywhere]');
    for (const cell of [...container.querySelectorAll('th, td')]) {
      expect(classes(cell), cell.textContent ?? '').toContain('px-3');
      expect(classes(cell)).not.toContain('px-4');
    }
  });

  it('the role and the username break after their separators, and read exactly as stored', async () => {
    const { container } = await renderPage();
    const fm = rowOf(container, 'qa.finance.manager');
    const [, username, role] = [...fm.querySelectorAll('td')];
    expect(username!.innerHTML).toBe('qa.<wbr>finance.<wbr>manager');
    expect(role!.innerHTML).toBe('FINANCE_<wbr>MANAGER');
    expect(role!.textContent).toBe('FINANCE_MANAGER');
    expect(username!.textContent).toBe('qa.finance.manager');
    // The launch suites find a row by its username cell's accessible name
    // (support/accounts-helpers.ts usersRow). Chromium computes it from the text,
    // a <wbr> adding nothing — checked with Playwright's getByRole on this markup.
    // jsdom's accessible-name library spaces a <wbr> out, so it is not asked here.
    // Nothing to break: no <wbr>.
    expect(rowOf(container, `e2${SFX}1`).querySelectorAll('td')[1]!.innerHTML).toBe(`e2${SFX}1`);
  });

  it('the floor, wrap and nowrap classes compile to the CSS that does the work', async () => {
    const out = await css(
      'min-w-[7rem] min-w-[8rem] min-w-[4.5rem] [overflow-wrap:anywhere] whitespace-nowrap'
    );
    expect(out).toContain('min-width: 7rem');
    expect(out).toContain('min-width: 8rem');
    expect(out).toContain('min-width: 4.5rem');
    expect(out).toContain('overflow-wrap: anywhere');
    expect(out).toContain('white-space: nowrap');
  });
});

describe('/users — the row actions wrap between buttons, and an open box fits its column', () => {
  it('Edit, Add e-mail, Enable and Reset password keep their words on one line', async () => {
    const { container } = await renderPage('disabled');
    const fm = rowOf(container, 'qa.finance.manager');
    for (const name of ['Edit', 'Add e-mail', 'Enable', 'Reset password']) {
      const b = within(fm).getByRole('button', { name });
      expect(classes(b), name).toContain('whitespace-nowrap');
    }
    const actions = within(fm).getByRole('button', { name: 'Enable' }).parentElement!;
    expect(classes(actions)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'justify-end']));
  });

  it('an open e-mail or reset box takes its own line and has no fixed width', async () => {
    const { container } = await renderPage('disabled');
    const fm = rowOf(container, 'qa.finance.manager');
    fireEvent.click(within(fm).getByRole('button', { name: 'Add e-mail' }));
    fireEvent.click(within(fm).getByRole('button', { name: 'Reset password' }));
    const forms = [...fm.querySelectorAll('form')];
    expect(forms).toHaveLength(2);
    for (const f of forms)
      expect(classes(f)).toEqual(expect.arrayContaining(['w-full', 'flex-wrap']));
    // A fixed w-56 box made the column 311 px and the table 1105 px at 1280.
    const inputs = [
      within(fm).getByLabelText('New e-mail for qa.finance.manager'),
      within(fm).getByLabelText('New password for qa.finance.manager'),
      within(fm).getByLabelText('Confirm new password for qa.finance.manager'),
    ];
    for (const input of inputs) {
      expect(
        classes(input).filter((c) => /^w-(?!full$)/.test(c)),
        input.getAttribute('aria-label')!
      ).toEqual([]);
    }
    expect(classes(inputs[0]!)).toContain('min-w-[7rem]');
    expect(classes(inputs[1]!.parentElement!)).toContain('min-w-[7rem]');
  });
});
