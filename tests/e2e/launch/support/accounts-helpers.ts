/**
 * Helpers for tests/e2e/launch/accounts-auth.spec.ts (sign-in, the password
 * rules, sessions, the role menus and /users). A NEW file on purpose: nothing in
 * the shared support files changes. Nothing here runs at import time.
 *
 * Two things every helper here keeps:
 *   - passwords go through fillSecret() and the password fields are emptied
 *     (clearSecretFields) before anything is asserted (README, "Passwords");
 *   - a context that signs in or changes a password carries ONE test address
 *     as x-forwarded-for on every request (contextAt). The sign-in made by a
 *     password change (services/password.ts renewOwnSession) and the login
 *     POST then charge the world's own `login:ip:` bucket, never the shared
 *     localhost one other spec files fail sign-ins against. No photo is uploaded
 *     from these contexts, so the header never reaches R2's CORS preflight.
 *
 * Alerts are always looked up inside `main` (or a form): Next's route announcer
 * is a role=alert element of its own on every page (app-router-announcer.js).
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import type { Role } from '@prisma/client';
import { omanDate, omanDateTime } from '../../../../lib/tz';
import { db } from './env';
import { HOME_BY_ROLE, clearSecretFields, contextAs, fillSecret } from './sessions';
import type { DeviceKind, FixtureUser } from './types';

export { omanDate, omanDateTime };

// ── passwords ────────────────────────────────────────────────────────────────

/**
 * A new password of the run's secret shape (E2e-<16>-9a), so the secret scan
 * (secret-scan.ts FIXTURE_PASSWORD_SHAPE) finds it if it ever leaks into a
 * report. Never logged, never typed with fill().
 */
export function freshPassword(): string {
  return `E2e-${randomBytes(12).toString('base64url')}-9a`;
}

/** Whether `plain` is the password one of the user's PasswordHistory rows holds. */
export async function historyHolds(userId: string, plain: string): Promise<boolean> {
  const rows = await db.passwordHistory.findMany({ where: { userId }, select: { hash: true } });
  for (const r of rows) if (await bcrypt.compare(plain, r.hash)) return true;
  return false;
}

/** Whether `plain` is the user's current password (read from the row, compared here). */
export async function passwordIs(userId: string, plain: string): Promise<boolean> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  return bcrypt.compare(plain, u.passwordHash);
}

// ── contexts and sign-in ─────────────────────────────────────────────────────

/**
 * contextAs() with every request of the context carrying `ip` as
 * x-forwarded-for (the login limiter's address). `u` null = signed out.
 */
export async function contextAt(
  browser: Browser,
  u: FixtureUser | null,
  ip: string,
  o: { device?: DeviceKind; lastCheck?: number } = {}
): Promise<BrowserContext> {
  return contextAs(browser, u, { ...o, ip, extra: { extraHTTPHeaders: { 'x-forwarded-for': ip } } });
}

/** /login, once React has hydrated the form (a tap before that is a native GET). */
export async function openLoginPage(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
}

/**
 * Types a username and password into the open login page and presses Sign in,
 * then waits for the server's answer to the login POST. The caller asserts the
 * outcome (the URL, or loginAlert()). The password field is emptied before
 * this returns.
 */
export async function submitLogin(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await fillSecret(page.getByLabel('Password'), password);
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/login',
    { timeout: 60_000 }
  );
  try {
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await answered;
  } finally {
    await clearSecretFields(page);
  }
}

/** The login form's refusal (scoped: the route announcer is a role=alert too). */
export function loginAlert(page: Page): Locator {
  return page.getByRole('main').getByRole('alert');
}

export const INVALID_LOGIN = 'Invalid username or password.';
export const ACCOUNT_LOCKED = 'Account temporarily locked due to repeated attempts. Try again in a minute.';
export const NETWORK_THROTTLED = /^Too many attempts from your network\. Try again in (\d+)s\.$/;

/**
 * Best-effort wait until the client app is interactive: no network for a
 * moment, and the app router's announcer (mounted in an effect after
 * hydration) is in the document.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.locator('next-route-announcer').waitFor({ state: 'attached', timeout: 30_000 }).catch(() => undefined);
}

/**
 * Reloads `path` until the session is refused (the page lands on /login): the
 * per-instance freshness cache (lib/auth.ts FRESH_TTL_MS, 30 s) decides when.
 */
