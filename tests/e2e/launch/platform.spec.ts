/**
 * PLATFORM — the checks that need the production build, served with TZ=UTC
 * like Vercel, in a browser set to Asia/Muscat / en-GB:
 *
 *   1. security headers and the CSP on every response type, the nonce, and the
 *      operator smoke script (SEC-HEADERS-PROD);
 *   2. the real flows under the production policy: a salesman's phone submit
 *      with a photo through R2, the manager's review page, both blob
 *      downloads, /notifications (SEC-CSP-GOLDEN-PATHS);
 *   3. every date and time on screen in Oman time — wave 1 FIXED these (times
 *      group), so each page asserts the Oman reading and NOT the UTC one
 *      (TZ-SERVER-RENDERED-TIMES, MGR-TIMEZONE, FIN-26-TIMES-OMAN);
 *   4. no hydration error on a full load of any menu page of any role, nor on
 *      /notifications, nor on /import/<batch> in German and Arabic browsers —
 *      both FIXED in wave 1 (TZ-HYDRATION-418);
 *   5. loading skeletons on a slow phone link, the in-page redirect, Back and
 *      Forward from the router cache, and what the 30-second router cache shows
 *      after a decision made elsewhere (STREAM-LOADING-SKELETONS + the critic's
 *      router-cache scenario);
 *   6. layout at 360, 412 and 768 for every role; the drawer (wave 1 added
 *      Change password to every menu and Export to Supervisor/Manager/Viewer);
 *      Needs correction reachable from Today and Work (wave 1) (MOBILE-LAYOUT);
 *   7. accessibility basics (A11Y-BASICS; the axe scan is a11y.spec.ts);
 *   8. big lists and the slow-phone numbers (PERF-SLOW-PHONE);
 *   9. health and cron endpoints, e-mail off (OPS-HEALTH, OPS-CRON-AUTH,
 *      FIN-20-EMAIL-OFF steps 1-2).
 *
 * Desktop unless a describe says @phone.
 *
 * App bugs found by the 8 Oct run, all FIXED in the launch candidate and asserted
 * as fixed (no test here is expected to fail): the phone drawer is a dialog that
 * takes the focus and closes on its current page (KNOWN_BUGS.drawerA11y,
 * ee81e93); the master export and the field-update report download (81c936e); a
 * query-only tap on Today lands (8e47bc6, TransitionWatchdog); /dashboard at 768
 * does not scroll sideways (f52222a), so it is back in every role's layout
 * loop; the reject form and the Create user form name their fields (cf148e5,
 * 140eed9); 'Current password incorrect.' is read out (8642d85).
 */
import { expect, request as pwRequest, test, type Browser, type Locator, type Page } from '@playwright/test';
import type { Role } from '@prisma/client';
import {
  BASE_URL,
  SERVER_MODE,
  clearSecretFields,
  contextAs,
  createWorld,
  db,
  fillSecret,
  hasR2,
  hitTest,
  homePathFor,
  installLaunchHooks,
  newId,
  notRunHere,
  redact,
  requireLaunchEnv,
  seedNotification,
  seedUpdateEdit,
  signInViaUi,
  standardWorld,
  uniquePng,
  type DeviceKind,
  type FixtureUser,
  type World,
} from './support';
import {
  CRON_KEYS,
  ENGINE_MARKERS,
  PRISMA_BROWSER_SHIM,
  SLOW_4G,
  SLOW_LINK,
  SMOKE_CHECKS,
  SMOKE_VERCEL_ONLY,
  brokenPageHeading,
  collectChunks,
  cronRunsByKey,
  cronRunsSince,
  headingLog,
  imagesWithoutAlt,
  lastUtcInstant,
  minutesApart,
  omanText,
  overflowCulprits,
  pageNow,
  recordHeadings,
  runSmoke,
  scriptMeter,
  seedAuditRow,
  seedImportBatch,
  seedOutboxNotifications,
  seedPendingUpdates,
  seedTemixBatch,
  setLastLogin,
  settle,
  sideOverflow,
  throttle,
  unlabelledControls,
  utcText,
  waitForHydrated,
  watchProblems,
  type HeadingEntry,
} from './support/platform-helpers';
import { relayR2Puts } from './support/approvals-queue-helpers';

// ── shared expectations ───────────────────────────────────────────────────────

/** One fixture account per role in standardWorld. */
const ONE_PER_ROLE: Array<{ key: string; role: Role }> = [
  { key: 'SA', role: 'SALESMAN' },
  { key: 'SUP', role: 'SUPERVISOR' },
  { key: 'M1', role: 'MANAGER' },
  { key: 'STW', role: 'STEWARD' },
  { key: 'VW', role: 'VIEWER' },
  { key: 'ACC1', role: 'ACCOUNTANT' },
  { key: 'FM1', role: 'FINANCE_MANAGER' },
  { key: 'GM1', role: 'GM' },
];

const CHANGE_PASSWORD = { label: 'Change password', path: '/profile/change-password' };
const EXPORT = { label: 'Export', path: '/export' };

/**
 * The menus of the launch build (components/nmwc/Sidebar.tsx NAV_BY_ROLE, which
 * the phone drawer reads too). Wave 1 (admin group) added Change password, last,
 * to every role and Export to the Supervisor, Manager and Viewer.
 */
const MENU: Record<Role, Array<{ label: string; path: string }>> = {
  SALESMAN: [
    { label: 'Today', path: '/today' },
    { label: 'Customers', path: '/customers' },
    { label: 'New customer', path: '/customers/new' },
    { label: 'Work items', path: '/work' },
    { label: 'Needs correction', path: '/rejected' },
    CHANGE_PASSWORD,
  ],
  SUPERVISOR: [
    { label: 'Approvals', path: '/approvals' },
    { label: 'My team', path: '/team' },
    { label: 'Customers', path: '/customers' },
    { label: 'Work items', path: '/work' },
    EXPORT,
    CHANGE_PASSWORD,
  ],
  MANAGER: [
    { label: 'Dashboard', path: '/dashboard' },
    { label: 'Approvals', path: '/approvals' },
    { label: 'Users', path: '/users' },
    { label: 'Routes & regions', path: '/routes' },
    { label: 'Customers', path: '/customers' },
    { label: 'Reactivations', path: '/reactivations' },
    { label: 'Audit log', path: '/audit' },
    { label: 'Work items', path: '/work' },
    { label: 'Service status', path: '/status' },
    EXPORT,
    CHANGE_PASSWORD,
  ],
  STEWARD: [
    { label: 'Import', path: '/import' },
    { label: 'Dashboard', path: '/dashboard' },
    EXPORT,
    { label: 'Temix sync', path: '/temix' },
    { label: 'Customers', path: '/customers' },
    { label: 'Duplicates', path: '/duplicates' },
    { label: 'Routes & regions', path: '/routes' },
    { label: 'Users', path: '/users' },
    { label: 'Audit log', path: '/audit' },
    { label: 'Work items', path: '/work' },
    { label: 'Service status', path: '/status' },
    CHANGE_PASSWORD,
  ],
  VIEWER: [{ label: 'Dashboard', path: '/dashboard' }, { label: 'Customers', path: '/customers' }, EXPORT, CHANGE_PASSWORD],
  ACCOUNTANT: [
    { label: 'Approvals', path: '/approvals' },
    { label: 'Customers', path: '/customers' },
    { label: 'Work items', path: '/work' },
    CHANGE_PASSWORD,
  ],
  FINANCE_MANAGER: [
    { label: 'Approvals', path: '/approvals' },
    { label: 'Customers', path: '/customers' },
    { label: 'Work items', path: '/work' },
    CHANGE_PASSWORD,
  ],
  GM: [
    { label: 'Approvals', path: '/approvals' },
    { label: 'Customers', path: '/customers' },
    { label: 'Work items', path: '/work' },
    CHANGE_PASSWORD,
  ],
};

/** Every page a role reaches from its menu, plus /profile (the salesman's Me tab) and the bell. */
function pagesFor(role: Role, extra: string[] = []): string[] {
  return [...new Set([...MENU[role].map((m) => m.path), '/profile', '/notifications', ...extra])];
}

const UNEXPECTED_RESPONSE = 'An unexpected response was received from the server';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The page is exactly this path (any query or hash). */
const urlIs = (path: string) => new RegExp(`^${escapeRe(BASE_URL)}${escapeRe(path)}(\\?|#|$)`);
/** A PageHeader's subtitle: the <p> right after the page's h1. */
const subtitleOf = (page: Page) => page.locator('main h1 + p').first();

/** "dd/mm/yyyy" → "yyyy-mm-dd". */
const isoOf = (ddmmyyyy: string) => ddmmyyyy.split('/').reverse().join('-');

/**
 * Hard-loads every path as `u` on each device and returns what went wrong:
 * redirected away (the menu offers a page the role cannot open), an HTTP error,
 * an error boundary, a hydration error and — with `layout` — a sideways scroll.
 */
async function visitPages(
  browser: Browser,
  u: FixtureUser,
  paths: string[],
  o: {
    devices: DeviceKind[];
    layout: boolean;
    /** Width checks to leave out (asserted in a test of their own); everything else still runs. None today. */
    skipLayout?: Array<{ device: DeviceKind; path: string }>;
  }
): Promise<string[]> {
  const bad: string[] = [];
  for (const device of o.devices) {
    const ctx = await contextAs(browser, u, { device });
    const page = await ctx.newPage();
    const watch = watchProblems(page);
    for (const path of paths) {
      const res = await page.goto(path);
      await settle(page);
      const at = new URL(page.url()).pathname;
      if (at !== path.split('?')[0]) bad.push(`${device} ${path}: landed on ${at}`);
      if ((res?.status() ?? 200) >= 400) bad.push(`${device} ${path}: HTTP ${res?.status()}`);
      const broken = await brokenPageHeading(page);
      if (broken) bad.push(`${device} ${path}: shows "${broken}"`);
      if (await page.getByText(UNEXPECTED_RESPONSE).count()) bad.push(`${device} ${path}: "${UNEXPECTED_RESPONSE}"`);
      if (o.layout && !o.skipLayout?.some((s) => s.device === device && s.path === path)) {
        const over = await sideOverflow(page);
        if (over > 1) bad.push(`${device} ${path}: ${over}px sideways scroll — ${(await overflowCulprits(page)).join('; ')}`);
      }
    }
    bad.push(...watch.hydration().map((h) => `${device} hydration error — ${h}`));
    await ctx.close();
  }
  return bad;
}

