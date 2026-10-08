/**
 * THE SALESMAN ON AN IPHONE — his critical path in WebKit (Playwright's WebKit,
 * iPhone 15 profile: 393×659, touch, Safari user agent, GPS at Muscat). @iphone
 * only; run by the `iphone` project of playwright.launch.config.ts.
 *
 * Only the paths where WebKit differs from the Chromium phone project:
 *   - the session cookie: the production build's Secure __Host- cookie over
 *     http://localhost (a probe first). This Windows WebKit stores that cookie
 *     but never sends it over plain http, so the probe then tries the cookie
 *     bridge (iphone-helpers.ts installCookieBridge: each request to the app is
 *     sent from Node with the context's cookies, WebKit does everything else);
 *     the cookie test skips, saying why, and the others run through the
 *     bridge, annotated. When the bridge fails too, every other test skips,
 *     saying why;
 *   - the login form an iPhone keyboard types into (no auto-capital, no
 *     autocorrect, 16 px fields so Safari does not zoom), and the forced change;
 *   - Today, the Search key of the keyboard, opening a customer, touch taps;
 *   - a camera-sized JPEG through WebKit's file chooser, compressed by WebKit's
 *     canvas, PUT by WebKit's XHR to R2 (CORS from http://localhost:3000), attached;
 *   - WebKit geolocation and the accuracy band (green, amber, red refused);
 *   - position: sticky inside the form's <fieldset>, above the fixed tab bar;
 *   - Oman time printed by WebKit's Intl ("Already received at HH:MM") and the
 *     notification list hydrating with the same text the UTC server printed;
 *   - Arabic-Indic digits typed into the new-customer form's number fields;
 *   - Sign out deleting this user's form copies from WebKit's localStorage.
 *
 * The new-customer form has no date input (only the /customers filters have,
 * and this Windows WebKit build renders type="date" as a plain text box), so no
 * date picker is tested here. Known gaps are test.fail, each in its own test
 * (none open now: the Arabic-digit count and the 14 px change-password boxes
 * were fixed in 1a4e8e1 and f7f240a, and their tests assert the fix).
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts iphone --project=iphone
 */
import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  INITIAL_PASSWORD,
  MUSCAT,
  MUSCAT_GEO,
  PORT,
  SESSION_COOKIE,
  auditFor,
  clearSecretFields,
  createWorld,
  db,
  expectNoSideScroll,
  fetchAs,
  fillSecret,
  hasR2,
  hitTest,
  installLaunchHooks,
  omanDayAfter,
  requireLaunchEnv,
  resetLimits,
  seedNotification,
  type World,
} from './support';
import {
  R2_HOST,
  UNCONFIRMED_MESSAGE,
  adoptSalesmanWork,
  arabicDigits,
  cameraJpeg,
  captureOf,
  collectHydrationErrors,
  deviceCopies,
  dropDraftBuckets,
  eventually,
  fieldsUnder16px,
  freshPassword,
  gpsAccuracyAdvice,
  iphoneContext,
  jpegSize,
  loseFirstReply,
  missingText,
  naturalWidth,
  omanHm,
  omanLongDate,
  omanStamp,
  photoSlot,
  probeWebKitSession,
  retakeOf,
  scrollPage,
  settled,
  signInOnIphone,
  signOutDraftsQuestion,
  standsAboveTabBar,
  tabBar,
  takeBridgeTrace,
  utcStamp,
  webkitBridgeNote,
  webkitSessionNote,
  yesterdayUtcAt,
} from './support/iphone-helpers';

const SUBMIT = 'Submit for approval ▶';
const GPS_TEXT = '23.588100, 58.382900';
const DIRECTIONS_HREF = 'https://www.google.com/maps/dir/?api=1&destination=23.588100,58.382900';
const ALREADY_RECEIVED = /^✓ Already received at (\d{2}:\d{2}) — it is waiting for approval\. Nothing more to do\.$/;
/** The salesman's submit gate the server runs with (lib/submit-gate.ts): CORE unless SALESMAN_SUBMIT_GATE=FULL. */
const FULL_GATE = process.env.SALESMAN_SUBMIT_GATE === 'FULL';

/** A customer complete under either submit gate (CORE or FULL), with its photos when R2 is there. */
const complete = (key: string, contact: string) => ({
  key,
  phone: true,
  contact,
  crNumber: true,
  crPhoto: true,
  subChannel: true,
  branches: [
    {
      key: 'S',
      route: 'A',
      gps: { ...MUSCAT },
      day: omanDayAfter(2),
      photos: ['SHOP', 'SIGNBOARD'] as ('SHOP' | 'SIGNBOARD')[],
      coolersCount: 1,
      equipmentConfirmed: true,
    },
  ],
});

