/**
 * ACCESS CONTROL — the deny side of the launch build, for every role:
 *
 *   1. the page matrix: 8 roles + signed out × every page, each ending where the
 *      app sends it, with nothing of the refused page in the first response or
 *      the final page; every menu item (desktop sidebar, 412 px drawer, the
 *      salesman's tab bar) lands on its own page; finance roles get no write
 *      control on a profile                              (AUTHZ-PAGE-MATRIX,
 *      SV-REFUSE-STEWARD-PAGES, MGR-FORBIDDEN-PAGES, FIN-14-ROLE-MUST-NOT, SM-SCOPE-URLS);
 *   2. deep links outside a route or region: branded 404s, 404 photos, empty
 *      searches, a two-region customer cut to each user's branches; the Manager
 *      with no regions; the read-only Viewer             (AUTHZ-SCOPE-DEEPLINKS,
 *      MGR-NO-REGIONS, SV-VIEWER-READONLY-PROFILE);
 *   3. route handlers by role: exports, perf probe, presign, import templates,
 *      cron/ops without a bearer, the four field forms and the photo attach /
 *      detach                                             (AUTHZ-HTTP-MATRIX, SM-SCOPE-API,
 *      SV-REFUSE-APIS, the API half of FIN-14 and MGR-FORBIDDEN-PAGES);
 *   4. server actions captured from the real UI (the POST aborted in the browser)
 *      and replayed as every other role, signed out, and by a Manager who must
 *      change his password                               (AUTHZ-HTTP-MATRIX, SM-SCOPE-SERVER-ACTIONS);
 *   5. the photo API contract: presign/finalize limits, cache headers, the type
 *      pin, the burst limit, a removed photo                (UPLOAD-API-LIMITS, UPLOAD-PHOTO-SERVE);
 *   6. error pages: the branded 404 and the in-app error boundary (ERR-404, ERR-APP-BOUNDARY);
 *   7. a two-region customer's request (MGR-CHAIN-CUSTOMER-SCOPE), as the owner
 *      decided on 7 Oct (decision 3): only a Manager of every branch it changes
 *      sees it in his queue and may decide it.
 *
 * Launch-candidate behaviour asserted (wave 1, wave 2 and the small batches are FIXED, never test.fail):
 *   every role's menu ends with "Change password", Export is in the Supervisor's,
 *   Manager's and Viewer's menus; /export lists only what that role may export;
 *   presign/finalize refusals carry a message; a Manager decides only his own
 *   regions' branches; region on/off is Steward-only; the CR document of a CREDIT
 *   customer is locked for a salesman; only the Steward edits an account; a
 *   region-less Manager's empty queues say why (noRegionEmptyState, fd41184 /
 *   ea45750); every streamed export downloads (STREAMED_EXPORT_BUG, found by this
 *   file's first run, fixed by 81c936e). No test here is expected to fail.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts access-control --project=phone --project=desktop
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { Role } from '@prisma/client';
import {
  BASE_URL,
  MUSCAT,
  actionIdFor,
  captureServerAction,
  clearSecretFields,
  contextAs,
  createWorld,
  db,
  expectNoDataLeak,
  expectNoRegionNotice,
  fillSecret,
  hasR2,
  homePathFor,
  installLaunchHooks,
  mutePage,
  newId,
  notRunHere,
  omanDateISO,
  postForm,
  postJson,
  receiptEditId,
  replayServerAction,
  requestReactivationViaApi,
  requireLaunchEnv,
  seedPhoto,
  seedUpdateEdit,
  sha256Hex,
  snapshot,
  standardWorld,
  submitCreateViaApi,
  submitEnrichViaApi,
  tinyJpeg,
  uploadPhotoViaApi,
  type CapturedAction,
  type DeviceKind,
  type FixtureUser,
  type ReplayResult,
  type World,
} from './support';
import {
  esc,
  finalizeRaw,
  hydrated,
  pathOf,
  presignForWorld,
  presignRaw,
  putToR2,
  seedCorruptUpdateEdit,
  seedImportBatch,
  seedTemixBatch,
  signedOutRequest,
  withoutFormField,
  xlsxCellTexts,
} from './support/access-control-helpers';

// ── shared words (read from the app's code) ───────────────────────────────────

/** app/not-found.tsx */
const NOT_FOUND_TEXT = "That page doesn't exist or isn't available to your account.";
/** app/(app)/error.tsx */
const ERROR_CARD = 'This page could not load.';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Found by this file's first run (7 Oct), not in KNOWN_BUGS, and FIXED in the launch
 * candidate (81c936e): /api/exports/customers and /api/exports/changes answered 500
 * "Export failed" for every role allowed to export. lib/excel.ts openStreamedWorkbook()
 * did `await import('node:stream')`; webpack's fake-namespace helper copies no named
 * export from a module whose value is a function (Stream), so `PassThrough` was
 * undefined ("b is not a constructor"). The export tests below must pass.
 */

/** The h1 each role's landing page shows (lib/role-home.ts). Fixture salesmen are "Salim …". */
const HOME_HEADING: Record<Role, string> = {
  SALESMAN: 'Good day, Salim',
  SUPERVISOR: 'Approval queue',
  ACCOUNTANT: 'Approval queue',
  FINANCE_MANAGER: 'Approval queue',
  GM: 'Approval queue',
  MANAGER: 'Dashboard',
  VIEWER: 'Dashboard',
  STEWARD: 'Import Excel',
};

/** The h1 of each menu destination (PageHeader titles). */
const HEADING_BY_PATH: Record<string, string> = {
  '/today': 'Good day, Salim',
  '/customers': 'Customers',
  '/customers/new': 'New customer',
  '/work': 'Work items',
  '/rejected': 'Needs correction',
  '/approvals': 'Approval queue',
  '/team': 'My team',
  '/export': 'Export to Excel',
  '/dashboard': 'Dashboard',
  '/users': 'Users',
  '/routes': 'Routes & Regions',
  '/reactivations': 'Reactivation queue',
  '/audit': 'Audit log',
  '/status': 'Service status',
  '/import': 'Import Excel',
  '/temix': 'Temix sync',
  '/duplicates': 'Duplicate review',
  '/profile': 'My profile',
  '/profile/change-password': 'Change password',
  '/notifications': 'Notifications',
};

/**
 * components/nmwc/Sidebar.tsx NAV_BY_ROLE, as the launch build ships it: every
 * menu ends with "Change password"; Export is offered to the Supervisor, the
 * Manager and the Viewer too (wave 1, admin #14).
 */
const CHANGE_PASSWORD: [string, string] = ['Change password', '/profile/change-password'];
const EXPORT: [string, string] = ['Export', '/export'];
const FINANCE_MENU: Array<[string, string]> = [
  ['Approvals', '/approvals'],
  ['Customers', '/customers'],
  ['Work items', '/work'],
  CHANGE_PASSWORD,
];
const MENU: Record<Role, Array<[string, string]>> = {
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
  ACCOUNTANT: FINANCE_MENU,
  FINANCE_MANAGER: FINANCE_MENU,
  GM: FINANCE_MENU,
};

/** The salesman's phone tab bar (components/nmwc/Sidebar.tsx MobileTabBar). */
const TAB_BAR: Array<[string, string]> = [
  ['Today', '/today'],
  ['Customers', '/customers'],
  ['Work', '/work'],
  ['Me', '/profile'],
];

/** One fixture user of each role, as the page matrix walks them. */
const MATRIX_KEYS = ['SA', 'SUP', 'M1', 'STW', 'VW', 'ACC1', 'FM1', 'GM1'] as const;

/** A strong throwaway password of the shape the secret scan looks for; typed with fillSecret only. */
const throwawayPassword = () => `E2e-${randomBytes(12).toString('base64url')}-9a`;

// ── small page helpers ────────────────────────────────────────────────────────

async function expectBranded404(page: Page, what: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: '404', exact: true }), what).toBeVisible();
  await expect(page.getByText(NOT_FOUND_TEXT, { exact: true }), what).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to home', exact: true }), what).toBeVisible();
}

async function expectPath(page: Page, path: string, what: string, timeout = 30_000): Promise<void> {
  await expect.poll(() => pathOf(page), { message: `${what}: ends on ${path}`, timeout }).toBe(path);
}

async function expectHeading(page: Page, heading: string, what: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first(), what).toHaveText(heading, { timeout: 60_000 });
}

/** A rendered page that is neither the branded 404 nor the error card. */
async function expectNoErrorPage(page: Page, what: string): Promise<void> {
  await expect(page.getByText(NOT_FOUND_TEXT), `${what}: no 404`).toHaveCount(0);
  await expect(page.getByText(ERROR_CARD), `${what}: no error card`).toHaveCount(0);
}

async function pageAs(browser: Browser, u: FixtureUser | null, device: DeviceKind = 'desktop'): Promise<Page> {
  return (await contextAs(browser, u, { device })).newPage();
}

