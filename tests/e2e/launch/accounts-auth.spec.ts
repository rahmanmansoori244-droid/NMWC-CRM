/**
 * ACCOUNTS AND SIGN-IN — the launch build (production main + the four features
 * + the wave-1 launch fixes + the owner decisions of 7 Oct):
 *
 *   - the first sign-in of every role on the hand-out password '12345', the
 *     forced change, and each role's landing page and menu (desktop sidebar,
 *     phone drawer, the salesman's tab bar);
 *   - the forced-change gate (pages, tab taps, the APIs, sign-out from it);
 *   - the password rules, failures and the two login throttles;
 *   - sign-out, a voluntary change, and how fast other sessions end
 *     (disable, reset, role change);
 *   - /users for the Steward (create, reset, disable, F1 e-mail, claim badges,
 *     Edit account and the leaver/joiner hand-over, every row's actions on
 *     screen at desktop widths) and for a Manager;
 *   - an approver created with his regions; Me (/profile).
 *
 * Launch behaviour asserted (fixed, so no test.fail): after a password change
 * the browser is signed in again on a renewed session and lands on its home
 * ("Password changed. Taking you to your home page…", wave 1 bug 48); refusals
 * on /users read red (role=alert); one's own row offers "Change my password"
 * instead of Disable/Reset; every menu ends with Change password and Export is
 * offered to every role /export admits; e-mail is lower-cased and a clash in
 * any case is refused; the GM's row has the e-mail button (owner decision 6);
 * the Steward's Edit account and the create form's regions (owner decision 8).
 * Fixed in the launch candidate and asserted as fixed (their test.fail markers
 * are gone): the phone menu is a dialog that closes on its current page
 * (KNOWN_BUGS.drawerA11y, ee81e93), a region-less Accountant is told why
 * /approvals is empty, in NoRegionNotice's exact words and once
 * (KNOWN_BUGS.noRegionEmptyState, fd41184, e8e6bc9), and a reset refused for a
 * reused password says so once on /users (06763c2).
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts accounts-auth --project=phone --project=desktop
 */
import { expect, request as pwRequest, test, type Locator, type Page } from '@playwright/test';
import type { Role } from '@prisma/client';
import {
  BASE_URL,
  INITIAL_PASSWORD,
  SESSION_COOKIE,
  apiSignIn,
  auditFor,
  clearSecretFields,
  createWorld,
  db,
  drainLimit,
  expectNoDataLeak,
  expectNoRegionNotice,
  expectNoSideScroll,
  fillSecret,
  installLaunchHooks,
  newId,
  omanDateISO,
  postForm,
  postJson,
  projectDevice,
  requireLaunchEnv,
  resetLimits,
  seedUpdateEdit,
  snapshot,
  type DeviceKind,
  type FixtureUser,
  type World,
} from './support';
import {
  ACCOUNT_LOCKED,
  CHANGE_PAGE,
  INVALID_LOGIN,
  MENU_BY_ROLE,
  NETWORK_THROTTLED,
  TAB_BAR,
  TEMPORARY_NOTE,
  VOLUNTARY_SUBTITLE,
  changeOwnPassword,
  contextAt,
  countLine,
  createForm,
  createUserViaUi,
  expectForcedChangePage,
  expectGateRefusal,
  expectHome,
  expectItems,
  expectSignedOut,
  fillCreateForm,
  freshPassword,
  historyHolds,
  homeUrl,
  loginAlert,
  menuNav,
  omanDate,
  omanDateTime,
  openEditDialog,
  openLoginPage,
  pageSubtitle,
  passwordIs,
  postsDuring,
  profileValue,
  rosterUsernames,
  saveEditDialog,
  settle,
  submitLogin,
  tabBar,
  tabCounts,
  tryChangePassword,
  usersAction,
  usersBanner,
  usersRow,
} from './support/accounts-helpers';

const ROLE_LABEL: Record<Role, string> = {
  SALESMAN: 'Salesman',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager',
  STEWARD: 'Data Steward',
  VIEWER: 'Read-only Viewer',
  ACCOUNTANT: 'Accountant',
  FINANCE_MANAGER: 'Finance Manager',
  GM: 'GM',
};

/** The audit rows about one user, as "ACTION:reason" strings. */
async function auditKinds(userId: string): Promise<string[]> {
  return (await auditFor({ entityId: userId })).map((a) => `${a.action}:${a.reason ?? ''}`);
}

async function userRow(id: string) {
  return db.user.findUniqueOrThrow({
    where: { id },
    select: {
      username: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
      sessionsRevokedAt: true,
      passwordHash: true,
      ownedRouteId: true,
      supervisorId: true,
      email: true,
      phone: true,
      managedRegions: { select: { code: true } },
    },
  });
}

/** Signs `u` in on a fresh signed-out context at `ip` and asserts the refusal message. */
async function expectSignInRefused(
  browser: import('@playwright/test').Browser,
  u: { username: string; password: string },
  ip: string,
  message: string | RegExp,
  device: DeviceKind = 'desktop'
): Promise<void> {
  const page = await (await contextAt(browser, null, ip, { device })).newPage();
  await openLoginPage(page);
  await submitLogin(page, u.username, u.password);
  await expect(loginAlert(page)).toHaveText(message);
  await expect(page).toHaveURL(/\/login(\?|$)/);
}