/** A bell for every role: one unread row at 21:30Z (01:30 next day in Oman) and one read row. */
async function seedBellPerRole(w: World, at: Date): Promise<void> {
  for (const { key } of ONE_PER_ROLE) {
    await seedNotification(w, { user: key, kind: 'EDIT_STAGE_ADVANCED', title: w.name('Bell check'), createdAt: at });
    await seedNotification(w, {
      user: key,
      kind: 'EDIT_SUBMITTED',
      title: w.name('Bell check, read'),
      createdAt: new Date(at.getTime() - 3_600_000),
      read: true,
    });
  }
}

/** The value a Today stat tile shows (its first number). */
async function tileNumber(tile: Locator): Promise<number> {
  const text = await tile.innerText();
  return Number(/\d+/.exec(text)?.[0] ?? NaN);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1-2. Security headers and the CSP (SEC-HEADERS-PROD, SEC-CSP-GOLDEN-PATHS)
// ═════════════════════════════════════════════════════════════════════════════

const REQUIRED_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' blob: data:",
];

/** What is wrong with one response's headers (redacted: the policy names the R2 account). */
function headerProblems(what: string, headers: Array<{ name: string; value: string }>): string[] {
  const out: string[] = [];
  const all = (n: string) => headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
  const one = (n: string) => all(n)[0];
  const csps = all('content-security-policy');
  if (csps.length !== 1) out.push(`${what}: ${csps.length} Content-Security-Policy headers (want exactly one)`);
  const csp = csps[0] ?? '';
  for (const d of REQUIRED_DIRECTIVES) if (!csp.includes(d)) out.push(`${what}: CSP lacks ${d}`);
  if (!/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/.test(csp)) {
    out.push(`${what}: script-src is not exactly 'self' 'nonce-…' 'strict-dynamic' — ${redact(/script-src[^;]*/.exec(csp)?.[0] ?? '(none)')}`);
  }
  if (csp.includes("'unsafe-eval'")) out.push(`${what}: CSP allows 'unsafe-eval'`);
  const account = process.env.R2_ACCOUNT_ID;
  if (account && !csp.includes(`https://${account}.r2.cloudflarestorage.com`)) {
    out.push(`${what}: connect-src does not name https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`);
  }
  const want: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(self), camera=(self), microphone=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  for (const [h, v] of Object.entries(want)) if (one(h) !== v) out.push(`${what}: ${h} is ${JSON.stringify(one(h) ?? null)} (want ${v})`);
  if (!(one('strict-transport-security') ?? '').includes('max-age=')) out.push(`${what}: no Strict-Transport-Security`);
  if (all('x-powered-by').length) out.push(`${what}: X-Powered-By is sent`);
  return out;
}

/** The nonce of a document's policy, and whether every <script> of the HTML carries it. */
function nonceCheck(csp: string, html: string): { nonce: string | null; scripts: number; unstamped: number } {
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? null;
  const tags = html.match(/<script\b[^>]*>/gi) ?? [];
  const unstamped = nonce ? tags.filter((t) => !t.includes(`nonce="${nonce}"`)).length : tags.length;
  return { nonce, scripts: tags.length, unstamped };
}