/** A row of the /users table, by the exact username in its Username cell. */
function userRow(page: Page, username: string) {
  return page.locator('tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${esc(username)}$`) }) });
}

/** SB's new-customer request saved as a DRAFT through the real route (another salesman's request). */
async function sbDraftCreate(browser: Browser, world: World): Promise<string> {
  const ctx = await contextAs(browser, world.user('SB'), { device: 'desktop' });
  try {
    const page = await ctx.newPage();
    const out = await submitCreateViaApi(
      page,
      {
        isDraft: true,
        customer: { legalName: world.name('SB draft shop'), paymentTerms: 'CASH' },
        branches: [{ branchName: world.name('SB draft branch') }],
      },
      { world }
    );
    const id = receiptEditId(out);
    if (!out.ok || !id) throw new Error(`SB's draft new-customer request was refused: ${out.code} ${out.message}`);
    return id;
  } finally {
    await ctx.close();
  }
}

// ── the page matrix ───────────────────────────────────────────────────────────

type MatrixFixture = { world: World; editA: string; marker: string; batchId: string; batchName: string };

type MatrixPage = {
  path: string;
  /** '/' and '/home': every role lands on its own home. */
  home?: boolean;
  allow?: Role[] | 'all';
  heading?: string;
  /** Where a refused role ends, when it is not its home. */
  refusedTo?: { path: string; heading: string };
  /** Text of this page that must never reach a caller it refuses. */
  needles?: string[];
};

/**
 * The matrix world: the standard world with SA reporting to the Supervisor (so
 * the Supervisor's queue, team and export have someone in them), a SUBMITTED
 * update on FULL whose new contact is a marker only its review page shows, and
 * a customer import batch uploaded by the Steward.
 */
async function buildMatrixWorld(tag: string): Promise<MatrixFixture> {
  const world = await standardWorld(tag, { users: [{ key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'SUP' }] });
  const marker = world.name('ACL contact');
  const { id: editA } = await seedUpdateEdit(world, {
    customer: 'FULL',
    submitter: 'SA',
    patch: { customer: { contactPerson: marker } },
  });
  const batchName = `${world.name('acl customers')}.xlsx`;
  const batchId = await seedImportBatch(world, { uploader: 'STW', filename: batchName, status: 'PROMOTED' });
  return { world, editA, marker, batchId, batchName };
}

function matrixPages(fx: MatrixFixture): MatrixPage[] {
  const full = fx.world.customer('FULL');
  const profile = `/customers/${full.id}`;
  const admin: Role[] = ['MANAGER', 'STEWARD'];
  const approvers: Role[] = ['SUPERVISOR', 'MANAGER', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM'];
  const people = [fx.world.user('ACC2').username];
  const batch = [fx.batchName];
  const queue = [fx.marker];
  return [
    { path: '/', home: true },
    { path: '/home', home: true },
    { path: '/today', allow: ['SALESMAN'], heading: HEADING_BY_PATH['/today'] },
    { path: '/customers', allow: 'all', heading: 'Customers' },
    { path: '/customers/new', allow: ['SALESMAN'], heading: 'New customer', refusedTo: { path: '/customers', heading: 'Customers' } },
    { path: profile, allow: 'all', heading: full.legalName },
    {
      path: `${profile}/edit`,
      allow: ['SALESMAN', 'MANAGER', 'STEWARD'],
      heading: full.legalName,
      refusedTo: { path: profile, heading: full.legalName },
    },
    { path: '/work', allow: 'all', heading: 'Work items' },
    { path: '/rejected', allow: ['SALESMAN'], heading: 'Needs correction', refusedTo: { path: '/work', heading: 'Work items' } },
    { path: '/approvals', allow: approvers, heading: 'Approval queue', needles: queue },
    { path: `/approvals/${fx.editA}`, allow: approvers, heading: full.legalName, needles: queue },
    { path: '/team', allow: ['SUPERVISOR'], heading: 'My team' },
    { path: '/dashboard', allow: ['MANAGER', 'VIEWER', 'STEWARD'], heading: 'Dashboard' },
    { path: '/status', allow: admin, heading: 'Service status', needles: people },
    { path: '/users', allow: admin, heading: 'Users', needles: people },
    { path: '/routes', allow: admin, heading: 'Routes & Regions', needles: people },
    { path: '/audit', allow: admin, heading: 'Audit log', needles: people },
    { path: '/reactivations', allow: ['MANAGER'], heading: 'Reactivation queue' },
    { path: '/export', allow: ['MANAGER', 'STEWARD', 'VIEWER', 'SUPERVISOR'], heading: 'Export to Excel' },
    { path: '/import', allow: ['STEWARD'], heading: 'Import Excel', needles: batch },
    { path: `/import/${fx.batchId}`, allow: ['STEWARD'], heading: fx.batchName, needles: batch },
    { path: '/temix', allow: ['STEWARD'], heading: 'Temix sync', needles: batch },
    { path: '/duplicates', allow: ['STEWARD'], heading: 'Duplicate review', needles: batch },
    { path: '/notifications', allow: 'all', heading: 'Notifications' },
    { path: '/profile', allow: 'all', heading: 'My profile' },
    { path: '/profile/change-password', allow: 'all', heading: 'Change password' },
  ];
}

function expectedFor(p: MatrixPage, role: Role | null): { path: string; heading?: string; refused: boolean } {
  if (!role) return { path: '/login', refused: true };
  if (p.home) return { path: homePathFor(role), heading: HOME_HEADING[role], refused: false };
  const allowed = p.allow === 'all' || (p.allow ?? []).includes(role);
  if (allowed) return { path: p.path, heading: p.heading, refused: false };
  return { ...(p.refusedTo ?? { path: homePathFor(role), heading: HOME_HEADING[role] }), refused: true };
}

/** One identity across every page of the matrix. */
async function runMatrixRow(browser: Browser, fx: MatrixFixture, key: string | null, device: DeviceKind): Promise<void> {
  const u = key ? fx.world.user(key) : null;
  const ctx = await contextAs(browser, u, { device });
  const page = await ctx.newPage();
  const everyNeedle = [fx.batchName, fx.marker, fx.world.user('ACC2').username];
  for (const p of matrixPages(fx)) {
    const exp = expectedFor(p, u?.role ?? null);
    const what = `${key ?? 'signed out'} → ${p.path}`;
    const needles = u ? (exp.refused ? (p.needles ?? []) : []) : everyNeedle;
    await test.step(what, async () => {
      if (needles.length > 0) {
        // The FIRST response of a refused page — before any redirect is followed —
        // must not carry the page's data (no flash of Steward or queue data).
        const first = await ctx.request.get(p.path, { maxRedirects: 0, failOnStatusCode: false });
        const body = await first.text();
        for (const n of needles) expect(body, `${what}: the first response must not hold "${n}"`).not.toContain(n);
      }
      await page.goto(p.path);
      await expectPath(page, exp.path, what);
      if (exp.heading) await expectHeading(page, exp.heading, what);
      if (u) await expectNoErrorPage(page, what);
      if (needles.length > 0) {
        await expectNoDataLeak(page, needles);
        const html = await page.content();
        for (const n of needles) expect(html, `${what}: the final page must not hold "${n}"`).not.toContain(n);
      }
    });
  }
}

test.describe('access control: page matrix', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let fx: MatrixFixture;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    fx = await buildMatrixWorld('acm');
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (fx?.world) await fx.world.cleanup();
  });

  for (const key of MATRIX_KEYS) {
    test(`page matrix: ${key} ends where the app sends him on every page, and sees nothing of a refused one`, async ({ browser }) => {
      test.setTimeout(600_000);
      await runMatrixRow(browser, fx, key, 'desktop');
    });
  }

  test('page matrix: signed out, every page goes to /login and shows nothing', async ({ browser }) => {
    test.setTimeout(600_000);
    await runMatrixRow(browser, fx, null, 'desktop');
  });

  test('every desktop sidebar item of every role lands on its own page — no redirect, 404 or loop', async ({ browser }) => {
    test.setTimeout(900_000);
    for (const key of MATRIX_KEYS) {
      const u = fx.world.user(key);
      const page = await pageAs(browser, u, 'desktop');
      await page.goto('/');
      await expectPath(page, homePathFor(u.role), `${key} home`);
      const sidebar = page
        .getByRole('navigation')
        .filter({ has: page.getByRole('link', { name: 'Change password', exact: true }) })
        .first();
      const want = MENU[u.role];
      await expect(sidebar.getByRole('link'), `${key}'s menu (Change password last; Export for SUP/MANAGER/VIEWER)`).toHaveText(
        want.map(([label]) => label)
      );
      for (const [label, href] of want) {
        await test.step(`${key}: ${label}`, async () => {
          await sidebar.getByRole('link', { name: label, exact: true }).click();
          await expectPath(page, href, `${key} menu ${label}`);
          await expectHeading(page, HEADING_BY_PATH[href]!, `${key} menu ${label}`);
          await expectNoErrorPage(page, `${key} menu ${label}`);
        });
      }
      await page.context().close();
    }
  });

  test('every item of the 412 px menu drawer lands on its own page, for every role but the salesman', async ({ browser }) => {
    test.setTimeout(900_000);
    for (const key of MATRIX_KEYS.filter((k) => k !== 'SA')) {
      const u = fx.world.user(key);
      const page = await pageAs(browser, u, 'phone');
      for (const [label, href] of MENU[u.role]) {
        await test.step(`${key}: ${label}`, async () => {
          // From a page none of the menus links, so every item is a real navigation.
          await page.goto('/profile');
          await expectHeading(page, 'My profile', `${key} profile`);
          const open = page.getByRole('button', { name: 'Open menu', exact: true });
          await hydrated(open);
          await open.click();
          const drawer = page.locator('#mobile-nav-drawer');
          await expect(drawer.getByRole('link'), `${key}'s drawer`).toHaveText(MENU[u.role].map(([l]) => l));
          await drawer.getByRole('link', { name: label, exact: true }).click();
          await expectPath(page, href, `${key} drawer ${label}`);
          await expectHeading(page, HEADING_BY_PATH[href]!, `${key} drawer ${label}`);
          await expectNoErrorPage(page, `${key} drawer ${label}`);
          await expect(drawer, `${key}: the drawer closes on navigation`).toHaveCount(0);
        });
      }
      await page.context().close();
    }
  });

  test('a Manager’s Routes and Users pages hold his regions only, without the Steward’s controls', async ({ browser }) => {
    const { world } = fx;
    const page = await pageAs(browser, world.user('M1'));
    await page.goto('/routes');
    await expectHeading(page, 'Routes & Regions', 'M1 /routes');
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${esc(world.region('R1').name)}`) })).toBeVisible();
    await expect(page.getByText(world.region('R2').name)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'New region', exact: true }), 'no New region panel').toHaveCount(0);
    // Owner decision 5 (7 Oct): no region switch for a Manager, and no route switch
    // in a region he shares (R1: M1 and M2).
    await expect(
      page.getByText('Only the Data Steward switches a region off or on, and a route in a region you share with another Manager. Ask the Steward.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Disable|Enable)$/ })).toHaveCount(0);

    await page.goto('/users');
    await expectHeading(page, 'Users', 'M1 /users');
    await expect(page.locator('td', { hasText: new RegExp(`^${esc(world.user('SA').username)}$`) })).toBeVisible();
    for (const k of ['SB', 'ACC2', 'FM1', 'STW', 'VW']) {
      await expect(page.locator('td', { hasText: new RegExp(`^${esc(world.user(k).username)}$`) }), `M1 does not administer ${k}`).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^(Add e-mail|Change e-mail)$/ }), 'e-mail is the Steward’s').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit', exact: true }), 'Edit account is the Steward’s').toHaveCount(0);
    await expect(page.locator('select[name="role"] option'), 'a Manager creates the field force only').toHaveText(['Salesman', 'Supervisor']);
  });

  test('the Accountant, Finance Manager and GM get no Enrich, Archive, close or reactivate control and no field on a profile', async ({ browser }) => {
    test.setTimeout(300_000);
    const full = fx.world.customer('FULL');
    const closed = fx.world.customer('CLOSEDB');
    // The controls exist: the salesman and the Manager see them on the same pages.
    const sa = await pageAs(browser, fx.world.user('SA'));
    await sa.goto(`/customers/${full.id}`);
    await expect(sa.getByRole('link', { name: 'Enrich', exact: true })).toBeVisible();
    await expect(sa.getByRole('button', { name: 'Mark closed', exact: true })).toBeVisible();
    await sa.goto(`/customers/${closed.id}`);
    await expect(sa.getByRole('button', { name: 'Request reactivation', exact: true })).toBeVisible();
    const m1 = await pageAs(browser, fx.world.user('M1'));
    await m1.goto(`/customers/${full.id}`);
    await expect(m1.getByRole('link', { name: 'Enrich', exact: true })).toBeVisible();
    await expect(m1.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();

    for (const key of ['ACC1', 'FM1', 'GM1']) {
      const page = await pageAs(browser, fx.world.user(key));
      for (const c of [full, closed]) {
        await page.goto(`/customers/${c.id}`);
        await expectHeading(page, c.legalName, `${key} on ${c.key}`);
        const main = page.locator('main');
        await expect(main.getByRole('link', { name: 'Enrich', exact: true }), `${key}: no Enrich`).toHaveCount(0);
        await expect(main.getByRole('button', { name: 'Archive', exact: true }), `${key}: no Archive`).toHaveCount(0);
        await expect(main.getByRole('button', { name: 'Mark closed', exact: true }), `${key}: no Mark closed`).toHaveCount(0);
        await expect(main.getByRole('button', { name: 'Request reactivation', exact: true }), `${key}: no reactivation`).toHaveCount(0);
        // No field that could change anything — the credit figures included.
        await expect(main.locator('input, textarea, select'), `${key}: no input on a profile`).toHaveCount(0);
      }
    }
  });
});

test.describe('access control: page matrix — the salesman on a phone', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let fx: MatrixFixture;
  let sbDraft: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    fx = await buildMatrixWorld('acp');
    sbDraft = await sbDraftCreate(browser, fx.world);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (fx?.world) await fx.world.cleanup();
  });

  test('page matrix: SA on a phone ends where the app sends him, and sees nothing of a refused page', async ({ browser }) => {
    test.setTimeout(600_000);
    await runMatrixRow(browser, fx, 'SA', 'phone');
  });

  test('SA on a phone: another route’s customer, an archived one and another salesman’s request are the branded 404', async ({ browser }) => {
    const page = await pageAs(browser, fx.world.user('SA'), 'phone');
    const bonly = fx.world.customer('BONLY');
    await page.goto(`/customers/${bonly.id}`);
    await expectBranded404(page, 'route-B customer');
    await expect(page.getByText(bonly.legalName)).toHaveCount(0);
    // The edit form sends him to the profile, which then 404s.
    await page.goto(`/customers/${bonly.id}/edit`);
    await expectPath(page, `/customers/${bonly.id}`, 'route-B edit form');
    await expectBranded404(page, 'route-B edit form → profile');
    await page.goto(`/customers/${fx.world.customer('ARCH').id}`);
    await expectBranded404(page, 'archived customer');
    await page.goto(`/customers/new?edit=${sbDraft}`);
    await expectBranded404(page, "SB's draft new-customer request");
    await expect(page.getByText(fx.world.name('SB draft shop'))).toHaveCount(0);
  });

  test('the salesman’s tab bar: every tab lands on its own page', async ({ browser }) => {
    const page = await pageAs(browser, fx.world.user('SA'), 'phone');
    await page.goto('/today');
    await expectHeading(page, HEADING_BY_PATH['/today']!, 'today');
    const bar = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Me', exact: true }) });
    await expect(bar.getByRole('link')).toHaveText(TAB_BAR.map(([l]) => l));
    for (const [label, href] of TAB_BAR) {
      await bar.getByRole('link', { name: label, exact: true }).click();
      await expectPath(page, href, `tab ${label}`);
      await expectHeading(page, HEADING_BY_PATH[href]!, `tab ${label}`);
      await expectNoErrorPage(page, `tab ${label}`);
    }
  });
});

// ── deep links, the region-less Manager, the Viewer ──────────────────────────

/** A distinct address, so its absence from a page proves the branch was not sent. */
const B1_ADDRESS = 'Plot 1188, Way 9071, Salalah Gardens';

test.describe('access control: deep links and scope', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let bonlyEdit: string;
  let sbDraft: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    world = await standardWorld('acd', {
      users: [{ key: 'MNR', role: 'MANAGER' }],
      customers: [
        {
          key: 'BONLY',
          phone: true,
          crNumber: true,
          crPhoto: true,
          photoBy: 'SB',
          branches: [{ key: 'S', route: 'B', day: 'TODAY', photos: ['SHOP'] }],
        },
        {
          key: 'MULTI',
          phone: true,
          contact: 'Nasser Al Rawahi',
          photoBy: 'SB',
          branches: [
            { key: 'A1', route: 'A' },
            { key: 'A2', route: 'A' },
            { key: 'B1', route: 'B', address: B1_ADDRESS, photos: ['SHOP'] },
          ],
        },
      ],
    });
    ({ id: bonlyEdit } = await seedUpdateEdit(world, {
      customer: 'BONLY',
      submitter: 'SB',
      patch: { customer: { contactPerson: world.name('BONLY contact') } },
    }));
    sbDraft = await sbDraftCreate(browser, world);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('a customer outside the route or region is the branded 404, its edit form too', async ({ browser }) => {
    test.setTimeout(300_000);
    const bonly = world.customer('BONLY');
    for (const key of ['SA', 'M1', 'ACC1', 'MNR']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(`/customers/${bonly.id}`);
      await expectBranded404(page, `${key} → BONLY`);
      await expect(page.getByText(bonly.legalName), `${key}: no BONLY name`).toHaveCount(0);
      await page.goto(`/customers/${bonly.id}/edit`);
      await expectPath(page, `/customers/${bonly.id}`, `${key} → BONLY edit`);
      await expectBranded404(page, `${key} → BONLY edit → profile`);
    }
    // Region R2's Manager edits it; the org-wide Finance Manager and Viewer read it.
    const m5 = await pageAs(browser, world.user('M5'));
    await m5.goto(`/customers/${bonly.id}/edit`);
    await expectPath(m5, `/customers/${bonly.id}/edit`, 'M5 → BONLY edit');
    await expectHeading(m5, bonly.legalName, 'M5 → BONLY edit');
    for (const key of ['FM1', 'VW']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(`/customers/${bonly.id}`);
      await expectHeading(page, bonly.legalName, `${key} → BONLY`);
      await page.goto(`/customers/${bonly.id}/edit`);
      await expectPath(page, `/customers/${bonly.id}`, `${key} → BONLY edit → profile`);
    }
  });

  test('the salesman: an archived customer and another salesman’s new-customer request are the branded 404', async ({ browser }) => {
    const page = await pageAs(browser, world.user('SA'));
    await page.goto(`/customers/${world.customer('ARCH').id}`);
    await expectBranded404(page, 'archived customer');
    await page.goto(`/customers/new?edit=${sbDraft}`);
    await expectBranded404(page, "SB's draft request");
    await expect(page.getByText(world.name('SB draft shop'))).toHaveCount(0);
  });

  test('a request about another region’s customer is a 404 to the Manager and Accountant of another region', async ({ browser }) => {
    const bonly = world.customer('BONLY');
    for (const key of ['M1', 'ACC1', 'MNR']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(`/approvals/${bonlyEdit}`);
      await expectBranded404(page, `${key} → BONLY request`);
      await expect(page.getByText(bonly.legalName)).toHaveCount(0);
    }
    for (const key of ['M5', 'FM1']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(`/approvals/${bonlyEdit}`);
      await expectHeading(page, bonly.legalName, `${key} → BONLY request`);
    }
  });

  test('photos of another region’s customer answer 404 NOT_FOUND', async ({ browser }) => {
    notRunHere(!hasR2, 'the photos need R2');
    const bonly = world.customer('BONLY');
    const shop = bonly.photos.find((p) => p.wire === 'SHOP')!;
    const cr = bonly.photos.find((p) => p.wire === 'CR')!;
    expect(shop && cr, 'BONLY has its shop and CR photos').toBeTruthy();
    for (const key of ['SA', 'M1', 'ACC1', 'MNR']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      for (const p of [shop, cr]) {
        const res = await ctx.request.get(`/api/photos/${p.id}`, { failOnStatusCode: false });
        expect(res.status(), `${key} → BONLY ${p.kind}`).toBe(404);
        expect(await res.json()).toEqual({ error: 'NOT_FOUND' });
      }
    }
    for (const key of ['M5', 'FM1', 'VW']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      const res = await ctx.request.get(`/api/photos/${shop.id}`, { failOnStatusCode: false });
      expect(res.status(), `${key} → BONLY shop`).toBe(200);
      expect(res.headers()['content-type']).toBe('image/jpeg');
    }
  });

  test('a search for another region’s customer finds nothing', async ({ browser }) => {
    const bonly = world.customer('BONLY');
    const q = `/customers?q=${encodeURIComponent(bonly.legalName)}`;
    for (const key of ['SA', 'M1', 'ACC1', 'MNR']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(q);
      await expectHeading(page, 'Customers', `${key} search`);
      await expect(page.getByText(/^~?0 total$/), `${key}: 0 total`).toBeVisible();
      await expect(page.getByText('No customers match', { exact: true })).toBeVisible();
      // The query itself is echoed (the search box and the "Search: …" chip):
      // what must be absent is the customer — no row, no link, no id.
      await expect(page.locator(`a[href^="/customers/${bonly.id}"]`), `${key}: no BONLY row`).toHaveCount(0);
      expect(await page.content(), `${key}: BONLY's id is not on the page`).not.toContain(bonly.id);
    }
    for (const key of ['M5', 'FM1', 'VW']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(q);
      await expect(page.getByText(bonly.legalName, { exact: true }).first(), `${key} finds BONLY`).toBeVisible();
    }
  });

  test('a two-region customer shows each salesman and Manager only his own branches', async ({ browser }) => {
    const multi = world.customer('MULTI');
    const [a1, a2, b1] = ['A1', 'A2', 'B1'].map((k) => world.branch(`MULTI.${k}`));
    const b1Photo = multi.photos.find((p) => p.branchId === b1!.id);
    for (const key of ['SA', 'M1']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(`/customers/${multi.id}`);
      await expectHeading(page, multi.legalName, `${key} → MULTI`);
      for (const b of [a1!, a2!]) await expect(page.getByRole('heading', { level: 3, name: b.name, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 3, name: b1!.name, exact: true })).toHaveCount(0);
      const html = await page.content();
      expect(html, `${key}: B1's id`).not.toContain(b1!.id);
      expect(html, `${key}: B1's address`).not.toContain(B1_ADDRESS);
      if (b1Photo) expect(html, `${key}: B1's photo`).not.toContain(b1Photo.id);
    }
    for (const key of ['FM1', 'GM1', 'STW', 'VW']) {
      const page = await pageAs(browser, world.user(key));
      await page.goto(`/customers/${multi.id}`);
      for (const b of [a1!, a2!, b1!]) {
        await expect(page.getByRole('heading', { level: 3, name: b.name, exact: true }), `${key} sees ${b.key}`).toBeVisible();
      }
    }
  });

  test('a Manager with no regions is told so, and sees no region’s data', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, world.user('MNR'));
    const leaks = [
      world.customer('FULL').legalName,
      world.customer('BONLY').legalName,
      world.customer('MULTI').legalName,
      world.region('R1').name,
      world.region('R2').name,
      world.user('SA').username,
      world.user('SB').username,
    ];
    const checks: Array<[string, string, string | RegExp]> = [
      ['/dashboard', 'Dashboard', 'No regions assigned'],
      ['/users', 'Users', 'No regions assigned to you yet — ask a Steward'],
      ['/routes', 'Routes & Regions', 'No regions assigned to you yet — ask a Steward'],
      ['/audit', 'Audit log', '0 matching events'],
      ['/customers', 'Customers', /^~?0 total$/],
      ['/export', 'Export to Excel', 'You have no managed regions yet, so there is nothing for you to export. Ask a Steward.'],
      ['/approvals', 'Approval queue', '0 pending'],
      ['/reactivations', 'Reactivation queue', '0 closed shops requesting reactivation'],
    ];
    for (const [path, heading, says] of checks) {
      await page.goto(path);
      await expectPath(page, path, `MNR ${path}`);
      await expectHeading(page, heading, `MNR ${path}`);
      await expect(page.getByText(says, { exact: typeof says === 'string' }).first(), `MNR ${path}`).toBeVisible();
      const html = await page.content();
      for (const n of leaks) expect(html, `MNR ${path} must not hold "${n}"`).not.toContain(n);
    }
  });

  test('a Manager with no regions is told why his approval and reactivation queues are empty', async ({ browser }) => {
    // Was KNOWN_BUGS.noRegionEmptyState (fixed, fd41184 / ea45750): the queues read "Nothing pending" /
    // "No reactivation requests" as on a quiet day, without a word about the missing regions. Now
    // NoRegionNotice says it, word for word and once (e8e6bc9: not in the header as well).
    const page = await pageAs(browser, world.user('MNR'));
    for (const [path, requests] of [
      ['/approvals', 'approval requests'],
      ['/reactivations', 'reactivation requests'],
    ] as const) {
      await page.goto(path);
      await expectNoRegionNotice(page, requests, `MNR ${path}`);
    }
  });

  test('the Viewer reads every region and has no way to change anything', async ({ browser }) => {
    const vw = world.user('VW');
    const page = await pageAs(browser, vw);
    await page.goto(`/customers?q=${encodeURIComponent(world.sfx)}`);
    await expectHeading(page, 'Customers', 'VW customers');
    for (const k of ['FULL', 'BONLY']) {
      await expect(page.getByText(world.customer(k).legalName, { exact: true }).first(), `VW lists ${k}`).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /^Regions/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Routes/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export filtered', exact: true })).toBeVisible();
    const more = page.getByRole('button', { name: 'More filters', exact: true });
    await hydrated(more);
    await more.click();
    await expect(page.locator('#cf-supervisor')).toBeVisible();
    await expect(page.locator('#cf-salesman')).toBeVisible();

    const multi = world.customer('MULTI');
    await page.goto(`/customers/${multi.id}`);
    for (const k of ['A1', 'A2', 'B1']) {
      await expect(page.getByRole('heading', { level: 3, name: world.branch(`MULTI.${k}`).name, exact: true })).toBeVisible();
    }
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: 'Enrich', exact: true })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Mark closed', exact: true })).toHaveCount(0);
    await page.goto(`/customers/${world.customer('CLOSEDB').id}`);
    await expect(page.locator('main').getByRole('button', { name: 'Request reactivation', exact: true })).toHaveCount(0);

    await page.goto(`/customers/${multi.id}/edit`);
    await expectPath(page, `/customers/${multi.id}`, 'VW edit → profile');
    await page.goto('/customers/new');
    await expectPath(page, '/customers', 'VW new customer → /customers');

    if (hasR2) {
      const shop = world.customer('FULL').photos.find((p) => p.wire === 'SHOP')!;
      const res = await page.context().request.get(`/api/photos/${shop.id}`, { failOnStatusCode: false });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/jpeg');
    }
    expect(await db.customerEdit.count({ where: { submittedById: vw.id } }), 'no request by the Viewer').toBe(0);
    expect(await db.auditLog.count({ where: { actorId: vw.id } }), 'no audit row by the Viewer').toBe(0);
  });
});