test.describe('iphone: the salesman’s critical path in WebKit', { tag: ['@iphone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  // Independent cases (not serial): one failing does not skip the others.

  let world: World;
  let since: Date;
  /** Whether WebKit keeps a signed-in session on this server, on its own or through the cookie bridge (probed once per worker). */
  let webkit: { ok: boolean; landed: string; bridged: boolean; rawLanded: string } = {
    ok: false,
    landed: 'not probed',
    bridged: false,
    rawLanded: 'not probed',
  };
  const needsSession = () => {
    test.skip(!webkit.ok, webkitSessionNote(webkit.landed));
    if (webkit.bridged) test.info().annotations.push({ type: 'webkit-cookie-bridge', description: webkitBridgeNote(webkit.rawLanded) });
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    since = new Date();
    world = await createWorld('iph', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A', region: 'R1' },
        { key: 'F', region: 'R1' },
        { key: 'O', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
        // First sign-in on the hand-out password: used by that one test only.
        { key: 'SF', role: 'SALESMAN', route: 'F', supervisor: 'M1', mustChangePassword: true },
        // Signs out (every session of his ends): used by that one test only.
        { key: 'SO', role: 'SALESMAN', route: 'O', supervisor: 'M1' },
      ],
      customers: [
        { key: 'DUE1', phone: true, contact: 'Hamed Al Siyabi', branches: [{ key: 'S', route: 'A', day: 'TODAY', gps: { ...MUSCAT } }] },
        { key: 'DUE2', phone: true, contact: 'Yusuf Al Kindi', branches: [{ key: 'S', route: 'A', day: 'TODAY' }] },
        // No GPS and no shop photo: the photo test, then the GPS-band test.
        { key: 'EN1', phone: true, contact: 'Said Al Hinai', branches: [{ key: 'S', route: 'A' }] },
        { key: 'EN2', phone: true, contact: 'Ali Al Abri', branches: [{ key: 'S', route: 'A' }] },
        // Complete: one submit each (one open request per customer).
        complete('EN3', 'Salim Al Balushi'),
        complete('EN4', 'Khalid Al Harthy'),
        { key: 'OC1', phone: true, contact: 'Majid Al Shukaili', branches: [{ key: 'S', route: 'O' }] },
      ],
    });
    webkit = await probeWebKitSession(browser, world.user('SA'));
  });

  test.afterEach(async ({}, testInfo) => {
    // What the cookie bridge sent and got (paths and statuses only), for a failure's report.
    const lines = takeBridgeTrace();
    if (lines.length && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('cookie-bridge-trace', { body: lines.join('\n'), contentType: 'text/plain' });
    }
    if (world) await adoptSalesmanWork(world, since);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (!world) return;
    await adoptSalesmanWork(world, since);
    await dropDraftBuckets(world);
    await world.cleanup();
  });

  test('WebKit keeps the signed-in session on this server (the Secure __Host- cookie over http://localhost)', async () => {
    // This Windows WebKit stores a Secure cookie that arrives over plain http but
    // never sends it back there: a gap of the test machine, not of the app
    // (production is https). Then this property cannot be tested here — said so,
    // not passed — and the other tests run through the cookie bridge.
    test.skip(webkit.bridged, webkitBridgeNote(webkit.rawLanded));
    expect(webkit.ok, webkitSessionNote(webkit.landed)).toBe(true);
  });

  test('first sign-in on 12345: a login form for an iPhone keyboard, the forced change, then Today', async ({ browser }) => {
    needsSession();
    test.setTimeout(240_000);
    const sf = world.user('SF');
    const ip = world.ip(1);
    await resetLimits({ users: [sf], ips: [ip] });
    // A boolean, so a failure never prints a password into the report.
    expect(sf.password === INITIAL_PASSWORD, 'SF holds the hand-out password 12345').toBe(true);
    // Every request carries the world's address: the sign-in AND the one the
    // password change makes charge the world's login:ip bucket. No photo here.
    const ctx = await iphoneContext(browser, null, { extra: { extraHTTPHeaders: { 'x-forwarded-for': ip } } });
    const page = await ctx.newPage();

    await page.goto('/login');
    const form = page.locator('form[data-hydrated="1"]');
    await form.waitFor({ timeout: 60_000 });
    const username = page.getByLabel('Username');
    // iOS capitalises the first letter and "corrects" a route code into a word unless told not to.
    await expect(username).toHaveAttribute('autocapitalize', 'none');
    await expect(username).toHaveAttribute('autocorrect', 'off');
    await expect(username).toHaveAttribute('spellcheck', 'false');
    await expect(username).toHaveAttribute('autocomplete', 'username');
    await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(await fieldsUnder16px(form), 'Safari zooms into a field under 16 px').toEqual([]);

    await username.tap();
    await username.pressSequentially(sf.username);
    try {
      await fillSecret(page.getByLabel('Password'), sf.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).tap();
      await page.waitForURL((url) => url.pathname !== '/login', { timeout: 60_000 }).catch(() => undefined);
    } finally {
      await clearSecretFields(page);
    }

    // The forced change, with his tab bar.
    await expect(page).toHaveURL(/\/profile\/change-password(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: 'Change password', exact: true })).toBeVisible();
    await expect(page.getByText('You must change your password before continuing.', { exact: true })).toBeVisible();
    await expect(page.getByText('The Manager set you a temporary password. Choose a new one to continue.', { exact: true })).toBeVisible();
    await expect(tabBar(page), 'the salesman keeps his tab bar on the forced page').toBeVisible();
    // Shown as text (Show new password), the new password must not be capitalised or corrected either.
    for (const name of ['newPassword', 'confirmNewPassword']) {
      await expect(page.locator(`input[name="${name}"]`)).toHaveAttribute('autocapitalize', 'none');
      await expect(page.locator(`input[name="${name}"]`)).toHaveAttribute('autocorrect', 'off');
    }

    await settled(page);
    const next = freshPassword();
    try {
      await fillSecret(page.locator('input[name="currentPassword"]'), sf.password);
      await fillSecret(page.locator('input[name="newPassword"]'), next);
      await fillSecret(page.locator('input[name="confirmNewPassword"]'), next);
      await page.getByRole('button', { name: 'Change password', exact: true }).tap();
    } finally {
      await clearSecretFields(page);
    }
    await expect(page.getByRole('main')).toContainText('Password changed. Taking you to your home page…');
    sf.password = next;
    sf.mustChangePassword = false;

    // Home on the renewed session: Today, in Oman time.
    await expect(page).toHaveURL(/\/today(\?|$)/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Good day, ${sf.fullName.split(' ')[0]}`);
    await expect(page.locator('main').getByText(omanLongDate(), { exact: true })).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: sf.id }, select: { mustChangePassword: true } })).mustChangePassword).toBe(false);
    const cookie = (await ctx.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly, 'WebKit holds the renewed session cookie, HttpOnly').toBe(true);
  });

  test('Today in Oman time, the keyboard’s Search key on Customers, and opening a customer', async ({ browser }) => {
    needsSession();
    const sa = world.user('SA');
    const page = await (await iphoneContext(browser, sa)).newPage();
    await page.goto('/today');
    const main = page.locator('main');
    const vp = page.viewportSize()!;
    expect(vp, 'the iPhone 15 viewport').toEqual({ width: 393, height: 659 });

    await expect(page.getByRole('heading', { level: 1, name: `Good day, ${sa.fullName.split(' ')[0]}`, exact: true })).toBeVisible();
    await expect(main.getByText(omanLongDate(), { exact: true }), 'the Oman day, not the UTC server’s').toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: "Today's visits (2)", exact: true })).toBeVisible();
    const cards = main.locator('article');
    await expect(cards).toHaveCount(2);
    const due1 = world.customer('DUE1');
    const card1 = cards.filter({ has: page.getByRole('heading', { name: due1.legalName, exact: true }) });
    await expect(card1.getByRole('link', { name: due1.phone!, exact: true })).toHaveAttribute('href', `tel:${due1.phone}`);
    const directions = card1.getByRole('link', { name: 'Directions', exact: true });
    await expect(directions).toHaveAttribute('href', DIRECTIONS_HREF);
    await expect(directions).toHaveAttribute('target', '_blank');
    await expectNoSideScroll(page);

    // The fixed tab bar: 56 px, on the bottom edge, Today highlighted.
    const bar = tabBar(page);
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.height), 'the tab bar is 56 px').toBe(56);
    expect(Math.round(box.y + box.height), 'fixed to the bottom edge').toBe(vp.height);
    await expect(bar.getByRole('link', { name: 'Today', exact: true })).toHaveClass(/text-brand-700/);

    // Customers by a tap on the tab bar; the search box submits on the keyboard's Search (Enter) key.
    await bar.getByRole('link', { name: 'Customers', exact: true }).tap();
    await expect(page).toHaveURL(/\/customers(\?|$)/);
    await settled(page);
    const search = page.getByRole('searchbox', { name: 'Search customers' });
    expect(await search.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)), 'Safari zooms into a field under 16 px').toBeGreaterThanOrEqual(16);
    const due2 = world.customer('DUE2');
    await search.tap();
    await search.pressSequentially(due2.legalName);
    await search.press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('q'), { message: 'the Search key applied the search' }).toBe(due2.legalName);
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByRole('heading', { name: due2.legalName, exact: true })).toBeVisible();
    await expectNoSideScroll(page);

    // Open the customer from its card.
    await cards.first().getByRole('link', { name: `${due2.legalName} · ${due2.code}`, exact: true }).tap();
    await expect(page).toHaveURL(new RegExp(`/customers/${due2.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: due2.legalName, exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: due2.phone!, exact: true })).toHaveAttribute('href', `tel:${due2.phone}`);
    await expect(main.getByRole('link', { name: 'Enrich', exact: true })).toHaveAttribute('href', `/customers/${due2.id}/edit`);
    await expectNoSideScroll(page);
  });

  test('Enrich: a camera-sized photo through WebKit’s file chooser is compressed by WebKit, PUT to R2 and attached', async ({ browser }) => {
    needsSession();
    test.skip(!hasR2, 'the photo goes to R2');
    // The page PUTs straight to R2, whose CORS rule admits the origin http://localhost:3000 only.
    test.skip(PORT !== 3000, 'R2 accepts browser PUTs from http://localhost:3000 only');
    test.setTimeout(240_000);
    const sa = world.user('SA');
    const en1 = world.customer('EN1');
    const page = await (await iphoneContext(browser, sa)).newPage();
    await page.goto(`/customers/${en1.id}/edit`);
    await settled(page);

    // A fix first: the photo carries the point it was taken at.
    await page.getByRole('button', { name: /^Capture GPS/ }).tap();
    await expect(page.locator('main [data-accuracy-band]')).toContainText(GPS_TEXT);
    await expect.poll(() => missingText(page)).toContain('Branch 1 shop photo');

    const slot = photoSlot(page, 'Shop front');
    const input = slot.locator('input[type="file"]');
    await expect(input, 'the camera input takes images').toHaveAttribute('accept', 'image/*');
    await expect(input, 'and opens the rear camera').toHaveAttribute('capture', 'environment');

    const original = await cameraJpeg(page);
    expect(jpegSize(original), 'a 12 MP iPhone photo').toEqual({ width: 4032, height: 3024 });
    let puts = 0;
    page.on('request', (r) => {
      if (r.method() === 'PUT' && R2_HOST.test(r.url())) puts += 1;
    });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), captureOf(slot).tap()]);
    expect(chooser.isMultiple(), 'one photo per slot').toBe(false);
    await chooser.setFiles({ name: 'IMG_4032.JPG', mimeType: 'image/jpeg', buffer: original });
    await expect(retakeOf(slot), 'the photo is up and attached').toBeVisible({ timeout: 120_000 });
    expect(puts, 'the PUT went from WebKit straight to R2 (CORS from http://localhost:3000)').toBeGreaterThanOrEqual(1);

    // The slot previews the compressed photo from a blob: URL (CSP img-src blob:).
    const preview = slot.locator('img');
    await expect(preview).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => naturalWidth(preview), { message: 'the preview decodes' }).toBe(1920);

    // Attached to the branch's shop slot, his, at the captured point.
    const { shopPhotoId } = await db.branch.findUniqueOrThrow({ where: { id: en1.branch.id }, select: { shopPhotoId: true } });
    expect(shopPhotoId, 'attached to the shop slot').not.toBeNull();
    const att = await db.attachment.findUniqueOrThrow({
      where: { id: shopPhotoId! },
      select: { kind: true, capturedById: true, mimeType: true, bytes: true, r2Key: true, capturedLat: true, capturedLng: true, deletedAt: true },
    });
    expect(att).toMatchObject({ kind: 'SHOP', capturedById: sa.id, mimeType: 'image/jpeg', deletedAt: null });
    expect(att.r2Key).toMatch(new RegExp(`^\\d{4}/\\d{2}/\\d{2}/${sa.id}/SHOP/[0-9a-f-]{36}\\.jpg$`));
    expect(att.capturedLat).toBeCloseTo(MUSCAT.lat, 4);
    expect(att.capturedLng).toBeCloseTo(MUSCAT.lng, 4);

    // What R2 holds is WebKit's own JPEG: 1920 px on the long side, a fraction of the camera file.
    const back = await fetchAs(page, `/api/photos/${shopPhotoId}`);
    expect(back.status).toBe(200);
    expect(back.headers['content-type']).toBe('image/jpeg');
    expect(back.body.length).toBe(att.bytes);
    expect(jpegSize(back.body), 'compressed in WebKit to 1920 px on the long side').toEqual({ width: 1920, height: 1440 });
    expect(back.body.length, 'well under the camera file').toBeLessThan(original.length / 3);
    expect(back.body.length, 'under finalize’s 3 MB cap').toBeLessThan(3 * 1024 * 1024);
    await expect.poll(() => missingText(page), { message: 'the gate saw the photo' }).not.toContain('Branch 1 shop photo');
  });

  test('Enrich: WebKit’s GPS fix shows its accuracy band — green, amber, red and refused, green again', async ({ browser }) => {
    needsSession();
    const ctx = await iphoneContext(browser, world.user('SA'));
    const page = await ctx.newPage();
    await page.goto(`/customers/${world.customer('EN2').id}/edit`);
    await settled(page);
    const chip = page.locator('main [data-accuracy-band]');
    const submit = page.getByRole('button', { name: SUBMIT, exact: true });
    const fair = gpsAccuracyAdvice(60)!;
    const poor = gpsAccuracyAdvice(150, true)!;

    await page.getByRole('button', { name: /^Capture GPS/ }).tap();
    await expect(chip).toHaveAttribute('data-accuracy-band', 'good');
    await expect(chip).toContainText(GPS_TEXT);
    await expect(chip).toContainText('±9m');
    await expect(page.getByText(fair, { exact: true })).toHaveCount(0);

    const recapture = page.getByRole('button', { name: 'Recapture GPS', exact: true });
    await ctx.setGeolocation({ ...MUSCAT_GEO, accuracy: 60 });
    await recapture.tap();
    await expect(chip).toHaveAttribute('data-accuracy-band', 'fair');
    await expect(chip).toContainText('±60m');
    await expect(page.getByText(fair, { exact: true })).toBeVisible();
    await expect.poll(() => missingText(page)).not.toContain('GPS within');

    await ctx.setGeolocation({ ...MUSCAT_GEO, accuracy: 150 });
    await recapture.tap();
    await expect(chip).toHaveAttribute('data-accuracy-band', 'poor');
    await expect(chip).toContainText('±150m');
    await expect(page.getByText(poor, { exact: true })).toBeVisible();
    await expect.poll(() => missingText(page)).toContain('Branch 1 GPS within 100 m');
    await expect(submit, 'a fresh fix over ±100 m cannot be submitted').toBeDisabled();

    await ctx.setGeolocation({ ...MUSCAT_GEO, accuracy: 12 });
    await recapture.tap();
    await expect(chip).toHaveAttribute('data-accuracy-band', 'good');
    await expect(chip).toContainText('±12m');
    await expect(page.getByText(poor, { exact: true })).toHaveCount(0);
    await expect.poll(() => missingText(page)).not.toContain('GPS within');
  });

  test('Enrich: the sticky Submit bar stands above the tab bar, a tap submits, and the edit page says when in Oman time', async ({ browser }) => {
    needsSession();
    test.skip(FULL_GATE && !hasR2, 'the FULL gate needs the seeded CR photo, which needs R2');
    test.setTimeout(240_000);
    const sa = world.user('SA');
    const en3 = world.customer('EN3');
    const page = await (await iphoneContext(browser, sa)).newPage();

    // From the customer to his form, by touch.
    await page.goto(`/customers/${en3.id}`);
    await expect(page.getByRole('heading', { level: 1, name: en3.legalName, exact: true })).toBeVisible();
    await page.locator('main').getByRole('link', { name: 'Enrich', exact: true }).tap();
    await expect(page).toHaveURL(new RegExp(`/customers/${en3.id}/edit$`));
    await settled(page);
    expect(await fieldsUnder16px(page.locator('main')), 'Safari zooms into a field under 16 px').toEqual([]);
    await expectNoSideScroll(page);

    const contact = world.name('Yusuf Al Kindi');
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    const submit = page.getByRole('button', { name: SUBMIT, exact: true });
    const draft = page.getByRole('button', { name: 'Save draft', exact: true });
    await expect(submit).toBeEnabled();

    // Mid-page (photo tiles scroll behind the bar) and at the end: on top, above the tab bar.
    for (const where of ['middle', 'end'] as const) {
      await scrollPage(page, where);
      await expect.poll(() => hitTest(page, submit), { message: `${where}: Submit is on top` }).toBe(true);
      await expect.poll(() => hitTest(page, draft), { message: `${where}: Save draft is on top` }).toBe(true);
      await expect.poll(() => standsAboveTabBar(page, submit), { message: `${where}: Submit stands above the tab bar` }).toBe(true);
    }
    await page.getByLabel('Address *', { exact: true }).focus();
    await expect.poll(() => hitTest(page, submit), { message: 'Submit with the Address box focused' }).toBe(true);

    await scrollPage(page, 'middle');
    await submit.tap();
    await expect(page).toHaveURL(new RegExp(`/customers/${en3.id}$`), { timeout: 30_000 });
    const sent = await db.customerEdit.findMany({
      where: { customerId: en3.id, submittedById: sa.id, state: 'SUBMITTED' },
      select: { submittedAt: true, fieldChanges: true },
    });
    expect(sent, 'one request').toHaveLength(1);
    expect((sent[0]!.fieldChanges as Array<{ field: string }>).map((c) => c.field)).toContain('customer.contactPerson');

    // Reopened, the form says when it was sent — on the Oman clock.
    await page.goto(`/customers/${en3.id}/edit`);
    await expect(
      page.getByText(`Your changes sent at ${omanHm(sent[0]!.submittedAt!)} arrived and are waiting for approval.`, { exact: false })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toBeDisabled();
  });

  test('a lost reply: Try again in the sticky bar answers "Already received at HH:MM", Oman time printed by WebKit', async ({ browser }) => {
    needsSession();
    test.skip(FULL_GATE && !hasR2, 'the FULL gate needs the seeded CR photo, which needs R2');
    test.skip(process.env.E2E_PAGE_REQUEST_OK !== '1', 'route.fetch needs the context’s session cookie (global setup did not prove page.request)');
    const sa = world.user('SA');
    const en4 = world.customer('EN4');
    const page = await (await iphoneContext(browser, sa)).newPage();
    await page.goto(`/customers/${en4.id}/edit`);
    await settled(page);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Nasser Al Rawahi'));
    const submit = page.getByRole('button', { name: SUBMIT, exact: true });
    await expect(submit).toBeEnabled();

    const lost = await loseFirstReply(page, '/api/forms/customer-edit');
    await scrollPage(page, 'middle');
    await submit.tap();
    await expect(page.getByRole('alert').filter({ hasText: UNCONFIRMED_MESSAGE })).toBeVisible({ timeout: 30_000 });
    expect(lost, 'the first send reached the server').toEqual({ status: 200, error: null });
    const tryAgain = page.getByRole('button', { name: 'Try again', exact: true });
    await expect.poll(() => hitTest(page, tryAgain), { message: 'Try again is on top' }).toBe(true);
    await expect.poll(() => standsAboveTabBar(page, tryAgain), { message: 'Try again stands above the tab bar' }).toBe(true);
    await tryAgain.tap();

    const status = page.getByRole('status').filter({ hasText: 'Already received' });
    await expect(status).toHaveText(ALREADY_RECEIVED);
    const shown = ALREADY_RECEIVED.exec((await status.innerText()).trim())![1];
    const edits = await db.customerEdit.findMany({
      where: { customerId: en4.id, submittedById: sa.id, state: 'SUBMITTED' },
      select: { submittedAt: true },
    });
    expect(edits, 'written once').toHaveLength(1);
    expect(shown, 'the receipt time on the Oman clock, as WebKit’s Intl formats it').toBe(omanHm(edits[0]!.submittedAt!));
    await expect(page.getByRole('button', { name: 'Sent ✓', exact: true })).toBeDisabled();
  });

  test('the notification list prints Oman time and hydrates in WebKit with the text the UTC server printed', async ({ browser }) => {
    needsSession();
    const title = world.name('Edit approved');
    // 21:30 UTC yesterday is 01:30 today in Oman: a different day on each clock.
    const at = yesterdayUtcAt(21, 30);
    await seedNotification(world, { user: 'SA', kind: 'EDIT_APPROVED_FINAL', title, createdAt: at });
    const page = await (await iphoneContext(browser, world.user('SA'))).newPage();
    // /notifications is on the launch allow-list for React #418 while that bug is open; asserted here directly.
    const hydration = collectHydrationErrors(page);
    for (const load of ['first load', 'reload'] as const) {
      if (load === 'first load') await page.goto('/notifications');
      else await page.reload();
      await settled(page);
      const main = page.locator('main');
      await expect(main.getByText(title, { exact: true }), load).toBeVisible();
      await expect(main.getByText(omanStamp(at), { exact: true }), `${load}: Oman time`).toBeVisible();
      await expect(main.getByText(utcStamp(at), { exact: true }), `${load}: not the UTC clock`).toHaveCount(0);
    }
    expect(hydration(), 'no hydration error in WebKit').toEqual([]);
  });

  test('new customer: Arabic-Indic digits in the phone, CR, credit limit, payment term and a typed GPS point are read as numbers', async ({ browser }) => {
    needsSession();
    test.setTimeout(240_000);
    const sa = world.user('SA');
    const page = await (await iphoneContext(browser, sa)).newPage();
    await page.goto('/customers/new');
    await settled(page);
    const main = page.locator('main');

    await page.locator('label').filter({ has: page.locator('input[name="paymentTerms"][value="CREDIT"]') }).tap();
    await expect(page.locator('input[name="paymentTerms"][value="CREDIT"]')).toBeChecked();
    await expect.poll(() => missingText(page)).toContain('Credit limit');
    expect(await fieldsUnder16px(main), 'Safari zooms into a field under 16 px').toEqual([]);
    await expectNoSideScroll(page);

    const legalName = world.name('مؤسسة النور للتجارة');
    const cr = String(100_000_000 + randomInt(900_000_000));
    const phone = (await world.allocPhones(1))[0]!;
    const local = phone.slice(4);
    const typed = async (label: string, text: string) => {
      const box = page.getByLabel(label, { exact: true });
      await box.tap();
      await box.pressSequentially(text);
      await expect(box, label).toHaveValue(text);
    };
    await typed('Legal name *', legalName);
    await typed('CR number *', arabicDigits(cr));
    await typed('Primary phone *', `+${arabicDigits('968')} ${arabicDigits(local.slice(0, 4))} ${arabicDigits(local.slice(4))}`);
    // 1234.5 with the Arabic decimal separator (U+066B); 45 days.
    await typed('Requested credit limit (OMR) *', `${arabicDigits('1234')}٫${arabicDigits('5')}`);
    await typed('Requested payment term (days) *', arabicDigits('45'));

    // A typed GPS point: Arabic-Indic digits and the Arabic decimal separator.
    await page.getByRole('button', { name: 'Enter coordinates manually', exact: true }).tap();
    await page.getByLabel(/^Latitude/).pressSequentially(`${arabicDigits('23')}٫${arabicDigits('5881')}`);
    await page.getByLabel(/^Longitude/).pressSequentially(`${arabicDigits('58')}٫${arabicDigits('3829')}`);
    const reason = world.name('GPS would not fix inside the souq');
    await page.getByLabel(/^Why didn.t GPS work/).fill(reason);
    await page.getByRole('button', { name: 'Save manual location', exact: true }).tap();
    const chip = main.locator('[data-accuracy-band="manual"]');
    await expect(chip).toContainText(GPS_TEXT);
    await expect(chip).toContainText('Manual');

    // Two coolers, by touch.
    await page.getByRole('button', { name: 'Increase Coolers', exact: true }).tap();
    await page.getByRole('button', { name: 'Increase Coolers', exact: true }).tap();
    await expect(page.getByRole('spinbutton', { name: 'Coolers', exact: true })).toHaveValue('2');

    // Read as numbers on the phone: none of these is "missing" any more (Channel and the photos still are).
    const stillMissing = async () => {
      const text = await missingText(page);
      return ['Credit limit', 'Payment term days', 'Primary phone', 'CR number', 'Branch 1 GPS'].filter((item) => text.includes(item));
    };
    await expect.poll(stillMissing, { message: 'typed in Arabic-Indic digits, yet still "missing"' }).toEqual([]);
    await expect.poll(() => missingText(page), { message: 'the list is still there' }).toContain('Channel');

    await page.getByRole('button', { name: 'Save draft', exact: true }).tap();
    await expect(page.getByRole('status').filter({ hasText: '✓ Draft saved. Finish and submit when ready.' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => new URL(page.url()).searchParams.get('edit'), { message: 'the draft’s id in the address' }).not.toBeNull();
    const editId = new URL(page.url()).searchParams.get('edit')!;
    world.adopt.edit(editId);

    // …and on the server.
    const edit = await db.customerEdit.findUniqueOrThrow({
      where: { id: editId },
      select: { state: true, submittedById: true, requestedCreditLimit: true, requestedPaymentTermDays: true, fieldChanges: true },
    });
    expect(edit).toMatchObject({ state: 'DRAFT', submittedById: sa.id, requestedPaymentTermDays: 45 });
    expect(Number(edit.requestedCreditLimit)).toBe(1234.5);
    expect(JSON.stringify(edit.fieldChanges), 'the typed point keeps its reason').toContain(reason);
    const customer = await db.editCustomerDraft.findUniqueOrThrow({
      where: { editId },
      select: { legalName: true, paymentTerms: true, crNumberNorm: true, primaryPhoneNorm: true },
    });
    expect(customer).toEqual({ legalName, paymentTerms: 'CREDIT', crNumberNorm: cr, primaryPhoneNorm: phone });
    const branches = await db.editBranchDraft.findMany({ where: { editId }, select: { gpsLat: true, gpsLng: true, coolersCount: true } });
    expect(branches).toHaveLength(1);
    expect(branches[0]!.gpsLat).toBeCloseTo(23.5881, 6);
    expect(branches[0]!.gpsLng).toBeCloseTo(58.3829, 6);
    expect(branches[0]!.coolersCount).toBe(2);
  });

  test('new customer: a count typed in Arabic-Indic digits into an equipment box is read', async ({ browser }) => {
    needsSession();
    const page = await (await iphoneContext(browser, world.user('SA'))).newPage();
    await page.goto('/customers/new');
    await settled(page);
    // Typed in ASCII digits, WebKit's number box takes the count.
    const coolers = page.getByRole('spinbutton', { name: 'Coolers', exact: true });
    await coolers.selectText();
    await coolers.pressSequentially('7');
    await expect(coolers).toHaveValue('7');
    // Was a known bug (a typed ٣ became 0); fixed in 1a4e8e1: StepperInput is type="text" and folds digits with lib/digits.
    const stands = page.getByRole('spinbutton', { name: 'Stands', exact: true });
    await stands.selectText();
    await stands.pressSequentially(arabicDigits('3'));
    await expect(stands).toHaveValue('3', { timeout: 5_000 });
  });

  test('the change-password boxes (the forced first-sign-in page) are 16 px, so Safari does not zoom into them', async ({ browser }) => {
    needsSession();
    const page = await (await iphoneContext(browser, world.user('SA'))).newPage();
    await page.goto('/profile/change-password');
    const form = page.locator('form').filter({ has: page.locator('input[name="currentPassword"]') });
    await expect(form).toBeVisible();
    // Was a known bug (14 px inputs, so iOS Safari zoomed in); fixed in f7f240a: each input is text-base below sm.
    expect(await fieldsUnder16px(form), 'Safari zooms into a field under 16 px').toEqual([]);
  });

  test('Sign out on the iPhone deletes his unsent form copies after asking, keeps a colleague’s, and nothing comes back', async ({ browser }) => {
    needsSession();
    test.setTimeout(240_000);
    const so = world.user('SO');
    const colleague = world.user('SA');
    const oc1 = world.customer('OC1');
    const ip = world.ip(2);
    await resetLimits({ users: [so], ips: [ip] });
    const page = await (await iphoneContext(browser, so)).newPage();

    // Two unsent copies of his on this phone: an update he typed, and a new customer.
    const typedContact = world.name('Typed on the iPhone');
    await page.goto(`/customers/${oc1.id}/edit`);
    await settled(page);
    await page.getByLabel('Contact person *', { exact: true }).fill(typedContact);
    const editKey = `nmwc:draft:${so.id}:${oc1.id}`;
    await eventually(async () => (await deviceCopies(page))[editKey]?.includes(typedContact) ?? false, 'the update copy is on the phone');
    const typedName = world.name('Unsent Shop');
    await page.goto('/customers/new');
    await settled(page);
    await page.getByLabel('Legal name *', { exact: true }).fill(typedName);
    const createKey = `nmwc:create:${so.id}:new`;
    await eventually(async () => (await deviceCopies(page))[createKey]?.includes(typedName) ?? false, 'the new-customer copy is on the phone');
    // …and a colleague's, on the same shared phone.
    const theirs = `nmwc:draft:${colleague.id}:${oc1.id}`;
    await page.evaluate((k) => window.localStorage.setItem(k, '{"contactPerson":"a colleague’s"}'), theirs);
    expect(Object.keys(await deviceCopies(page)).sort()).toEqual([createKey, editKey, theirs].sort());

    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await page.getByRole('banner').getByRole('button', { name: 'Sign out', exact: true }).tap();
    await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 30_000 });
    expect(asked, 'WebKit showed the question').toBe(signOutDraftsQuestion(2));
    const left = await deviceCopies(page);
    expect(Object.keys(left), 'only the colleague’s copy is left').toEqual([theirs]);
    expect(JSON.stringify(left)).not.toContain(typedContact);
    expect(JSON.stringify(left)).not.toContain(typedName);
    await expect.poll(async () => (await auditFor({ actorId: so.id, action: 'LOGOUT' })).length, { message: 'one LOGOUT row' }).toBe(1);

    // He signs in again on this phone: nothing he typed comes back. Today loads
    // in full first, as it does before he can tap anything (run 2: a goto issued
    // the moment the address said /today was cut off by Today's own load).
    const navigations: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations.push(new URL(f.url()).pathname);
    });
    await signInOnIphone(page, so.username, so.password, { ip, expectUrl: /\/today(\?|$)/ });
    await settled(page);
    await expect(page.getByRole('heading', { level: 1, name: `Good day, ${so.fullName.split(' ')[0]}`, exact: true })).toBeVisible();
    test.info().annotations.push({ type: 'navigations from sign-in to Today', description: navigations.join(' → ') });
    await page.goto(`/customers/${oc1.id}/edit`);
    await settled(page);
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue('Majid Al Shukaili');
    await expect(page.getByText('Restored a local draft from your last visit.', { exact: true })).toHaveCount(0);
    await page.goto('/customers/new');
    await settled(page);
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue('');
    await expect(page.getByText(/^Restored the details you typed on this phone/)).toHaveCount(0);
  });
});