export async function expectSignedOut(page: Page, path: string, timeout = 45_000): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(path, { waitUntil: 'load' });
        // A redirect streamed under a loading boundary lands a moment after load.
        await page.waitForURL((url) => url.pathname === '/login', { timeout: 2_000 }).catch(() => undefined);
        return new URL(page.url()).pathname;
      },
      { timeout, intervals: [3_000], message: `${path} should end on /login once the session is revoked` }
    )
    .toBe('/login');
}

/** The number of POST requests the page sends while `act` runs (and `settleMs` after). */
export async function postsDuring(page: Page, act: () => Promise<void>, settleMs = 1_500): Promise<number> {
  let n = 0;
  const on = (r: Request) => {
    if (r.method() === 'POST') n++;
  };
  page.on('request', on);
  try {
    await act();
    await page.waitForTimeout(settleMs);
  } finally {
    page.off('request', on);
  }
  return n;
}

/**
 * A middleware redirect to the change page, or the route's own 403
 * PASSWORD_CHANGE_REQUIRED — never an answer that did anything.
 */
export async function expectGateRefusal(res: APIResponse, what: string): Promise<void> {
  const status = res.status();
  if (status >= 300 && status < 400) {
    expect(res.headers()['location'] ?? '', `${what}: redirected to the change page`).toContain('/profile/change-password');
    return;
  }
  expect(status, `${what}: refused`).toBe(403);
  const json = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  expect(json.code ?? json.error, `${what}: the refusal names the password change`).toBe('PASSWORD_CHANGE_REQUIRED');
}

// ── pages ────────────────────────────────────────────────────────────────────

/** The landing page's h1 per role (lib/role-home.ts sends each role there). */
export const HOME_HEADING: Record<Role, RegExp> = {
  SALESMAN: /^Good day, /,
  SUPERVISOR: /^Approval queue$/,
  ACCOUNTANT: /^Approval queue$/,
  FINANCE_MANAGER: /^Approval queue$/,
  GM: /^Approval queue$/,
  MANAGER: /^Dashboard$/,
  VIEWER: /^Dashboard$/,
  STEWARD: /^Import Excel$/,
};

export function homeUrl(role: Role): RegExp {
  return new RegExp(`${(HOME_BY_ROLE[role] as string).replace(/\//g, '\\/')}(\\?|$)`);
}

export async function expectHome(page: Page, role: Role): Promise<void> {
  await expect(page).toHaveURL(homeUrl(role));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_HEADING[role]);
}

/** The PageHeader subtitle under the page's h1. */
export function pageSubtitle(page: Page): Locator {
  return page.getByRole('heading', { level: 1 }).locator('xpath=following-sibling::p[1]');
}

export const CHANGE_PAGE = /\/profile\/change-password(\?|$)/;
export const FORCED_SUBTITLE = 'You must change your password before continuing.';
export const VOLUNTARY_SUBTITLE = 'Update your account password.';
export const TEMPORARY_NOTE = 'The Manager set you a temporary password. Choose a new one to continue.';
export const CHANGED_HOME = 'Password changed. Taking you to your home page…';

/** The forced change page: its address, heading, subtitle and the amber note. */
export async function expectForcedChangePage(page: Page): Promise<void> {
  await expect(page).toHaveURL(CHANGE_PAGE);
  await expect(page.getByRole('heading', { level: 1, name: 'Change password', exact: true })).toBeVisible();
  await expect(pageSubtitle(page)).toHaveText(FORCED_SUBTITLE);
  await expect(page.getByText(TEMPORARY_NOTE, { exact: true })).toBeVisible();
}

/**
 * Changes the password on the open change page (forced or voluntary) and
 * asserts the launch behaviour: "Taking you to your home page…" and then the
 * role's home, signed in on a renewed session (services/password.ts).
 */
export async function changeOwnPassword(page: Page, current: string, next: string, home: RegExp): Promise<void> {
  await settle(page);
  try {
    await fillSecret(page.locator('input[name="currentPassword"]'), current);
    await fillSecret(page.locator('input[name="newPassword"]'), next);
    await fillSecret(page.locator('input[name="confirmNewPassword"]'), next);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
  } finally {
    // The form has read its values as it submitted: empty them before asserting.
    await clearSecretFields(page);
  }
  await expect(page.getByRole('main')).toContainText(CHANGED_HOME);
  await expect(page).toHaveURL(home, { timeout: 30_000 });
}