// ── route handlers ────────────────────────────────────────────────────────────

test.describe('access control: route handlers', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let sbDraft: string;
  /** A shop photo on SA's route captured by the Manager (R2 only). */
  let m1Photo: string | null = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    world = await standardWorld('acr', {
      users: [{ key: 'MFLAG', role: 'MANAGER', regions: ['R1'], mustChangePassword: true }],
      customers: [
        {
          key: 'CRED',
          paymentTerms: 'CREDIT',
          creditLimit: '500.000',
          termDays: 30,
          phone: true,
          contact: 'Khalid Al Harthy',
          crNumber: true,
          crPhoto: true,
          branches: [{ key: 'S', route: 'A' }],
        },
        // Complete at customer level under either submit gate (CORE, or FULL with R2).
        {
          key: 'LEGAL',
          phone: true,
          contact: 'Said Al Maskari',
          subChannel: true,
          crNumber: true,
          crPhoto: true,
          branches: [{ key: 'S', route: 'A' }],
        },
        {
          key: 'CLOSEDBB',
          phone: true,
          branches: [{ key: 'S', route: 'B', status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) }],
        },
      ],
    });
    sbDraft = await sbDraftCreate(browser, world);
    if (hasR2) {
      m1Photo = (await seedPhoto(world, { kind: 'SHOP', capturedBy: 'M1', branchId: world.branch('NODAY1').id, wire: 'SHOP' })).id;
    }
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  const exportPaths = () => {
    const r1 = world.region('R1').id;
    return [`/api/exports/customers?regionId=${r1}`, `/api/exports/changes?since=${omanDateISO()}&regionId=${r1}`];
  };

  test('exports: 403 “Your role cannot export.” for the salesman and the finance roles, 401 signed out', async ({ browser }) => {
    test.setTimeout(300_000);
    const paths = exportPaths();
    for (const key of ['SA', 'ACC1', 'FM1', 'GM1']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      for (const path of paths) {
        const res = await ctx.request.get(path, { failOnStatusCode: false, maxRedirects: 0 });
        expect(res.status(), `${key} ${path}`).toBe(403);
        expect(await res.json(), `${key} ${path}`).toEqual({ error: 'Your role cannot export.' });
      }
    }
    const anon = await signedOutRequest();
    try {
      for (const path of paths) {
        const res = await anon.get(path, { failOnStatusCode: false, maxRedirects: 0 });
        expect(res.status(), `signed out ${path}`).toBe(401);
      }
    } finally {
      await anon.dispose();
    }
  });

  test('exports: a workbook for the Viewer, the Steward, the Manager and the Supervisor', async ({ browser }) => {
    // Was the STREAMED_EXPORT_BUG blocker (every streamed export answered 500), fixed by 81c936e.
    test.setTimeout(300_000);
    const paths = exportPaths();
    for (const key of ['VW', 'STW', 'M1', 'SUP']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      for (const path of paths) {
        const res = await ctx.request.get(path, { failOnStatusCode: false, maxRedirects: 0 });
        expect(res.status(), `${key} ${path}`).toBe(200);
        expect(res.headers()['content-type'], `${key} ${path}`).toBe(XLSX);
      }
    }
  });

  test('/export offers a Manager only his own regions', async ({ browser }) => {
    const page = await pageAs(browser, world.user('M1'));
    await page.goto('/export');
    await expectHeading(page, 'Export to Excel', 'M1 /export');
    const html = await page.content();
    expect(html).toContain(world.region('R1').name);
    expect(html, '/export lists only the regions he may export').not.toContain(world.region('R2').name);
  });

  test('a Manager’s export holds his regions only', async ({ browser }) => {
    // Was the STREAMED_EXPORT_BUG blocker (500 "b is not a constructor"), fixed by 81c936e.
    test.setTimeout(300_000);
    const ctx = await contextAs(browser, world.user('M1'), { device: 'desktop' });
    const res = await ctx.request.get('/api/exports/customers', { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const cells = await xlsxCellTexts(await res.body());
    expect(cells, 'FULL (R1) is exported').toContain(world.branch('FULL').code);
    expect(cells, "MULTI's R1 branch is exported").toContain(world.branch('MULTI.A1').code);
    expect(cells, 'BONLY (R2) is not').not.toContain(world.branch('BONLY').code);
    expect(cells, "MULTI's R2 branch is not").not.toContain(world.branch('MULTI.B1').code);

    const yesterday = omanDateISO(new Date(Date.now() - 86_400_000));
    const changes = await ctx.request.get(`/api/exports/changes?since=${yesterday}&regionId=${world.region('R2').id}`, {
      failOnStatusCode: false,
    });
    expect(changes.status()).toBe(200);
    expect(changes.headers()['x-row-count'], 'an R2-filtered change report is empty for an R1 Manager').toBe('0');
  });

  test('/api/perf-probe: 403 for every role but the Steward and the Manager, 401 signed out', async ({ browser }) => {
    for (const key of ['SA', 'SUP', 'VW', 'ACC1', 'FM1', 'GM1']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      const res = await ctx.request.get('/api/perf-probe', { failOnStatusCode: false, maxRedirects: 0 });
      expect(res.status(), key).toBe(403);
      expect(await res.json()).toEqual({ error: 'FORBIDDEN' });
    }
    const anon = await signedOutRequest();
    try {
      expect((await anon.get('/api/perf-probe', { failOnStatusCode: false })).status()).toBe(401);
    } finally {
      await anon.dispose();
    }
    for (const key of ['M1', 'STW']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      expect((await ctx.request.get('/api/perf-probe', { failOnStatusCode: false })).status(), key).toBe(200);
    }
  });

  test('/api/photos/presign: 403 FORBIDDEN_ROLE with its message for the roles that cannot attach, and for a Manager’s GUARANTEE', async ({ browser }) => {
    const shop = { kind: 'SHOP', mimeType: 'image/jpeg', bytes: 1000 };
    for (const key of ['VW', 'ACC1', 'FM1', 'GM1', 'SUP']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      const out = await presignRaw(ctx.request, shop);
      expect(out.status, key).toBe(403);
      expect(out.json, key).toEqual({ error: 'FORBIDDEN_ROLE', message: 'Your role cannot upload this photo.' });
    }
    const m1 = await contextAs(browser, world.user('M1'), { device: 'desktop' });
    const guarantee = await presignRaw(m1.request, { ...shop, kind: 'GUARANTEE' });
    expect(guarantee.status).toBe(403);
    expect(guarantee.json.error).toBe('FORBIDDEN_ROLE');
    const anon = await signedOutRequest();
    try {
      const out = await presignRaw(anon, shop);
      expect(out.status).toBe(401);
      expect(out.json.error).toBe('UNAUTHORIZED');
    } finally {
      await anon.dispose();
    }
  });

  test('the import templates are the Steward’s only', async ({ browser }) => {
    const stw = await contextAs(browser, world.user('STW'), { device: 'desktop' });
    const ok = await stw.request.get('/import/template?kind=customer', { failOnStatusCode: false });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['content-type']).toBe(XLSX);
    const none = await stw.request.get('/import/template?kind=../../.env', { failOnStatusCode: false });
    expect(none.status()).toBe(404);
    for (const key of ['M1', 'SA', 'VW']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'desktop' });
      const res = await ctx.request.get('/import/template?kind=account', { failOnStatusCode: false, maxRedirects: 0 });
      expect(res.status(), key).toBe(403);
      expect(await res.json()).toEqual({ error: 'Only a Steward can import.' });
    }
    const anon = await signedOutRequest();
    try {
      expect((await anon.get('/import/template?kind=customer', { failOnStatusCode: false, maxRedirects: 0 })).status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test('cron and ops endpoints refuse a caller without the bearer', async () => {
    const anon = await signedOutRequest();
    try {
      for (const path of ['/api/cron/sla-escalate', '/api/cron/email-drain']) {
        const res = await anon.get(path, { failOnStatusCode: false });
        expect(res.status(), path).toBe(401);
        expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' });
      }
      const ops = await anon.post('/api/ops/backup-report', { data: {}, failOnStatusCode: false });
      expect(ops.status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test('the field forms refuse the Viewer and every out-of-scope salesman request, and nothing changes', async ({ browser }) => {
    test.setTimeout(300_000);
    const sa = world.user('SA');
    const full = world.customer('FULL');
    const bonly = world.customer('BONLY');
    const multi = world.customer('MULTI');
    const b1 = world.branch('MULTI.B1');
    const touched = [full, bonly, multi, world.customer('CLOSEDBB')];
    const ids = touched.map((c) => c.id);
    const branchIds = touched.flatMap((c) => Object.values(c.branches).map((b) => b.id));
    const rows = {
      CustomerEdit: { OR: [{ customerId: { in: ids } }, { id: sbDraft }] },
      Branch: { customerId: { in: ids } },
      Attachment: { OR: [{ customerId: { in: ids } }, { branchId: { in: branchIds } }] },
    };
    const before = await snapshot(['CustomerEdit', 'Branch', 'Attachment'], rows);

    // The Viewer: an edit and a close are refused for his role.
    const vwPage = await pageAs(browser, world.user('VW'));
    const vwEdit = await submitEnrichViaApi(vwPage, { customerId: full.id, customer: { contactPerson: world.name('Viewer contact') } });
    expect(vwEdit).toMatchObject({ status: 200, ok: false, message: 'Role VIEWER cannot submit edits.' });
    const vwClose = await postForm(vwPage, 'branch-close', {
      submissionId: randomUUID(),
      branchId: full.branch.id,
      reason: 'The shop is closed',
      attachmentId: newId(),
    });
    expect(vwClose).toMatchObject({ status: 200, ok: false, message: 'Role VIEWER not allowed.' });

    const saPage = await pageAs(browser, sa);
    // Route B's customer.
    expect(await submitEnrichViaApi(saPage, { customerId: bonly.id, customer: { contactPerson: world.name('Not mine') } })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: 'This customer is not on your route.',
    });
    // His own two-region customer, carrying route B's branch.
    expect(
      await submitEnrichViaApi(saPage, { customerId: multi.id, branches: [{ branchId: b1.id, openingHours: '09:00-21:00' }] })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'You can only edit branches on your route.' });
    // Payment terms never ride an update.
    const terms = await submitEnrichViaApi(saPage, { customerId: full.id, customer: { paymentTerms: 'CREDIT' } });
    expect(terms).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(terms.fields?.['customer.paymentTerms']).toMatch(/^Payment terms \(CASH\/CREDIT\) cannot be changed from the customer edit/);
    // A status flip has its own lanes.
    const status = await submitEnrichViaApi(saPage, { customerId: full.id, customer: { status: 'CLOSED' } });
    expect(status).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(status.fields?.['customer.status']).toBe('Use the close-shop or reactivation action for status changes — not the edit form.');
    // Only a Steward or a Manager un-confirms the equipment.
    const equipment = await submitEnrichViaApi(saPage, {
      customerId: full.id,
      branches: [{ branchId: full.branch.id, equipmentConfirmed: false }],
    });
    expect(equipment).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(equipment.fields?.[`branch.${full.branch.id}.equipment`]).toBe(
      'Only a Data Steward or a Manager can mark the equipment as not counted.'
    );
    // Close and reactivate a branch on route B.
    expect(
      await postForm(saPage, 'branch-close', {
        submissionId: randomUUID(),
        branchId: b1.id,
        reason: 'The shop is closed',
        attachmentId: newId(),
      })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Branch is not on your route.' });
    expect(
      await postForm(saPage, 'branch-reactivate', {
        submissionId: randomUUID(),
        branchId: world.branch('CLOSEDBB').id,
        reason: 'The shop is open again',
        attachmentId: newId(),
      })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Branch is not on your route.' });
    // Another salesman's new-customer request.
    expect(
      await submitCreateViaApi(saPage, {
        editId: sbDraft,
        isDraft: true,
        customer: { legalName: world.name('Taken over'), paymentTerms: 'CASH' },
        branches: [{ branchName: world.name('Taken over branch') }],
      })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'This create request belongs to another user.' });
    // A Manager cannot start a new-customer request.
    const m1Page = await pageAs(browser, world.user('M1'));
    expect(
      await submitCreateViaApi(m1Page, {
        isDraft: true,
        customer: { legalName: world.name('Manager shop'), paymentTerms: 'CASH' },
        branches: [{ branchName: world.name('Manager branch') }],
      })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Only a Salesman can request a new customer.' });

    expect(await snapshot(['CustomerEdit', 'Branch', 'Attachment'], rows), 'no request, branch or photo row changed').toBe(before);
    expect(await db.customerEdit.count({ where: { submittedById: world.user('VW').id } })).toBe(0);
  });

  test('the field forms refuse another site, a non-JSON body, an unknown form, a signed-out caller and a Manager who must change his password', async ({ browser }) => {
    const saPage = await pageAs(browser, world.user('SA'));
    const body = JSON.stringify({ customerId: world.customer('FULL').id });
    const evil = await saPage.request.post('/api/forms/customer-edit', {
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      data: body,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(evil.status()).toBe(403);
    expect(await evil.json()).toEqual({ ok: false, code: 'FORBIDDEN', message: 'Cross-site request refused.' });
    const text = await saPage.request.post('/api/forms/customer-edit', {
      headers: { 'content-type': 'text/plain' },
      data: body,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(text.status()).toBe(415);
    const unknown = await postJson(saPage, '/api/forms/x', {});
    expect(unknown.status()).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const anon = await signedOutRequest();
    try {
      const res = await anon.post('/api/forms/customer-edit', {
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        data: body,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(res.status()).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    } finally {
      await anon.dispose();
    }

    // The middleware sends a must-change session to the password page; the route,
    // if reached, answers PASSWORD_CHANGE_REQUIRED. Either way nothing is sent.
    const flagged = await pageAs(browser, world.user('MFLAG'));
    const out = await postForm(flagged, 'customer-edit', { customerId: world.customer('FULL').id });
    expect(
      out.code === 'PASSWORD_CHANGE_REQUIRED' || (out.code === 'REDIRECTED' && /\/profile\/change-password/.test(out.location ?? '')),
      JSON.stringify(out)
    ).toBe(true);
    expect(await db.customerEdit.count({ where: { submittedById: world.user('MFLAG').id } })).toBe(0);
  });

  test('a salesman’s legal-name change is dropped without a word; the rest of his request goes through', async ({ browser }) => {
    const legal = world.customer('LEGAL');
    const contact = world.name('Legal contact');
    const saPage = await pageAs(browser, world.user('SA'));
    const out = await submitEnrichViaApi(
      saPage,
      { customerId: legal.id, customer: { legalName: world.name('Renamed by salesman'), contactPerson: contact } },
      { world }
    );
    expect(out, JSON.stringify(out)).toMatchObject({ status: 200, ok: true });
    const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: receiptEditId(out)! }, select: { fieldChanges: true } });
    const fields = (edit.fieldChanges as unknown as Array<{ field: string; after: unknown }>).map((c) => c.field);
    expect(fields).toEqual(['customer.contactPerson']);
    expect(await db.customer.findUniqueOrThrow({ where: { id: legal.id }, select: { legalName: true } })).toEqual({
      legalName: legal.legalName,
    });
  });

  test('photo attach and remove refuse another route’s branch, another user’s photo and a credit customer’s CR document', async ({ browser }) => {
    notRunHere(!hasR2, 'uploads need R2');
    test.setTimeout(300_000);
    const sa = world.user('SA');
    const cred = world.customer('CRED');
    const b1 = world.branch('MULTI.B1');
    const credCr = cred.photos.find((p) => p.wire === 'CR')!;
    expect(credCr, "CRED has its CR document, taken by SA").toBeTruthy();
    const rows = {
      Branch: { id: { in: [b1.id, world.branch('NODAY1').id] } },
      Customer: { id: cred.id },
      Attachment: { id: { in: [credCr.id, m1Photo!] } },
    };
    const before = await snapshot(['Branch', 'Customer', 'Attachment'], rows);
    const saPage = await pageAs(browser, sa);

    const toB1 = await uploadPhotoViaApi(saPage, world, { kind: 'SHOP', attach: { branchId: b1.id, slot: 'SHOP' } });
    expect(toB1.attached).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Branch not on your route.' });
    // Owner decision 2 (7 Oct): the CR document of a CREDIT customer is locked for a salesman.
    const crLocked = 'The CR document of a credit customer is changed by your manager or the Data Steward.';
    const toCred = await uploadPhotoViaApi(saPage, world, { kind: 'CR', attach: { customerId: cred.id, slot: 'CR' } });
    expect(toCred.attached).toMatchObject({ ok: false, code: 'FORBIDDEN', message: crLocked });

    const detachOthers = await postJson(saPage, '/api/photos/detach', { attachmentId: m1Photo });
    expect(await detachOthers.json()).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'You can only remove photos you captured.' });
    const detachCr = await postJson(saPage, '/api/photos/detach', { attachmentId: credCr.id });
    expect(await detachCr.json()).toMatchObject({ ok: false, code: 'FORBIDDEN', message: crLocked });

    expect(await snapshot(['Branch', 'Customer', 'Attachment'], rows), 'no slot or photo changed').toBe(before);
    // The two refused uploads stay unattached.
    const unwired = await db.attachment.findMany({
      where: { id: { in: [toB1.attachmentId, toCred.attachmentId] } },
      select: { customerId: true, branchId: true, deletedAt: true },
    });
    expect(unwired).toEqual([
      { customerId: null, branchId: null, deletedAt: null },
      { customerId: null, branchId: null, deletedAt: null },
    ]);
  });
});

// ── server actions, captured from the UI and replayed ─────────────────────────

type Caller = { by: string; req: APIRequestContext };

/**
 * Opens `url` as `u`, runs `trigger` and returns the server-action POST it makes —
 * aborted in the browser, so the action never runs. Native confirm() dialogs are
 * accepted. The page is closed after the capture.
 */
async function captureAs(
  browser: Browser,
  u: FixtureUser,
  url: string,
  trigger: (page: Page) => Promise<void>
): Promise<CapturedAction> {
  const ctx = await contextAs(browser, u, { device: 'desktop' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept().catch(() => undefined));
  await page.goto(url);
  try {
    return await captureServerAction(page, () => trigger(page));
  } finally {
    // A trigger that typed a password must not leave it on a page a failure would snapshot.
    await clearSecretFields(page);
    await page.close().catch(() => undefined);
  }
}

/** Request contexts of fixture users (desktop, minted sessions). */
async function callersFor(browser: Browser, world: World, keys: string[]): Promise<Caller[]> {
  const out: Caller[] = [];
  for (const k of keys) out.push({ by: k, req: (await contextAs(browser, world.user(k), { device: 'desktop' })).request });
  return out;
}

function describeReplay(by: string, r: ReplayResult): string {
  return `${by}: HTTP ${r.status} ${r.code ?? ''} ${r.message ?? ''} ${r.text.slice(0, 200)}`;
}

/** Every caller is refused (an { ok: false } answer, never "not found"), with the message when given. */
async function expectRefused(a: CapturedAction, callers: Caller[], message?: string | RegExp): Promise<void> {
  for (const c of callers) {
    const r = await replayServerAction(c.req, a);
    expect(r.refused, describeReplay(c.by, r)).toBe(true);
    expect(r.notFound, describeReplay(c.by, r)).toBe(false);
    if (message !== undefined) {
      if (typeof message === 'string') expect(r.message, describeReplay(c.by, r)).toBe(message);
      else expect(r.message ?? '', describeReplay(c.by, r)).toMatch(message);
    }
  }
}

/** Signed out: the action answers "Not signed in.". */
async function expectSignedOutRefused(a: CapturedAction): Promise<void> {
  const anon = await signedOutRequest();
  try {
    const r = await replayServerAction(anon, a);
    expect(r.refused, describeReplay('signed out', r)).toBe(true);
    expect(r.message, describeReplay('signed out', r)).toBe('Not signed in.');
  } finally {
    await anon.dispose();
  }
}

/**
 * A Manager who must change his password: posted to /profile/change-password
 * (the one page his session may reach) the action is not there, or refuses
 * PASSWORD_CHANGE_REQUIRED; posted to its own page the middleware sends him to
 * the password page.
 */
async function expectFlaggedRefused(flagged: APIRequestContext, a: CapturedAction): Promise<void> {
  const atPassword = await replayServerAction(flagged, a, { path: '/profile/change-password' });
  // Next 15 forwards an action posted to a page whose worker lacks it to the worker
  // that holds it (node_modules/next/dist/server/app-render/action-handler.js
  // createForwardedActionResponse). That internal hop passes the middleware again,
  // which sends the must-change session to the password page; Next then answers a
  // bare `{}` and the action never runs (the callers' snapshots prove it).
  const forwardedAndStopped = atPassword.status === 200 && atPassword.text.trim() === '{}';
  expect(
    atPassword.notFound || atPassword.code === 'PASSWORD_CHANGE_REQUIRED' || forwardedAndStopped,
    describeReplay('MFLAG at /profile/change-password', atPassword)
  ).toBe(true);
  const atPage = await replayServerAction(flagged, a);
  expect(
    atPage.code === 'PASSWORD_CHANGE_REQUIRED' || /\/profile\/change-password/.test(atPage.redirect ?? ''),
    describeReplay('MFLAG at the page', atPage)
  ).toBe(true);
}

test.describe('access control: server actions replayed by the wrong caller', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let editA: string;
  let failedBatch: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('aca', {
      users: [
        { key: 'MNR', role: 'MANAGER' },
        { key: 'MFLAG', role: 'MANAGER', regions: ['R1'], mustChangePassword: true },
      ],
    });
    ({ id: editA } = await seedUpdateEdit(world, {
      customer: 'FULL',
      submitter: 'SA',
      patch: { customer: { contactPerson: world.name('Replay contact') } },
    }));
    // A suspected pair (same CR number) on /duplicates, and a stranded customer batch.
    const cr = `CR${world.SFX}D1`;
    await world.addCustomer({ key: 'DUPA', phone: true, crNumber: cr, branches: [{ key: 'S', route: 'A' }] });
    await world.addCustomer({ key: 'DUPB', phone: true, crNumber: cr, branches: [{ key: 'S', route: 'A' }] });
    failedBatch = await seedImportBatch(world, { uploader: 'STW', filename: `${world.name('acl stranded')}.xlsx`, status: 'FAILED' });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('approve, reject and bulk approve of a Manager’s request are refused for every other caller', async ({ browser }) => {
    test.setTimeout(420_000);
    const m1 = world.user('M1');
    const full = world.customer('FULL');
    const rows = { CustomerEdit: { id: editA }, Customer: { id: full.id } };
    const untouched = await snapshot(['CustomerEdit', 'Customer'], rows);

    const approve = await captureAs(browser, m1, `/approvals/${editA}`, async (page) => {
      const btn = page.getByRole('button', { name: /^✓ Approve$/ });
      await hydrated(btn);
      await btn.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Approve this edit?');
      await dialog.getByRole('button', { name: /^Approve$/ }).click();
    });
    expect(approve.actionId).toBe(actionIdFor('approveEditAndGoAction', 'app/(app)/approvals/[id]/page'));
    const reject = await captureAs(browser, m1, `/approvals/${editA}`, async (page) => {
      const btn = page.getByRole('button', { name: /^✗ Reject$/ });
      await hydrated(btn);
      await btn.click();
      await page.locator('textarea[name="reason"]').fill('Please check the contact person again.');
      await page.getByRole('button', { name: /^✗ Send back to salesman$/ }).click();
    });
    expect(reject.actionId).toBe(actionIdFor('rejectEditAndGoAction', 'app/(app)/approvals/[id]/page'));
    const bulk = await captureAs(browser, m1, '/approvals', async (page) => {
      const box = page.getByRole('checkbox', { name: `Select edit for ${full.legalName}` });
      await hydrated(box);
      await box.check();
      await page.getByRole('button', { name: /^✓ Approve 1$/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^Approve 1$/ }).click();
    });
    expect(bulk.actionId).toBe(actionIdFor('bulkApproveEditsAction', 'app/(app)/approvals/page'));

    const others = await callersFor(browser, world, ['SA', 'VW', 'ACC1', 'FM1', 'GM1', 'M5', 'MNR', 'STW']);
    await expectRefused(approve, others, 'You are not authorized to act on this step.');
    await expectRefused(reject, others, 'You are not authorized to act on this step.');
    // A bulk run answers ok with a per-request failure: nothing approved.
    for (const c of others) {
      const r = await replayServerAction(c.req, bulk);
      expect(r.notFound, describeReplay(c.by, r)).toBe(false);
      expect(r.text, describeReplay(c.by, r)).toContain('"successes":[]');
      expect(r.text, describeReplay(c.by, r)).toContain('You are not authorized to act on this step.');
    }
    for (const a of [approve, reject, bulk]) await expectSignedOutRefused(a);
    const [flagged] = await callersFor(browser, world, ['MFLAG']);
    await expectFlaggedRefused(flagged!.req, approve);

    expect(await snapshot(['CustomerEdit', 'Customer'], rows), 'the request and the customer are untouched').toBe(untouched);
  });

  test('an approval replayed without its decision token is refused as out of date — even by the Manager himself', async ({ browser }) => {
    const m1 = world.user('M1');
    const rows = { CustomerEdit: { id: editA }, Customer: { id: world.customer('FULL').id } };
    const untouched = await snapshot(['CustomerEdit', 'Customer'], rows);
    const approve = await captureAs(browser, m1, `/approvals/${editA}`, async (page) => {
      const btn = page.getByRole('button', { name: /^✓ Approve$/ });
      await hydrated(btn);
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: /^Approve$/ }).click();
    });
    const [me] = await callersFor(browser, world, ['M1']);
    // withoutFormField throws unless the token was in the body and is gone from it:
    // with the token, M1's replay would RUN the approval.
    const r = await replayServerAction(me!.req, approve, { mutateBody: (b) => withoutFormField(b, 'decisionToken') });
    expect(r.refused, describeReplay('M1 without token', r)).toBe(true);
    expect(r.message).toBe('This page is out of date. Reload it and review the request again.');
    expect(await snapshot(['CustomerEdit', 'Customer'], rows)).toBe(untouched);
  });

  test('user administration: reset, disable, create, e-mail and Edit account are refused outside the Steward’s and the right Manager’s reach', async ({ browser }) => {
    test.setTimeout(420_000);
    const stw = world.user('STW');
    const sb = world.user('SB');
    const acc2 = world.user('ACC2');
    const newFm = `e2e.newfm.${world.sfx}`;
    const users = { id: { in: [sb.id, acc2.id] } };
    const untouched = await snapshot(['User'], users);

    const reset = await captureAs(browser, stw, '/users', async (page) => {
      const row = userRow(page, sb.username);
      const btn = row.getByRole('button', { name: 'Reset password', exact: true });
      await hydrated(btn);
      await btn.click();
      const pw = throwawayPassword();
      await fillSecret(row.locator('input[name="password"]'), pw);
      await fillSecret(row.locator('input[name="confirmPassword"]'), pw);
      await row.getByRole('button', { name: 'Save', exact: true }).click();
    });
    expect(reset.actionId).toBe(actionIdFor('resetPasswordAction', 'app/(app)/users/page'));
    const toggle = await captureAs(browser, stw, '/users', async (page) => {
      const btn = userRow(page, acc2.username).getByRole('button', { name: 'Disable', exact: true });
      await hydrated(btn);
      await btn.click(); // the confirm() is accepted
    });
    expect(toggle.actionId).toBe(actionIdFor('toggleUserActiveAction', 'app/(app)/users/page'));
    const email = await captureAs(browser, stw, '/users', async (page) => {
      const row = userRow(page, acc2.username);
      const btn = row.getByRole('button', { name: 'Add e-mail', exact: true });
      await hydrated(btn);
      await btn.click();
      await row.getByRole('textbox', { name: `New e-mail for ${acc2.username}` }).fill(`${acc2.username}@example.test`);
      await row.getByRole('button', { name: 'Save', exact: true }).click();
    });
    expect(email.actionId).toBe(actionIdFor('updateUserEmailAction', 'app/(app)/users/page'));
    const edit = await captureAs(browser, stw, '/users', async (page) => {
      const btn = userRow(page, acc2.username).getByRole('button', { name: 'Edit', exact: true });
      await hydrated(btn);
      await btn.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(`Edit ${acc2.fullName}`);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    });
    expect(edit.actionId).toBe(actionIdFor('updateUserAccountAction', 'app/(app)/users/page'));
    const create = await captureAs(browser, stw, '/users', async (page) => {
      const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create user', exact: true }) });
      const submit = form.getByRole('button', { name: 'Create user', exact: true });
      await hydrated(submit);
      await form.locator('input[name="fullName"]').fill(world.name('New Finance Manager'));
      await form.locator('input[name="nmwc-new-account-handle"]').fill(newFm);
      await form.locator('select[name="role"]').selectOption('FINANCE_MANAGER');
      await fillSecret(form.locator('input[name="nmwc-new-account-secret"]'), throwawayPassword());
      await submit.click();
    });
    expect(create.actionId).toBe(actionIdFor('createUserAction', 'app/(app)/users/page'));

    const notAdmin = await callersFor(browser, world, ['SA', 'VW', 'ACC1', 'FM1', 'GM1']);
    const [m1, m5, mnr] = await callersFor(browser, world, ['M1', 'M5', 'MNR']);
    // Reset of R2's salesman: R1's Manager does not manage him; a region-less Manager manages no one.
    await expectRefused(reset, [m1!], 'That account belongs to a region you do not manage.');
    await expectRefused(reset, [mnr!], 'You have no managed regions assigned — ask a Steward.');
    await expectRefused(reset, notAdmin, 'Only Managers or Stewards can manage users.');
    // An Accountant is Steward-provisioned: no Manager disables him.
    await expectRefused(toggle, [m1!, m5!, mnr!], /^A Manager can only manage Salesman\/Supervisor accounts/);
    await expectRefused(toggle, notAdmin, 'Only Managers or Stewards can manage users.');
    await expectRefused(email, [m1!, m5!], 'Only a Steward can change an account’s e-mail address.');
    await expectRefused(edit, [m1!, m5!], 'Only the Data Steward can edit an account.');
    await expectRefused(edit, notAdmin, 'Only Managers or Stewards can manage users.');
    for (const c of [m1!, mnr!]) {
      const r = await replayServerAction(c.req, create);
      expect(r.refused, describeReplay(c.by, r)).toBe(true);
      expect(r.text, describeReplay(c.by, r)).toContain('A Manager can only create Salesman/Supervisor accounts');
    }
    await expectRefused(create, notAdmin, 'Only Managers or Stewards can manage users.');
    for (const a of [reset, toggle, email, edit, create]) await expectSignedOutRefused(a);
    const [flagged] = await callersFor(browser, world, ['MFLAG']);
    await expectFlaggedRefused(flagged!.req, create);

    expect(await snapshot(['User'], users), 'SB and ACC2 are untouched').toBe(untouched);
    expect(await db.user.count({ where: { username: newFm } }), 'no Finance Manager was created').toBe(0);
  });

  test('routes and regions: create region, create route in another region, switch a region or a shared region’s route off — refused (on/off is the Steward’s)', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const r2 = world.region('R2');
    const regionCode = `E2R${world.SFX}Z`;
    const routeCode = `E2${world.SFX}Z`;

    const createRegion = await captureAs(browser, stw, '/routes', async (page) => {
      const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create region', exact: true }) });
      const submit = form.getByRole('button', { name: 'Create region', exact: true });
      await hydrated(submit);
      await form.locator('input[name="code"]').fill(regionCode);
      await form.locator('input[name="name"]').fill(world.name('Replayed region'));
      await submit.click();
    });
    expect(createRegion.actionId).toBe(actionIdFor('createRegionAction', 'app/(app)/routes/page'));
    const createRoute = await captureAs(browser, stw, '/routes', async (page) => {
      const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create route', exact: true }) });
      const submit = form.getByRole('button', { name: 'Create route', exact: true });
      await hydrated(submit);
      await form.locator('input[name="code"]').fill(routeCode);
      await form.locator('input[name="name"]').fill(world.name('Replayed route'));
      await form.locator('select[name="regionId"]').selectOption(r2.id);
      await submit.click();
    });
    expect(createRoute.actionId).toBe(actionIdFor('createRouteAction', 'app/(app)/routes/page'));
    const toggleRegion = await captureAs(browser, stw, '/routes', async (page) => {
      const header = page.locator('header').filter({ has: page.locator('span', { hasText: new RegExp(`^${esc(r2.code)}$`) }) });
      const btn = header.getByRole('button', { name: 'Disable', exact: true });
      await hydrated(btn);
      await btn.click(); // the confirm() is accepted
    });
    expect(toggleRegion.actionId).toBe(actionIdFor('toggleRegionActiveAction', 'app/(app)/routes/page'));
    const a2 = world.route('A2');
    const toggleRoute = await captureAs(browser, stw, '/routes', async (page) => {
      const row = page.locator('tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${esc(a2.code)}$`) }) });
      const btn = row.getByRole('button', { name: 'Disable', exact: true });
      await hydrated(btn);
      await btn.click(); // the confirm() is accepted
    });
    expect(toggleRoute.actionId).toBe(actionIdFor('toggleRouteActiveAction', 'app/(app)/routes/page'));

    const [m1, m5, mnr] = await callersFor(browser, world, ['M1', 'M5', 'MNR']);
    const notAdmin = await callersFor(browser, world, ['SA', 'VW', 'ACC1', 'FM1', 'GM1']);
    await expectRefused(createRegion, [m1!, m5!], 'Only the Steward can create a region.');
    await expectRefused(createRegion, notAdmin, 'Only Managers and the Steward can manage routes.');
    await expectRefused(createRoute, [m1!], 'That region is not one you manage.');
    await expectRefused(createRoute, [mnr!], 'You have no managed regions assigned — ask a Steward.');
    await expectRefused(createRoute, notAdmin, 'Only Managers and the Steward can manage routes.');
    // Owner decision 5 (7 Oct): not even the region's own Manager switches it.
    await expectRefused(toggleRegion, [m5!, m1!, mnr!], 'Only the Data Steward can switch a region off or on.');
    await expectRefused(toggleRegion, notAdmin, 'Only Managers and the Steward can manage routes.');
    // The same rule for a route in a region other active Managers share (R1: M1, M2).
    await expectRefused(
      toggleRoute,
      [m1!],
      'Other Managers share this route’s region, so only the Data Steward can switch the route off or on.'
    );
    await expectRefused(toggleRoute, [m5!], 'That region is not one you manage.');
    await expectRefused(toggleRoute, [mnr!], 'You have no managed regions assigned — ask a Steward.');
    await expectRefused(toggleRoute, notAdmin, 'Only Managers and the Steward can manage routes.');
    for (const a of [createRegion, createRoute, toggleRegion, toggleRoute]) await expectSignedOutRefused(a);

    expect(await db.region.count({ where: { code: regionCode } })).toBe(0);
    expect(await db.route.count({ where: { code: routeCode } })).toBe(0);
    expect(await db.region.findUniqueOrThrow({ where: { id: r2.id }, select: { isActive: true } })).toEqual({ isActive: true });
    expect(await db.route.findUniqueOrThrow({ where: { id: a2.id }, select: { isActive: true } })).toEqual({ isActive: true });
  });

  test('duplicates: merge and Mark distinct are the Steward’s alone', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const a = world.customer('DUPA');
    const b = world.customer('DUPB');
    const pair = (page: Page) => page.locator('li').filter({ hasText: a.legalName }).filter({ hasText: b.legalName }).first();
    const rows = { Customer: { id: { in: [a.id, b.id] } }, Branch: { customerId: { in: [a.id, b.id] } } };
    const untouched = await snapshot(['Customer', 'Branch'], rows);

    const dismiss = await captureAs(browser, stw, '/duplicates', async (page) => {
      const btn = pair(page).getByRole('button', { name: 'Mark distinct', exact: true });
      await hydrated(btn);
      await btn.click(); // the confirm() is accepted
    });
    expect(dismiss.actionId).toBe(actionIdFor('dismissDuplicateAction', 'app/(app)/duplicates/page'));
    const merge = await captureAs(browser, stw, '/duplicates', async (page) => {
      const btn = pair(page).getByRole('button', { name: /^Keep ← / });
      await hydrated(btn);
      await btn.click(); // the confirm() is accepted
    });
    expect(merge.actionId).toBe(actionIdFor('mergeCustomersAction', 'app/(app)/duplicates/page'));

    const callers = await callersFor(browser, world, ['M1', 'SA', 'VW', 'ACC1', 'FM1', 'GM1']);
    await expectRefused(dismiss, callers, 'Only the Data Steward can merge customers.');
    await expectRefused(merge, callers, 'Only the Data Steward can merge customers.');
    for (const x of [dismiss, merge]) await expectSignedOutRefused(x);
    expect(await snapshot(['Customer', 'Branch'], rows), 'both customers are untouched').toBe(untouched);
    expect(await db.auditLog.count({ where: { entityType: 'CustomerPair', entityId: { contains: a.id } } })).toBe(0);
  });

  test('imports: a customer-master upload and a promote are the Steward’s alone', async ({ browser }) => {
    test.setTimeout(300_000);
    const stw = world.user('STW');
    const uploadName = `acl-upload-${world.sfx}.xlsx`;
    const rows = { ImportBatch: { id: failedBatch } };
    const untouched = await snapshot(['ImportBatch'], rows);

    const upload = await captureAs(browser, stw, '/import', async (page) => {
      const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Upload customer master', exact: true }) });
      const submit = form.getByRole('button', { name: 'Upload customer master', exact: true });
      await hydrated(submit);
      await form.locator('input[type="file"]').setInputFiles({ name: uploadName, mimeType: XLSX, buffer: Buffer.from('not a workbook') });
      await submit.click();
    });
    expect(upload.actionId).toBe(actionIdFor('uploadCustomerMasterAction', 'app/(app)/import/page'));
    const promote = await captureAs(browser, stw, `/import/${failedBatch}`, async (page) => {
      const btn = page.getByRole('button', { name: 'Finish promote', exact: true });
      await hydrated(btn);
      await btn.click();
    });
    expect(promote.actionId).toBe(actionIdFor('promoteCustomerBatchAction', 'app/(app)/import/[batchId]/page'));

    const callers = await callersFor(browser, world, ['M1', 'SA', 'VW', 'ACC1', 'FM1', 'GM1']);
    await expectRefused(upload, callers, 'Only the Data Steward can run imports.');
    await expectRefused(promote, callers, 'Only the Data Steward can run imports.');
    for (const x of [upload, promote]) await expectSignedOutRefused(x);
    expect(await snapshot(['ImportBatch'], rows), 'the stranded batch is untouched').toBe(untouched);
    expect(await db.importBatch.count({ where: { filename: uploadName } }), 'no batch was uploaded').toBe(0);
  });

  test('archive and Export filtered are refused to the roles that may not, and to another region’s Manager', async ({ browser }) => {
    test.setTimeout(300_000);
    const m1 = world.user('M1');
    const target = world.customer('NODAY2');
    const rows = { Customer: { id: target.id }, Branch: { customerId: target.id } };
    const untouched = await snapshot(['Customer', 'Branch'], rows);

    const archive = await captureAs(browser, m1, `/customers/${target.id}`, async (page) => {
      const btn = page.getByRole('button', { name: 'Archive', exact: true });
      await hydrated(btn);
      await btn.click();
      await page.getByPlaceholder('e.g. Shop permanently closed — confirmed by the route supervisor.').fill('Closed for good, checked on site.');
      await page.getByRole('button', { name: 'Archive customer', exact: true }).click();
    });
    expect(archive.actionId).toBe(actionIdFor('archiveCustomerAction', 'app/(app)/customers/[id]/page'));
    const exportFiltered = await captureAs(browser, m1, `/customers?q=${encodeURIComponent(world.sfx)}`, async (page) => {
      const btn = page.getByRole('button', { name: 'Export filtered', exact: true });
      await hydrated(btn);
      await btn.click();
    });
    expect(exportFiltered.actionId).toBe(actionIdFor('exportFilteredCustomersAction', 'app/(app)/customers/page'));

    const notAllowed = await callersFor(browser, world, ['SA', 'VW', 'ACC1', 'FM1', 'GM1']);
    await expectRefused(archive, notAllowed, 'Only a Steward or Manager can archive a customer.');
    // Another region's Manager, and one with no region, cannot reach the customer.
    await expectRefused(archive, await callersFor(browser, world, ['M5', 'MNR']), 'Edit not allowed.');
    await expectRefused(exportFiltered, await callersFor(browser, world, ['SA', 'ACC1', 'FM1', 'GM1']), 'Your role cannot export.');
    for (const x of [archive, exportFiltered]) await expectSignedOutRefused(x);
    expect(await snapshot(['Customer', 'Branch'], rows), 'the customer is not archived').toBe(untouched);
  });

  test('a reactivation is decided only by a Manager of the branch’s region', async ({ browser }) => {
    notRunHere(!hasR2, 'the reactivation request needs an evidence photo (R2)');
    test.setTimeout(300_000);
    const sa = world.user('SA');
    const m1 = world.user('M1');
    const closed = world.customer('CLOSEDB');
    const saPage = await pageAs(browser, sa);
    const evidence = await uploadPhotoViaApi(saPage, world, { kind: 'FREE' });
    const req = await requestReactivationViaApi(
      saPage,
      { branchId: closed.branch.id, reason: 'The shop is open again', attachmentId: evidence.attachmentId },
      world
    );
    expect(req, JSON.stringify(req)).toMatchObject({ ok: true });
    const reactivation = receiptEditId(req)!;
    const rows = { CustomerEdit: { id: reactivation }, Branch: { id: closed.branch.id } };
    const untouched = await snapshot(['CustomerEdit', 'Branch'], rows);
    const card = (page: Page) => page.locator('li').filter({ hasText: closed.legalName }).first();

    const approve = await captureAs(browser, m1, '/reactivations', async (page) => {
      const btn = card(page).getByRole('button', { name: '✓ Reactivate', exact: true });
      await hydrated(btn);
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Reactivate', exact: true }).click();
    });
    expect(approve.actionId).toBe(actionIdFor('approveReactivationAction', 'app/(app)/reactivations/page'));
    const reject = await captureAs(browser, m1, '/reactivations', async (page) => {
      const btn = card(page).getByRole('button', { name: 'Keep closed', exact: true });
      await hydrated(btn);
      await btn.click();
      await card(page).getByPlaceholder('Why are you keeping it closed?').fill('Still shuttered on my visit.');
      await card(page).getByRole('button', { name: 'Keep closed', exact: true }).click();
    });
    expect(reject.actionId).toBe(actionIdFor('rejectReactivationAction', 'app/(app)/reactivations/page'));

    for (const a of [approve, reject]) {
      for (const [key, role] of [
        ['SA', 'SALESMAN'],
        ['VW', 'VIEWER'],
        ['ACC1', 'ACCOUNTANT'],
        ['FM1', 'FINANCE_MANAGER'],
        ['STW', 'STEWARD'],
      ] as const) {
        await expectRefused(a, await callersFor(browser, world, [key]), `Role ${role} not allowed.`);
      }
      await expectRefused(a, await callersFor(browser, world, ['M5']), 'This branch is not in your managed regions.');
      await expectSignedOutRefused(a);
    }
    await expectRefused(approve, await callersFor(browser, world, ['MNR']), 'You have no managed regions assigned.');
    await expectRefused(reject, await callersFor(browser, world, ['MNR']), 'This branch is not in your managed regions.');
    expect(await snapshot(['CustomerEdit', 'Branch'], rows), 'the request is pending and the branch closed').toBe(untouched);
  });
});

// ── the photo API contract ────────────────────────────────────────────────────

test.describe('access control: the photo API contract', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;
  let guaranteeId: string;
  let removedId: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    if (!hasR2) return;
    world = await createWorld('acu', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        // The photo burst bucket is per user (per server instance): his own.
        { key: 'VWB', role: 'VIEWER' },
      ],
      customers: [
        {
          key: 'PIC',
          phone: true,
          contact: 'Rashid Al Amri',
          crNumber: true,
          crPhoto: true,
          branches: [{ key: 'S', route: 'A', gps: MUSCAT, photos: ['SHOP'] }],
        },
      ],
    });
    const pic = world.customer('PIC');
    guaranteeId = (await seedPhoto(world, { kind: 'GUARANTEE', capturedBy: 'SA', customerId: pic.id })).id;
    removedId = (await seedPhoto(world, { kind: 'SHOP', capturedBy: 'SA', branchId: pic.branch.id })).id;
    await db.attachment.update({ where: { id: removedId }, data: { deletedAt: new Date() } });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test.beforeEach(() => {
    notRunHere(!hasR2, 'the photo API needs R2');
  });

  const attachmentsBy = (userId: string) => db.attachment.count({ where: { capturedById: userId } });

  test('presign refuses more than 3 MB, a GIF and a PDF; nothing is written', async ({ browser }) => {
    const sa = world.user('SA');
    const ctx = await contextAs(browser, sa, { device: 'desktop' });
    const before = await attachmentsBy(sa.id);
    for (const body of [
      { kind: 'SHOP', mimeType: 'image/jpeg', bytes: 3 * 1024 * 1024 + 1 },
      { kind: 'SHOP', mimeType: 'image/gif', bytes: 1000 },
      { kind: 'GUARANTEE', mimeType: 'application/pdf', bytes: 1000 },
    ]) {
      const out = await presignRaw(ctx.request, body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.json.error).toBe('VALIDATION_FAILED');
      expect(out.json.message).toBe('This photo cannot be uploaded: it must be a JPEG, PNG or WebP image of 3 MB at most.');
    }
    expect(await attachmentsBy(sa.id)).toBe(before);
  });

  test('presign → exact PUT → finalize creates the photo once; the same hash again is deduped to it', async ({ browser }) => {
    const ctx = await contextAs(browser, world.user('SA'), { device: 'desktop' });
    const bytes = tinyJpeg(`${world.sfx}-happy`);
    const { url, key } = await presignForWorld(ctx.request, world, { kind: 'SHOP', mimeType: 'image/jpeg', bytes: bytes.length });
    expect(await putToR2(url, bytes, 'image/jpeg')).toBe(200);
    const body = { key, kind: 'SHOP', hash: sha256Hex(bytes), width: 16, height: 16 };
    const first = await finalizeRaw(ctx.request, body);
    expect(first.status).toBe(200);
    const id = String(first.json.attachmentId);
    world.adopt.attachment(id);
    expect(first.json).toEqual({ attachmentId: id, deduped: false });
    const again = await finalizeRaw(ctx.request, body);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ attachmentId: id, deduped: true });
    expect(await db.attachment.findUniqueOrThrow({ where: { id }, select: { bytes: true, r2Key: true } })).toEqual({
      bytes: bytes.length,
      r2Key: key,
    });
  });

  test('finalize refuses another user’s key, a kind swap and a key never uploaded; nothing is written', async ({ browser }) => {
    const sa = world.user('SA');
    const saCtx = await contextAs(browser, sa, { device: 'desktop' });
    const m1Ctx = await contextAs(browser, world.user('M1'), { device: 'desktop' });
    const before = await attachmentsBy(sa.id);
    const bytes = tinyJpeg(`${world.sfx}-refusals`);
    const hash = sha256Hex(bytes);

    const theirs = await presignForWorld(m1Ctx.request, world, { kind: 'SHOP', mimeType: 'image/jpeg', bytes: bytes.length });
    const mismatch = await finalizeRaw(saCtx.request, { key: theirs.key, kind: 'SHOP', hash });
    expect(mismatch.status).toBe(403);
    expect(mismatch.json.error).toBe('KEY_MISMATCH');

    const mine = await presignForWorld(saCtx.request, world, { kind: 'SHOP', mimeType: 'image/jpeg', bytes: bytes.length });
    expect(await putToR2(mine.url, bytes, 'image/jpeg')).toBe(200);
    const swap = await finalizeRaw(saCtx.request, { key: mine.key, kind: 'CR', hash });
    expect(swap.status).toBe(403);
    expect(swap.json.error).toBe('KIND_MISMATCH');

    const never = await presignForWorld(saCtx.request, world, { kind: 'SHOP', mimeType: 'image/jpeg', bytes: bytes.length });
    const missing = await finalizeRaw(saCtx.request, { key: never.key, kind: 'SHOP', hash: sha256Hex(tinyJpeg('never')) });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('OBJECT_NOT_FOUND');

    expect(await attachmentsBy(sa.id), 'no attachment row for a refusal').toBe(before);
  });

  test('a client capturedAt a year ago is stored as R2’s upload time', async ({ browser }) => {
    const page = await pageAs(browser, world.user('SA'));
    const yearAgo = new Date(Date.now() - 365 * 86_400_000);
    const up = await uploadPhotoViaApi(page, world, { kind: 'SHOP', capturedAt: yearAgo });
    const row = await db.attachment.findUniqueOrThrow({ where: { id: up.attachmentId }, select: { capturedAt: true } });
    expect(Math.abs(row.capturedAt.getTime() - Date.now()), 'capturedAt is R2 LastModified, minutes ago').toBeLessThan(15 * 60_000);
  });

  test('R2 refuses a PUT whose length differs from the signed length', async ({ browser }) => {
    const ctx = await contextAs(browser, world.user('SA'), { device: 'desktop' });
    const bytes = tinyJpeg(`${world.sfx}-length`);
    const { url } = await presignForWorld(ctx.request, world, { kind: 'SHOP', mimeType: 'image/jpeg', bytes: bytes.length });
    expect(await putToR2(url, Buffer.concat([bytes, Buffer.alloc(7, 0x20)]), 'image/jpeg')).toBe(403);
  });

  test('serving: a shop photo is cached and revalidated by ETag; CR and GUARANTEE are never cached', async ({ browser }) => {
    const ctx = await contextAs(browser, world.user('M1'), { device: 'desktop' });
    const pic = world.customer('PIC');
    const shop = pic.photos.find((p) => p.wire === 'SHOP')!;
    const cr = pic.photos.find((p) => p.wire === 'CR')!;
    const res = await ctx.request.get(`/api/photos/${shop.id}`, { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');
    expect(res.headers()['cache-control']).toBe('private, max-age=3600, immutable');
    const etag = res.headers()['etag'];
    expect(etag).toBe(`"p-${shop.id}"`);
    const again = await ctx.request.get(`/api/photos/${shop.id}`, { headers: { 'if-none-match': etag! }, failOnStatusCode: false });
    expect(again.status()).toBe(304);
    for (const id of [cr.id, guaranteeId]) {
      const conf = await ctx.request.get(`/api/photos/${id}`, { failOnStatusCode: false });
      expect(conf.status(), id).toBe(200);
      expect(conf.headers()['cache-control']).toBe('private, no-store, no-cache, must-revalidate');
      expect(conf.headers()['etag']).toBeUndefined();
    }
  });

  test('an object PUT as text/html is served as an image with nosniff, never as HTML', async ({ browser }) => {
    const ctx = await contextAs(browser, world.user('SA'), { device: 'desktop' });
    const html = Buffer.from(`<html><body><form action="https://evil.example">${world.sfx}</form></body></html>`, 'utf8');
    const { url, key } = await presignForWorld(ctx.request, world, { kind: 'SHOP', mimeType: 'image/jpeg', bytes: html.length });
    expect(await putToR2(url, html, 'text/html')).toBe(200);
    const fin = await finalizeRaw(ctx.request, { key, kind: 'SHOP', hash: sha256Hex(html) });
    expect(fin.status).toBe(200);
    const id = String(fin.json.attachmentId);
    world.adopt.attachment(id);
    expect(await db.attachment.findUniqueOrThrow({ where: { id }, select: { mimeType: true } })).toEqual({ mimeType: 'text/html' });
    const res = await ctx.request.get(`/api/photos/${id}`, { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('a burst of photo requests is cut with 429 and Retry-After; a removed photo is 404', async ({ browser }) => {
    const ctx = await contextAs(browser, world.user('VWB'), { device: 'desktop' });
    const shop = world.customer('PIC').photos.find((p) => p.wire === 'SHOP')!;
    // Revalidations: the limiter runs before the 304, so no R2 read is spent.
    const statuses = await Promise.all(
      Array.from({ length: 75 }, () =>
        ctx.request
          .get(`/api/photos/${shop.id}`, { headers: { 'if-none-match': `"p-${shop.id}"` }, failOnStatusCode: false })
          .then((r) => ({ status: r.status(), retryAfter: r.headers()['retry-after'] }))
      )
    );
    const limited = statuses.filter((s) => s.status === 429);
    expect(limited.length, `statuses: ${statuses.map((s) => s.status).join(',')}`).toBeGreaterThan(0);
    expect(Number(limited[0]!.retryAfter)).toBeGreaterThan(0);

    const m1 = await contextAs(browser, world.user('M1'), { device: 'desktop' });
    const gone = await m1.request.get(`/api/photos/${removedId}`, { failOnStatusCode: false });
    expect(gone.status()).toBe(404);
    expect(await gone.json()).toEqual({ error: 'NOT_FOUND' });
  });
});

// ── error pages ───────────────────────────────────────────────────────────────

test.describe('access control: error pages', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // Its own region and Manager: the corrupt request below reaches no other queue.
    world = await createWorld('ace', {
      regions: [{ key: 'R3' }],
      routes: [{ key: 'C', region: 'R3' }],
      users: [
        { key: 'MB', role: 'MANAGER', regions: ['R3'] },
        { key: 'SC', role: 'SALESMAN', route: 'C', supervisor: 'MB' },
        { key: 'STW', role: 'STEWARD' },
      ],
      customers: [{ key: 'BOUND', phone: true, contact: 'Talib Al Wahaibi', branches: [{ key: 'S', route: 'C' }] }],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  const LEAKS = /\bat \S+ \(|TypeError|ReferenceError|Cannot read propert|Prisma|node_modules|webpack|Next\.js \d/;

  test('unknown pages and records are the branded 404, with no stack or record data; its links go home and to the profile', async ({ browser }) => {
    const mb = await pageAs(browser, world.user('MB'));
    const unknown = await mb.goto('/no-such-page');
    expect(unknown?.status()).toBe(404);
    await expectBranded404(mb, 'MB /no-such-page');
    for (const path of [`/customers/${newId()}`, `/approvals/${newId()}`]) {
      await mb.goto(path);
      await expectBranded404(mb, `MB ${path}`);
      expect(await mb.locator('body').innerText()).not.toMatch(LEAKS);
    }
    await mb.goto('/no-such-page');
    await mb.getByRole('link', { name: 'Go to home', exact: true }).click();
    await expectPath(mb, '/dashboard', 'Go to home → the Manager’s home');
    await mb.goto('/no-such-page');
    await mb.getByRole('link', { name: 'My profile', exact: true }).click();
    await expectPath(mb, '/profile', 'My profile');

    const stw = await pageAs(browser, world.user('STW'));
    await stw.goto(`/import/${newId()}`);
    await expectBranded404(stw, 'STW unknown batch');
    expect(await stw.locator('body').innerText()).not.toMatch(LEAKS);
  });

  test('signed out, an unknown page is the branded 404 and both its links lead to sign-in', async ({ browser }) => {
    const page = await pageAs(browser, null);
    const res = await page.goto('/no-such-page');
    expect(res?.status()).toBe(404);
    await expectBranded404(page, 'signed out /no-such-page');
    expect(await page.locator('body').innerText()).not.toMatch(LEAKS);
    await page.getByRole('link', { name: 'Go to home', exact: true }).click();
    await expectPath(page, '/login', 'Go to home → sign in');
    await page.goto('/no-such-page');
    await page.getByRole('link', { name: 'My profile', exact: true }).click();
    await expectPath(page, '/login', 'My profile → sign in');
  });

  test('a page that throws keeps the menus, shows only a reference, retries, and reloads the app', async ({ browser }) => {
    const bound = world.customer('BOUND');
    const id = await seedCorruptUpdateEdit(world, { customer: 'BOUND', submitter: 'SC' });
    const ctx = await contextAs(browser, world.user('MB'), { device: 'desktop' });
    const page = await ctx.newPage();
    // The error below is the test's own doing: do not fail the test on its console report.
    mutePage(page);
    await page.goto(`/approvals/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: ERROR_CARD, exact: true })).toBeVisible();
    await expect(page.getByText(/^Reference: \S+$/)).toBeVisible();
    // The TopBar and the sidebar stay.
    await expect(page.locator('a[href="/notifications"]')).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(LEAKS);
    expect(text, 'no customer data on the card').not.toContain(bound.legalName);

    const retry = page.getByRole('button', { name: 'Try again', exact: true });
    await hydrated(retry);
    const refetch = page.waitForRequest((r) => r.method() === 'GET' && r.url().includes(`/approvals/${id}`), { timeout: 30_000 });
    await retry.click();
    await refetch;
    await expect(page.getByRole('heading', { level: 1, name: ERROR_CARD, exact: true }), 'same card while the row stays corrupt').toBeVisible();

    await page.getByRole('link', { name: 'Reload the app', exact: true }).click();
    await expectPath(page, '/dashboard', 'Reload the app → /home → the Manager’s dashboard');
    await expectHeading(page, 'Dashboard', 'after Reload the app');

    // Record how the queue renders that request (owner question, no expectation).
    await page.goto('/approvals');
    const h1 = page.getByRole('heading', { level: 1, name: /^(Approval queue|This page could not load\.)$/ });
    await expect(h1).toBeVisible();
    const queueShows = (await h1.textContent()) === ERROR_CARD ? 'the whole queue shows the error card' : `the queue renders, ${await page.getByText(bound.legalName).count()} card(s) naming the customer`;
    test.info().annotations.push({ type: 'corrupt request on /approvals', description: queueShows });
  });
});

// ── a two-region customer's request (owner decision 3, 7 Oct) ────────────────

test.describe('access control: a two-region customer’s request is decided by its own region', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;
  const NEW_ADDRESS_BASE = 'Way 7711, Al Khuwair, Muscat';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('acc', {
      regions: [{ key: 'R1' }, { key: 'R2' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'B', region: 'R2' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'M5', role: 'MANAGER', regions: ['R2'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
      ],
      customers: [
        {
          key: 'CHAIN',
          phone: true,
          contact: 'Hilal Al Busaidi',
          branches: [
            { key: 'A1', route: 'A', gps: MUSCAT, photos: ['SHOP', 'SIGNBOARD'], address: 'Way 3012, Al Ghubra North, Muscat' },
            { key: 'B1', route: 'B' },
          ],
        },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('R1’s change to a chain customer: R2’s Manager neither queues, reads nor decides it; R1’s Manager approves it', async ({ browser }) => {
    notRunHere(!hasR2, "the gate needs A1's shop photo (R2)");
    test.setTimeout(300_000);
    const chain = world.customer('CHAIN');
    const a1 = world.branch('CHAIN.A1');
    const newAddress = `${NEW_ADDRESS_BASE} ${world.sfx}`;
    const saPage = await pageAs(browser, world.user('SA'));
    const sent = await submitEnrichViaApi(
      saPage,
      {
        customerId: chain.id,
        branches: [
          {
            branchId: a1.id,
            address: newAddress,
            gpsLat: MUSCAT.lat + 0.002,
            gpsLng: MUSCAT.lng + 0.002,
            gpsAccuracy: 8,
            gpsCapturedAt: new Date().toISOString(),
          },
        ],
      },
      { world }
    );
    expect(sent, JSON.stringify(sent)).toMatchObject({ status: 200, ok: true });
    const editId = receiptEditId(sent)!;

    // R2's Manager: not in his queue; the page is read-only and holds none of A1's changes.
    const m5 = await pageAs(browser, world.user('M5'));
    await m5.goto('/approvals');
    await expectHeading(m5, 'Approval queue', 'M5 queue');
    await expect(m5.getByText(chain.legalName), 'not in R2’s queue').toHaveCount(0);
    await m5.goto(`/approvals/${editId}`);
    await expectHeading(m5, chain.legalName, 'M5 review page');
    await expect(m5.getByText('For your information: this request is waiting at the')).toBeVisible();
    await expect(m5.getByText(/^Not shown: the changes to 1 branch outside your regions\./)).toBeVisible();
    expect(await m5.content(), 'R1’s new address is not sent to R2’s Manager').not.toContain(newAddress);
    // His Approve is refused by the server.
    const approve = m5.getByRole('button', { name: /^✓ Approve$/ });
    await hydrated(approve);
    await approve.click();
    await m5.getByRole('dialog').getByRole('button', { name: /^Approve$/ }).click();
    await expect(m5.getByText('You are not authorized to act on this step.')).toBeVisible();
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true } })).toEqual({ state: 'SUBMITTED' });

    // R1's Manager: in his queue, and he approves it.
    const m1 = await pageAs(browser, world.user('M1'));
    await m1.goto('/approvals');
    await expect(m1.getByText(chain.legalName).first()).toBeVisible();
    await m1.goto(`/approvals/${editId}`);
    await expect(m1.getByText(newAddress).first(), 'R1’s Manager sees the A1 diff').toBeVisible();
    const m1Approve = m1.getByRole('button', { name: /^✓ Approve$/ });
    await hydrated(m1Approve);
    await m1Approve.click();
    await m1.getByRole('dialog').getByRole('button', { name: /^Approve$/ }).click();
    await expectPath(m1, '/approvals', 'approved → back to the queue');
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true, reviewedById: true } })).toEqual({
      state: 'APPROVED',
      reviewedById: world.user('M1').id,
    });
    expect(await db.branch.findUniqueOrThrow({ where: { id: a1.id }, select: { address: true } })).toEqual({ address: newAddress });
  });
});

// ── Temix (exclusive: Generate moves the whole queue) ─────────────────────────

test.describe('access control: Temix actions replayed by the wrong caller', { tag: ['@exclusive'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let batchId: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('act', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'STW', role: 'STEWARD' },
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        { key: 'VW', role: 'VIEWER' },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'FM1', role: 'FINANCE_MANAGER' },
        { key: 'GM1', role: 'GM' },
      ],
      customers: [{ key: 'TQ', phone: true, temixSyncState: 'PENDING_UPLOAD', branches: [{ key: 'S', route: 'A' }] }],
    });
    batchId = await seedTemixBatch(world, { creator: 'STW' });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('Generate and Mark loaded are the Steward’s alone', async ({ browser }) => {
    test.setTimeout(300_000);
    // A replay that a broken guard let through would move the whole UAT queue:
    // only when the queue holds nothing but this world's customer.
    const mine = world.customers().map((c) => c.id);
    const foreign = await db.customer.count({
      where: {
        id: { notIn: mine },
        OR: [{ temixSyncState: 'PENDING_UPLOAD', deletedAt: null }, { temixSyncState: 'DEACTIVATE_PENDING' }],
      },
    });
    notRunHere(foreign > 0, `the UAT Temix queue holds ${foreign} customer(s) that are not this world's — run on a Neon branch`);
    const stw = world.user('STW');
    const tq = world.customer('TQ');
    const rows = { Customer: { id: tq.id }, TemixSyncBatch: { id: batchId } };
    const untouched = await snapshot(['Customer', 'TemixSyncBatch'], rows);

    const generate = await captureAs(browser, stw, '/temix', async (page) => {
      const btn = page.getByRole('button', { name: '⬇ Generate upload file', exact: true });
      await hydrated(btn);
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Generate & download', exact: true }).click();
    });
    expect(generate.actionId).toBe(actionIdFor('generateTemixBatchAction', 'app/(app)/temix/page'));
    const markLoaded = await captureAs(browser, stw, '/temix', async (page) => {
      const row = page.locator('tr').filter({ hasText: `…${batchId.slice(-6)}` });
      const btn = row.getByRole('button', { name: 'Mark loaded', exact: true });
      await hydrated(btn);
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Yes, it is loaded', exact: true }).click();
    });
    expect(markLoaded.actionId).toBe(actionIdFor('markTemixBatchLoadedAction', 'app/(app)/temix/page'));

    const callers = await callersFor(browser, world, ['M1', 'SA', 'VW', 'ACC1', 'FM1', 'GM1']);
    await expectRefused(generate, callers, 'Only the Steward manages Temix sync.');
    await expectRefused(markLoaded, callers, 'Only the Steward manages Temix sync.');
    for (const a of [generate, markLoaded]) await expectSignedOutRefused(a);
    expect(await snapshot(['Customer', 'TemixSyncBatch'], rows), 'the queue and the batch are untouched').toBe(untouched);
    expect(await db.temixSyncBatch.count({ where: { createdById: { in: callers.map((c) => world.user(c.by).id) } } })).toBe(0);
  });
});