test.describe('platform: security headers and the CSP', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  notRunHere(SERVER_MODE === 'dev', 'next dev adds unsafe-eval and compiles on demand: the production policy is under test');

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('plc', {
      customers: [
        // The golden path's shop: due today on SA's route, no GPS and no photo yet.
        { key: 'GOLD', phone: true, contact: 'Hamad Al Wahaibi', branches: [{ key: 'S', route: 'A', day: 'TODAY' }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  test('every response type carries exactly one CSP and the full set of security headers', async ({ browser }) => {
    const anon = await pwRequest.newContext({ baseURL: BASE_URL });
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    const problems: string[] = [];

    const login = await anon.get('/login', { maxRedirects: 0, failOnStatusCode: false });
    expect(login.status()).toBe(200);
    problems.push(...headerProblems('GET /login', login.headersArray()));

    const health = await anon.get('/api/health', { maxRedirects: 0, failOnStatusCode: false });
    expect(health.status()).toBe(200);
    problems.push(...headerProblems('GET /api/health', health.headersArray()));

    const signedOut = await anon.get('/customers', { maxRedirects: 0, failOnStatusCode: false });
    expect([302, 303, 307, 308], 'signed out, /customers redirects').toContain(signedOut.status());
    expect(signedOut.headers()['location'] ?? '').toContain('/login');
    problems.push(...headerProblems('GET /customers (signed out, redirect)', signedOut.headersArray()));

    const today = await page.goto('/today');
    expect(today?.status()).toBe(200);
    problems.push(...headerProblems('GET /today (signed in)', await today!.headersArray()));

    const shop = world.customer('FULL').photos.find((p) => p.wire === 'SHOP');
    const photoId = shop?.id ?? newId();
    const photo = await page.goto(`/api/photos/${photoId}`);
    expect(photo?.status(), shop ? 'a seeded photo streams' : 'no R2: an unknown photo id').toBe(shop ? 200 : 404);
    problems.push(...headerProblems('GET /api/photos/<id>', await photo!.headersArray()));

    const missing = await page.goto('/no-such-page');
    expect(missing?.status()).toBe(404);
    problems.push(...headerProblems('GET /no-such-page (404)', await missing!.headersArray()));

    expect(problems, 'security header problems').toEqual([]);
    await anon.dispose();
  });

  test('documents: a fresh nonce per request, and every <script> carries it', async ({ browser }) => {
    const anon = await pwRequest.newContext({ baseURL: BASE_URL });
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await anon.get('/login', { failOnStatusCode: false });
      const csp = res.headers()['content-security-policy'] ?? '';
      const c = nonceCheck(csp, await res.text());
      expect(c.nonce, '/login: the policy carries a nonce').toBeTruthy();
      expect(c.scripts, '/login: Next rendered its scripts').toBeGreaterThan(0);
      expect(c.unstamped, '/login: <script> tags without the nonce').toBe(0);
      nonces.push(c.nonce!);
    }
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    for (let i = 0; i < 2; i++) {
      const res = await page.goto('/today');
      const csp = (await res!.allHeaders())['content-security-policy'] ?? '';
      const c = nonceCheck(csp, await res!.text());
      expect(c.nonce, '/today: the policy carries a nonce').toBeTruthy();
      expect(c.scripts).toBeGreaterThan(0);
      expect(c.unstamped, '/today: <script> tags without the nonce').toBe(0);
      nonces.push(c.nonce!);
    }
    expect(new Set(nonces).size, 'every response had its own nonce').toBe(nonces.length);
    // The login form hydrates under the strict policy (an inert page would never set the marker).
    const login = await (await contextAs(browser, null)).newPage();
    await login.goto('/login');
    await expect(login.locator('form[data-hydrated="1"]')).toBeAttached({ timeout: 60_000 });
    await anon.dispose();
  });

  test('npm run smoke against this server passes everything but the Vercel-only checks', async () => {
    test.setTimeout(240_000);
    const smoke = runSmoke();
    const missing = SMOKE_CHECKS.filter((n) => smoke.results[n] === 'missing');
    expect(missing, `smoke checks that did not report (exit ${smoke.status})`).toEqual([]);
    const failed = SMOKE_CHECKS.filter((n) => smoke.results[n] === 'FAIL');
    test.info().annotations.push({
      type: 'smoke',
      description: `Vercel-only on localhost: ${SMOKE_VERCEL_ONLY.map((n) => `${n}=${smoke.results[n]}`).join(', ')}`,
    });
    expect(failed.filter((n) => !SMOKE_VERCEL_ONLY.includes(n)), 'smoke checks that failed on this build').toEqual([]);
  });

  test.describe('the golden paths under the production policy', () => {
    test.describe.configure({ mode: 'serial' });
    let editId: string | undefined;

    test('salesman on a phone: sign in, Today, Enrich, Capture GPS, a photo through R2, Submit — no CSP violation', async ({
      browser,
    }) => {
      notRunHere(!hasR2, 'the photo upload needs R2');
      test.setTimeout(300_000);
      const sa = world.user('SA');
      const gold = world.customer('GOLD');
      const ctx = await contextAs(browser, null, { device: 'phone' });
      const page = await ctx.newPage();
      const watch = watchProblems(page);

      // signInViaUi waits for form[data-hydrated="1"]: the form came alive under the nonce policy.
      await signInViaUi(page, sa.username, sa.password, { ip: world.ip(1) });
      await expect(page).toHaveURL(urlIs('/today'));
      await page.getByRole('link', { name: `${gold.legalName} · ${gold.code}` }).click();
      await expect(page).toHaveURL(urlIs(`/customers/${gold.id}`));
      await page.getByRole('link', { name: 'Enrich', exact: true }).click();
      await expect(page).toHaveURL(urlIs(`/customers/${gold.id}/edit`));
      const submit = page.getByRole('button', { name: /^Submit for approval/ });
      await waitForHydrated(submit);

      await page.getByRole('button', { name: /^Capture GPS/ }).click();
      await expect(page.getByRole('button', { name: 'Recapture GPS' })).toBeVisible();

      // The shop photo: compressed in the browser, PUT straight to R2 (connect-src), finalized, attached live.
      // The bucket's CORS rule admits the browser's PUT from http://localhost:3000 only: on a lane's own
      // E2E_PORT the PUT is relayed from Node (relayR2Puts; nothing is routed on 3000). The CSP is still
      // the browser's: connect-src is checked in the page before the request reaches the route.
      await relayR2Puts(page);
      const shopSlot = page.getByText(/^Shop front( \*)?$/).locator('xpath=ancestor::div[.//input[@type="file"]][1]');
      const put = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).hostname.endsWith('.r2.cloudflarestorage.com'),
        { timeout: 120_000 }
      );
      await shopSlot.locator('input[type="file"]').setInputFiles({ name: 'shop.png', mimeType: 'image/png', buffer: uniquePng() });
      expect((await put).status(), 'the browser PUT to R2').toBe(200);
      await expect
        .poll(
          async () => (await db.branch.findUniqueOrThrow({ where: { id: gold.branch.id }, select: { shopPhotoId: true } })).shopPhotoId,
          { timeout: 90_000, message: 'the shop photo is attached to the branch' }
        )
        .not.toBeNull();
      const attached = await db.branch.findUniqueOrThrow({ where: { id: gold.branch.id }, select: { shopPhotoId: true } });
      world.adopt.attachment(attached.shopPhotoId!);

      await expect(submit).toBeEnabled();
      await submit.click();
      // The form says it arrived and replaces itself with the profile.
      await expect(page).toHaveURL(urlIs(`/customers/${gold.id}`), { timeout: 60_000 });
      const edit = await db.customerEdit.findFirstOrThrow({
        where: { customerId: gold.id, submittedById: sa.id, state: 'SUBMITTED' },
        select: { id: true, pendingRole: true, fieldChanges: true },
      });
      world.adopt.edit(edit.id);
      editId = edit.id;
      expect(edit.pendingRole).toBe('SUPERVISOR');
      expect(JSON.stringify(edit.fieldChanges)).toContain('.gpsLat');

      expect(watch.csp(), 'CSP violations on the salesman flow').toEqual([]);
      expect(watch.hydration(), 'hydration errors on the salesman flow').toEqual([]);
    });

    test('manager: the review page with photo thumbnails and the map links, then /notifications — no CSP violation', async ({
      browser,
    }) => {
      notRunHere(!hasR2, 'the salesman step uploads a photo to R2');
      test.skip(!editId, 'the salesman step did not submit');
      const m1 = world.user('M1');
      const page = await (await contextAs(browser, m1)).newPage();
      const watch = watchProblems(page);

      await page.goto(`/approvals/${editId}`);
      const thumb = page.getByRole('img', { name: 'Shop front' }).first();
      await thumb.scrollIntoViewIfNeeded();
      await expect
        .poll(() => thumb.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { message: 'the thumbnail decodes' })
        .toBeGreaterThan(0);
      const proposed = page.getByRole('link', { name: 'View proposed location on map' });
      await expect(proposed).toHaveAttribute('href', /^https:\/\//);
      await expect(proposed).toHaveAttribute('target', '_blank');

      // A complete shop (FULL): three live thumbnails and "Open in Google Maps" on the location on file.
      const full = await seedUpdateEdit(world, {
        customer: 'FULL',
        submitter: 'SA',
        patch: { branches: [{ branch: 'FULL', openingHours: '07:00-23:00' }] },
        slaDueAt: new Date(Date.now() + 3 * 86_400_000),
      });
      await page.goto(`/approvals/${full.id}`);
      for (const name of ['CR document', 'Shop front', 'Signboard']) {
        const img = page.getByRole('img', { name }).first();
        await img.scrollIntoViewIfNeeded();
        await expect
          .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { message: `${name} decodes` })
          .toBeGreaterThan(0);
      }
      const maps = page.getByRole('link', { name: 'Open in Google Maps' }).first();
      await expect(maps).toHaveAttribute('href', /^https:\/\//);
      await expect(maps).toHaveAttribute('rel', /noopener/);

      await page.goto('/notifications');
      await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
      await settle(page);

      expect(watch.csp(), 'CSP violations on the manager pages').toEqual([]);
      expect(watch.hydration(), 'hydration errors on the manager pages').toEqual([]);
    });
  });

  test("blob download: the Steward's /export 'Download .xlsx' saves the master under the Oman date", async ({ browser }) => {
    // Was an APP BUG (blocker), fixed by 81c936e: GET /api/exports/customers answered 500 "Export failed"
    // (export.fail "b is not a constructor") — lib/excel.ts PassThrough was undefined in the webpack server build.
    test.setTimeout(300_000);
    const today = isoOf(omanText(new Date()).date);

    const stw = await (await contextAs(browser, world.user('STW'))).newPage();
    const stwWatch = watchProblems(stw);
    await stw.goto('/export');
    const xlsx = stw.getByRole('button', { name: 'Download .xlsx' });
    await waitForHydrated(xlsx);
    // Only what changed today (the fixtures, a few real rows), not the whole UAT master. Found by its label
    // (claude/fix-small-7, 28e7075, ties the /export labels to their inputs).
    await stw.getByLabel('Updated since', { exact: true }).fill(today);
    const answer = stw.waitForResponse((r) => new URL(r.url()).pathname === '/api/exports/customers', { timeout: 180_000 });
    const saved = stw.waitForEvent('download', { timeout: 180_000 });
    saved.catch(() => undefined);
    await xlsx.click();
    expect((await answer).status(), 'GET /api/exports/customers').toBe(200);
    const master = await saved;
    expect(master.suggestedFilename()).toBe(`nmwc-customer-master-${today}.xlsx`);
    expect(await master.failure(), 'the master download completes').toBeNull();
    // The form's own refusal box (Next's empty route announcer is role=alert on every page too).
    await expect(stw.locator('form').getByRole('alert')).toHaveCount(0);
    expect(stwWatch.csp(), 'CSP violations on the master download').toEqual([]);
  });

  test("blob download: the Steward's field-update report saves under the Oman date", async ({ browser }) => {
    // Was an APP BUG (blocker), fixed by 81c936e: GET /api/exports/changes failed the same way (the same
    // lib/excel.ts openStreamedWorkbook).
    test.setTimeout(300_000);
    const today = isoOf(omanText(new Date()).date);
    const stw = await (await contextAs(browser, world.user('STW'))).newPage();
    const watch = watchProblems(stw);
    await stw.goto('/export');
    const report = stw.getByRole('button', { name: 'Download field-update report' });
    await waitForHydrated(report);
    // Today's changes only, rows with changes only: a small file.
    await stw.getByLabel('Changes from', { exact: true }).fill(today);
    await stw.getByLabel('Changes until', { exact: true }).fill(today);
    await stw.getByLabel('Only customers with changes').check();
    const answer = stw.waitForResponse((r) => new URL(r.url()).pathname === '/api/exports/changes', { timeout: 180_000 });
    const saved = stw.waitForEvent('download', { timeout: 180_000 });
    saved.catch(() => undefined);
    await report.click();
    expect((await answer).status(), 'GET /api/exports/changes').toBe(200);
    const file = await saved;
    expect(file.suggestedFilename()).toBe(`nmwc-field-updates-${today}.xlsx`);
    expect(await file.failure(), 'the report download completes').toBeNull();
    await expect(stw.locator('form').getByRole('alert')).toHaveCount(0);
    expect(watch.csp(), 'CSP violations on the report download').toEqual([]);
  });

  test("blob download: the Manager's /customers 'Export filtered' saves under the Oman date", async ({ browser }) => {
    test.setTimeout(300_000);
    const today = isoOf(omanText(new Date()).date);
    const mgr = await (await contextAs(browser, world.user('M1'))).newPage();
    const mgrWatch = watchProblems(mgr);
    await mgr.goto('/customers');
    const exportFiltered = mgr.getByRole('button', { name: 'Export filtered' });
    await waitForHydrated(exportFiltered);
    const [filtered] = await Promise.all([mgr.waitForEvent('download', { timeout: 120_000 }), exportFiltered.click()]);
    expect(filtered.suggestedFilename()).toBe(`customers-${today}.xlsx`);
    expect(await filtered.failure(), 'the filtered download completes').toBeNull();

    expect(mgrWatch.csp(), 'CSP violations on the filtered download').toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Times in Oman time (TZ-SERVER-RENDERED-TIMES, MGR-TIMEZONE, FIN-26-TIMES-OMAN)
//    Fixed in wave 1 (times group): every page asserts the Oman reading.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('platform: every time on screen is Oman time while the server runs UTC', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  /** The last 21:30Z: 01:30 the NEXT day in Oman — a UTC page shows the wrong time AND date. */
  let T1: Date;
  /** 06:30Z that same UTC day: 10:30 in Oman (MGR-TIMEZONE). */
  let T2: Date;
  /** FULL's GPS capture: 21:55Z. */
  let TG: Date;
  /** The Temix batch's "loaded" stamp: 22:30Z. */
  let TL: Date;
  /** The canary: the last 05:30Z, 09:30 in Oman. */
  let T0530: Date;
  let returnedId: string;
  let pendingId: string;
  let importFile: string;
  let temixId: string;
  let auditReason: string;
  let bellTitle: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('plt', {
      routes: [{ key: 'AS', region: 'R1' }],
      // A salesman under the Supervisor, for /team.
      users: [{ key: 'SS', role: 'SALESMAN', route: 'AS', supervisor: 'SUP' }],
    });
    T1 = lastUtcInstant(21, 30);
    T2 = new Date(T1.getTime() - 15 * 3_600_000);
    TG = new Date(T1.getTime() + 25 * 60_000);
    TL = new Date(T1.getTime() + 60 * 60_000);
    T0530 = lastUtcInstant(5, 30);
    auditReason = world.name('Oman time audit row');
    bellTitle = world.name('Oman time bell');

    await db.branch.update({ where: { id: world.branch('FULL').id }, data: { gpsCapturedAt: TG } });
    // Sent at 10:30 Oman, sent back by M1 at 01:30 the next Oman day.
    returnedId = (
      await seedUpdateEdit(world, {
        customer: 'FULL',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('Returned contact') } },
        state: 'NEEDS_CORRECTION',
        submittedAt: T2,
        decision: { by: 'M1', reason: world.name('Re-check the contact'), at: T1 },
      })
    ).id;
    // Sent at 01:30 Oman; its deadline is ahead, so no SLA sweep touches it.
    pendingId = (
      await seedUpdateEdit(world, {
        customer: 'DUE1',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('Pending contact') } },
        submittedAt: T1,
        stageEnteredAt: T1,
        slaDueAt: new Date(Date.now() + 3 * 86_400_000),
      })
    ).id;
    await seedAuditRow(world, { actor: 'M1', customer: 'FULL', at: T1, reason: auditReason });
    importFile = (await seedImportBatch(world, { uploader: 'STW', rows: 0, status: 'PROMOTED', uploadedAt: T1 })).filename;
    temixId = await seedTemixBatch(world, { createdBy: 'STW', createdAt: T1, markedLoadedAt: TL });
    await seedNotification(world, { user: 'M1', kind: 'EDIT_SUBMITTED', title: bellTitle, editId: pendingId, createdAt: T1 });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  test('approval page: submitted, decided, chain history and GPS capture times read in Oman time (MGR-TIMEZONE, FIN-26)', async ({
    browser,
  }) => {
    const sa = world.user('SA');
    const m1 = world.user('M1');
    const page = await (await contextAs(browser, m1)).newPage();
    await page.goto(`/approvals/${returnedId}`);
    const main = page.locator('main');

    await expect(subtitleOf(page)).toContainText(`submitted by ${sa.fullName} · ${omanText(T2).dateTime}`);
    expect(omanText(T2).dateTime).toMatch(/, 10:30:00$/);
    await expect(page.getByText(/^Decision:/).first()).toContainText(`by ${m1.fullName} on ${omanText(T1).dateTime}`);
    await expect(page.getByRole('listitem').filter({ hasText: `at SUPERVISOR step by ${m1.fullName}` })).toContainText(
      omanText(T1).dateTime
    );
    await expect(page.getByText(`captured ${omanText(TG).dateTime}`)).toBeVisible();
    for (const t of [T1, T2, TG]) await expect(main).not.toContainText(utcText(t).dateTime);

    // A request sent at 21:30Z is dated the next Oman day in its subtitle.
    await page.goto(`/approvals/${pendingId}`);
    await expect(subtitleOf(page)).toContainText(`submitted by ${sa.fullName} · ${omanText(T1).dateTime}`);
    await expect(main).not.toContainText(utcText(T1).dateTime);
  });

  test("/audit: the When column is Oman time, for the Manager's and the Steward's log", async ({ browser }) => {
    for (const key of ['M1', 'STW']) {
      const page = await (await contextAs(browser, world.user(key))).newPage();
      await page.goto(`/audit?q=${encodeURIComponent(world.customer('FULL').id)}`);
      const row = page.getByRole('row').filter({ hasText: auditReason });
      await expect(row, `${key}: the seeded audit row is listed`).toHaveCount(1);
      await expect(row).toContainText(omanText(T1).dateTime);
      await expect(row).not.toContainText(utcText(T1).dateTime);
    }
  });

  test('/customers/<id>: Recent activity is Oman time', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('M1'))).newPage();
    await page.goto(`/customers/${world.customer('DUE1').id}`);
    const line = page.getByRole('listitem').filter({ hasText: `${world.user('SA').fullName} submitted 1 change(s)` });
    await expect(line).toContainText(omanText(T1).dateTime);
    await expect(line).not.toContainText(utcText(T1).dateTime);
  });

  test('/import: the batch list is Oman time', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    await page.goto('/import');
    const row = page.getByRole('row').filter({ hasText: importFile });
    await expect(row).toContainText(omanText(T1).dateTime);
    await expect(row).not.toContainText(utcText(T1).dateTime);
  });

  test('/profile: Last login 05:30Z reads 09:30 — the canary that the server really runs UTC', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    // After the context exists: a fallback UI sign-in would itself write lastLoginAt.
    await setLastLogin(world, 'SA', T0530);
    await page.goto('/profile');
    const value = page.locator('dt', { hasText: 'Last login' }).locator('xpath=following-sibling::dd[1]');
    expect(omanText(T0530).dateTime).toMatch(/, 09:30:00$/);
    await expect(value).toHaveText(omanText(T0530).dateTime);
  });

  test('/rejected: the date a request was sent back is the Oman date', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/rejected');
    await expect(page.getByText(`Sent back by ${world.user('M1').fullName} · ${omanText(T1).date}`)).toBeVisible();
    await expect(page.locator('main')).not.toContainText(`· ${utcText(T1).date}`);
  });

  test('/team: last login is the Oman date', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SUP'))).newPage();
    await setLastLogin(world, 'SS', T1);
    await page.goto('/team');
    const row = page.getByRole('row').filter({ hasText: world.user('SS').username });
    await expect(row).toContainText(omanText(T1).date);
    await expect(row).not.toContainText(utcText(T1).date);
  });

  test('/temix: batch created and loaded stamps are Oman time', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    const marker = `…${temixId.slice(-6)}`;
    let row = page.getByRole('row').filter({ hasText: marker });
    // The history pages 20 at a time; the seeded batch is recent but others may be newer.
    for (let p = 1; p <= 10; p++) {
      await page.goto(p === 1 ? '/temix' : `/temix?page=${p}`);
      // The page streams behind loading.tsx: count rows only once the real page is on screen.
      await expect(page.getByRole('heading', { level: 2, name: 'Batch history', exact: true })).toBeVisible();
      row = page.getByRole('row').filter({ hasText: marker });
      if ((await row.count()) > 0) break;
    }
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(omanText(T1).dateTime);
    await expect(row).toContainText(`✓ ${omanText(TL).date}`);
    await expect(row).not.toContainText(utcText(T1).dateTime);
  });

  test('/users: last login is the Oman date', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    await setLastLogin(world, 'FM1', T1);
    await page.goto('/users');
    const row = page.getByRole('row').filter({ hasText: world.user('FM1').username });
    await expect(row).toContainText(omanText(T1).date);
    await expect(row).not.toContainText(utcText(T1).date);
  });

  test('/work: a sent-back request is dated in Oman', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/work');
    const item = page.getByRole('link').filter({ hasText: world.customer('FULL').legalName });
    await expect(item).toContainText('Needs correction');
    await expect(item).toContainText(omanText(T1).date);
    await expect(item).not.toContainText(utcText(T1).date);
  });

  test('/today: the header date is the Oman day', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    const before = omanText(new Date()).longDate;
    await page.goto('/today');
    const after = omanText(new Date()).longDate;
    await expect(subtitleOf(page)).toHaveText(before === after ? before : new RegExp(`^(${escapeRe(before)}|${escapeRe(after)})$`));
  });

  test('/notifications: the list stamp is Oman time and the page hydrates without #418 (MGR-TIMEZONE)', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('M1'))).newPage();
    const watch = watchProblems(page);
    await page.goto('/notifications');
    await settle(page);
    // M1's only notification in this world is the seeded one.
    await expect(page.getByText(bellTitle)).toBeVisible();
    await expect(page.getByText(omanText(T1).dayTime, { exact: true })).toBeVisible();
    await expect(page.getByText(utcText(T1).dayTime, { exact: true })).toHaveCount(0);
    expect(watch.hydration(), 'hydration errors on /notifications').toEqual([]);
  });

  test("already right and staying right: the dashboard's 'Figures as of' and /status 'Measured at' read the Oman clock", async ({
    browser,
  }) => {
    const page = await (await contextAs(browser, world.user('M1'))).newPage();
    for (const [path, re] of [
      ['/dashboard', /^Figures as of (\d{2}:\d{2}) Oman time$/],
      ['/status', /^Measured at (\d{2}:\d{2}) Oman time$/],
    ] as const) {
      await page.goto(path);
      const stamp = page.getByText(re);
      await expect(stamp, `${path}: the stamp`).toBeVisible({ timeout: 60_000 });
      const shown = re.exec((await stamp.innerText()).trim())?.[1] ?? '';
      const now = omanText(new Date()).hhmm;
      expect(minutesApart(shown, now), `${path}: ${shown} against Oman ${now}`).toBeLessThanOrEqual(3);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Hydration on a full load (TZ-HYDRATION-418) — desktop; the phone and tablet
//    widths load the same pages in the layout describe below, with the same check.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('platform: no hydration error on a full load of any menu page', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  notRunHere(SERVER_MODE === 'dev', 'next dev reports hydration differently; the production build is under test');

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('plh');
    await seedBellPerRole(world, lastUtcInstant(21, 30));
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  for (const { key, role } of ONE_PER_ROLE) {
    test(`${role}: every menu page, /profile and /notifications hard-loaded in Asia/Muscat en-GB`, async ({ browser }) => {
      test.setTimeout(480_000);
      const extra = role === 'SALESMAN' ? [`/customers/${world.customer('FULL').id}`, `/customers/${world.customer('FULL').id}/edit`] : [];
      const bad = await visitPages(browser, world.user(key), pagesFor(role, extra), { devices: ['desktop'], layout: false });
      expect(bad, `${role}: pages that did not load cleanly`).toEqual([]);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Loading skeletons on a slow link, and the router cache (STREAM-LOADING-SKELETONS)
// ═════════════════════════════════════════════════════════════════════════════

const isSkeleton = (e: HeadingEntry) => e.sub === 'Loading…' || e.h1 === 'Loading your day…';

/** Skeleton first, then the page: the first skeleton entry after t0, and the first real one. */
function skeletonThenPage(log: HeadingEntry[], t0: number, target: { path: string; title: string }) {
  const after = log.filter((e) => e.t >= t0);
  const skeleton = after.find(isSkeleton);
  const page = after.find((e) => e.path === target.path && e.h1 === target.title && !isSkeleton(e));
  return { skeleton, page, skeletonMs: skeleton ? Math.round(skeleton.t - t0) : null, pageMs: page ? Math.round(page.t - t0) : null };
}

test.describe('platform: loading skeletons on a slow phone link', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  notRunHere(SERVER_MODE === 'dev', 'next dev compiles on demand: the production build is under test');

  let world: World;
  let pendingId: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('pls');
    pendingId = (
      await seedUpdateEdit(world, {
        customer: 'GAPS',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('Router cache contact') } },
        slaDueAt: new Date(Date.now() + 3 * 86_400_000),
      })
    ).id;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  const SALESMAN_TABS = [
    { label: 'Customers', path: '/customers', title: 'Customers', ready: (p: Page) => p.getByText(/^~?[\d,]+ total$/) },
    { label: 'Work', path: '/work', title: 'Work items', ready: (p: Page) => p.getByText('Things that need your attention', { exact: true }) },
    { label: 'Me', path: '/profile', title: 'My profile', ready: (p: Page) => p.getByRole('heading', { level: 1, name: 'My profile' }) },
  ];
  const tabBarOf = (p: Page) => p.getByRole('navigation').filter({ has: p.getByRole('link', { name: 'Me', exact: true }) });

  test('salesman: each tab paints its loading skeleton at once, then the page', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await (await contextAs(browser, world.user('SA'), { device: 'phone' })).newPage();
    await page.goto('/today');
    await settle(page);
    const tabs = tabBarOf(page);
    await waitForHydrated(tabs.getByRole('link', { name: 'Customers', exact: true }));
    await recordHeadings(page);
    await throttle(page, SLOW_LINK);
    for (const tab of SALESMAN_TABS) {
      const t0 = await pageNow(page);
      await tabs.getByRole('link', { name: tab.label, exact: true }).tap();
      await expect(page).toHaveURL(urlIs(tab.path), { timeout: 60_000 });
      await expect(tab.ready(page)).toBeVisible({ timeout: 60_000 });
      const r = skeletonThenPage(await headingLog(page), t0, tab);
      test.info().annotations.push({ type: 'skeleton', description: `${tab.label}: skeleton at ${r.skeletonMs} ms, page at ${r.pageMs} ms` });
      expect(r.skeleton, `${tab.label}: a loading skeleton was painted (never a frozen old page)`).toBeTruthy();
      expect(r.skeletonMs!, `${tab.label}: the skeleton came at once (target 300 ms on this throttle)`).toBeLessThanOrEqual(1_000);
      if (r.page) expect(r.skeleton!.t, `${tab.label}: the skeleton came before the page`).toBeLessThanOrEqual(r.page.t);
      await expect(page.getByText(UNEXPECTED_RESPONSE)).toHaveCount(0);
    }
  });

  test('salesman: opening /approvals on a slow link still lands on Today (the redirect inside a streamed page)', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await (await contextAs(browser, world.user('SA'), { device: 'phone' })).newPage();
    await page.goto('/today');
    await settle(page);
    await throttle(page, SLOW_LINK);
    await page.goto('/approvals', { waitUntil: 'commit', timeout: 90_000 });
    await expect(page).toHaveURL(urlIs('/today'), { timeout: 90_000 });
    await expect(page.getByRole('heading', { level: 1, name: /^Good day, / })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(UNEXPECTED_RESPONSE)).toHaveCount(0);
  });

  test('salesman: Back and Forward within 30 s come from the router cache, with no server round trip', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, world.user('SA'), { device: 'phone' })).newPage();
    await page.goto('/today');
    await settle(page);
    const tabs = tabBarOf(page);
    await waitForHydrated(tabs.getByRole('link', { name: 'Customers', exact: true }));
    await throttle(page, SLOW_LINK);
    const [customers, work] = SALESMAN_TABS;
    await tabs.getByRole('link', { name: customers!.label, exact: true }).tap();
    await expect(customers!.ready(page)).toBeVisible({ timeout: 60_000 });
    await tabs.getByRole('link', { name: work!.label, exact: true }).tap();
    await expect(work!.ready(page)).toBeVisible({ timeout: 60_000 });

    // RSC fetches of a page itself (prefetches of links on screen are not a round trip for it).
    const fetched: string[] = [];
    page.on('request', (r) => {
      const h = r.headers();
      if (h['rsc'] === '1' && !h['next-router-prefetch']) fetched.push(new URL(r.url()).pathname);
    });
    let t0 = Date.now();
    await page.goBack({ waitUntil: 'commit' });
    await expect(page).toHaveURL(urlIs('/customers'));
    await expect(customers!.ready(page)).toBeVisible({ timeout: 10_000 });
    const backMs = Date.now() - t0;
    t0 = Date.now();
    await page.goForward({ waitUntil: 'commit' });
    await expect(page).toHaveURL(urlIs('/work'));
    await expect(work!.ready(page)).toBeVisible({ timeout: 10_000 });
    const forwardMs = Date.now() - t0;
    test.info().annotations.push({ type: 'router-cache', description: `Back ${backMs} ms, Forward ${forwardMs} ms on a 400 ms link` });
    expect(fetched.filter((p) => p === '/customers' || p === '/work'), 'Back/Forward re-fetched the page').toEqual([]);
    await expect(page.getByText(UNEXPECTED_RESPONSE)).toHaveCount(0);
  });

  test('records what a salesman sees for 30 s after a decision made elsewhere, and that a reload is fresh (critic: router cache)', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await (await contextAs(browser, world.user('SA'), { device: 'phone' })).newPage();
    await page.goto('/today');
    await settle(page);
    const tile = page.getByRole('link', { name: /Needs correction/ });
    expect(await tileNumber(tile), 'nothing sent back yet').toBe(0);
    const tabs = tabBarOf(page);
    await waitForHydrated(tabs.getByRole('link', { name: 'Work', exact: true }));
    await tabs.getByRole('link', { name: 'Work', exact: true }).tap();
    await expect(page).toHaveURL(urlIs('/work'));

    // The Manager sends the request back, elsewhere (the decision itself is the approval specs').
    await db.customerEdit.update({
      where: { id: pendingId },
      data: {
        state: 'NEEDS_CORRECTION',
        pendingRole: null,
        slaDueAt: null,
        reviewedById: world.user('M1').id,
        reviewedAt: new Date(),
        decisionReason: world.name('Sent back while the phone had Today cached'),
      },
    });

    await tabs.getByRole('link', { name: 'Today', exact: true }).tap();
    await expect(page).toHaveURL(urlIs('/today'));
    const cached = await tileNumber(page.getByRole('link', { name: /Needs correction/ }));
    test.info().annotations.push({
      type: 'router-cache',
      description: `Today re-opened within 30 s of its last load showed Needs correction = ${cached} (the server now says 1; staleTimes.dynamic = 30)`,
    });
    await page.reload();
    expect(await tileNumber(page.getByRole('link', { name: /Needs correction/ })), 'a reload shows the decision').toBe(1);
  });

  test('manager on a phone: each drawer item paints its skeleton before the page', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await (await contextAs(browser, world.user('M1'), { device: 'phone' })).newPage();
    await page.goto('/dashboard');
    await settle(page);
    const open = page.getByRole('button', { name: 'Open menu' });
    await waitForHydrated(open);
    await recordHeadings(page);
    await throttle(page, SLOW_LINK);
    const items = [
      { label: 'Approvals', path: '/approvals', title: 'Approval queue', ready: (p: Page) => p.getByText(/^\d+ pending/) },
      { label: 'Audit log', path: '/audit', title: 'Audit log', ready: (p: Page) => p.getByText(/matching events$/) },
      { label: 'Customers', path: '/customers', title: 'Customers', ready: (p: Page) => p.getByText(/^~?[\d,]+ total$/) },
    ];
    for (const item of items) {
      await open.tap();
      const drawer = page.locator('#mobile-nav-drawer');
      await expect(drawer).toBeVisible();
      const t0 = await pageNow(page);
      await drawer.getByRole('link', { name: item.label, exact: true }).tap();
      await expect(page).toHaveURL(urlIs(item.path), { timeout: 60_000 });
      await expect(item.ready(page)).toBeVisible({ timeout: 60_000 });
      await expect(drawer).toBeHidden();
      const r = skeletonThenPage(await headingLog(page), t0, item);
      test.info().annotations.push({ type: 'skeleton', description: `drawer ${item.label}: skeleton at ${r.skeletonMs} ms, page at ${r.pageMs} ms` });
      expect(r.skeleton, `${item.label}: a loading skeleton was painted (never a frozen old page)`).toBeTruthy();
      if (r.page) expect(r.skeleton!.t, `${item.label}: the skeleton came before the page`).toBeLessThanOrEqual(r.page.t);
      await expect(page.getByText(UNEXPECTED_RESPONSE)).toHaveCount(0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Layout for every role (MOBILE-LAYOUT) — 360x740, 412x915, 768x1024
// ═════════════════════════════════════════════════════════════════════════════

test.describe('platform: layout for every role at 360, 412 and 768', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('pll');
    await seedBellPerRole(world, lastUtcInstant(21, 30));
    // Something sent back to SA, so Needs correction has a row to reach.
    await seedUpdateEdit(world, {
      customer: 'GAPS',
      submitter: 'SA',
      patch: { customer: { contactPerson: world.name('Layout contact') } },
      state: 'NEEDS_CORRECTION',
      decision: { by: 'M1', reason: world.name('Add the contact person') },
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  for (const { key, role } of ONE_PER_ROLE) {
    test(`${role}: no sideways scroll and no hydration error on any menu page at 360, 412 and 768`, async ({ browser }) => {
      test.setTimeout(900_000);
      const full = world.customer('FULL').id;
      const extra = role === 'SALESMAN' ? [`/customers/${full}`, `/customers/${full}/edit`] : [];
      const bad = await visitPages(browser, world.user(key), pagesFor(role, extra), {
        devices: ['phone360', 'phone', 'tablet'],
        layout: true,
      });
      expect(bad, `${role}: layout problems`).toEqual([]);
    });
  }

  test('the insights dashboard at 768 has no sideways scroll (Manager, Steward, Viewer)', async ({ browser }) => {
    // Was an APP BUG (minor, layout), fixed by f52222a: at 768 px (sidebar shown) /dashboard scrolled 3 px sideways
    // for every dashboard role — the "Where the located branches are" card put the map and the coverage side by side
    // from md, leaving the coverage column ~16 px. They stack below lg now. /dashboard at 768 is also back in each
    // role's layout loop above; this test names the three dashboard roles on their own.
    test.setTimeout(300_000);
    const bad: string[] = [];
    for (const key of ['M1', 'STW', 'VW']) {
      const ctx = await contextAs(browser, world.user(key), { device: 'tablet' });
      const page = await ctx.newPage();
      await page.goto('/dashboard');
      await settle(page);
      await expect(page.getByText(/^Figures as of \d{2}:\d{2} Oman time$/)).toBeVisible({ timeout: 60_000 });
      const over = await sideOverflow(page);
      if (over > 1) bad.push(`${key}: ${over}px — ${(await overflowCulprits(page, 5)).join('; ')}`);
      await ctx.close();
    }
    if (bad.length) {
      test.info().annotations.push({ type: 'overflow', description: bad.join(' | ') });
      console.log(`[platform] /dashboard at 768: ${bad.join(' | ')}`);
    }
    expect(bad, '/dashboard at 768').toEqual([]);
  });

  test('below 768: the drawer lists the role menu, closes on Escape and on navigation, and Sign out is reachable', async ({ browser }) => {
    test.setTimeout(420_000);
    for (const { key, role } of ONE_PER_ROLE.filter((r) => r.role !== 'SALESMAN')) {
      const ctx = await contextAs(browser, world.user(key), { device: 'phone360' });
      const page = await ctx.newPage();
      const home = homePathFor(role);
      await page.goto(home);
      await settle(page);
      const open = page.getByRole('button', { name: 'Open menu' });
      await waitForHydrated(open);
      await open.click();
      const drawer = page.locator('#mobile-nav-drawer');
      await expect(drawer, `${role}: the drawer opens`).toBeVisible();
      await expect(open).toHaveAttribute('aria-expanded', 'true');
      expect((await drawer.getByRole('link').allInnerTexts()).map((t) => t.trim()), `${role}: the drawer lists the menu`).toEqual(
        MENU[role].map((m) => m.label)
      );
      await page.keyboard.press('Escape');
      await expect(drawer, `${role}: Escape closes the drawer`).toBeHidden();

      await open.click();
      const target = MENU[role].find((m) => m.path !== home && m.path !== CHANGE_PASSWORD.path)!;
      await drawer.getByRole('link', { name: target.label, exact: true }).click();
      await expect(page).toHaveURL(urlIs(target.path), { timeout: 60_000 });
      await expect(drawer, `${role}: the drawer closes on navigation`).toBeHidden();

      const signOut = page.getByRole('button', { name: 'Sign out' });
      await expect(signOut).toBeVisible();
      expect(await hitTest(page, signOut), `${role}: Sign out is not covered at 360 px`).toBe(true);
      await ctx.close();
    }
  });

  test('at 768: the sidebar shows, the phone tab bar and the menu button do not', async ({ browser }) => {
    const sa = await (await contextAs(browser, world.user('SA'), { device: 'tablet' })).newPage();
    await sa.goto('/today');
    await settle(sa);
    await expect(sa.getByRole('link', { name: 'Needs correction', exact: true }), 'the salesman sidebar').toBeVisible();
    await expect(sa.getByRole('link', { name: 'Me', exact: true }), 'the phone tab bar is hidden').toBeHidden();
    expect(await sideOverflow(sa)).toBeLessThanOrEqual(1);

    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'tablet' })).newPage();
    await m1.goto('/dashboard');
    await settle(m1);
    await expect(m1.getByRole('link', { name: 'Audit log', exact: true }), 'the manager sidebar').toBeVisible();
    await expect(m1.getByRole('button', { name: 'Open menu' }), 'no drawer button at 768').toBeHidden();
  });

  test('a salesman on a phone: the tab bar, Submit above it, New customer from Today, Needs correction from Today and from Work', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const full = world.customer('FULL');
    const gaps = world.customer('GAPS');
    for (const device of ['phone360', 'phone'] as const) {
      const ctx = await contextAs(browser, world.user('SA'), { device });
      const page = await ctx.newPage();
      await page.goto('/today');
      await settle(page);
      const tabBar = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Me', exact: true }) });
      expect((await tabBar.getByRole('link').allInnerTexts()).map((t) => t.trim()), `${device}: the tab bar`).toEqual([
        'Today',
        'Customers',
        'Work',
        'Me',
      ]);

      // Wave 1: the red Today tile and the Work link reach /rejected (no menu entry on a phone).
      const tile = page.getByRole('link', { name: /Needs correction/ });
      expect(await tileNumber(tile)).toBe(1);
      await tile.click();
      await expect(page).toHaveURL(urlIs('/rejected'));
      await expect(page.getByRole('heading', { level: 3, name: gaps.legalName, exact: true })).toBeVisible();
      await page.goto('/work');
      await page.getByRole('link', { name: 'Sent back to you (1) — see why' }).click();
      await expect(page).toHaveURL(urlIs('/rejected'));

      // New customer from the Today header (the sidebar is hidden on a phone).
      await page.goto('/today');
      await page.getByRole('link', { name: 'New customer', exact: true }).click();
      await expect(page).toHaveURL(urlIs('/customers/new'));

      // The sticky Submit bar stands on the tab bar: the button is what a tap at its centre hits.
      for (const path of ['/customers/new', `/customers/${full.id}/edit`]) {
        await page.goto(path);
        await settle(page);
        const submit = page.getByRole('button', { name: /^Submit for approval/ });
        await expect(submit).toBeVisible();
        expect(await hitTest(page, submit), `${device} ${path}: Submit is not under the tab bar`).toBe(true);
      }
      await ctx.close();
    }
  });

  test('the phone drawer closes when the current page is tapped', async ({ browser }) => {
    // KNOWN_BUGS.drawerA11y, fixed (ee81e93): the drawer closed only on a pathname change.
    const page = await (await contextAs(browser, world.user('M1'), { device: 'phone' })).newPage();
    await page.goto('/customers');
    await settle(page);
    const open = page.getByRole('button', { name: 'Open menu' });
    await waitForHydrated(open);
    await open.click();
    const drawer = page.locator('#mobile-nav-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Customers', exact: true }).click();
    await expect(drawer).toBeHidden({ timeout: 5_000 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Accessibility basics (A11Y-BASICS)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('platform: accessibility basics', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let gapsEdit: string;
  let fullEdit: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('pla');
    const future = new Date(Date.now() + 3 * 86_400_000);
    gapsEdit = (
      await seedUpdateEdit(world, {
        customer: 'GAPS',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('A11y contact') } },
        slaDueAt: future,
      })
    ).id;
    if (hasR2) {
      fullEdit = (
        await seedUpdateEdit(world, {
          customer: 'FULL',
          submitter: 'SA',
          patch: { branches: [{ branch: 'FULL', openingHours: '07:00-23:00' }] },
          slaDueAt: future,
        })
      ).id;
    }
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  test('keyboard only: Tab to the fields, Enter signs in', async ({ browser }) => {
    const u = world.user('SA2');
    const page = await (await contextAs(browser, null)).newPage();
    // The sign-in POST carries this world's address, as signInViaUi sends it.
    await page.route('**/login', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') await route.continue({ headers: { ...req.headers(), 'x-forwarded-for': world.ip(2) } });
      else await route.continue();
    });
    await page.goto('/login');
    await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Username')).toBeFocused();
    await page.keyboard.type(u.username);
    await page.keyboard.press('Tab');
    const password = page.getByLabel('Password');
    await expect(password).toBeFocused();
    // The secret never goes through a recorded keyboard step.
    await fillSecret(password, u.password);
    await page.keyboard.press('Enter');
    try {
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
    } finally {
      await clearSecretFields(page);
    }
    await expect(page).toHaveURL(urlIs(homePathFor(u.role)));
  });

  test('Approve dialog: focus starts on the confirm button, Tab stays inside, Escape cancels and gives focus back', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('M1'))).newPage();
    await page.goto(`/approvals/${gapsEdit}`);
    const approve = page.getByRole('button', { name: /^✓ Approve$/ });
    await waitForHydrated(approve);
    await approve.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Approve this edit?');
    const confirm = dialog.getByRole('button', { name: 'Approve', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(approve).toBeFocused();
    const after = await db.customerEdit.findUniqueOrThrow({ where: { id: gapsEdit }, select: { state: true } });
    expect(after.state, 'Escape decided nothing').toBe('SUBMITTED');
  });

  test('labels: every field on /login has a name getByLabel can find', async ({ browser }) => {
    const page = await (await contextAs(browser, null)).newPage();
    await page.goto('/login');
    await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    expect(await unlabelledControls(page)).toEqual([]);
  });

  test('labels: every field on the change-password page has a name', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/profile/change-password');
    for (const name of ['Current password', 'New password (min 12 chars)', 'Confirm new password']) {
      await expect(page.getByLabel(name, { exact: true })).toBeVisible();
    }
    expect(await unlabelledControls(page)).toEqual([]);
  });

  test('labels: every field on the Enrich form has a name', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto(`/customers/${world.customer('FULL').id}/edit`);
    await waitForHydrated(page.getByRole('button', { name: 'Save draft' }));
    await expect(page.getByLabel('Legal name *')).toBeVisible();
    expect(await unlabelledControls(page)).toEqual([]);
  });

  test('labels: every field on the New customer form has a name', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/customers/new');
    await waitForHydrated(page.getByRole('button', { name: 'Save draft' }));
    await expect(page.getByLabel('Legal name *')).toBeVisible();
    expect(await unlabelledControls(page)).toEqual([]);
  });

  test('labels: every field on the approval page, the reject form open, has a name', async ({ browser }) => {
    // Was an APP BUG (minor, a11y), fixed by cf148e5: the reject form's Category <select> and reason <textarea> had
    // <label>s with no htmlFor/id, so neither field had a name.
    const page = await (await contextAs(browser, world.user('M1'))).newPage();
    await page.goto(`/approvals/${gapsEdit}`);
    const reject = page.getByRole('button', { name: '✗ Reject' });
    await waitForHydrated(reject);
    await reject.click();
    await expect(page.getByRole('heading', { name: 'Reject this submission' })).toBeVisible();
    expect(await unlabelledControls(page), 'unlabelled fields on the approval page').toEqual([]);
    // getByLabel finds each field by its words.
    await expect(page.getByLabel('Category', { exact: true })).toHaveAttribute('name', 'category');
    await expect(page.getByLabel(/^Reason for the /)).toHaveAttribute('name', 'reason');
  });

  test('labels: every field on /users (the Create user form) has a name', async ({ browser }) => {
    // Was an APP BUG (minor, a11y), fixed by 140eed9: no Create user label was tied to its field (the Field helper,
    // Role, Supervisor and Route rendered <label> without htmlFor and the inputs without id).
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    await page.goto('/users');
    await waitForHydrated(page.getByRole('button', { name: 'Create user' }));
    expect(await unlabelledControls(page), 'unlabelled fields on /users').toEqual([]);
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create user' }) });
    await expect(form.getByLabel(/^Full name/)).toHaveAttribute('name', 'fullName');
    await expect(form.getByLabel('Role', { exact: true })).toHaveAttribute('name', 'role');
    await expect(form.getByLabel(/^Phone/)).toHaveAttribute('name', 'phone');
  });

  test('labels: every field on /export has a name, the filters included', async ({ browser }) => {
    // Was an a11y gap (no KNOWN_BUGS entry): Min / Max completeness % and Updated since were bare <label>s beside
    // bare inputs. Tied by claude/fix-small-7 (28e7075), which must be merged before this run.
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    await page.goto('/export');
    await waitForHydrated(page.getByRole('button', { name: 'Download .xlsx' }));
    expect(await unlabelledControls(page), 'unlabelled fields on /export').toEqual([]);
    for (const name of ['Min completeness %', 'Max completeness %']) {
      await expect(page.getByLabel(name, { exact: true }), name).toHaveAttribute('type', 'number');
    }
    await expect(page.getByLabel('Updated since', { exact: true })).toHaveAttribute('type', 'date');
  });

  test('labels: every field on /routes (Create region, Create route) has a name', async ({ browser }) => {
    // The same gap, fixed by claude/fix-small-7 (d544585): Code, Name and Region were bare <label>s.
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    await page.goto('/routes');
    await waitForHydrated(page.getByRole('button', { name: 'Create route' }));
    expect(await unlabelledControls(page), 'unlabelled fields on /routes').toEqual([]);
  });

  test('labels: every filter on /audit has a name', async ({ browser }) => {
    // The same gap, fixed by claude/fix-small-7 (19ff6e5): the search box and the Action and Entity selects had no label.
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    await page.goto('/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
    expect(await unlabelledControls(page), 'unlabelled fields on /audit').toEqual([]);
  });

  test('errors use role=alert: a refused sign-in', async ({ browser }) => {
    const page = await (await contextAs(browser, null)).newPage();
    await signInViaUi(page, world.user('VW').username, 'not-the-right-password', { ip: world.ip(3) });
    await expect(page).toHaveURL(urlIs('/login'));
    // Next's route announcer is an empty role=alert on every page: the form's own alert carries the message.
    await expect(page.getByRole('alert').filter({ hasText: 'Invalid username or password.' })).toBeVisible();
  });

  test('errors use role=alert: change password — the two new passwords differ', async ({ browser }) => {
    const u = world.user('SA');
    const page = await (await contextAs(browser, u)).newPage();
    await page.goto('/profile/change-password');
    const submit = page.getByRole('button', { name: 'Change password' });
    await waitForHydrated(submit);
    try {
      await fillSecret(page.getByLabel('Current password', { exact: true }), u.password);
      await fillSecret(page.getByLabel('New password (min 12 chars)', { exact: true }), 'Platform-check-0001');
      await fillSecret(page.getByLabel('Confirm new password', { exact: true }), 'Platform-check-0002');
      await submit.click();
    } finally {
      await clearSecretFields(page);
    }
    // Next's route announcer is an empty role=alert on every page: the form's own alert carries the message.
    await expect(page.getByRole('alert').filter({ hasText: 'The two new passwords do not match.' })).toBeVisible();
  });

  test('errors use role=alert: change password — the current password is wrong', async ({ browser }) => {
    // Was an APP BUG (minor, a11y), fixed by 8642d85: the server's field error 'Current password incorrect.' was a
    // plain <p>, not role=alert; only the mismatch error carried role=alert.
    const page = await (await contextAs(browser, world.user('ACC1'))).newPage();
    await page.goto('/profile/change-password');
    const submit = page.getByRole('button', { name: 'Change password' });
    await waitForHydrated(submit);
    try {
      await fillSecret(page.getByLabel('Current password', { exact: true }), 'not-the-current-password');
      await fillSecret(page.getByLabel('New password (min 12 chars)', { exact: true }), 'Platform-check-0003');
      await fillSecret(page.getByLabel('Confirm new password', { exact: true }), 'Platform-check-0003');
      await submit.click();
    } finally {
      await clearSecretFields(page);
    }
    await expect(page.getByText('Current password incorrect.')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Current password incorrect.' })).toBeVisible();
  });

  test('images have alt text: the profile, the Enrich form and the review page', async ({ browser }) => {
    notRunHere(!hasR2, 'the photos need R2');
    test.skip(!fullEdit, 'the FULL request was not seeded');
    const full = world.customer('FULL');
    const sa = await (await contextAs(browser, world.user('SA'))).newPage();
    const m1 = await (await contextAs(browser, world.user('M1'))).newPage();
    const missing: string[] = [];
    for (const [page, path] of [
      [sa, `/customers/${full.id}`],
      [sa, `/customers/${full.id}/edit`],
      [m1, `/approvals/${fullEdit}`],
    ] as const) {
      await page.goto(path);
      await settle(page);
      expect(await page.locator('main img').count(), `${path}: photos are shown`).toBeGreaterThan(0);
      missing.push(...(await imagesWithoutAlt(page)).map((src) => `${path}: ${src}`));
    }
    expect(missing).toEqual([]);
  });

  test('the phone drawer by keyboard: a dialog that takes the focus', async ({ browser }) => {
    // KNOWN_BUGS.drawerA11y, fixed (ee81e93): there was no role=dialog, no focus move, no focus trap.
    const page = await (await contextAs(browser, world.user('M1'), { device: 'phone' })).newPage();
    await page.goto('/dashboard');
    const open = page.getByRole('button', { name: 'Open menu' });
    await waitForHydrated(open);
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mobile-nav-drawer')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    expect(await page.evaluate(() => !!document.activeElement?.closest('#mobile-nav-drawer')), 'focus moved into the drawer').toBe(true);
  });

  // The axe scan of the main screens is a11y.spec.ts (@axe-core/playwright 4.13.0, added 8 Oct with the owner's word).
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Big lists and the slow phone (PERF-SLOW-PHONE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('platform: big lists and a slow phone', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  const N = 210;
  const ROWS = 1200;
  const keys = Array.from({ length: N }, (_, i) => `P${String(i + 1).padStart(3, '0')}`);
  let world: World;
  let batch: { id: string; filename: string };

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    world = await createWorld('plb', {
      regions: [{ key: 'RP' }],
      routes: [{ key: 'P', region: 'RP' }],
      users: [
        { key: 'MP', role: 'MANAGER', regions: ['RP'] },
        { key: 'SP', role: 'SALESMAN', route: 'P', supervisor: 'MP' },
        { key: 'STW', role: 'STEWARD' },
      ],
      // A 210-branch route, every shop due today.
      customers: keys.map((key) => ({ key, phone: null, contact: null, branches: [{ key: 'S', route: 'P', day: 'TODAY' as const }] })),
    });
    // 210 requests waiting on the region's Manager.
    await seedPendingUpdates(world, { customers: keys, submitter: 'SP' });
    // A promotable 1,200-row batch (never promoted here).
    batch = await seedImportBatch(world, { uploader: 'STW', rows: ROWS, status: 'READY' });
  });

  test.afterAll(async () => {
    test.setTimeout(600_000);
    await world?.cleanup();
  });

  test("Today renders 200 of the route's 210 visits and pages to the rest", async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, world.user('SP'))).newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { __longTaskMs: number };
      w.__longTaskMs = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__longTaskMs += e.duration;
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* no long-task timing in this browser */
      }
    });
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 2, name: `Today's visits (${N})`, exact: true })).toBeVisible();
    await expect(page.getByText(`Showing 200 of ${N} visits · Page 1 of 2`)).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(200);
    await settle(page);
    const before = await page.evaluate(() => (window as unknown as { __longTaskMs: number }).__longTaskMs);
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
      await page.waitForTimeout(50);
    }
    const scrollLongTasks = (await page.evaluate(() => (window as unknown as { __longTaskMs: number }).__longTaskMs)) - before;
    test.info().annotations.push({ type: 'perf', description: `Today, 200 cards: ${Math.round(scrollLongTasks)} ms of long tasks while scrolling` });

    // Page 2 by its address (the tap on Next is its own test below).
    await page.goto('/today?page=2');
    await expect(page.getByText(`Showing ${N - 200} of ${N} visits · Page 2 of 2`)).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(N - 200);
    await expect(page.getByRole('navigation', { name: 'Visit pages' }).getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/today?page=1');
  });

  test("Today: a tap on 'Next' lands on page 2", async ({ browser }) => {
    // Was an APP BUG (major), fixed by 8e47bc6 (TransitionWatchdog): a tap that changes only the query string often
    // never landed — the React canary inside Next 15.5 drops a ping and parks the render (URL stayed /today).
    test.setTimeout(120_000);
    const page = await (await contextAs(browser, world.user('SP'))).newPage();
    await page.goto('/today');
    const next = page.getByRole('navigation', { name: 'Visit pages' }).getByRole('link', { name: 'Next' });
    await waitForHydrated(next);
    await settle(page);
    await next.click();
    await expect(page).toHaveURL(/\/today\?page=2$/);
    await expect(page.getByText(`Showing ${N - 200} of ${N} visits · Page 2 of 2`)).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(N - 200);
  });

  test("/approvals reads '210 pending · showing the 200 most overdue' and lists 200 cards", async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, world.user('MP'))).newPage();
    await page.goto('/approvals');
    await expect(subtitleOf(page)).toHaveText(`${N} pending · showing the 200 most overdue`);
    await expect(page.locator('main a[href^="/approvals/"]')).toHaveCount(200);
  });

  test('/customers shows 50 per page', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SP'))).newPage();
    await page.goto('/customers');
    await expect(subtitleOf(page)).toHaveText(new RegExp(`^~?${N} total$`));
    await expect(page.locator('main article')).toHaveCount(50);
    await expect(page.getByText('Page 1 of 5', { exact: true })).toBeVisible();
    await page.goto('/customers?page=5');
    await expect(page.locator('main article')).toHaveCount(N - 200);
    await expect(page.getByText('Page 5 of 5', { exact: true })).toBeVisible();
  });

  test('/import/<batch> shows 100 rows per page across 1,200 rows', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, world.user('STW'))).newPage();
    const rows = page.getByRole('region', { name: 'Import rows' }).locator('tbody tr');
    await page.goto(`/import/${batch.id}?show=all`);
    await expect(page.getByText('Rows 1–100 of 1,200', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(100);
    await page.goto(`/import/${batch.id}?show=all&page=12`);
    await expect(page.getByText('Rows 1,101–1,200 of 1,200', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(100);
  });

  test('/import/<batch>: the Promote button hydrates in German and Arabic browsers (fixed in wave 1)', async ({ browser }) => {
    notRunHere(SERVER_MODE === 'dev', 'next dev reports hydration differently');
    for (const locale of ['de-DE', 'ar-OM']) {
      const page = await (await contextAs(browser, world.user('STW'), { extra: { locale } })).newPage();
      const watch = watchProblems(page);
      await page.goto(`/import/${batch.id}`);
      await settle(page);
      await expect(page.getByRole('button', { name: `Promote ${ROWS.toLocaleString('en-US')} clean rows` }), locale).toBeVisible();
      expect(watch.hydration(), `${locale}: hydration errors on /import/<batch>`).toEqual([]);
    }
  });

  test('slow 4G and a 4x CPU: transferred JS and time to interactive per route are recorded; no server-only code reaches a chunk', async ({
    browser,
  }) => {
    notRunHere(SERVER_MODE === 'dev', 'next dev ships unminified development bundles');
    test.setTimeout(600_000);
    const first = world.customer(keys[0]!).id;
    const routes: Array<{ path: string; user: string | null; ready: (p: Page) => Locator }> = [
      { path: '/login', user: null, ready: (p) => p.locator('form[data-hydrated="1"]') },
      { path: '/today', user: 'SP', ready: (p) => p.locator('main article a').first() },
      { path: '/customers', user: 'SP', ready: (p) => p.locator('main article a').first() },
      { path: `/customers/${first}/edit`, user: 'SP', ready: (p) => p.getByRole('button', { name: 'Save draft' }) },
      { path: '/customers/new', user: 'SP', ready: (p) => p.getByRole('button', { name: 'Save draft' }) },
    ];
    const BUDGET_KB = 350;
    const BUDGET_MS = 5_000;
    const chunks = new Map<string, string>();
    for (const r of routes) {
      const ctx = await contextAs(browser, r.user ? world.user(r.user) : null, { device: 'phone' });
      const page = await ctx.newPage();
      const seen = collectChunks(page);
      const cdp = await throttle(page, SLOW_4G);
      const meter = scriptMeter(cdp);
      const t0 = Date.now();
      await page.goto(r.path, { waitUntil: 'commit', timeout: 120_000 });
      if (r.path === '/login') await r.ready(page).waitFor({ state: 'attached', timeout: 120_000 });
      else await waitForHydrated(r.ready(page), 120_000);
      const interactiveMs = Date.now() - t0;
      await settle(page, 30_000);
      const kb = Math.round(meter.bytes() / 1024);
      const label = r.path.replace(first, '<id>');
      const over = kb > BUDGET_KB || interactiveMs > BUDGET_MS;
      test.info().annotations.push({
        type: over ? 'perf-over-proposed-budget' : 'perf',
        description: `${label}: ${kb} KB of JS in ${meter.count()} scripts, interactive after ${interactiveMs} ms (proposed budget ${BUDGET_KB} KB, ${BUDGET_MS} ms)`,
      });
      for (const [k, v] of seen) chunks.set(k, v);
      await ctx.close();
    }
    expect(chunks.size, 'script chunks were read').toBeGreaterThan(0);
    const hits: string[] = [];
    for (const [file, body] of chunks) for (const m of ENGINE_MARKERS) if (m.re.test(body)) hits.push(`${m.what} in ${file}`);
    expect(hits, 'server-only code in a browser chunk').toEqual([]);
    const shim = [...chunks].filter(([, body]) => PRISMA_BROWSER_SHIM.test(body)).map(([file]) => file);
    test.info().annotations.push({
      type: 'prisma-browser-shim',
      description: shim.length
        ? `${shim.length} chunk(s) carry @prisma/client's browser shim (a client component imports the Role value): ${shim.join(', ')}`
        : 'no chunk carries the @prisma/client browser shim',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Health and cron (OPS-HEALTH, OPS-CRON-AUTH, FIN-20-EMAIL-OFF steps 1-2)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('platform: health probe, cron and ops endpoints, e-mail off', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  const monitor = process.env.HEALTH_BEARER ?? '';
  const monitorUsable = monitor.length >= 20;
  const cronSecret = process.env.CRON_SECRET ?? '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('plo', {
      regions: [{ key: 'R' }],
      routes: [{ key: 'A', region: 'R' }],
      users: [
        { key: 'M', role: 'MANAGER', regions: ['R'] },
        { key: 'S', role: 'SALESMAN', route: 'A', supervisor: 'M' },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  test('/api/health: anonymous gets exactly {"status":"ok"}; a presented but wrong bearer is refused', async () => {
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const anon = await api.get('/api/health', { failOnStatusCode: false });
    expect(anon.status()).toBe(200);
    expect(await anon.text()).toBe('{"status":"ok"}');

    const wrong = await api.get('/api/health', { headers: { authorization: 'Bearer wrong' }, failOnStatusCode: false });
    expect(wrong.status()).toBe(401);
    // No usable HEALTH_BEARER on this server: any bearer is told the monitor is not configured.
    expect(await wrong.json()).toEqual({ error: monitorUsable ? 'UNAUTHORIZED' : 'MONITOR_NOT_CONFIGURED' });
    test.info().annotations.push({
      type: 'health',
      description: monitorUsable ? 'HEALTH_BEARER is set on this server' : 'HEALTH_BEARER is not set in this checkout: the monitor answer is MONITOR_NOT_CONFIGURED',
    });
    await api.dispose();
  });

  test('/api/health with the monitor bearer: db, R2 and heartbeats checked, alarms, commit and version', async () => {
    notRunHere(!monitorUsable, 'HEALTH_BEARER is not set (or shorter than 20) in this checkout’s .env');
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const res = await api.get('/api/health', { headers: { authorization: `Bearer ${monitor}` }, failOnStatusCode: false });
    expect([200, 503]).toContain(res.status());
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
      cron: { alarms: string[] };
      commit: string;
      version: string;
    };
    expect(body.checks).toMatchObject({ db: 'ok', r2: 'ok', heartbeats: 'ok' });
    expect(Array.isArray(body.cron.alarms)).toBe(true);
    expect(typeof body.commit).toBe('string');
    expect(typeof body.version).toBe('string');
    if (res.status() === 200) expect(['ok', 'warn']).toContain(body.status);
    else {
      expect(body.status).toBe('degraded');
      test.info().annotations.push({ type: 'health', description: `503: critical jobs alarming on UAT — ${body.cron.alarms.join(', ')}` });
    }
    await api.dispose();
  });

  test('cron routes refuse a call without the right bearer three ways, and record no run', async () => {
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const runsBefore = await cronRunsByKey();
    const schedulerWindow = new Date(Date.now() - 300_000);
    const since = new Date(Date.now() - 1_000);
    const bearers: Array<[string, Record<string, string>]> = [
      ['no Authorization header', {}],
      ['a wrong bearer', { authorization: 'Bearer wrong' }],
      cronSecret
        ? ['CRON_SECRET plus one character', { authorization: `Bearer ${cronSecret}x` }]
        : ['a long made-up bearer (CRON_SECRET is not set here)', { authorization: `Bearer ${'k'.repeat(48)}` }],
    ];
    for (const key of CRON_KEYS) {
      for (const [what, headers] of bearers) {
        const res = await api.get(`/api/cron/${key}`, { headers, maxRedirects: 0, failOnStatusCode: false });
        expect(res.status(), `${key}, ${what}`).toBe(401);
        expect(await res.json(), `${key}, ${what}`).toEqual({ error: 'UNAUTHORIZED' });
      }
    }
    const ours = (await cronRunsSince(since)).filter((r) => r.source === 'other');
    expect(ours, 'a refused call recorded a run').toEqual([]);
    const runsAfter = await cronRunsByKey();
    const scheduled = await cronRunsSince(schedulerWindow);
    for (const key of CRON_KEYS) {
      const bySchedulers = scheduled.filter((r) => r.key === key && r.source !== 'other').length;
      expect(runsAfter[key]! - runsBefore[key]!, `${key}: heartbeat runs moved only by a real scheduler`).toBeLessThanOrEqual(bySchedulers);
    }
    await api.dispose();
  });

  test('/api/ops/backup-report: GET is 405, an unauthenticated POST is 401', async () => {
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const get = await api.get('/api/ops/backup-report', { failOnStatusCode: false });
    expect(get.status()).toBe(405);
    expect(await get.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    const post = await api.post('/api/ops/backup-report', { data: {}, failOnStatusCode: false });
    expect(post.status()).toBe(401);
    expect(await post.json()).toEqual({ error: 'UNAUTHORIZED' });
    await api.dispose();
  });

  test('keep-warm with the cron bearer answers {warm:true} and records its heartbeat', async () => {
    notRunHere(!cronSecret, 'CRON_SECRET is not set in this checkout’s .env: no authorized call can be made');
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const since = new Date(Date.now() - 1_000);
    const res = await api.get('/api/cron/keep-warm', { headers: { authorization: `Bearer ${cronSecret}` }, failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ warm: true });
    const beat = await db.cronHeartbeat.findUnique({ where: { key: 'keep-warm' }, select: { lastRunAt: true, lastOk: true } });
    expect(beat?.lastOk).toBe(true);
    expect(beat!.lastRunAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
    expect((await cronRunsSince(since)).some((r) => r.key === 'keep-warm' && r.source === 'other')).toBe(true);
    await api.dispose();
  });

  test('e-mail is off: the drain refuses without the bearer, answers "disabled" with it, and no notification is touched (FIN-20)', async () => {
    const ids = await seedOutboxNotifications(world, ['M', 'S']);
    const api = await pwRequest.newContext({ baseURL: BASE_URL });
    const anon = await api.get('/api/cron/email-drain', { failOnStatusCode: false });
    expect(anon.status()).toBe(401);
    expect(await anon.json()).toEqual({ error: 'UNAUTHORIZED' });
    if (cronSecret) {
      const res = await api.get('/api/cron/email-drain', { headers: { authorization: `Bearer ${cronSecret}` }, failOnStatusCode: false });
      expect(res.status()).toBe(200);
      // The server runs with NOTIFY_EMAIL_ENABLED='' (playwright.launch.config.ts).
      expect(await res.json()).toEqual({ enabled: false, reason: 'disabled', configErrors: 0 });
    } else {
      test.info().annotations.push({ type: 'email', description: 'CRON_SECRET is not set here: the authorized drain call was not made' });
    }
    const rows = await db.notification.findMany({ where: { id: { in: ids } }, select: { emailedAt: true, emailAttempts: true, emailStatus: true } });
    expect(rows).toHaveLength(ids.length);
    for (const r of rows) expect(r).toEqual({ emailedAt: null, emailAttempts: 0, emailStatus: null });
    await api.dispose();
  });
});