/** Fills the change form and submits it, for a refusal (the caller asserts the message). */
export async function tryChangePassword(page: Page, current: string, next: string, confirm = next): Promise<void> {
  await settle(page);
  try {
    await fillSecret(page.locator('input[name="currentPassword"]'), current);
    await fillSecret(page.locator('input[name="newPassword"]'), next);
    await fillSecret(page.locator('input[name="confirmNewPassword"]'), confirm);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
  } finally {
    await clearSecretFields(page);
  }
}

// ── menus ────────────────────────────────────────────────────────────────────

type Item = readonly [label: string, href: string];
const CHANGE_PASSWORD: Item = ['Change password', '/profile/change-password'];
const EXPORT: Item = ['Export', '/export'];
const APPROVER: Item[] = [['Approvals', '/approvals'], ['Customers', '/customers'], ['Work items', '/work'], CHANGE_PASSWORD];

/**
 * The menu each role must see — the launch build: every role ends with Change
 * password, and Export is offered to every role /export admits (wave-1 fix #14).
 */
export const MENU_BY_ROLE: Record<Role, readonly Item[]> = {
  SALESMAN: [
    ['Today', '/today'],
    ['Customers', '/customers'],
    ['New customer', '/customers/new'],
    ['Work items', '/work'],
    ['Needs correction', '/rejected'],
    CHANGE_PASSWORD,
  ],
  SUPERVISOR: [['Approvals', '/approvals'], ['My team', '/team'], ['Customers', '/customers'], ['Work items', '/work'], EXPORT, CHANGE_PASSWORD],
  MANAGER: [
    ['Dashboard', '/dashboard'],
    ['Approvals', '/approvals'],
    ['Users', '/users'],
    ['Routes & regions', '/routes'],
    ['Customers', '/customers'],
    ['Reactivations', '/reactivations'],
    ['Audit log', '/audit'],
    ['Work items', '/work'],
    ['Service status', '/status'],
    EXPORT,
    CHANGE_PASSWORD,
  ],
  STEWARD: [
    ['Import', '/import'],
    ['Dashboard', '/dashboard'],
    EXPORT,
    ['Temix sync', '/temix'],
    ['Customers', '/customers'],
    ['Duplicates', '/duplicates'],
    ['Routes & regions', '/routes'],
    ['Users', '/users'],
    ['Audit log', '/audit'],
    ['Work items', '/work'],
    ['Service status', '/status'],
    CHANGE_PASSWORD,
  ],
  VIEWER: [['Dashboard', '/dashboard'], ['Customers', '/customers'], EXPORT, CHANGE_PASSWORD],
  ACCOUNTANT: APPROVER,
  FINANCE_MANAGER: APPROVER,
  GM: APPROVER,
};

/** The salesman's bottom tab bar on a phone. */
export const TAB_BAR: readonly Item[] = [
  ['Today', '/today'],
  ['Customers', '/customers'],
  ['Work', '/work'],
  ['Me', '/profile'],
];

/**
 * The visible role menu: the desktop sidebar, or the phone drawer while it is
 * open (the only navigation that links Change password). Hidden ones are not
 * matched, so on a phone with the drawer closed this finds nothing.
 */
export function menuNav(page: Page): Locator {
  return page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Change password', exact: true }) });
}

/** The salesman's tab bar (the only navigation with a "Me" link). */
export function tabBar(page: Page): Locator {
  return page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Me', exact: true }) });
}

async function items(nav: Locator): Promise<Array<[string, string]>> {
  const links = nav.getByRole('link');
  const labels = (await links.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  return labels.map((l, i) => [l, hrefs[i]!]);
}

/** The navigation lists exactly `expected`, in order (label and target). */
export async function expectItems(nav: Locator, expected: readonly Item[], what: string): Promise<void> {
  await expect(nav, `${what} is shown`).toBeVisible();
  expect(await items(nav), what).toEqual(expected.map(([l, h]) => [l, h]));
}

// ── /users ───────────────────────────────────────────────────────────────────

/** A row of the Users table, by its exact username. */
export function usersRow(page: Page, username: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: username, exact: true }) });
}

/** The banner above the Users table (UsersFeedback: a div with role=status). */
export function usersBanner(page: Page): Locator {
  return page.locator('main div[role="status"]').first();
}