/** Signs `u` in on a fresh signed-out context at `ip`; returns the page. */
async function signIn(
  browser: import('@playwright/test').Browser,
  u: { username: string; password: string },
  ip: string,
  device: DeviceKind = 'desktop'
) {
  const page = await (await contextAt(browser, null, ip, { device })).newPage();
  await openLoginPage(page);
  await submitLogin(page, u.username, u.password);
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
  return page;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. First sign-in: a salesman on his phone (AUTH-FIRST-SIGNIN-EVERY-ROLE, SM-AUTH-FIRST-LOGIN)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a salesman’s first sign-in on his phone', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('afs', {
      regions: [{ key: 'R1' }],
      // Two-character route codes, as many go-live routes are (C4, W…).
      routes: [
        { key: 'Z412', region: 'R1', twoChar: true },
        { key: 'Z360', region: 'R1', twoChar: true },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S412', role: 'SALESMAN', route: 'Z412', supervisor: 'M1', mustChangePassword: true },
        { key: 'S360', role: 'SALESMAN', route: 'Z360', supervisor: 'M1', mustChangePassword: true },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  for (const [key, device, n] of [
    ['S412', 'phone', 1],
    ['S360', 'phone360', 3],
  ] as const) {
    test(`${device}: the route code in capitals with a trailing space, the forced change, then Today`, async ({ browser }) => {
      test.setTimeout(240_000);
      const u = world.user(key);
      const ip = world.ip(n);
      await resetLimits({ users: [u], ips: [ip, world.ip(n + 1)] });
      const typed = `${u.routeCode!.toUpperCase()} `;
      expect(u.username).toBe(u.routeCode!.toLowerCase());

      const page = await (await contextAt(browser, null, ip, { device })).newPage();
      await openLoginPage(page);
      await submitLogin(page, typed, INITIAL_PASSWORD);
      await expectForcedChangePage(page);
      // The salesman keeps his tab bar on the forced page.
      await expectItems(tabBar(page), TAB_BAR, 'the tab bar on the forced change page');
      if (device === 'phone360') await expectNoSideScroll(page);
      // Capitals and the trailing space found the account and its own bucket (trimmed, lower-cased).
      expect(await db.rateLimit.count({ where: { key: `login:user:${u.username}` } })).toBe(1);
      expect(await db.rateLimit.count({ where: { key: `login:user:${typed}` } })).toBe(0);

      const old = u.password;
      const next = freshPassword();
      await changeOwnPassword(page, old, next, /\/today(\?|$)/);
      u.password = next;
      u.mustChangePassword = false;
      await expectHome(page, 'SALESMAN');
      if (device === 'phone360') await expectNoSideScroll(page);

      // The old password is refused with the one opaque message; the new one lands on Today.
      const again = await (await contextAt(browser, null, world.ip(n + 1), { device })).newPage();
      await openLoginPage(again);
      await submitLogin(again, typed, old);
      await expect(loginAlert(again)).toHaveText(INVALID_LOGIN);
      await submitLogin(again, typed, next);
      await expectHome(again, 'SALESMAN');

      const row = await userRow(u.id);
      expect(row.mustChangePassword).toBe(false);
      expect(row.sessionsRevokedAt).not.toBeNull();
      expect(row.lastLoginAt).not.toBeNull();
      expect(await db.passwordHistory.count({ where: { userId: u.id } })).toBe(1);
      expect(await historyHolds(u.id, INITIAL_PASSWORD), 'the history row holds the hand-out password').toBe(true);
      const kinds = await auditKinds(u.id);
      // First sign-in, the renewed session after the change, the sign-in with the new password.
      expect(kinds.filter((k) => k === 'LOGIN:')).toHaveLength(3);
      expect(kinds.filter((k) => k === 'UPDATE:self_password_change')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'LOGIN_FAIL:wrong_password')).toHaveLength(1);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. First sign-in: every other role (MGR-LOGIN-FIRST, FIN-01, SV-STEWARD-SIGNIN-MENU, SV-VIEWER-SIGNIN-DASHBOARD)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the first sign-in of every other role', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  const ROLES: Array<[key: string, role: Role]> = [
    ['MGR', 'MANAGER'],
    ['ACC', 'ACCOUNTANT'],
    ['FM', 'FINANCE_MANAGER'],
    ['GM', 'GM'],
    ['STW', 'STEWARD'],
    ['VW', 'VIEWER'],
    ['SUP', 'SUPERVISOR'],
  ];
  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('afr', {
      regions: [{ key: 'R1' }],
      users: ROLES.map(([key, role]) => ({
        key,
        role,
        mustChangePassword: true,
        ...(role === 'MANAGER' || role === 'ACCOUNTANT' ? { regions: ['R1'] } : {}),
      })),
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  for (const [i, [key, role]] of ROLES.entries()) {
    test(`${role}: the forced change on '12345', then ${role === 'STEWARD' ? '/import' : role === 'MANAGER' || role === 'VIEWER' ? '/dashboard' : '/approvals'} with the role’s menu`, async ({ browser }) => {
      test.setTimeout(240_000);
      const u = world.user(key);
      const ip = world.ip(2 * i + 1);
      const ip2 = world.ip(2 * i + 2);
      await resetLimits({ users: [u], ips: [ip, ip2] });

      const page = await (await contextAt(browser, null, ip, { device: 'desktop' })).newPage();
      await openLoginPage(page);
      await submitLogin(page, u.username, INITIAL_PASSWORD);
      await expectForcedChangePage(page);
      await expect(tabBar(page), 'only salesmen have a tab bar').toHaveCount(0);

      const old = u.password;
      const next = freshPassword();
      await changeOwnPassword(page, old, next, homeUrl(role));
      u.password = next;
      u.mustChangePassword = false;
      await expectHome(page, role);
      await expectItems(menuNav(page), MENU_BY_ROLE[role], `${role}'s sidebar`);
      await expect(page.getByRole('link', { name: /^Notifications/ }), 'the bell').toBeVisible();
      if (role === 'VIEWER') {
        // The Viewer's dashboard is the whole organisation's.
        await expect(pageSubtitle(page)).toHaveText(/^Whole organisation · /);
      } else if (role === 'MANAGER') {
        await expect(pageSubtitle(page)).toHaveText(/^Your regions/);
      } else if (role === 'STEWARD') {
        await expect(page.getByRole('heading', { level: 2, name: /^account master$/i })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: /^customer master$/i })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: 'Recent batches' })).toBeVisible();
      } else {
        await expect(pageSubtitle(page)).toHaveText(/^\d+ pending/);
      }
      for (const entry of ['/', '/home']) {
        await page.goto(entry);
        await expectHome(page, role);
      }

      // The old password is refused; the new one lands on the same home.
      const again = await (await contextAt(browser, null, ip2, { device: 'desktop' })).newPage();
      await openLoginPage(again);
      await submitLogin(again, u.username, old);
      await expect(loginAlert(again)).toHaveText(INVALID_LOGIN);
      await submitLogin(again, u.username, next);
      await expectHome(again, role);

      const row = await userRow(u.id);
      expect(row.mustChangePassword).toBe(false);
      expect(row.lastLoginAt).not.toBeNull();
      expect(row.sessionsRevokedAt).not.toBeNull();
      expect(await db.passwordHistory.count({ where: { userId: u.id } })).toBe(1);
      expect(await historyHolds(u.id, INITIAL_PASSWORD)).toBe(true);
      const kinds = await auditKinds(u.id);
      expect(kinds.filter((k) => k === 'LOGIN:')).toHaveLength(3);
      expect(kinds).toContain('UPDATE:self_password_change');
      expect(kinds).toContain('LOGIN_FAIL:wrong_password');
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Role menus on the phone and the desktop (+ NAV-PROFILE-AND-EXPORT-REACH)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: each role’s menu', { tag: ['@phone', '@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  const KEYS: Array<[key: string, role: Role]> = [
    ['SA', 'SALESMAN'],
    ['SUP', 'SUPERVISOR'],
    ['M1', 'MANAGER'],
    ['STW', 'STEWARD'],
    ['VW', 'VIEWER'],
    ['ACC1', 'ACCOUNTANT'],
    ['FM1', 'FINANCE_MANAGER'],
    ['GM1', 'GM'],
  ];
  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('amn', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SUP', role: 'SUPERVISOR' },
        { key: 'STW', role: 'STEWARD' },
        { key: 'VW', role: 'VIEWER' },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'FM1', role: 'FINANCE_MANAGER' },
        { key: 'GM1', role: 'GM' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  for (const [i, [key, role]] of KEYS.entries()) {
    test(`${role}: the menu lists exactly its pages, reaches Change password${MENU_BY_ROLE[role].some(([l]) => l === 'Export') ? ' and Export' : ''} without a typed address`, async ({ browser }) => {
      test.setTimeout(240_000);
      const u = world.user(key);
      const device = projectDevice();
      const page = await (await contextAt(browser, u, world.ip(i + 1))).newPage();
      await page.goto('/');
      await expectHome(page, role);
      await settle(page);
      const openMenu = page.getByRole('button', { name: 'Open menu' });

      if (device === 'desktop') {
        await expectItems(menuNav(page), MENU_BY_ROLE[role], `${role}'s sidebar`);
        await expect(openMenu).toBeHidden();
        await expect(tabBar(page)).toHaveCount(0);
      } else if (role === 'SALESMAN') {
        // His phone navigation is the tab bar; no drawer, no sidebar.
        await expectItems(tabBar(page), TAB_BAR, 'the salesman’s tab bar');
        await expect(openMenu).toHaveCount(0);
        await expect(menuNav(page)).toHaveCount(0);
      } else {
        await expect(tabBar(page), 'only salesmen have a tab bar').toHaveCount(0);
        await expect(menuNav(page), 'the drawer starts closed').toHaveCount(0);
        await openMenu.click();
        await expectItems(menuNav(page), MENU_BY_ROLE[role], `${role}'s phone drawer`);
        await page.keyboard.press('Escape');
        await expect(menuNav(page), 'Escape closes the drawer').toHaveCount(0);
        await openMenu.click();
        await menuNav(page).getByRole('link', { name: 'Customers', exact: true }).click();
        await expect(page).toHaveURL(/\/customers(\?|$)/);
        await expect(menuNav(page), 'navigating closes the drawer').toHaveCount(0);
      }

      // Change password is one tap away for every role (wave-1 fix #14).
      if (device === 'phone' && role === 'SALESMAN') {
        await tabBar(page).getByRole('link', { name: 'Me', exact: true }).click();
        await expect(page).toHaveURL(/\/profile(\?|$)/);
        await page.getByRole('main').getByRole('link', { name: 'Change password', exact: true }).click();
      } else {
        if (device === 'phone') await openMenu.click();
        await menuNav(page).getByRole('link', { name: 'Change password', exact: true }).click();
      }
      await expect(page).toHaveURL(CHANGE_PAGE);
      await expect(page.getByRole('heading', { level: 1, name: 'Change password', exact: true })).toBeVisible();
      await expect(pageSubtitle(page)).toHaveText(VOLUNTARY_SUBTITLE);
      await expect(page.getByText(TEMPORARY_NOTE)).toHaveCount(0);

      // Export, for every role /export admits.
      if (MENU_BY_ROLE[role].some(([label]) => label === 'Export')) {
        if (device === 'phone') await openMenu.click();
        await menuNav(page).getByRole('link', { name: 'Export', exact: true }).click();
        await expect(page).toHaveURL(/\/export(\?|$)/);
        await expect(page.getByRole('heading', { level: 1, name: 'Export to Excel' })).toBeVisible();
      }

      // Every item opens its page as this role — no redirect back to /home, neither
      // as an HTTP redirect nor as the streamed one a page under a loading boundary sends.
      for (const [label, href] of MENU_BY_ROLE[role]) {
        const res = await page.request.get(href, { maxRedirects: 0, failOnStatusCode: false });
        expect(res.status(), `${role} → ${label} (${href})`).toBe(200);
        expect(await res.text(), `${role} → ${label} (${href}) is not redirected while streaming`).not.toContain('__next-page-redirect');
      }
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Gaps found before launch and fixed in the launch candidate (their own
// non-serial tests; they were test.fail until the fixes merged)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: gaps fixed for launch', () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('akg', {
      regions: [{ key: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        // A legacy Accountant with no region (the create form and the import now refuse one).
        { key: 'ACC0', role: 'ACCOUNTANT' },
        { key: 'STW', role: 'STEWARD' },
        { key: 'VR', role: 'VIEWER' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('the phone menu is a dialog, and tapping the page it is on closes it', { tag: ['@phone'] }, async ({ browser }) => {
    // KNOWN_BUGS.drawerA11y, fixed (ee81e93): the drawer had no dialog role or focus trap, and its current item left it open.
    const page = await (await contextAt(browser, world.user('M1'), world.ip(1), { device: 'phone' })).newPage();
    await page.goto('/dashboard');
    await settle(page);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog'), 'the open drawer is a dialog').toBeVisible();
    await menuNav(page).getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(menuNav(page), 'tapping the current page closes the drawer').toHaveCount(0);
  });

  test('an Accountant with no region is told so on /approvals instead of an empty queue', { tag: ['@desktop'] }, async ({ browser }) => {
    // KNOWN_BUGS.noRegionEmptyState, fixed (fd41184): a region-less approver saw "Nothing pending" with no hint why.
    // NoRegionNotice says it now, word for word and once (e8e6bc9: not in the header as well).
    const page = await (await contextAt(browser, world.user('ACC0'), world.ip(2), { device: 'desktop' })).newPage();
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1, name: 'Approval queue' })).toBeVisible();
    await expectNoRegionNotice(page, 'approval requests', 'ACC0 /approvals');
  });

  test('a reset refused for a reused password says so once on /users', { tag: ['@desktop'] }, async ({ browser }) => {
    // Fixed (06763c2): lib/password-policy.ts assertPasswordNotReused puts the same sentence on `password` and
    // `newPassword`, and UserRowActions refusalText joined every field, so the refusal read twice. It keeps each
    // distinct sentence once now.
    const stw = world.user('STW');
    const vr = world.user('VR');
    const page = await (await contextAt(browser, stw, world.ip(3), { device: 'desktop' })).newPage();
    await page.goto('/users');
    await settle(page);
    const row = usersRow(page, vr.username);
    await row.getByRole('button', { name: 'Reset password', exact: true }).click();
    const form = row.locator('form').filter({ has: page.locator('input[name="confirmPassword"]') });
    // His current password: refused as a reuse, nothing changes.
    await fillSecret(form.locator('input[name="password"]'), vr.password);
    await fillSecret(form.locator('input[name="confirmPassword"]'), vr.password);
    await usersAction(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    const refusal = row.getByRole('alert');
    await expect(refusal).toContainText('You cannot reuse one of your last 5 passwords.');
    await expect(refusal).toHaveClass(/text-red-600/);
    expect(await passwordIs(vr.id, vr.password), 'nothing changed').toBe(true);
    expect((await userRow(vr.id)).mustChangePassword).toBe(false);
    // The sentence, once.
    await expect(refusal).toHaveText('You cannot reuse one of your last 5 passwords.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The forced-change gate: a salesman (SM-AUTH-FORCED-GATE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a salesman who must change his password reaches nothing else', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('agt', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S', role: 'SALESMAN', route: 'A', supervisor: 'M1', mustChangePassword: true },
        { key: 'S2', role: 'SALESMAN', route: 'A2', supervisor: 'M1', mustChangePassword: true },
      ],
      customers: [{ key: 'C1', phone: true, contact: 'Hamed Al Siyabi', branches: [{ key: 'S', route: 'A', day: 'TODAY' }] }],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('tab taps and typed addresses all show the change page, with the address bar put right', async ({ browser }) => {
    const s = world.user('S');
    const c1 = world.customer('C1');
    const page = await (await contextAt(browser, s, world.ip(1))).newPage();
    await page.goto('/today');
    await expectForcedChangePage(page);
    await settle(page);
    for (const [label] of TAB_BAR) {
      await tabBar(page).getByRole('link', { name: label, exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await expect(page, `tap ${label}`).toHaveURL(CHANGE_PAGE);
      await expect(page.getByRole('heading', { level: 1 }), `tap ${label}`).toHaveText('Change password');
    }
    for (const path of [`/customers/${c1.id}`, '/customers/new', '/import', '/users', '/temix']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(CHANGE_PAGE);
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveText('Change password');
    }
    await expectNoDataLeak(page, [c1.legalName]);
  });

  test('the APIs refuse the flagged session, and nothing is written', async ({ browser }) => {
    const s = world.user('S');
    const page = await (await contextAt(browser, s, world.ip(1))).newPage();
    await page.goto('/profile/change-password');
    await expectGateRefusal(await postJson(page, '/api/forms/customer-edit', {}), 'POST /api/forms/customer-edit');
    await expectGateRefusal(
      await postJson(page, '/api/photos/presign', { kind: 'SHOP', mimeType: 'image/jpeg', bytes: 2048 }),
      'POST /api/photos/presign'
    );
    await expectGateRefusal(await page.request.get(`/api/photos/${newId()}`, { maxRedirects: 0, failOnStatusCode: false }), 'GET /api/photos/<id>');
    await expectGateRefusal(await page.request.get('/api/exports/customers', { maxRedirects: 0, failOnStatusCode: false }), 'GET /api/exports/customers');
    expect(await db.customerEdit.count({ where: { submittedById: s.id } })).toBe(0);
    expect(await db.importBatch.count({ where: { uploadedById: s.id } })).toBe(0);
    expect(await db.attachment.count({ where: { capturedById: s.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorId: s.id } })).toBe(0);
  });

  test('the change completes from the page a tap on Today bounced him to, and he lands on Today', async ({ browser }) => {
    const s = world.user('S');
    const ip = world.ip(2);
    await resetLimits({ users: [s], ips: [ip] });
    const page = await (await contextAt(browser, s, ip)).newPage();
    await page.goto('/profile/change-password');
    await settle(page);
    await tabBar(page).getByRole('link', { name: 'Today', exact: true }).click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expectForcedChangePage(page);
    const next = freshPassword();
    await changeOwnPassword(page, s.password, next, /\/today(\?|$)/);
    s.password = next;
    s.mustChangePassword = false;
    await expect(page.getByText('An unexpected response was received from the server')).toHaveCount(0);
    await expectHome(page, 'SALESMAN');
    expect((await userRow(s.id)).mustChangePassword).toBe(false);
  });

  test('Sign out works from the forced page', async ({ browser }) => {
    const s2 = world.user('S2');
    const page = await (await contextAt(browser, s2, world.ip(3))).newPage();
    await page.goto('/today');
    await expectForcedChangePage(page);
    await settle(page);
    await page.getByRole('banner').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login(\?|$)/);
    expect(await auditKinds(s2.id)).toContain('LOGOUT:');
    expect((await userRow(s2.id)).sessionsRevokedAt).not.toBeNull();
    await page.goto('/today');
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The forced-change gate: a Steward (SV-MUSTCHANGE-GATE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a Steward who must change his password reaches nothing else', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('ags', { users: [{ key: 'STW', role: 'STEWARD', mustChangePassword: true }] });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('every Steward page shows the change page, the export API refuses, and nothing is written', async ({ browser }) => {
    const stw = world.user('STW');
    const page = await (await contextAt(browser, stw, world.ip(1), { device: 'desktop' })).newPage();
    for (const path of ['/import', '/users', '/temix', '/dashboard', '/export', '/audit', '/duplicates']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(CHANGE_PAGE);
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveText('Change password');
    }
    await expectForcedChangePage(page);
    await expectGateRefusal(await page.request.get('/api/exports/customers', { maxRedirects: 0, failOnStatusCode: false }), 'GET /api/exports/customers');
    await expectGateRefusal(await page.request.get('/api/exports/changes', { maxRedirects: 0, failOnStatusCode: false }), 'GET /api/exports/changes');
    expect(await db.importBatch.count({ where: { uploadedById: stw.id } })).toBe(0);
    expect(await db.temixSyncBatch.count({ where: { createdById: stw.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorId: stw.id } })).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Password rules (AUTH-PASSWORD-RULES, SM-AUTH-CHANGE-VALIDATION)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the password rules', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('apr', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('refusals say what is wrong, keep what was typed, and change nothing', async ({ browser }) => {
    const s = world.user('S');
    const ip = world.ip(1);
    await resetLimits({ users: [s], ips: [ip] });
    const page = await (await contextAt(browser, s, ip)).newPage();
    await page.goto('/profile/change-password');
    await expect(pageSubtitle(page)).toHaveText(VOLUNTARY_SUBTITLE);
    await expect(page.getByText(TEMPORARY_NOTE)).toHaveCount(0);
    await settle(page);

    const untouched = await snapshot(['User'], { id: s.id });
    const history = await db.passwordHistory.count({ where: { userId: s.id } });
    const audits = (await auditFor({ entityId: s.id })).length;
    const main = page.getByRole('main');
    const current = page.locator('input[name="currentPassword"]');
    const fresh = page.locator('input[name="newPassword"]');
    const confirm = page.locator('input[name="confirmNewPassword"]');

    // (a) The two new passwords differ: refused in the page, nothing is sent, nothing typed is lost.
    await fillSecret(current, s.password);
    await fillSecret(fresh, freshPassword());
    await fillSecret(confirm, freshPassword());
    const sent = await postsDuring(page, () => page.getByRole('button', { name: 'Change password', exact: true }).click());
    const kept = await Promise.all([current, fresh, confirm].map((f) => f.evaluate((el) => (el as HTMLInputElement).value.length)));
    await clearSecretFields(page);
    expect(sent, 'no request leaves the page').toBe(0);
    await expect(main.getByRole('alert')).toHaveText('The two new passwords do not match.');
    expect(kept.every((n) => n > 0), 'every field keeps what was typed').toBe(true);

    // (b) 11 characters, past the browser's minlength: the server refuses it.
    await fresh.evaluate((el) => el.removeAttribute('minlength'));
    await tryChangePassword(page, s.password, 'E2e-short-1');
    await expect(main).toContainText('Password must be at least 12 characters');

    // (c) A wrong current password.
    await tryChangePassword(page, freshPassword(), freshPassword());
    await expect(main).toContainText('Current password incorrect.');

    // (d) The new password is the current one.
    await tryChangePassword(page, s.password, s.password);
    await expect(main).toContainText('New password must differ from current.');

    // Nothing was written, and the session is still good.
    expect(await snapshot(['User'], { id: s.id })).toBe(untouched);
    expect(await db.passwordHistory.count({ where: { userId: s.id } })).toBe(history);
    expect((await auditFor({ entityId: s.id })).length).toBe(audits);
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'My profile' })).toBeVisible();
  });

  test('Show turns only the two new-password fields into plain text', async ({ browser }) => {
    const s = world.user('S');
    const page = await (await contextAt(browser, s, world.ip(1))).newPage();
    await page.goto('/profile/change-password');
    await settle(page);
    const current = page.locator('input[name="currentPassword"]');
    const fresh = page.locator('input[name="newPassword"]');
    const confirm = page.locator('input[name="confirmNewPassword"]');
    // Dummy text, never submitted (shown as plain text once Show is on).
    await fresh.fill('dummy new value');
    await confirm.fill('dummy new value');
    const show = page.getByRole('button', { name: 'Show new password' });
    await show.click();
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    await expect(fresh).toHaveAttribute('type', 'text');
    await expect(confirm).toHaveAttribute('type', 'text');
    await expect(current).toHaveAttribute('type', 'password');
    for (const f of [fresh, confirm]) {
      await expect(f).toHaveAttribute('autocapitalize', 'none');
      await expect(f).toHaveAttribute('autocorrect', 'off');
      await expect(f).toHaveAttribute('spellcheck', 'false');
    }
    await show.click();
    await expect(fresh).toHaveAttribute('type', 'password');
    await expect(confirm).toHaveAttribute('type', 'password');
  });

  test('none of the last five passwords can be used again, and the history keeps five', async ({ browser }) => {
    test.setTimeout(420_000);
    const s = world.user('S');
    const ip = world.ip(2);
    const page = await (await contextAt(browser, s, ip)).newPage();
    const used: string[] = [s.password];
    const change = async () => {
      // Each change signs this browser in again (renewOwnSession): one per-user login token.
      await resetLimits({ users: [s], ips: [ip] });
      const before = (await userRow(s.id)).sessionsRevokedAt?.getTime() ?? 0;
      await page.goto('/profile/change-password');
      const next = freshPassword();
      await changeOwnPassword(page, s.password, next, /\/today(\?|$)/);
      s.password = next;
      used.push(next);
      const after = (await userRow(s.id)).sessionsRevokedAt?.getTime() ?? 0;
      expect(after, 'each change ends the other sessions').toBeGreaterThan(before);
    };

    await change(); // P0 → P1
    await change(); // P1 → P2
    await change(); // P2 → P3
    // P1 again: refused, nothing written.
    const untouched = await snapshot(['User'], { id: s.id });
    await page.goto('/profile/change-password');
    await tryChangePassword(page, s.password, used[1]!);
    await expect(page.getByRole('main')).toContainText('You cannot reuse one of your last 5 passwords.');
    expect(await snapshot(['User'], { id: s.id })).toBe(untouched);

    await change(); // P3 → P4
    await change(); // P4 → P5
    await change(); // P5 → P6: six changes
    expect(await db.passwordHistory.count({ where: { userId: s.id } }), 'at most five history rows').toBe(5);
    expect(await historyHolds(s.id, used[0]!), 'the oldest password has left the history').toBe(false);
    expect(await passwordIs(s.id, s.password)).toBe(true);
    expect((await auditKinds(s.id)).filter((k) => k === 'UPDATE:self_password_change')).toHaveLength(6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Sign-in failures (AUTH-SIGNIN-FAILURES, SM-AUTH-LOGIN-ERRORS a/b)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a refused sign-in', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('asf', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S1', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SX', role: 'SALESMAN', route: 'A2', supervisor: 'M1', isActive: false },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('a wrong password, an unknown name and a disabled account read the same; only known accounts are audited', async ({ browser }) => {
    const s1 = world.user('S1');
    const sx = world.user('SX');
    const unknown = `e2e.nobody.${world.sfx}`;
    await resetLimits({ users: [s1, sx], ips: [world.ip(1), world.ip(2), world.ip(3)] });

    await expectSignInRefused(browser, { username: s1.username, password: freshPassword() }, world.ip(1), INVALID_LOGIN, 'phone');
    await expectSignInRefused(browser, { username: unknown, password: freshPassword() }, world.ip(2), INVALID_LOGIN, 'phone');
    await expectSignInRefused(browser, { username: sx.username, password: sx.password }, world.ip(3), INVALID_LOGIN, 'phone');

    expect(await auditKinds(s1.id)).toEqual(['LOGIN_FAIL:wrong_password']);
    expect(await auditKinds(sx.id)).toEqual(['LOGIN_FAIL:inactive']);
    // An unknown name has no account to point at: logged, never an audit row (critic correction).
    expect(await db.auditLog.count({ where: { entityId: `unknown:${unknown}` } })).toBe(0);
  });

  test('empty fields are stopped by the browser, and the way back in is on the page', async ({ browser }) => {
    const page = await (await contextAt(browser, null, world.ip(4))).newPage();
    await openLoginPage(page);
    const sent = await postsDuring(page, () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
    expect(sent).toBe(0);
    expect(await page.getByLabel('Username').evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    await expect(page).toHaveURL(/\/login$/);
    await expect(loginAlert(page)).toHaveCount(0);
    await expect(page.getByText('Forgot your password? Contact your Manager — they can reset it for you.', { exact: true })).toBeVisible();
  });

  test('a tap before the page is ready does nothing and never puts the password in the address', async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await contextAt(browser, null, world.ip(5));
    const page = await ctx.newPage();
    // As served, before any script runs: the button is disabled.
    const html = await (await page.request.get('/login')).text();
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>/);
    expect(html).not.toContain('data-hydrated');

    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    page.on('framenavigated', (f) => seen.push(f.url()));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    try {
      await page.goto('/login', { waitUntil: 'commit' });
      await page.locator('#password').waitFor({ state: 'attached', timeout: 60_000 });
      // A dummy value: the point is that nothing typed may reach the address bar.
      await page.locator('#username').fill(`e2e.early.${world.sfx}`, { force: true }).catch(() => undefined);
      await page.locator('#password').fill('dummy-not-a-password', { force: true }).catch(() => undefined);
      if ((await page.locator('form[data-hydrated="1"]').count()) === 0) {
        await page.locator('button[type="submit"]').click({ force: true, timeout: 5_000 }).catch(() => undefined);
      }
      await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 120_000 });
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    }
    await clearSecretFields(page);
    await expect(page).toHaveURL(/\/login$/);
    expect(seen.filter((u) => /password=/i.test(u)), 'no URL ever carried the password').toEqual([]);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8a. The per-account lock (AUTH-ACCOUNT-LOCK, SM-AUTH-LOGIN-ERRORS c)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the per-account lock', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('alk', {
      users: [
        { key: 'V1', role: 'VIEWER' },
        { key: 'V2', role: 'VIEWER' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('a sixth attempt inside the refill window is locked although the password is right; it opens about 24 s later', async ({ browser }) => {
    test.setTimeout(300_000);
    const v = world.user('V1');
    const ip = world.ip(1);
    await resetLimits({ users: [v], ips: [ip] });
    const ctx = await contextAt(browser, null, ip, { device: 'desktop' });
    const page = await ctx.newPage();
    await openLoginPage(page);
    // Five attempts spent (the bucket refills one every 12 s): pre-drained rather than raced.
    await drainLimit(`login:user:${v.username}`);
    await submitLogin(page, v.username, v.password);
    await expect(loginAlert(page)).toHaveText(ACCOUNT_LOCKED);
    await expect(page).toHaveURL(/\/login(\?|$)/);
    expect((await ctx.cookies()).some((c) => c.name === SESSION_COOKIE), 'no session cookie').toBe(false);
    // The lock gave the network token back: the address is not charged for it.
    const ipBucket = await db.rateLimit.findUnique({ where: { key: `login:ip:${ip}` } });
    expect(ipBucket?.tokens ?? 5).toBeGreaterThan(4.5);
    expect(await auditKinds(v.id)).not.toContain('LOGIN:');

    await page.waitForTimeout(26_000);
    await submitLogin(page, v.username, v.password);
    await expectHome(page, 'VIEWER');
  });

  test('wrong passwords from five addresses lock the account for a sixth address too', async ({ browser }) => {
    test.setTimeout(300_000);
    const v = world.user('V2');
    const ips = [2, 3, 4, 5, 6, 7].map((n) => world.ip(n));
    await resetLimits({ users: [v], ips });
    const ctx = await contextAt(browser, null, ips[5]!, { device: 'desktop' });
    const page = await ctx.newPage();
    await openLoginPage(page);
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      for (const ip of ips.slice(0, 5)) {
        const r = await apiSignIn(api, v.username, `wrong-${world.sfx}`, { ip });
        expect(r.signedIn).toBe(false);
      }
    } finally {
      await api.dispose();
    }
    await submitLogin(page, v.username, v.password);
    await expect(loginAlert(page)).toHaveText(ACCOUNT_LOCKED);
    expect((await ctx.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);
    expect((await auditKinds(v.id)).filter((k) => k === 'LOGIN_FAIL:wrong_password')).toHaveLength(5);
    // Each address paid for its own one failure only.
    for (const ip of ips.slice(0, 5)) {
      const b = await db.rateLimit.findUnique({ where: { key: `login:ip:${ip}` } });
      expect(b?.tokens, ip).toBeGreaterThan(3.5);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8b. One network, many salesmen (AUTH-NETWORK-THROTTLE-TRAINING-ROOM, SM-AUTH-LOGIN-ERRORS d)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the shared-network throttle', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('anw', {
      regions: [{ key: 'R1' }],
      routes: ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, region: 'R1' })),
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S1', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'S2', role: 'SALESMAN', route: 'B', supervisor: 'M1' },
        { key: 'S3', role: 'SALESMAN', route: 'C', supervisor: 'M1' },
        { key: 'S4', role: 'SALESMAN', route: 'D', supervisor: 'M1' },
        { key: 'L1', role: 'SALESMAN', route: 'E', supervisor: 'M1' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  async function failFrom(ip: string, names: string[]): Promise<void> {
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      for (const name of names) {
        const r = await apiSignIn(api, name, `typo-${world.sfx}`, { ip });
        expect(r.signedIn).toBe(false);
      }
    } finally {
      await api.dispose();
    }
  }

  test('five typos across three salesmen hold back a fourth with the right password; he gets in after the wait he is told', async ({ browser }) => {
    test.setTimeout(300_000);
    test.info().annotations.push({
      type: 'owner decision',
      description:
        'Hand-out day: five failed sign-ins per minute from one office address hold back everyone behind it for ~12-24 s. Hand out in small groups, or raise the network bucket.',
    });
    const ip = world.ip(1);
    const [a, b, c, d] = ['S1', 'S2', 'S3', 'S4'].map((k) => world.user(k)) as [FixtureUser, FixtureUser, FixtureUser, FixtureUser];
    await resetLimits({ users: [a, b, c, d], ips: [ip] });
    const page = await (await contextAt(browser, null, ip)).newPage();
    await openLoginPage(page);
    await failFrom(ip, [a.username, a.username, b.username, b.username, c.username]);

    await submitLogin(page, d.username, d.password);
    await expect(loginAlert(page)).toHaveText(NETWORK_THROTTLED);
    const wait = Number(NETWORK_THROTTLED.exec((await loginAlert(page).innerText()).trim())![1]);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    // The network bucket refused first, so his own account was not charged.
    expect(await db.rateLimit.findUnique({ where: { key: `login:user:${d.username}` } })).toBeNull();

    await page.waitForTimeout((wait + 2) * 1000);
    await submitLogin(page, d.username, d.password);
    await expectHome(page, 'SALESMAN');
  });

  test('a lone salesman who mistypes five times is held back by the network wait, never told his account is locked', async ({ browser }) => {
    test.setTimeout(300_000);
    const ip = world.ip(2);
    const l1 = world.user('L1');
    await resetLimits({ users: [l1], ips: [ip] });
    const page = await (await contextAt(browser, null, ip)).newPage();
    await openLoginPage(page);
    await failFrom(ip, Array.from({ length: 5 }, () => l1.username));

    await submitLogin(page, l1.username, l1.password);
    await expect(loginAlert(page)).toHaveText(NETWORK_THROTTLED);
    await expect(loginAlert(page)).not.toHaveText(ACCOUNT_LOCKED);
    const wait = Number(NETWORK_THROTTLED.exec((await loginAlert(page).innerText()).trim())![1]);
    await page.waitForTimeout((wait + 2) * 1000);
    await submitLogin(page, l1.username, l1.password);
    await expectHome(page, 'SALESMAN');
  });

  test('successful sign-ins from one address never use up its bucket', async () => {
    const ip = world.ip(3);
    const people = ['S1', 'S2', 'S3', 'S4', 'L1', 'M1'].map((k) => world.user(k));
    await resetLimits({ users: people, ips: [ip] });
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      for (const u of people) {
        const r = await apiSignIn(api, u.username, u.password, { ip });
        expect(r.signedIn, `${u.key} signs in`).toBe(true);
      }
    } finally {
      await api.dispose();
    }
    const bucket = await db.rateLimit.findUnique({ where: { key: `login:ip:${ip}` } });
    expect(bucket?.tokens ?? 5, 'six successes left the address its tokens').toBeGreaterThan(4.5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Sign-out (AUTH-LOGOUT, SM-AUTH-SIGNOUT)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: sign-out', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('aso', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SF', role: 'SALESMAN', route: 'A2', supervisor: 'M1', mustChangePassword: true },
      ],
      customers: [{ key: 'C1', phone: true, contact: 'Yusuf Al Kindi', branches: [{ key: 'S', route: 'A', day: 'TODAY' }] }],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('Sign out ends the session on every device, Back shows nothing, and signing in again works at once', async ({ browser }) => {
    test.setTimeout(300_000);
    const s = world.user('S');
    const c1 = world.customer('C1');
    await resetLimits({ users: [s], ips: [world.ip(1), world.ip(2)] });

    // P: his phone, re-read at every request once the 30 s cache allows (lastCheck 0).
    const phone = await (await contextAt(browser, s, world.ip(2), { device: 'phone', lastCheck: 0 })).newPage();
    await phone.goto('/today');
    await expectHome(phone, 'SALESMAN');

    // D: a desktop browser, signed in through the page.
    const desk = await (await contextAt(browser, null, world.ip(1), { device: 'desktop' })).newPage();
    await openLoginPage(desk);
    await submitLogin(desk, s.username, s.password);
    await expectHome(desk, 'SALESMAN');
    await desk.goto(`/customers/${c1.id}`);
    await expect(desk.getByRole('heading', { level: 1 })).toHaveText(c1.legalName);
    await settle(desk);

    const before = (await userRow(s.id)).sessionsRevokedAt?.getTime() ?? 0;
    await desk.getByRole('banner').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(desk).toHaveURL(/\/login(\?|$)/);
    // From here on, record whether the screen ever shows the customer: Back must
    // not render it, not even for a moment. (What Back SHOWS is the point. Sign
    // out is a soft navigation, so this tab's document still carries the inline
    // RSC payload of the customer page loaded before it — a <script> that is
    // never rendered — and page.content() would find the name there.)
    await desk.evaluate((needle) => {
      const w = window as unknown as { __e2eShown?: boolean };
      w.__e2eShown = false;
      const check = () => {
        if (document.body.innerText.includes(needle)) w.__e2eShown = true;
      };
      new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    }, c1.legalName);
    await desk.goBack();
    await expect(desk).toHaveURL(/\/login(\?|$)/);
    await settle(desk);
    await expect(desk.getByRole('button', { name: 'Sign in', exact: true }), 'Back leaves a usable sign-in page').toBeEnabled();
    await expectNoDataLeak(desk, [c1.legalName]);
    const shown = await desk.evaluate(() => (window as unknown as { __e2eShown?: boolean }).__e2eShown);
    // undefined: Back loaded another document, whose visible text was checked just above.
    expect(shown ?? false, 'Back never rendered the customer, not even for a moment').toBe(false);
    for (const path of ['/today', `/customers/${c1.id}`]) {
      await desk.goto(path);
      await expect(desk, path).toHaveURL(/\/login(\?|$)/);
      expect(await desk.content(), path).not.toContain(c1.legalName);
    }
    expect((await auditKinds(s.id)).filter((k) => k === 'LOGOUT:')).toHaveLength(1);
    expect((await userRow(s.id)).sessionsRevokedAt?.getTime() ?? 0).toBeGreaterThan(before);

    // Every device is signed out (AUTH-12): the phone at its next freshness check.
    await expectSignedOut(phone, '/today');

    // Signing in again works at once.
    await openLoginPage(desk);
    await submitLogin(desk, s.username, s.password);
    await expectHome(desk, 'SALESMAN');
  });

  test('Sign out from Me', async ({ browser }) => {
    const s = world.user('S');
    const page = await (await contextAt(browser, s, world.ip(3), { device: 'phone' })).newPage();
    await page.goto('/today');
    await tabBar(page).getByRole('link', { name: 'Me', exact: true }).click();
    await expect(page).toHaveURL(/\/profile(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: 'My profile' })).toBeVisible();
    const logouts = (await auditKinds(s.id)).filter((k) => k === 'LOGOUT:').length;
    await settle(page);
    await page.getByRole('main').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login(\?|$)/);
    expect((await auditKinds(s.id)).filter((k) => k === 'LOGOUT:')).toHaveLength(logouts + 1);
  });

  test('Sign out deletes his unsent form copies from the phone after asking, and leaves a colleague’s; No keeps him signed in', async ({ browser }) => {
    // Wave-1 fix (critic: a shared or lost phone): lib/device-drafts.ts, components/nmwc/SignOutButton.tsx.
    const s = world.user('S');
    const colleague = world.user('M1');
    const page = await (await contextAt(browser, s, world.ip(4), { device: 'phone' })).newPage();
    await page.goto('/today');
    await expectHome(page, 'SALESMAN');
    await settle(page);
    const keys = () =>
      page.evaluate(() =>
        Object.keys(window.localStorage)
          .filter((k) => k.startsWith('nmwc:draft:') || k.startsWith('nmwc:create:'))
          .sort()
      );
    await page.evaluate(
      ([me, other]) => {
        window.localStorage.setItem(`nmwc:draft:${me}:c-one`, '{"contactPerson":"typed on the phone"}');
        window.localStorage.setItem(`nmwc:create:${me}:new`, '{"legalName":"typed on the phone"}');
        window.localStorage.setItem(`nmwc:draft:${other}:c-two`, '{"contactPerson":"a colleague’s"}');
      },
      [s.id, colleague.id] as const
    );
    const signOut = page.getByRole('banner').getByRole('button', { name: 'Sign out', exact: true });
    const question =
      '2 unsent forms are saved on this device. Signing out deletes them, so the next person to use this device cannot read them. Sign out?';

    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await signOut.click();
    await expect.poll(() => asked).toBe(question);
    await page.waitForTimeout(1_500);
    await expect(page, 'No keeps him signed in').toHaveURL(/\/today(\?|$)/);
    expect(await keys()).toHaveLength(3);

    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await signOut.click();
    await expect(page).toHaveURL(/\/login(\?|$)/);
    expect(await keys(), 'only the colleague’s copy is left').toEqual([`nmwc:draft:${colleague.id}:c-two`]);
  });

  test('a link opened signed out goes to sign-in, and after it he lands on his home page, not on the link (recorded)', async ({ browser }) => {
    test.info().annotations.push({
      type: 'recorded behaviour',
      description:
        'No return address is kept: after sign-in loginAction goes to /home, or to the forced change (app/actions/auth.ts). A link shared on WhatsApp or e-mailed must be opened again. Owner to decide.',
    });
    const s = world.user('S');
    const sf = world.user('SF');
    const c1 = world.customer('C1');
    await resetLimits({ users: [s, sf], ips: [world.ip(5), world.ip(6)] });

    const page = await (await contextAt(browser, null, world.ip(5), { device: 'phone' })).newPage();
    await page.goto(`/customers/${c1.id}`);
    await expect(page).toHaveURL(/\/login(\?|$)/);
    await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    await submitLogin(page, s.username, s.password);
    await expectHome(page, 'SALESMAN');

    // Someone who must still change his password lands on the change page.
    const flagged = await (await contextAt(browser, null, world.ip(6), { device: 'phone' })).newPage();
    await flagged.goto(`/customers/${c1.id}`);
    await expect(flagged).toHaveURL(/\/login(\?|$)/);
    await flagged.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    await submitLogin(flagged, sf.username, sf.password);
    await expectForcedChangePage(flagged);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. A voluntary change (SM-AUTH-VOLUNTARY-CHANGE) and Me (SM-PROFILE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: Me, and changing the password from it', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('avc', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'S', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'S2', role: 'SALESMAN', route: 'A2', supervisor: 'M1' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('Me shows his own account: name, sign-in name, role, supervisor, route and this sign-in in Oman time', async ({ browser }) => {
    const s = world.user('S');
    const ip = world.ip(1);
    await resetLimits({ users: [s], ips: [ip] });
    const page = await (await contextAt(browser, null, ip)).newPage();
    await openLoginPage(page);
    await submitLogin(page, s.username, s.password);
    await expectHome(page, 'SALESMAN');
    const lastLoginAt = (await userRow(s.id)).lastLoginAt!;

    await tabBar(page).getByRole('link', { name: 'Me', exact: true }).click();
    await expect(page).toHaveURL(/\/profile(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: 'My profile' })).toBeVisible();
    const route = world.route('A');
    const region = world.region('R1');
    await expect(profileValue(page, 'Full name')).toHaveText(s.fullName);
    await expect(profileValue(page, 'Username')).toHaveText(s.username);
    await expect(profileValue(page, 'Role')).toHaveText('SALESMAN');
    await expect(profileValue(page, 'Reports to')).toHaveText(world.user('M1').fullName);
    await expect(profileValue(page, 'Route')).toHaveText(`${route.code} · ${route.name} (${region.name})`);
    // This sign-in (written at sign-in, before the page), on the Oman clock (wave-1 fix: no UTC).
    await expect(profileValue(page, 'Last login')).toHaveText(omanDateTime(lastLoginAt));
    await expect(page.getByRole('main').getByRole('link', { name: 'Change password', exact: true })).toHaveAttribute('href', '/profile/change-password');
    await expect(page.getByRole('main').getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const other = world.user('S2');
    await expectNoDataLeak(page, [other.fullName, other.username]);
  });

  test('a change from Me: the new password takes over, this phone stays signed in, the old password and other devices are out', async ({ browser }) => {
    test.setTimeout(300_000);
    const s = world.user('S');
    await resetLimits({ users: [s], ips: [world.ip(2), world.ip(3), world.ip(4)] });

    // Another device of his (re-read at every request once the 30 s cache allows).
    const other = await (await contextAt(browser, s, world.ip(3), { lastCheck: 0 })).newPage();
    await other.goto('/today');
    await expectHome(other, 'SALESMAN');

    const page = await (await contextAt(browser, s, world.ip(2))).newPage();
    await page.goto('/today');
    await tabBar(page).getByRole('link', { name: 'Me', exact: true }).click();
    await expect(page).toHaveURL(/\/profile(\?|$)/);
    await page.getByRole('main').getByRole('link', { name: 'Change password', exact: true }).click();
    await expect(page).toHaveURL(CHANGE_PAGE);
    await expect(pageSubtitle(page)).toHaveText(VOLUNTARY_SUBTITLE);
    await expect(page.getByText(TEMPORARY_NOTE)).toHaveCount(0);

    const old = s.password;
    const next = freshPassword();
    await changeOwnPassword(page, old, next, /\/today(\?|$)/);
    s.password = next;
    await expectHome(page, 'SALESMAN');

    // The other device ends at its next freshness check…
    await expectSignedOut(other, '/today');
    // …while this phone, renewed by the change (wave-1 fix 48), is still signed in.
    await page.goto('/today');
    await expectHome(page, 'SALESMAN');

    const anon = await (await contextAt(browser, null, world.ip(4))).newPage();
    await openLoginPage(anon);
    await submitLogin(anon, s.username, old);
    await expect(loginAlert(anon)).toHaveText(INVALID_LOGIN);
    await submitLogin(anon, s.username, next);
    await expectHome(anon, 'SALESMAN');

    expect(await historyHolds(s.id, old)).toBe(true);
    expect((await auditKinds(s.id)).filter((k) => k === 'UPDATE:self_password_change')).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Revocation: disable and role change (AUTH-DISABLE-REVOKES)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a disable or a role change ends the live session', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('arv', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'T', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'MG', role: 'MANAGER', regions: ['R1'] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('a disabled salesman is out within the cache window everywhere; a session under five minutes old is not re-read; Enable lets him back', async ({ browser }) => {
    test.setTimeout(300_000);
    const t = world.user('T');
    const stw = world.user('STW');
    await resetLimits({ users: [t], ips: [world.ip(2), world.ip(3), world.ip(4)] });

    const live = await (await contextAt(browser, t, world.ip(2), { device: 'phone', lastCheck: 0 })).newPage();
    await live.goto('/today');
    await expectHome(live, 'SALESMAN');
    const probe = `/api/photos/${newId()}`;
    expect((await live.request.get(probe, { failOnStatusCode: false })).status(), 'signed in: not found').toBe(404);
    // A session issued just now: its freshness re-read is up to five minutes away.
    const young = await (await contextAt(browser, t, world.ip(3), { device: 'phone' })).newPage();
    await young.goto('/today');
    await expectHome(young, 'SALESMAN');

    const admin = await (await contextAt(browser, stw, world.ip(1), { device: 'desktop' })).newPage();
    await admin.goto('/users');
    await settle(admin);
    let asked = '';
    admin.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await usersAction(admin, () => usersRow(admin, t.username).getByRole('button', { name: 'Disable', exact: true }).click());
    expect(asked).toBe(`Disable user "${t.username}"? They can no longer sign in, and the row leaves the Active list.`);
    await expect(usersBanner(admin)).toContainText(`Disabled "${t.username}". It is on the Disabled tab, where Enable puts it back.`);

    // Within the 30 s per-instance cache, every way in refuses him.
    await expect
      .poll(async () => (await live.request.get(probe, { failOnStatusCode: false })).status(), { timeout: 45_000, intervals: [3_000] })
      .toBe(401);
    const refused = await postForm(live, 'customer-edit', {});
    expect(refused).toMatchObject({ status: 401, ok: false, code: 'SIGNED_OUT', message: 'You are signed out, so nothing was sent.' });
    await live.goto('/today');
    await expect(live).toHaveURL(/\/login(\?|$)/);

    // Documented latency (lib/auth.ts JWT_FRESHNESS_MS): a cookie is re-read only five minutes after it was issued.
    test.info().annotations.push({
      type: 'documented latency',
      description: 'A session younger than five minutes is not re-read: a disabled account keeps it until then (AUTH-12).',
    });
    await young.goto('/today');
    await expectHome(young, 'SALESMAN');

    await expectSignInRefused(browser, t, world.ip(4), INVALID_LOGIN);
    expect(await auditKinds(t.id)).toContain('LOGIN_FAIL:inactive');
    expect((await userRow(t.id)).ownedRouteId, 'the route stays his').toBe(world.route('A').id);

    await admin.goto('/users?status=disabled');
    await settle(admin);
    admin.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await usersAction(admin, () => usersRow(admin, t.username).getByRole('button', { name: 'Enable', exact: true }).click());
    expect(asked).toBe(`Enable user "${t.username}"?`);
    await expect(usersBanner(admin)).toContainText(`Enabled "${t.username}".`);
    const back = await signIn(browser, t, world.ip(4));
    await expectHome(back, 'SALESMAN');
  });

  test('a role change on Edit account ends the session; signed in again he has the Viewer’s menu and no approvals', async ({ browser }) => {
    test.setTimeout(300_000);
    const mg = world.user('MG');
    const stw = world.user('STW');
    const r1 = world.region('R1');
    await resetLimits({ users: [mg], ips: [world.ip(5), world.ip(6)] });

    const old = await (await contextAt(browser, mg, world.ip(5), { device: 'desktop', lastCheck: 0 })).newPage();
    await old.goto('/dashboard');
    await expectHome(old, 'MANAGER');
    const probe = `/api/photos/${newId()}`;
    expect((await old.request.get(probe, { failOnStatusCode: false })).status()).toBe(404);
    const revokedBefore = (await userRow(mg.id)).sessionsRevokedAt?.getTime() ?? 0;

    const admin = await (await contextAt(browser, stw, world.ip(1), { device: 'desktop' })).newPage();
    await admin.goto('/users');
    await settle(admin);
    const dialog = await openEditDialog(admin, mg.username);
    await dialog.getByLabel('Role', { exact: true }).selectOption({ label: ROLE_LABEL.VIEWER });
    await expect(dialog).toContainText('A new role signs the person out; they sign in again to pick it up.');
    await saveEditDialog(admin, dialog);
    await expect(usersBanner(admin)).toContainText(
      `Saved "${mg.username}": role, regions. They are signed out and sign in again to pick up the change.`
    );

    const row = await userRow(mg.id);
    expect(row.role).toBe('VIEWER');
    expect(row.managedRegions).toEqual([]);
    expect(row.sessionsRevokedAt?.getTime() ?? 0).toBeGreaterThan(revokedBefore);
    const edit = (await auditFor({ entityId: mg.id, action: 'UPDATE' })).find((a) => a.reason === 'account_edit');
    expect(edit?.actorId).toBe(stw.id);
    expect(edit?.before).toEqual({ role: 'MANAGER', regions: [r1.code] });
    expect(edit?.after).toEqual({ role: 'VIEWER', regions: [] });

    await expect
      .poll(async () => (await old.request.get(probe, { failOnStatusCode: false })).status(), { timeout: 45_000, intervals: [3_000] })
      .toBe(401);
    await old.goto('/dashboard');
    await expect(old).toHaveURL(/\/login(\?|$)/);

    const page = await signIn(browser, mg, world.ip(6));
    await expectHome(page, 'VIEWER');
    await expectItems(menuNav(page), MENU_BY_ROLE.VIEWER, 'the Viewer’s sidebar');
    await page.goto('/approvals');
    await expectHome(page, 'VIEWER');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Demo accounts (AUTH-DEMO-ACCOUNTS); the server runs DEMO_ACCOUNTS_DISABLED=true
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: demo usernames', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('adm', {});
    // Names carry the world suffix, so cleanup finds them; the first two match
    // lib/demo-accounts.ts (salesman.* / supervisor.*), the third does not.
    await world.addUser({ key: 'DS', role: 'SALESMAN', username: `salesman.e2e${world.sfx}` });
    await world.addUser({ key: 'DV', role: 'SUPERVISOR', username: `supervisor.e2e${world.sfx}` });
    await world.addUser({ key: 'DST', role: 'STEWARD', username: `e2e.data.steward.${world.sfx}` });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('demo names are refused with the one message; a real name with “steward” in it signs in; /users marks the demo rows', async ({ browser }) => {
    const ds = world.user('DS');
    const dv = world.user('DV');
    const dst = world.user('DST');
    await resetLimits({ users: [ds, dv, dst], ips: [world.ip(1), world.ip(2), world.ip(3)] });
    for (const [i, u] of [ds, dv].entries()) {
      await expectSignInRefused(browser, u, world.ip(i + 1), INVALID_LOGIN);
      expect(await auditKinds(u.id), u.username).toEqual(['LOGIN_FAIL:demo_disabled']);
    }
    const page = await signIn(browser, dst, world.ip(3));
    await expectHome(page, 'STEWARD');
    await page.goto('/users');
    for (const u of [ds, dv]) await expect(usersRow(page, u.username), u.username).toContainText('Cannot sign in');
    await expect(usersRow(page, dst.username)).not.toContainText('Cannot sign in');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. /users, the Steward: creating accounts (SV-USERS-CREATE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the Steward creates accounts on /users', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;
  let created: { id: string; username: string; password: string } | undefined;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('auc', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'FREE', region: 'R1' },
        { key: 'FREE2', region: 'R1' },
        { key: 'OFF', region: 'R1', isActive: false },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'ACE', role: 'ACCOUNTANT', regions: ['R1'] },
      ],
    });
    await db.user.update({ where: { id: world.user('ACE').id }, data: { email: `acc.${world.sfx}@example.com` } });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('the route list offers active free routes only, and each refusal lands on its field', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const sa = world.user('SA');
    const m1 = world.user('M1');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    const form = createForm(page);
    await expect(form.locator('select[name="role"]'), 'Salesman first').toHaveValue('SALESMAN');
    const routes = form.locator('select[name="ownedRouteId"]');
    for (const [k, offered] of [
      ['FREE', 1],
      ['FREE2', 1],
      ['A', 0],
      ['OFF', 0],
    ] as const) {
      await expect(routes.locator(`option[value="${world.route(k).id}"]`), `route ${k}`).toHaveCount(offered);
    }

    // A username somebody holds.
    let f = await createUserViaUi(page, { fullName: world.name('Dup'), username: sa.username, role: ROLE_LABEL.VIEWER, password: freshPassword() });
    await expect(f.getByText('Username already taken.', { exact: true })).toBeVisible();
    // Eleven characters.
    f = await createUserViaUi(page, { fullName: world.name('Short'), username: `e2e.short.${world.sfx}`, role: ROLE_LABEL.VIEWER, password: 'E2e-short-1' });
    await expect(f.getByText('Password must be at least 12 characters', { exact: true })).toBeVisible();
    // An e-mail another account holds, in other capitals (wave-1 fix #37).
    f = await createUserViaUi(page, {
      fullName: world.name('Mail'),
      username: `e2e.mail.${world.sfx}`,
      role: ROLE_LABEL.VIEWER,
      email: `ACC.${world.SFX}@Example.COM`,
      password: freshPassword(),
    });
    await expect(f.getByText('That e-mail is already used by another account.', { exact: true })).toBeVisible();
    // A route another Steward gave away while this page was open.
    await page.goto('/users');
    await settle(page);
    const race = await world.addUser({ key: 'RACE', role: 'SALESMAN', route: 'FREE2', supervisor: 'M1' });
    const free2 = world.route('FREE2');
    f = await fillCreateForm(page, {
      fullName: world.name('Late'),
      role: ROLE_LABEL.SALESMAN,
      routeId: free2.id,
      username: `e2e.late.${world.sfx}`,
      supervisorId: m1.id,
      password: freshPassword(),
    });
    await usersAction(page, () => f.getByRole('button', { name: 'Create user', exact: true }).click());
    await expect(
      f.getByText(
        `Route ${free2.code} is worked by ${race.fullName} (${race.username}), whose account is active. A route has one salesman: disable him first if he has left, or move him to another route first.`,
        { exact: true }
      )
    ).toBeVisible();

    const none = await db.user.count({
      where: { username: { in: [`e2e.short.${world.sfx}`, `e2e.mail.${world.sfx}`, `e2e.late.${world.sfx}`] } },
    });
    expect(none, 'nothing refused was created').toBe(0);
  });

  test('a salesman on a free route: his username is the route code, he must change the password, and he has not signed in yet', async ({ browser }) => {
    const stw = world.user('STW');
    const m1 = world.user('M1');
    const free = world.route('FREE');
    const username = free.code.toLowerCase();
    const password = freshPassword();
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const form = await fillCreateForm(page, {
      fullName: world.name('Newman'),
      role: ROLE_LABEL.SALESMAN,
      routeId: free.id,
      supervisorId: m1.id,
      password,
    });
    await expect(form.locator('input[name="nmwc-new-account-handle"]'), 'the route code fills the username').toHaveValue(username);
    await usersAction(page, () => form.getByRole('button', { name: 'Create user', exact: true }).click());
    await expect(form.getByText(/^User created\./)).toBeVisible();
    await expect(form.locator('select[name="role"]'), 'the form is reset to Salesman').toHaveValue('SALESMAN');
    world.adopt.user(username);

    const user = await db.user.findUniqueOrThrow({
      where: { username },
      select: { id: true, role: true, mustChangePassword: true, ownedRouteId: true, supervisorId: true, lastLoginAt: true },
    });
    world.adopt.userId(user.id);
    expect(user).toMatchObject({ role: 'SALESMAN', mustChangePassword: true, ownedRouteId: free.id, supervisorId: m1.id, lastLoginAt: null });
    const row = usersRow(page, username);
    await expect(row).toContainText('Not signed in yet');
    await expect(row.locator('td').nth(4), 'Route').toHaveText(free.code);
    await expect(row.locator('td').nth(7), 'Last login').toHaveText('never');
    const audit = (await auditFor({ entityId: user.id, action: 'CREATE' }))[0];
    expect(audit?.actorId).toBe(stw.id);
    expect(audit?.after).toEqual({ username, role: 'SALESMAN', route: free.code, supervisor: m1.username, regions: [] });
    created = { id: user.id, username, password };
  });

  test('the new salesman signs in on his phone, is made to change the password, and lands on Today', async ({ browser }) => {
    test.skip(!created, 'the salesman was not created');
    const ip = world.ip(2);
    await resetLimits({ ips: [ip] });
    const page = await (await contextAt(browser, null, ip, { device: 'phone' })).newPage();
    await openLoginPage(page);
    await submitLogin(page, created!.username, created!.password);
    await expectForcedChangePage(page);
    await changeOwnPassword(page, created!.password, freshPassword(), /\/today(\?|$)/);
    await expectHome(page, 'SALESMAN');
    expect((await userRow(created!.id)).mustChangePassword).toBe(false);
  });

  test('one account of each approver role, listed in the roster’s role order; a Manager or an Accountant needs a region', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const r1 = world.region('R1');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();

    const f = await createUserViaUi(page, {
      fullName: world.name('Noregion'),
      username: `e2e.noreg.${world.sfx}`,
      role: ROLE_LABEL.MANAGER,
      password: freshPassword(),
    });
    await expect(
      f.getByText('A Manager or Accountant must manage at least one region, or he sees nothing and can approve nothing.', { exact: true })
    ).toBeVisible();

    const plan: Array<{ role: Role; key: string; regions?: string[] }> = [
      { role: 'GM', key: 'ngm' },
      { role: 'FINANCE_MANAGER', key: 'nfm' },
      { role: 'ACCOUNTANT', key: 'nacc', regions: [r1.id] },
      { role: 'MANAGER', key: 'nmgr', regions: [r1.id] },
      { role: 'SUPERVISOR', key: 'nsup' },
      { role: 'VIEWER', key: 'nvw' },
    ];
    for (const p of plan) {
      const username = `e2e.${p.key}.${world.sfx}`;
      const form = await createUserViaUi(page, {
        fullName: world.name(`New ${p.key}`),
        username,
        role: ROLE_LABEL[p.role],
        regionIds: p.regions,
        password: freshPassword(),
      });
      await expect(form.getByText(/^User created\./), username).toBeVisible();
      world.adopt.user(username);
      const u = await userRow((await db.user.findUniqueOrThrow({ where: { username }, select: { id: true } })).id);
      expect(u.role).toBe(p.role);
      expect(u.mustChangePassword).toBe(true);
      expect(u.managedRegions.map((g) => g.code)).toEqual(p.regions ? [r1.code] : []);
    }

    await page.goto('/users');
    const order = await rosterUsernames(page);
    const at = plan.map((p) => order.indexOf(`e2e.${p.key}.${world.sfx}`));
    expect(at.every((i) => i >= 0), 'every new account is listed').toBe(true);
    expect([...at].sort((x, y) => x - y), 'GM, FM, Accountant, Manager, Supervisor, Viewer').toEqual(at);
    for (const p of plan) {
      const row = usersRow(page, `e2e.${p.key}.${world.sfx}`);
      await expect(row).toContainText('Not signed in yet');
      await expect(row.locator('td').nth(5), `${p.role} regions`).toHaveText(p.regions ? r1.code : '—');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. /users, the Steward: reset, disable, own row (SV-USERS-RESET-PASSWORD, SV-USERS-DISABLE-ENABLE,
//     SV-USERS-GUARD-MESSAGES, AUTH-MANAGER-RESET: the Steward resets the GM)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the Steward resets, disables and enables on /users', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('aur', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SR', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SD', role: 'SALESMAN', route: 'A2', supervisor: 'M1' },
        { key: 'GM1', role: 'GM' },
      ],
    });
    // SR has claimed his account before (a reset then reads "Password change pending").
    await db.user.update({ where: { id: world.user('SR').id }, data: { lastLoginAt: new Date(Date.now() - 2 * 86_400_000) } });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('reset: a mismatch sends nothing; a match ends his live session and forces a change; a reused password is refused in red', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const sr = world.user('SR');
    await resetLimits({ users: [sr], ips: [world.ip(2), world.ip(3)] });

    const phone = await (await contextAt(browser, sr, world.ip(2), { device: 'phone', lastCheck: 0 })).newPage();
    await phone.goto('/today');
    await expectHome(phone, 'SALESMAN');

    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const row = usersRow(page, sr.username);
    await row.getByRole('button', { name: 'Reset password', exact: true }).click();
    const form = row.locator('form').filter({ has: page.locator('input[name="confirmPassword"]') });
    const pw = form.locator('input[name="password"]');
    const confirm = form.locator('input[name="confirmPassword"]');

    await fillSecret(pw, freshPassword());
    await fillSecret(confirm, freshPassword());
    const sent = await postsDuring(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    await clearSecretFields(page);
    expect(sent, 'nothing is sent').toBe(0);
    await expect(form.getByRole('alert')).toHaveText('The two new passwords do not match.');
    // Show turns both boxes into plain text and back (they are empty by now).
    const show = form.getByRole('button', { name: 'Show new password' });
    await show.click();
    await expect(pw).toHaveAttribute('type', 'text');
    await expect(confirm).toHaveAttribute('type', 'text');
    await show.click();
    await expect(pw).toHaveAttribute('type', 'password');
    await expect(confirm).toHaveAttribute('type', 'password');

    const before = await userRow(sr.id);
    const history = await db.passwordHistory.count({ where: { userId: sr.id } });
    const temp = freshPassword();
    await fillSecret(pw, temp);
    await fillSecret(confirm, temp);
    await usersAction(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    await expect(row.getByRole('status')).toHaveText('Password updated.');
    const after = await userRow(sr.id);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(true);
    expect(after.sessionsRevokedAt?.getTime() ?? 0).toBeGreaterThan(before.sessionsRevokedAt?.getTime() ?? 0);
    expect(await db.passwordHistory.count({ where: { userId: sr.id } })).toBe(history + 1);
    const reset = (await auditFor({ entityId: sr.id, action: 'UPDATE' })).filter((a) => a.reason === 'password_reset');
    expect(reset.map((a) => a.actorId)).toEqual([stw.id]);
    await expect(row, 'he has signed in before').toContainText('Password change pending');

    // His phone is out at its next freshness check.
    await expectSignedOut(phone, '/today');
    // The temporary password forces a change, then Today.
    const again = await (await contextAt(browser, null, world.ip(3), { device: 'phone' })).newPage();
    await openLoginPage(again);
    await submitLogin(again, sr.username, temp);
    await expectForcedChangePage(again);
    const mine = freshPassword();
    await changeOwnPassword(again, temp, mine, /\/today(\?|$)/);
    sr.password = mine;

    // The temporary one again: refused, and the refusal reads as an error (wave-1 fix #7).
    await page.goto('/users');
    await settle(page);
    await usersRow(page, sr.username).getByRole('button', { name: 'Reset password', exact: true }).click();
    const form2 = usersRow(page, sr.username).locator('form').filter({ has: page.locator('input[name="confirmPassword"]') });
    await fillSecret(form2.locator('input[name="password"]'), temp);
    await fillSecret(form2.locator('input[name="confirmPassword"]'), temp);
    await usersAction(page, () => form2.getByRole('button', { name: 'Save', exact: true }).click());
    const refusal = usersRow(page, sr.username).getByRole('alert');
    await expect(refusal).toContainText('You cannot reuse one of your last 5 passwords.');
    await expect(refusal).toHaveClass(/text-red-600/);
    await expect(usersRow(page, sr.username).getByRole('status')).toHaveCount(0);
    expect(await passwordIs(sr.id, mine), 'nothing changed').toBe(true);
  });

  test('the Steward resets the GM’s password', async ({ browser }) => {
    const stw = world.user('STW');
    const gm = world.user('GM1');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const row = usersRow(page, gm.username);
    await row.getByRole('button', { name: 'Reset password', exact: true }).click();
    const form = row.locator('form').filter({ has: page.locator('input[name="confirmPassword"]') });
    const temp = freshPassword();
    await fillSecret(form.locator('input[name="password"]'), temp);
    await fillSecret(form.locator('input[name="confirmPassword"]'), temp);
    await usersAction(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    await expect(row.getByRole('status')).toHaveText('Password updated.');
    expect((await userRow(gm.id)).mustChangePassword).toBe(true);
    expect(await passwordIs(gm.id, temp)).toBe(true);
    expect((await auditKinds(gm.id))).toContain('UPDATE:password_reset');
    gm.password = temp;
  });

  test('disable and enable: the banner, the tabs, a refused sign-in, and the route stays his', async ({ browser }) => {
    test.setTimeout(240_000);
    const stw = world.user('STW');
    const sd = world.user('SD');
    await resetLimits({ users: [sd], ips: [world.ip(4)] });
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await usersAction(page, () => usersRow(page, sd.username).getByRole('button', { name: 'Disable', exact: true }).click());
    expect(asked).toBe(`Disable user "${sd.username}"? They can no longer sign in, and the row leaves the Active list.`);
    await expect(usersBanner(page)).toContainText(`Disabled "${sd.username}". It is on the Disabled tab, where Enable puts it back.`);
    await expect(usersRow(page, sd.username), 'the row leaves the Active list').toHaveCount(0);
    const tabs = await tabCounts(page);
    expect(tabs.active + tabs.disabled).toBe(tabs.all);
    await expect(pageSubtitle(page)).toHaveText(new RegExp(`^${tabs.active} active accounts? · ${tabs.disabled} hidden by this filter$`));

    const row = await userRow(sd.id);
    expect(row.isActive).toBe(false);
    expect(row.sessionsRevokedAt).not.toBeNull();
    expect(row.ownedRouteId, 'the route stays his (route codes are usernames)').toBe(world.route('A2').id);
    const disabled = (await auditFor({ entityId: sd.id, action: 'UPDATE' })).find((a) => a.reason === 'disabled');
    expect(disabled?.before).toEqual({ isActive: true });
    expect(disabled?.after).toEqual({ isActive: false });
    await expectSignInRefused(browser, sd, world.ip(4), INVALID_LOGIN);

    await page.goto('/users?status=disabled');
    await settle(page);
    await expect(usersRow(page, sd.username)).toContainText('Disabled');
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await usersAction(page, () => usersRow(page, sd.username).getByRole('button', { name: 'Enable', exact: true }).click());
    expect(asked).toBe(`Enable user "${sd.username}"?`);
    await expect(usersBanner(page)).toContainText(`Enabled "${sd.username}".`);
    expect((await userRow(sd.id)).isActive).toBe(true);
    expect(await auditKinds(sd.id)).toContain('UPDATE:enabled');
    const back = await signIn(browser, sd, world.ip(4));
    await expectHome(back, 'SALESMAN');
  });

  test('his own row offers Change my password instead of Disable, Reset, Edit or e-mail', async ({ browser }) => {
    const stw = world.user('STW');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    const row = usersRow(page, stw.username);
    for (const name of ['Disable', 'Reset password', 'Edit', 'Add e-mail', 'Change e-mail']) {
      await expect(row.getByRole('button', { name, exact: true }), name).toHaveCount(0);
    }
    const link = row.getByRole('link', { name: 'Change my password', exact: true });
    await expect(link).toHaveAttribute('href', '/profile/change-password');
    await link.click();
    await expect(page).toHaveURL(CHANGE_PAGE);
    await expect(pageSubtitle(page)).toHaveText(VOLUNTARY_SUBTITLE);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. /users, the Steward: the notification e-mail (SV-USERS-EMAIL-F1, owner decision 6)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: notification e-mail addresses on /users', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('aue', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'MGE', role: 'MANAGER', regions: ['R1'] },
        { key: 'ACE', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'GMX', role: 'GM' },
        { key: 'FMX', role: 'FINANCE_MANAGER' },
        { key: 'SUPX', role: 'SUPERVISOR' },
        { key: 'SAX', role: 'SALESMAN', route: 'A', supervisor: 'MGE' },
        { key: 'VWX', role: 'VIEWER' },
        { key: 'STW2', role: 'STEWARD' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('add, refuse, store lower-case, clash and clear a Manager’s address; it never reaches the page or the audit', async ({ browser }) => {
    test.setTimeout(240_000);
    const stw = world.user('STW');
    const mge = world.user('MGE');
    const ace = world.user('ACE');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const row = usersRow(page, mge.username);
    await row.getByRole('button', { name: 'Add e-mail', exact: true }).click();
    const box = row.getByRole('textbox', { name: `New e-mail for ${mge.username}` });
    const save = row.locator('form').filter({ has: page.locator('input[name="contactAddress"]') }).getByRole('button', { name: 'Save', exact: true });

    await save.click();
    await expect(row.getByRole('alert')).toHaveText('Type the address to add.');
    await box.fill('n/a');
    await usersAction(page, () => save.click());
    await expect(row.getByRole('alert')).toHaveText('Enter a valid e-mail address, or leave the box empty to clear it.');

    const typed = `E2E.Mgr.${world.SFX}@Example.com`;
    const stored = typed.toLowerCase();
    await box.fill(typed);
    await usersAction(page, () => save.click());
    await expect(usersBanner(page)).toContainText(`Saved the e-mail of "${mge.username}".`);
    await expect(usersRow(page, mge.username)).toContainText('E-mail on file');
    expect((await userRow(mge.id)).email).toBe(stored);
    expect((await page.content()).toLowerCase(), 'the address is never sent to the page').not.toContain(stored);

    // The same mailbox for the Accountant, typed in lower case.
    const accRow = usersRow(page, ace.username);
    await accRow.getByRole('button', { name: 'Add e-mail', exact: true }).click();
    const accBox = accRow.getByRole('textbox', { name: `New e-mail for ${ace.username}` });
    await accBox.fill(stored);
    await usersAction(page, () => accRow.locator('form').filter({ has: page.locator('input[name="contactAddress"]') }).getByRole('button', { name: 'Save', exact: true }).click());
    await expect(accRow.getByRole('alert')).toHaveText('That e-mail is already used by another account.');
    expect((await userRow(ace.id)).email).toBeNull();

    // Clearing it asks first.
    await page.goto('/users');
    await settle(page);
    const row2 = usersRow(page, mge.username);
    await row2.getByRole('button', { name: 'Change e-mail', exact: true }).click();
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    const box2 = row2.getByRole('textbox', { name: `New e-mail for ${mge.username}` });
    // The stored address is never sent to the page: the box starts empty, and an empty box clears.
    await expect(box2).toHaveValue('');
    await usersAction(page, () => row2.locator('form').filter({ has: page.locator('input[name="contactAddress"]') }).getByRole('button', { name: 'Save', exact: true }).click());
    expect(asked).toBe(`Clear the e-mail address of "${mge.username}"? Work e-mails stop reaching them.`);
    await expect(usersBanner(page)).toContainText(`Cleared the e-mail of "${mge.username}".`);
    await expect(usersRow(page, mge.username)).not.toContainText('E-mail on file');
    expect((await userRow(mge.id)).email).toBeNull();

    const audits = (await auditFor({ entityId: mge.id, action: 'UPDATE' })).filter((a) => a.reason?.startsWith('email_'));
    expect(audits.map((a) => a.reason)).toEqual(['email_set', 'email_cleared']);
    for (const a of audits) {
      expect(a.actorId).toBe(stw.id);
      expect(a.after).toEqual({ changed: ['email'] });
      expect(JSON.stringify(a).toLowerCase(), 'no address in the audit row').not.toContain(stored);
    }
  });

  test('the e-mail button is on the rows the drain e-mails, the GM’s included, and never on one’s own row', async ({ browser }) => {
    const stw = world.user('STW');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    const offered = ['MGE', 'ACE', 'GMX', 'FMX', 'SUPX'];
    for (const key of offered) {
      await expect(usersRow(page, world.user(key).username).getByRole('button', { name: /^(Add|Change) e-mail$/ }), key).toHaveCount(1);
    }
    for (const key of ['SAX', 'VWX', 'STW2', 'STW']) {
      await expect(usersRow(page, world.user(key).username).getByRole('button', { name: /^(Add|Change) e-mail$/ }), key).toHaveCount(0);
    }
  });

  test('Edit account sets any role’s e-mail, lower-cased; the audit names the field and never the address', async ({ browser }) => {
    const stw = world.user('STW');
    const vw = world.user('VWX');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const dialog = await openEditDialog(page, vw.username);
    const typed = `Viewer.${world.SFX}@Example.com`;
    await dialog.getByLabel('E-mail', { exact: true }).fill(typed);
    await saveEditDialog(page, dialog);
    await expect(usersBanner(page)).toContainText(`Saved "${vw.username}": e-mail.`);
    expect((await userRow(vw.id)).email).toBe(typed.toLowerCase());
    const edit = (await auditFor({ entityId: vw.id, action: 'UPDATE' })).find((a) => a.reason === 'account_edit');
    expect(edit?.after).toEqual({ changed: ['email'] });
    expect(JSON.stringify(edit).toLowerCase()).not.toContain(typed.toLowerCase());
    expect((await page.content()).toLowerCase()).not.toContain(typed.toLowerCase());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16. /users, the Steward: who has not claimed an account (SV-USERS-LIST-CLAIM-STATE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: who has not claimed an account yet', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  const signedIn = { CS2: new Date(Date.now() - 2 * 86_400_000), CS3: new Date(Date.now() - 3 * 86_400_000) };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('aul', {
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'CS1', role: 'VIEWER', mustChangePassword: true },
        { key: 'CS2', role: 'VIEWER', mustChangePassword: true },
        { key: 'CS3', role: 'VIEWER' },
        { key: 'CS4', role: 'VIEWER', mustChangePassword: true, isActive: false },
      ],
    });
    for (const [key, at] of Object.entries(signedIn)) {
      await db.user.update({ where: { id: world.user(key).id }, data: { lastLoginAt: at } });
    }
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('the badges, the count line, the tabs and Last login agree', async ({ browser }) => {
    const page = await (await contextAt(browser, world.user('STW'), world.ip(1))).newPage();
    await page.goto('/users');
    const u = (k: string) => world.user(k).username;

    const cs1 = usersRow(page, u('CS1'));
    await expect(cs1).toContainText('Not signed in yet');
    await expect(cs1.locator('td').nth(7)).toHaveText('never');
    const cs2 = usersRow(page, u('CS2'));
    await expect(cs2).toContainText('Password change pending');
    await expect(cs2.locator('td').nth(7)).toHaveText(omanDate(signedIn.CS2));
    const cs3 = usersRow(page, u('CS3'));
    await expect(cs3).not.toContainText('Not signed in yet');
    await expect(cs3).not.toContainText('Password change pending');
    await expect(cs3.locator('td').nth(7)).toHaveText(omanDate(signedIn.CS3));
    await expect(usersRow(page, u('CS4')), 'a disabled account is not on Active').toHaveCount(0);

    // One render: the line counts exactly the badges on the rows shown, and the tabs add up.
    const line = await countLine(page);
    const body = page.locator('tbody');
    expect(line.shown).toBe(await page.locator('tbody tr').count());
    expect(line.notSignedIn).toBe(await body.getByText('Not signed in yet', { exact: true }).count());
    expect(line.pending).toBe(await body.getByText('Password change pending', { exact: true }).count());
    const tabs = await tabCounts(page);
    expect(tabs.active + tabs.disabled).toBe(tabs.all);
    expect(tabs.active).toBe(line.shown);
    await expect(pageSubtitle(page)).toHaveText(new RegExp(`^${tabs.active} active accounts? · ${tabs.disabled} hidden by this filter$`));
    await expect(page.getByRole('navigation', { name: 'Filter accounts by status' }).getByRole('link', { name: /^Active/ })).toHaveAttribute('aria-current', 'page');

    await page.goto('/users?status=disabled');
    const cs4 = usersRow(page, u('CS4'));
    await expect(cs4).toContainText('Disabled');
    await expect(cs4, 'no claim badge on a disabled account').not.toContainText('Not signed in yet');
    await expect(cs4.locator('td').nth(7)).toHaveText('never');
    await page.goto('/users?status=all');
    for (const k of ['CS1', 'CS2', 'CS3', 'CS4']) await expect(usersRow(page, u(k)), k).toHaveCount(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17. /users, the Steward: Edit account and the leaver/joiner hand-over (owner decision 8;
//     critic: replacing a salesman on a route; changing a supervisor, route or regions)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: the Steward’s Edit account', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('aed', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'LEAVE', region: 'R1' },
        { key: 'MVR', region: 'R1' },
        { key: 'FREE', region: 'R1' },
        { key: 'FREE3', region: 'R1' },
        { key: 'RREP', region: 'R1' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M2', role: 'MANAGER', regions: ['R1'] },
        { key: 'LV', role: 'SALESMAN', route: 'LEAVE', supervisor: 'M1' },
        { key: 'MV', role: 'SALESMAN', route: 'MVR', supervisor: 'M1' },
        { key: 'MREP', role: 'MANAGER', regions: ['R1'] },
        { key: 'SREP', role: 'SALESMAN', route: 'RREP', supervisor: 'MREP' },
        { key: 'DIS', role: 'SALESMAN', supervisor: 'M1', isActive: false },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('replacing a leaver: disable him, then create the joiner on his route under its code', async ({ browser }) => {
    test.setTimeout(240_000);
    const stw = world.user('STW');
    const lv = world.user('LV');
    const m1 = world.user('M1');
    const leave = world.route('LEAVE');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    page.once('dialog', (d) => void d.accept());
    await usersAction(page, () => usersRow(page, lv.username).getByRole('button', { name: 'Disable', exact: true }).click());
    await expect(usersBanner(page)).toContainText(`Disabled "${lv.username}".`);

    // A route held by a disabled account is offered for the hand-over (and only then).
    const form = createForm(page);
    const option = form.locator(`select[name="ownedRouteId"] option[value="${leave.id}"]`);
    await expect(option).toHaveText(`${leave.code} · ${leave.name} — from ${lv.fullName} (disabled)`);
    const password = freshPassword();
    await fillCreateForm(page, {
      fullName: world.name('Joiner'),
      role: ROLE_LABEL.SALESMAN,
      routeId: leave.id,
      supervisorId: m1.id,
      password,
    });
    await expect(form.locator('input[name="nmwc-new-account-handle"]'), 'the route code is the sign-in name').toHaveValue(lv.username);
    await expect(form).toContainText(
      `The route is taken from ${lv.fullName}’s disabled account, and his sign-in name ${lv.username} is retired if the new salesman signs in with it.`
    );
    await usersAction(page, () => form.getByRole('button', { name: 'Create user', exact: true }).click());
    const retired = `${lv.username}.left.${omanDateISO().replace(/-/g, '')}`;
    await expect(form.getByText(/^User created\./)).toContainText(
      `Route ${leave.code} was taken from ${lv.fullName}'s disabled account, whose sign-in name is now ${retired}.`
    );

    const joiner = await db.user.findUniqueOrThrow({
      where: { username: lv.username },
      select: { id: true, ownedRouteId: true, mustChangePassword: true, supervisorId: true },
    });
    world.adopt.userId(joiner.id);
    expect(joiner.id).not.toBe(lv.id);
    expect(joiner).toMatchObject({ ownedRouteId: leave.id, mustChangePassword: true, supervisorId: m1.id });
    const leaver = await userRow(lv.id);
    expect(leaver).toMatchObject({ username: retired, ownedRouteId: null, isActive: false });
    const reassign = (await auditFor({ entityId: lv.id, action: 'REASSIGN' }))[0];
    expect(reassign?.actorId).toBe(stw.id);
    expect(reassign?.before).toEqual({ ownedRouteCode: leave.code, username: lv.username });
    expect(reassign?.after).toEqual({ ownedRouteCode: null, username: retired });
    lv.username = retired;

    await page.goto('/users?status=disabled');
    await expect(usersRow(page, retired)).toHaveCount(1);
  });

  test('moving a salesman to another route gives him its code as his sign-in name and does not sign him out', async ({ browser }) => {
    const stw = world.user('STW');
    const mv = world.user('MV');
    const m1 = world.user('M1');
    const m2 = world.user('M2');
    const free = world.route('FREE');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const before = await userRow(mv.id);

    const dialog = await openEditDialog(page, mv.username);
    await dialog.getByLabel('Route', { exact: true }).selectOption(free.id);
    const newName = free.code.toLowerCase();
    const takeCode = dialog.getByRole('checkbox', { name: /Sign in with the route code/ });
    await expect(takeCode, 'on by default: he signs in with his route code today').toBeChecked();
    await expect(dialog).toContainText(`${mv.username} becomes ${newName}`);
    await dialog.getByLabel('Supervisor', { exact: true }).selectOption(m2.id);
    await saveEditDialog(page, dialog);
    const banner = usersBanner(page);
    await expect(banner).toContainText(`Saved "${newName}": sign-in name, route, supervisor.`);
    await expect(banner).toContainText(`${mv.fullName} now signs in as ${newName}.`);
    await expect(banner).not.toContainText('signed out');

    const after = await userRow(mv.id);
    expect(after).toMatchObject({ username: newName, ownedRouteId: free.id, supervisorId: m2.id });
    expect(after.sessionsRevokedAt?.getTime() ?? null, 'a route move signs nobody out').toBe(before.sessionsRevokedAt?.getTime() ?? null);
    const edit = (await auditFor({ entityId: mv.id, action: 'UPDATE' })).find((a) => a.reason === 'account_edit');
    expect(edit?.actorId).toBe(stw.id);
    expect(edit?.before).toEqual({ username: mv.username, route: world.route('MVR').code, supervisor: m1.username });
    expect(edit?.after).toEqual({ username: newName, route: free.code, supervisor: m2.username });
    world.adopt.user(newName);
    mv.username = newName;
  });

  test('a Manager’s regions: none, or dropping one his salesmen work in, is refused; adding one signs him out', async ({ browser }) => {
    const stw = world.user('STW');
    const mrep = world.user('MREP');
    const r1 = world.region('R1');
    const r2 = world.region('R2');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const revokedBefore = (await userRow(mrep.id)).sessionsRevokedAt?.getTime() ?? 0;

    const dialog = await openEditDialog(page, mrep.username);
    const box = (code: string) => dialog.locator('label').filter({ hasText: code }).getByRole('checkbox');
    await expect(box(r1.code)).toBeChecked();
    await box(r1.code).uncheck();
    await saveEditDialog(page, dialog);
    await expect(dialog.getByRole('alert')).toHaveText(
      'A Manager or Accountant must manage at least one region, or he sees nothing and can approve nothing.'
    );
    await box(r2.code).check();
    await saveEditDialog(page, dialog);
    await expect(dialog.getByRole('alert')).toHaveText(
      `1 active salesman/salesmen reporting to ${mrep.fullName} work in ${r1.code}. Keep the region, or give them another supervisor first.`
    );
    expect((await userRow(mrep.id)).managedRegions.map((g) => g.code), 'nothing saved yet').toEqual([r1.code]);

    await box(r1.code).check();
    await saveEditDialog(page, dialog);
    await expect(usersBanner(page)).toContainText(
      `Saved "${mrep.username}": regions. They are signed out and sign in again to pick up the change.`
    );
    const after = await userRow(mrep.id);
    expect(after.managedRegions.map((g) => g.code).sort()).toEqual([r1.code, r2.code].sort());
    expect(after.sessionsRevokedAt?.getTime() ?? 0).toBeGreaterThan(revokedBefore);
    const edit = (await auditFor({ entityId: mrep.id, action: 'UPDATE' })).find((a) => a.reason === 'account_edit');
    expect(edit?.before).toEqual({ regions: [r1.code] });
    expect(edit?.after).toEqual({ regions: [r1.code, r2.code].sort() });
    await expect(usersRow(page, mrep.username).locator('td').nth(5)).toHaveText([r1.code, r2.code].sort().join(', '));
  });

  test('an account others report to keeps a supervising role; a disabled account is given no route; a phone edit is audited without the number', async ({ browser }) => {
    const stw = world.user('STW');
    const mrep = world.user('MREP');
    const dis = world.user('DIS');
    const free3 = world.route('FREE3');
    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);

    let dialog = await openEditDialog(page, mrep.username);
    await dialog.getByLabel('Role', { exact: true }).selectOption({ label: ROLE_LABEL.VIEWER });
    await saveEditDialog(page, dialog);
    await expect(dialog.getByRole('alert')).toHaveText(
      `1 account(s) report to ${mrep.fullName}. Give them another supervisor before changing this role.`
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await userRow(mrep.id)).role).toBe('MANAGER');

    await page.goto('/users?status=disabled');
    await settle(page);
    dialog = await openEditDialog(page, dis.username);
    await expect(dialog).toContainText('This account is disabled.');
    await dialog.getByLabel('Route', { exact: true }).selectOption(free3.id);
    await saveEditDialog(page, dialog);
    await expect(dialog.getByRole('alert')).toHaveText(
      `${dis.fullName}'s account is disabled, so route ${free3.code} is not given to it. Enable the account first.`
    );
    await dialog.getByLabel('Route', { exact: true }).selectOption('');
    const phone = `+9689${String(Date.now()).slice(-7)}`;
    await dialog.getByLabel('Phone', { exact: true }).fill(phone);
    await saveEditDialog(page, dialog);
    await expect(usersBanner(page)).toContainText(`Saved "${dis.username}": phone.`);
    const after = await userRow(dis.id);
    expect(after).toMatchObject({ phone, ownedRouteId: null, isActive: false });
    const edit = (await auditFor({ entityId: dis.id, action: 'UPDATE' })).find((a) => a.reason === 'account_edit');
    expect(edit?.after).toEqual({ changed: ['phone'] });
    expect(JSON.stringify(edit), 'the number is never copied into the audit').not.toContain(phone.slice(-7));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18. /users, a Manager (MGR-USERS-ADMIN, AUTH-MANAGER-RESET, the own-row half of MGR-USERS-FORBIDDEN)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a Manager’s /users', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('amu', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
        { key: 'FREE', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M2', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SA2', role: 'SALESMAN', route: 'A2', supervisor: 'M2' },
        { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
        { key: 'SUP', role: 'SUPERVISOR' },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('M2 sees his region’s salesmen and himself, and is offered Salesman or Supervisor, his region’s supervisors and its free route', async ({ browser }) => {
    const m2 = world.user('M2');
    const page = await (await contextAt(browser, m2, world.ip(1))).newPage();
    await page.goto('/users');
    await expect(pageSubtitle(page)).toHaveText('3 active accounts in your regions');
    expect((await rosterUsernames(page)).sort()).toEqual([m2, world.user('SA'), world.user('SA2')].map((u) => u.username).sort());
    expect(await countLine(page)).toEqual({ shown: 3, notSignedIn: 0, pending: 0 });

    const form = createForm(page);
    expect(await form.locator('select[name="role"] option').allInnerTexts()).toEqual(['Salesman', 'Supervisor']);
    const sups = await form.locator('select[name="supervisorId"] option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(sups).toContain(m2.id);
    expect(sups).toContain(world.user('M1').id);
    expect(sups).not.toContain(world.user('M5').id);
    const routes = await form.locator('select[name="ownedRouteId"] option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(routes, 'only the free route of his region').toEqual([world.route('FREE').id]);
    await expect(form.locator('input[name="regionId"]')).toHaveCount(0);

    // No Steward-only tools.
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Add|Change) e-mail$/ })).toHaveCount(0);
    // His own row: the self-service link, not Disable or Reset (wave-1 fix #7).
    const own = usersRow(page, m2.username);
    await expect(own.getByRole('button', { name: 'Disable', exact: true })).toHaveCount(0);
    await expect(own.getByRole('button', { name: 'Reset password', exact: true })).toHaveCount(0);
    await expect(own.getByRole('link', { name: 'Change my password', exact: true })).toHaveAttribute('href', '/profile/change-password');
  });

  test('M2 creates a salesman on the free route of his region', async ({ browser }) => {
    const m2 = world.user('M2');
    const free = world.route('FREE');
    const page = await (await contextAt(browser, m2, world.ip(1))).newPage();
    const form = await createUserViaUi(page, {
      fullName: world.name('Mgr made'),
      role: ROLE_LABEL.SALESMAN,
      routeId: free.id,
      supervisorId: m2.id,
      password: freshPassword(),
    });
    await expect(form.getByText(/^User created\./)).toBeVisible();
    const username = free.code.toLowerCase();
    world.adopt.user(username);
    const u = await db.user.findUniqueOrThrow({ where: { username }, select: { id: true, mustChangePassword: true, ownedRouteId: true } });
    world.adopt.userId(u.id);
    expect(u).toMatchObject({ mustChangePassword: true, ownedRouteId: free.id });
    expect((await auditFor({ entityId: u.id, action: 'CREATE' }))[0]?.actorId).toBe(m2.id);
    await page.goto('/users');
    await expect(usersRow(page, username)).toContainText('Not signed in yet');
    expect(await countLine(page)).toEqual({ shown: 4, notSignedIn: 1, pending: 0 });
  });

  test('M2 resets SA: a mismatch sends nothing, a short one is refused in red, a match forces SA to change at his next sign-in', async ({ browser }) => {
    test.setTimeout(240_000);
    const m2 = world.user('M2');
    const sa = world.user('SA');
    await resetLimits({ users: [sa], ips: [world.ip(2)] });
    const page = await (await contextAt(browser, m2, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    const row = usersRow(page, sa.username);
    await row.getByRole('button', { name: 'Reset password', exact: true }).click();
    const form = row.locator('form').filter({ has: page.locator('input[name="confirmPassword"]') });
    const pw = form.locator('input[name="password"]');
    const confirm = form.locator('input[name="confirmPassword"]');

    await fillSecret(pw, freshPassword());
    await fillSecret(confirm, freshPassword());
    const sent = await postsDuring(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    await clearSecretFields(page);
    expect(sent).toBe(0);
    await expect(form.getByRole('alert')).toHaveText('The two new passwords do not match.');

    await pw.evaluate((el) => el.removeAttribute('minlength'));
    await fillSecret(pw, 'E2e-short-1');
    await fillSecret(confirm, 'E2e-short-1');
    await usersAction(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    const refusal = row.locator('span[role="alert"]');
    await expect(refusal).toHaveText('Password must be at least 12 characters');
    await expect(refusal).toHaveClass(/text-red-600/);
    expect((await userRow(sa.id)).mustChangePassword).toBe(false);

    const temp = freshPassword();
    await fillSecret(pw, temp);
    await fillSecret(confirm, temp);
    await usersAction(page, () => form.getByRole('button', { name: 'Save', exact: true }).click());
    await expect(row.getByRole('status')).toHaveText('Password updated.');
    expect((await userRow(sa.id)).mustChangePassword).toBe(true);
    const reset = (await auditFor({ entityId: sa.id, action: 'UPDATE' })).filter((a) => a.reason === 'password_reset');
    expect(reset.map((a) => a.actorId)).toEqual([m2.id]);

    const again = await (await contextAt(browser, null, world.ip(2), { device: 'phone' })).newPage();
    await openLoginPage(again);
    await submitLogin(again, sa.username, temp);
    await expectForcedChangePage(again);
    const mine = freshPassword();
    await changeOwnPassword(again, temp, mine, /\/today(\?|$)/);
    sa.password = mine;
    // The temporary password worked once.
    await expectSignInRefused(browser, { username: sa.username, password: temp }, world.ip(2), INVALID_LOGIN, 'phone');
  });

  test('M2 disables and enables SA2', async ({ browser }) => {
    test.setTimeout(240_000);
    const m2 = world.user('M2');
    const sa2 = world.user('SA2');
    await resetLimits({ users: [sa2], ips: [world.ip(3)] });
    const page = await (await contextAt(browser, m2, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    page.once('dialog', (d) => void d.accept());
    await usersAction(page, () => usersRow(page, sa2.username).getByRole('button', { name: 'Disable', exact: true }).click());
    await expect(usersBanner(page)).toContainText(`Disabled "${sa2.username}". It is on the Disabled tab, where Enable puts it back.`);
    await expect(pageSubtitle(page)).toHaveText(/ in your regions · 1 hidden by this filter$/);
    expect((await userRow(sa2.id)).isActive).toBe(false);
    expect((await auditFor({ entityId: sa2.id, action: 'UPDATE' })).find((a) => a.reason === 'disabled')?.actorId).toBe(m2.id);
    await expectSignInRefused(browser, sa2, world.ip(3), INVALID_LOGIN);

    await page.goto('/users?status=disabled');
    await settle(page);
    page.once('dialog', (d) => void d.accept());
    await usersAction(page, () => usersRow(page, sa2.username).getByRole('button', { name: 'Enable', exact: true }).click());
    await expect(usersBanner(page)).toContainText(`Enabled "${sa2.username}".`);
    const back = await signIn(browser, sa2, world.ip(3));
    await expectHome(back, 'SALESMAN');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19. Approvers are created with their regions (SV-USERS-NEW-MANAGER-REGIONS, FIN-25; owner decision 8)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: a new Manager or Accountant works in the regions he is given', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('anr', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        // A legacy Manager with no region (created before regions were required).
        { key: 'MGX', role: 'MANAGER' },
      ],
      customers: [{ key: 'C1', phone: true, contact: 'Saeed Al Hinai', branches: [{ key: 'S', route: 'A' }] }],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('a Manager and an Accountant created with R1 sign in, change the password, and see R1’s work', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const r1 = world.region('R1');
    const c1 = world.customer('C1');
    await seedUpdateEdit(world, { customer: 'C1', submitter: 'SA', patch: { customer: { contactPerson: world.name('New contact') } } });

    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    const made: Array<{ role: Role; username: string; password: string }> = [];
    for (const role of ['MANAGER', 'ACCOUNTANT'] as const) {
      const username = `e2e.r${role === 'MANAGER' ? 'mgr' : 'acc'}.${world.sfx}`;
      const password = freshPassword();
      const form = await createUserViaUi(page, { fullName: world.name(`Regional ${role}`), username, role: ROLE_LABEL[role], regionIds: [r1.id], password });
      await expect(form.getByText(/^User created\./), username).toBeVisible();
      world.adopt.user(username);
      made.push({ role, username, password });
    }
    await page.goto('/users');
    for (const m of made) await expect(usersRow(page, m.username).locator('td').nth(5)).toHaveText(r1.code);

    for (const [i, m] of made.entries()) {
      const ip = world.ip(2 + i);
      const p = await (await contextAt(browser, null, ip)).newPage();
      await openLoginPage(p);
      await submitLogin(p, m.username, m.password);
      await expectForcedChangePage(p);
      await changeOwnPassword(p, m.password, freshPassword(), homeUrl(m.role));
      await expectHome(p, m.role);
      if (m.role === 'MANAGER') {
        await expect(pageSubtitle(p)).toHaveText(/^Your regions/);
        await p.goto('/approvals');
        await expect(p.getByRole('main').getByText(c1.legalName).first(), 'R1’s waiting update').toBeVisible();
      } else {
        await expect(pageSubtitle(p)).toHaveText(/^\d+ pending/);
      }
    }
  });

  test('a legacy Manager with no region is told so, and Edit account gives him one', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const mgx = world.user('MGX');
    const r1 = world.region('R1');
    await resetLimits({ users: [mgx], ips: [world.ip(5), world.ip(6)] });

    const old = await (await contextAt(browser, mgx, world.ip(5), { lastCheck: 0 })).newPage();
    await old.goto('/dashboard');
    await expect(pageSubtitle(old)).toHaveText('No regions assigned');
    await expect(old.getByRole('main')).toContainText('You have no managed regions. Ask a Steward to assign your regions');
    await old.goto('/users');
    await expect(pageSubtitle(old)).toHaveText('No regions assigned to you yet — ask a Steward');

    const page = await (await contextAt(browser, stw, world.ip(1))).newPage();
    await page.goto('/users');
    await settle(page);
    await expect(usersRow(page, mgx.username).locator('td').nth(5)).toHaveText('None — sees nothing');
    const dialog = await openEditDialog(page, mgx.username);
    await dialog.locator('label').filter({ hasText: r1.code }).getByRole('checkbox').check();
    await saveEditDialog(page, dialog);
    await expect(usersBanner(page)).toContainText(`Saved "${mgx.username}": regions. They are signed out and sign in again to pick up the change.`);
    expect((await userRow(mgx.id)).managedRegions.map((g) => g.code)).toEqual([r1.code]);

    await expectSignedOut(old, '/dashboard');
    const p = await signIn(browser, mgx, world.ip(6));
    await expectHome(p, 'MANAGER');
    await expect(pageSubtitle(p)).toHaveText(/^Your regions/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 20. /users, the Steward: every row's actions on screen at desktop widths
//     (production walk 2026-10-09: Enable sat past the table's right edge)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('accounts: /users shows every row’s actions without sideways scrolling', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  // Read-only: nothing here changes an account, so the rows stay on their tabs.
  const ACTIVE = ['M1', 'SA'];
  const DISABLED = ['FMX', 'SD'];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('auw', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'A2', region: 'R1' },
      ],
      users: [
        { key: 'STW', role: 'STEWARD' },
        // The world's suffix makes every name, username and code as long as the
        // suite's longest; FINANCE_MANAGER is the widest role, and e-mailed, so
        // its row carries Add e-mail as well — four buttons.
        { key: 'M1', role: 'MANAGER', regions: ['R1'], mustChangePassword: true },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'FMX', role: 'FINANCE_MANAGER', isActive: false },
        { key: 'SD', role: 'SALESMAN', route: 'A2', supervisor: 'M1', isActive: false },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  // Playwright's headless Chromium hides scrollbars, so a 1280 px viewport lays
  // the page out 1280 px wide and the table's box is 1008 px; on Windows a
  // classic scrollbar takes 17 px of the screen and the box is 991 px (review of
  // the production walk 2026-10-09 fix). So each screen width is measured less
  // that scrollbar. A 1263 px viewport falls below Tailwind's xl breakpoint
  // (1280), which the real 1280 screen does not; nothing on /users uses xl:, so
  // that changes no layout here.
  const CLASSIC_SCROLLBAR = 17;

  /** The Accounts scroll box: its inner (client) rect, how it overflows and how far it is scrolled. */
  function accountsBox(page: Page) {
    return page.getByRole('region', { name: 'Accounts' }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const left = r.left + el.clientLeft;
      const top = r.top + el.clientTop;
      return {
        overflowX: getComputedStyle(el).overflowX,
        scrollLeft: el.scrollLeft,
        overflow: el.scrollWidth - el.clientWidth,
        left,
        top,
        right: left + el.clientWidth,
        bottom: top + el.clientHeight,
      };
    });
  }

  /** `button` lies inside `view`, the box's client rect. */
  async function expectInsideBox(button: Locator, view: Awaited<ReturnType<typeof accountsBox>>, what: string): Promise<void> {
    const b = await button.boundingBox();
    expect(b, `${what} is rendered`).not.toBeNull();
    expect(b!.x, `${what} left edge`).toBeGreaterThanOrEqual(view.left - 0.5);
    expect(b!.x + b!.width, `${what} right edge (box ends at ${view.right})`).toBeLessThanOrEqual(view.right + 0.5);
    expect(b!.y, `${what} top edge`).toBeGreaterThanOrEqual(view.top - 0.5);
    expect(b!.y + b!.height, `${what} bottom edge`).toBeLessThanOrEqual(view.bottom + 0.5);
  }

  /** Edit and Enable/Disable of `key`'s row lie inside the table box's visible rect, unscrolled. */
  async function actionsInsideBox(page: Page, key: string, what: string): Promise<void> {
    const u = world.user(key);
    const row = usersRow(page, u.username);
    await expect(row, `${what}: ${key}'s row`).toHaveCount(1);
    const view = await accountsBox(page);
    expect(view.scrollLeft, `${what}: the table is not scrolled sideways`).toBe(0);
    // No column hidden either: the whole table fits its box.
    expect(view.overflow, `${what}: the table is wider than its box by`).toBeLessThanOrEqual(1);
    const toggle = DISABLED.includes(key) ? 'Enable' : 'Disable';
    for (const name of ['Edit', toggle]) {
      await expectInsideBox(row.getByRole('button', { name, exact: true }), view, `${what}: ${key} ${name}`);
    }
  }

  test('at 1280×800, 1366×768 and 1920×1080 with a classic scrollbar, Edit and Enable/Disable sit inside the table box on Active, Disabled and All', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await (await contextAt(browser, world.user('STW'), world.ip(1))).newPage();
    const tabs: [string, string[]][] = [
      ['active', ACTIVE],
      ['disabled', DISABLED],
      ['all', [...ACTIVE, ...DISABLED]],
    ];
    for (const [width, height] of [
      [1280, 800],
      [1366, 768],
      [1920, 1080],
    ] as const) {
      await page.setViewportSize({ width: width - CLASSIC_SCROLLBAR, height });
      for (const [status, keys] of tabs) {
        await page.goto(`/users?status=${status}`);
        await settle(page);
        for (const key of keys) await actionsInsideBox(page, key, `${width}px less a scrollbar, ${status}`);
        await expectNoSideScroll(page);
      }
    }

    // The Create user panel is below the table now; the header link takes the Steward to it.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/users');
    await settle(page);
    await page.getByRole('link', { name: 'Create user', exact: true }).click();
    await expect(page).toHaveURL(/#create-user$/);
    await expect(page.getByRole('heading', { name: 'Create user', exact: true })).toBeInViewport();
    await expect(createForm(page).locator('input[name="fullName"]')).toBeInViewport();
  });

  test('at 375 px the page does not scroll sideways; the table scrolls inside its own box', async ({ browser }) => {
    const page = await (await contextAt(browser, world.user('STW'), world.ip(2))).newPage();
    await page.setViewportSize({ width: 375, height: 812 });
    for (const [status, key] of [
      ['active', 'SA'],
      ['disabled', 'SD'],
      ['all', 'FMX'],
    ] as const) {
      const what = `375px, ${status}`;
      await page.goto(`/users?status=${status}`);
      await settle(page);
      await expectNoSideScroll(page);
      const before = await accountsBox(page);
      expect(before.overflow, `${what}: the table is wider than its box by`).toBeGreaterThan(1);
      // A clipping box (overflow-hidden) also leaves scrollWidth above
      // clientWidth; that is how this table once hid its actions
      // (components/nmwc/TableScroll.tsx), so the box must scroll as well.
      expect(before.overflowX, `${what}: the box scrolls sideways`).toMatch(/^(auto|scroll)$/);
      // And the row's actions are reached that way: brought into view, Edit lies
      // inside the box because the box scrolled, not the page.
      const row = usersRow(page, world.user(key).username);
      await expect(row, `${what}: ${key}'s row`).toHaveCount(1);
      const edit = row.getByRole('button', { name: 'Edit', exact: true });
      await edit.scrollIntoViewIfNeeded();
      const after = await accountsBox(page);
      expect(after.scrollLeft, `${what}: the box scrolled to ${key}'s Edit`).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollX), `${what}: the page did not scroll sideways`).toBeLessThanOrEqual(1);
      await expectInsideBox(edit, after, `${what}: ${key} Edit`);
    }
  });
});