/** The Create user panel's form. */
export function createForm(page: Page): Locator {
  return page
    .locator('aside')
    .filter({ has: page.getByRole('heading', { name: 'Create user', exact: true }) })
    .locator('form');
}

export type NewAccount = {
  fullName: string;
  /** Omitted: the box keeps what the form filled in (a salesman's route code). */
  username?: string;
  /** The role as the select names it (lib/account-edit.ts ROLE_LABELS). */
  role: string;
  routeId?: string;
  supervisorId?: string;
  regionIds?: string[];
  email?: string;
  phone?: string;
  password: string;
};

/** Fills the Create user form (role first: it decides which fields show). */
export async function fillCreateForm(page: Page, a: NewAccount): Promise<Locator> {
  const form = createForm(page);
  await form.locator('select[name="role"]').selectOption({ label: a.role });
  if (a.routeId !== undefined) await form.locator('select[name="ownedRouteId"]').selectOption(a.routeId);
  await form.locator('input[name="fullName"]').fill(a.fullName);
  if (a.username !== undefined) await form.locator('input[name="nmwc-new-account-handle"]').fill(a.username);
  if (a.supervisorId !== undefined) await form.locator('select[name="supervisorId"]').selectOption(a.supervisorId);
  for (const id of a.regionIds ?? []) await form.locator(`input[name="regionId"][value="${id}"]`).check();
  await form.locator('input[name="email"]').fill(a.email ?? '');
  await form.locator('input[name="phone"]').fill(a.phone ?? '');
  await fillSecret(form.locator('input[name="nmwc-new-account-secret"]'), a.password);
  return form;
}

/** Waits for the answer of the server action a click on the Users page posts. */
export async function usersAction(page: Page, click: () => Promise<void>): Promise<void> {
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/users',
    { timeout: 60_000 }
  );
  try {
    await click();
    await answered;
  } finally {
    await clearSecretFields(page);
  }
}

/** Opens /users fresh, fills the Create user form and submits it. Returns the form. */
export async function createUserViaUi(page: Page, a: NewAccount): Promise<Locator> {
  await page.goto('/users');
  await settle(page);
  const form = await fillCreateForm(page, a);
  await usersAction(page, () => form.getByRole('button', { name: 'Create user', exact: true }).click());
  return form;
}

/** Opens the Steward's Edit account dialog on a row. */
export async function openEditDialog(page: Page, username: string): Promise<Locator> {
  await usersRow(page, username).getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toContainText(username);
  return dialog;
}

/** Saves the Edit account dialog and waits for the action's answer. */
export async function saveEditDialog(page: Page, dialog: Locator): Promise<void> {
  await usersAction(page, () => dialog.getByRole('button', { name: 'Save', exact: true }).click());
}

/** The Active / Disabled / All tab counts, as one render shows them. */
export async function tabCounts(page: Page): Promise<{ active: number; disabled: number; all: number }> {
  const nav = page.getByRole('navigation', { name: 'Filter accounts by status' });
  const read = async (label: string) => {
    const text = await nav.getByRole('link', { name: new RegExp(`^${label}`) }).innerText();
    const m = /(\d+)\s*$/.exec(text.trim());
    if (!m) throw new Error(`tab ${label}: no count in "${text}"`);
    return Number(m[1]);
  };
  return { active: await read('Active'), disabled: await read('Disabled'), all: await read('All') };
}

/** "Of N accounts shown: X not signed in yet · Y password change pending". */
export async function countLine(page: Page): Promise<{ shown: number; notSignedIn: number; pending: number }> {
  const line = page.locator('main p').filter({ hasText: /^Of \d+ accounts? shown:/ });
  const text = (await line.innerText()).replace(/\s+/g, ' ').trim();
  const m = /^Of (\d+) accounts? shown: (\d+) not signed in yet · (\d+) password change pending$/.exec(text);
  if (!m) throw new Error(`count line not understood: "${text}"`);
  return { shown: Number(m[1]), notSignedIn: Number(m[2]), pending: Number(m[3]) };
}

/** The usernames of the table's rows, in the order shown. */
export async function rosterUsernames(page: Page): Promise<string[]> {
  return (await page.locator('tbody tr td:nth-child(2)').allInnerTexts()).map((t) => t.trim());
}

/** The value next to a label on /profile ("Full name", "Route", …). */
export function profileValue(page: Page, label: string): Locator {
  return page
    .locator('dl > div')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
}
