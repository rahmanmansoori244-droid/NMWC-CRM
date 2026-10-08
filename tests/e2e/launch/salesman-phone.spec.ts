/**
 * THE SALESMAN ON HIS PHONE — what he sees, and the safety of every send from a
 * phone (enrich, new customer, close). @phone only (Pixel 5, 412×915; 360×740
 * where the layout is under test; 800 and 1280 px only to show what a wider
 * screen adds).
 *
 *   SM-TODAY-LIST, SM-TODAY-EDGES ......... Today, its stats, the no-day list, no route, a switched-off route, 201 visits
 *   SM-SEARCH, SM-FILTERS ................. search, the salesman's filter bar, saved views, URLs that try to widen his scope
 *   SM-CUSTOMER-PAGE ....................... only his branches, photos, maps and his actions (CR lock of wave 2)
 *   SM-TABBAR-STICKY (+ MOBILE-LAYOUT) ..... the tab bar, a sticky Submit bar above it, no side scroll, the sidebar from 768 px
 *   SM-WORK-ITEMS, SM-REJECTED-LIST ........ Work and Needs correction (wave 1: a phone reaches /rejected, wording, clear)
 *   SM-NOTIFICATIONS ....................... the bell (wave 1: red = returned work only) and the inbox
 *   SM-SUBMIT-DOUBLE-TAP / -OFFLINE / -NO-ANSWER, SM-SESSION-EXPIRY-MIDFORM, AUTH-EXPIRED-MID-FORM
 *                                            on the enrich, new-customer and close forms
 *   SM-PHOTO-WEAK-NETWORK, UPLOAD-PHONE-REAL-PHOTOS, SM-RATE-LIMITS
 *   + critic: the visit-day job from the no-day list (wave 2, decision 4), a route switched off mid-week (P2)
 *
 * Fixed in wave 1 and asserted as fixed (no test.fail): the Today header in Oman
 * time, the Needs-correction tile and Work link to /rejected, 'Sent to a Manager'
 * for a reactivation, 'Sent back by', returned updates prefilled, the salesman's
 * red bell counting returned work only, the signed-out / throttled photo upload
 * saying so, the close form's trimmed reason. The gaps this file found are
 * FIXED in the launch candidate and asserted as fixed (no test here is
 * test.fail): list pages fit the phone with long customer names (da59a76); a
 * switched-off route's Today says so, and its forms lock their photo slots up
 * front (804bda1, 38e530a); a photo the phone cannot read says why on its slot,
 * the HEIC hint for a HEIC (287bdc0); the photo-limit countdown runs, for a wait
 * of up to a minute (fa80408); a dropped upload is said in the app's words
 * (f960612). Fixed 8 Oct and asserted everywhere: an in-app tap that changes only the query
 * string of /today or /customers, and router.refresh(), land within 15 s of the
 * server's answer (landsOn / shownAfterRefresh fail on a hang; they used to load
 * the URL instead).
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts salesman-phone --project=phone
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  MUSCAT,
  OMAN_TODAY,
  auditFor,
  contextAs,
  createWorld,
  db,
  drainLimit,
  expectNoSideScroll,
  fakeHeic,
  fetchAs,
  hasR2,
  hitTest,
  installLaunchHooks,
  notificationsFor,
  omanDayAfter,
  reloadUntil,
  requireLaunchEnv,
  resetLimits,
  seedNotification,
  seedUpdateEdit,
  signInViaUi,
  standardWorld,
  tinyPdf,
  type FixtureUser,
  type World,
} from './support';
import {
  ATTACH_NO_ANSWER,
  CR_DOCUMENT_LOCKED_MESSAGE,
  HEIC_MESSAGE,
  OFFLINE_MESSAGE,
  PHOTO_UPLOADING_MESSAGE,
  R2_HOST,
  RATE_WAIT,
  RETURNED_CLEARED_REASON,
  SIGNED_OUT_MESSAGE,
  UNCONFIRMED_MESSAGE,
  UNREADABLE_PHOTO_MESSAGE,
  UPLOAD_NO_CONNECTION,
  UPLOAD_SIGNED_OUT,
  addFieldSalesman,
  adoptSalesmanWork,
  cameraJpeg,
  channelWithSubs,
  countRequests,
  delayDocument,
  delayPosts,
  dropDraftBuckets,
  fillCreateForm,
  generalTrade,
  jpegSize,
  landsOn,
  layoutDiagnosis,
  loseFirstReply,
  omanDate,
  omanDayTime,
  omanLongDate,
  photoSlot,
  pickFile,
  pngFile,
  retakeOf,
  seedCreateRequest,
  seedReactivationRow,
  settled,
  shownAfterRefresh,
  tabBar,
  throttle,
  todayStat,
  trackRequests,
  unthrottle,
  watchTexts,
} from './support/salesman-phone-helpers';

/**
 * The salesman's submit gate the server runs with (lib/submit-gate.ts): CORE, the
 * launch default, unless SALESMAN_SUBMIT_GATE=FULL in the .env both read. The
 * enrich tests change a customer-level field of a customer that is complete
 * under CORE (channel, phone, contact); under FULL it would also need a
 * sub-channel and a CR, and Submit would stay off.
 */
const FULL_GATE = process.env.SALESMAN_SUBMIT_GATE === 'FULL';
const CORE_ONLY = 'written for the CORE submit gate (the launch default)';

const GPS_TEXT = '23.588100, 58.382900';
const DIRECTIONS_HREF = 'https://www.google.com/maps/dir/?api=1&destination=23.588100,58.382900';
const ALREADY_RECEIVED = /^✓ Already received at \d{2}:\d{2} — it is waiting for approval\. Nothing more to do\.$/;
const SUBMIT = 'Submit for approval ▶';

/** Every request a salesman's submit writes notifies exactly these people, once each. */
async function expectOneSet(editId: string, userIds: string[]): Promise<void> {
  await expect
    .poll(async () => (await notificationsFor({ editId })).map((n) => n.userId).sort(), {
      message: 'one set of notifications: his supervisor (must act) and the region Accountant (FYI)',
    })
    .toEqual([...userIds].sort());
}

/** The enrich form of a customer, hydrated. Returns its Submit button. */
async function openEnrich(page: Page, customerId: string): Promise<Locator> {
  await page.goto(`/customers/${customerId}/edit`);
  await settled(page);
  const submit = page.getByRole('button', { name: SUBMIT, exact: true });
  await expect(submit).toBeVisible();
  return submit;
}

/** The close-shop form on a customer's page, filled: a fresh evidence photo and a reason. */
async function openCloseForm(page: Page, customerId: string, reason: string): Promise<{ form: Locator; submit: Locator }> {
  await page.goto(`/customers/${customerId}`);
  await settled(page);
  await page.locator('main').getByRole('button', { name: 'Mark closed', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Mark this branch closed', exact: true }) });
  await expect(form).toBeVisible();
  const evidence = photoSlot(form, 'Other');
  await pickFile(evidence, pngFile('evidence'));
  await expect(retakeOf(evidence), 'the evidence photo is up').toBeVisible({ timeout: 120_000 });
  const why = form.getByPlaceholder('Shop is permanently closed, signage removed.');
  const submit = form.getByRole('button', { name: 'Submit closure', exact: true });
  // Wave 1: five spaces are no reason (Submit used to light up and the server refused).
  await why.fill('     ');
  await expect(submit).toBeDisabled();
  await why.fill(reason);
  await expect(submit).toBeEnabled();
  return { form, submit };
}

/** Signs `u` in again in a second tab of the same phone (the page that lost its session stays open). */
async function signInInAnotherTab(ctx: BrowserContext, u: FixtureUser, ip: string): Promise<void> {
  const tab = await ctx.newPage();
  await signInViaUi(tab, u.username, u.password, { ip });
  await expect(tab).toHaveURL(/\/today(\?|$)/);
  await tab.close();
}

const mixCase = (s: string) => [...s].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join('');

// ════════════════════════════════════════════════════════════════════════════
// 1. Today, search, filters, the customer page, the visit-day job, the layout
// ════════════════════════════════════════════════════════════════════════════

test.describe('salesman phone: Today, search, filters, the customer page and the layout', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let sa: FixtureUser;
  let since: Date;
  /** Route B's branch of MULTI: never in his HTML. */
  const B1_ADDRESS = 'Shop 9, Ruwi High Street, opposite the B1 bus stop';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('sph', {
      customers: [
        // DUE1 with a GPS point, DUE2 without: Directions only where there is a point.
        { key: 'DUE1', phone: true, contact: 'Hamed Al Siyabi', branches: [{ key: 'S', route: 'A', day: 'TODAY', gps: { ...MUSCAT } }] },
        {
          key: 'MULTI',
          phone: true,
          contact: 'Nasser Al Rawahi',
          branches: [
            { key: 'A1', route: 'A' },
            { key: 'A2', route: 'A' },
            { key: 'B1', route: 'B', address: B1_ADDRESS, gps: { lat: 23.6005, lng: 58.5452, accuracy: 8 }, photos: ['SHOP'] },
          ],
        },
      ],
    });
    sa = world.user('SA');
    // Recent activity on CRED: his update, waiting at the Supervisor step.
    await seedUpdateEdit(world, { customer: 'CRED', submitter: 'SA', patch: { customer: { contactPerson: world.name('Khalid Al Harthy') } } });
  });

  test.afterEach(async () => {
    if (world) await adoptSalesmanWork(world, since);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (!world) return;
    await adoptSalesmanWork(world, since);
    await dropDraftBuckets(world);
    await world.cleanup();
  });

  test("Today: his route's visits for today's Oman day, the stats, the cards and the no-day list (SM-TODAY-LIST)", async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const net = trackRequests(page);
    await page.goto('/today');
    const main = page.locator('main');

    await expect(page.getByRole('heading', { level: 1, name: `Good day, ${sa.fullName.split(' ')[0]}`, exact: true })).toBeVisible();
    // Wave 1: the Oman date, not the server's UTC one (which was a day behind until 04:00 Oman).
    await expect(main.getByText(omanLongDate(), { exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: 'New customer', exact: true })).toHaveAttribute('href', '/customers/new');

    // The stats, against the database.
    const live = { routeId: world.route('A').id, deletedAt: null, customer: { deletedAt: null } };
    const [total, undated, scheduled, pending] = await Promise.all([
      db.branch.count({ where: live }),
      db.branch.count({ where: { ...live, dayOfVisit: null } }),
      db.branch.count({ where: { ...live, dayOfVisit: OMAN_TODAY } }),
      db.customerEdit.count({ where: { submittedById: sa.id, state: 'SUBMITTED' } }),
    ]);
    expect(total, 'GAPS, FULL, CRED, MULTI ×2, CLOSEDB, DUE1, DUE2, OTHERDAY, NODAY1, NODAY2').toBe(11);
    expect(scheduled).toBe(2);
    expect(pending, 'the seeded CRED update').toBeGreaterThanOrEqual(1);
    await expect(todayStat(page, 'Route branches')).toHaveText(String(total));
    await expect(todayStat(page, 'Pending approval')).toHaveText(String(pending));
    // Nothing of his was sent back.
    await expect(todayStat(page, 'Needs correction')).toHaveText('0');
    // Wave 1: the tile is his way to Needs correction on a phone.
    await expect(main.getByRole('link').filter({ hasText: 'Needs correction' })).toHaveAttribute('href', '/rejected');

    // Exactly the two branches due today; nothing off his route, archived or deleted.
    await expect(page.getByRole('heading', { level: 2, name: `Today's visits (${scheduled})`, exact: true })).toBeVisible();
    const cards = main.locator('article');
    await expect(cards).toHaveCount(2);
    for (const k of ['DUE1', 'DUE2']) {
      await expect(page.getByRole('heading', { level: 3, name: world.customer(k).legalName, exact: true })).toBeVisible();
    }
    for (const k of ['OTHERDAY', 'NODAY1', 'NODAY2', 'GAPS', 'FULL', 'CRED', 'MULTI', 'CLOSEDB', 'ARCH', 'DELETED', 'BONLY']) {
      await expect(main.getByText(world.customer(k).legalName), `${k} is not on today's list`).toHaveCount(0);
    }

    // A card: name, code, payment pill, status, tap-to-call, Directions only with a point.
    const due1 = world.customer('DUE1');
    const due2 = world.customer('DUE2');
    const card1 = cards.filter({ has: page.getByRole('heading', { name: due1.legalName, exact: true }) });
    await expect(card1).toContainText(due1.code);
    await expect(card1).toContainText('Cash');
    await expect(card1).toContainText('Active');
    await expect(card1.getByRole('link', { name: due1.phone!, exact: true })).toHaveAttribute('href', `tel:${due1.phone}`);
    const directions = card1.getByRole('link', { name: 'Directions', exact: true });
    await expect(directions).toHaveAttribute('href', DIRECTIONS_HREF);
    await expect(directions).toHaveAttribute('target', '_blank');
    const card2 = cards.filter({ has: page.getByRole('heading', { name: due2.legalName, exact: true }) });
    await expect(card2.getByRole('link', { name: due2.phone!, exact: true })).toHaveAttribute('href', `tel:${due2.phone}`);
    await expect(card2.getByRole('link', { name: 'Directions' }), 'no point, no Directions').toHaveCount(0);

    // The card opens the customer.
    await card1.getByRole('link', { name: `${due1.legalName} · ${due1.code}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${due1.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: due1.legalName, exact: true })).toBeVisible();

    // The no-day list, with the hint to set the day; then back, then the full list.
    await page.goto('/today');
    expect(undated, 'GAPS, CRED, MULTI ×2, CLOSEDB, NODAY1, NODAY2').toBe(7);
    await main.getByRole('link', { name: `Branches with no visit day (${undated})`, exact: true }).click();
    await landsOn(page, net, /\/today\?view=no-day$/, 'the no-day link');
    await expect(page.getByRole('heading', { level: 2, name: `Branches with no visit day (${undated})`, exact: true })).toBeVisible();
    await expect(
      main.getByText(
        "When you next enrich the shop (open it, tap Enrich), set the branch's Day of visit. It leaves this list once the change is approved.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(cards).toHaveCount(undated);
    for (const k of ['NODAY1', 'NODAY2', 'GAPS', 'CRED', 'CLOSEDB']) {
      await expect(page.getByRole('heading', { level: 3, name: world.customer(k).legalName, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('heading', { level: 3, name: world.customer('MULTI').legalName, exact: true }), 'one card per branch').toHaveCount(2);
    await expect(main.getByText(due1.legalName)).toHaveCount(0);
    await main.getByRole('link', { name: `Today's visits (${scheduled})`, exact: true }).click();
    await landsOn(page, net, /\/today$/, "the Today's visits link");
    await main.getByRole('link', { name: 'All my customers', exact: true }).click();
    await landsOn(page, net, /\/customers$/, 'the All my customers link');
  });

  test('a tap that changes only the query string lands at once: Today and the no-day list, four times each way', async ({ browser }) => {
    // Fixed 8 Oct (TransitionWatchdog): such a tap on /today or /customers used to hang for good — the RSC answer
    // arrived, nothing was pending, the page stayed (Filter stayed "Filtering…"). The first no-day tap after a fresh
    // load of /today hung in 4 of 4 runs.
    test.setTimeout(600_000);
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const net = trackRequests(page);
    const main = page.locator('main');
    await page.goto('/today');
    for (let i = 1; i <= 4; i++) {
      await main.getByRole('link', { name: /^Branches with no visit day \(\d+\)$/ }).click();
      await landsOn(page, net, /\/today\?view=no-day$/, `hop ${2 * i - 1}: the no-day link`);
      await main.getByRole('link', { name: /^Today's visits \(\d+\)$/ }).click();
      await landsOn(page, net, /\/today$/, `hop ${2 * i}: the Today's visits link`);
    }
  });

  test('search finds his customers by name, code, phone, branch name and branch code — never route B (SM-SEARCH)', async ({ browser }) => {
    // Seventeen Filter taps, each a query-string-only navigation that must land (landsOn).
    test.setTimeout(600_000);
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const net = trackRequests(page);
    const main = page.locator('main');
    const cards = main.locator('article');
    const mine = await db.customer.count({
      where: { deletedAt: null, branches: { some: { routeId: world.route('A').id, deletedAt: null } } },
    });
    await page.goto('/customers');
    // The header counts his route only (10 customers: under one page of 50).
    await expect(page.getByText(`${mine} total`, { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(mine);

    const box = page.getByRole('searchbox', { name: 'Search customers' });
    const search = async (q: string) => {
      await box.fill(q);
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      await landsOn(page, net, (u) => u.pathname === '/customers' && u.searchParams.get('q') === q.trim(), `searched "${q}"`);
    };
    const queriesFor = (key: string) => {
      const c = world.customer(key);
      const b = world.branch(key);
      const local = c.phone!.slice(4);
      return [
        mixCase(c.legalName.slice(1, 11)),
        c.code,
        `${local.slice(0, 4)} ${local.slice(4)}`,
        `+968 ${local.slice(0, 4)} ${local.slice(4)}`,
        `968${local}`,
        b.name,
        b.code,
      ];
    };

    // His FULL customer, by every key; Call and Directions from his route-A branch.
    const full = world.customer('FULL');
    for (const q of queriesFor('FULL')) {
      await search(q);
      await expect(cards, `"${q}" finds FULL only`).toHaveCount(1);
      const card = cards.filter({ has: page.getByRole('heading', { name: full.legalName, exact: true }) });
      await expect(card).toBeVisible();
      await expect(card.getByRole('link', { name: full.phone!, exact: true })).toHaveAttribute('href', `tel:${full.phone}`);
      await expect(card.getByRole('link', { name: 'Directions', exact: true })).toHaveAttribute('href', DIRECTIONS_HREF);
    }

    // Route B's customer, by the same keys: nothing.
    for (const q of queriesFor('BONLY')) {
      await search(q);
      await expect(page.getByText('No customers match', { exact: true }), `"${q}" finds nothing of route B`).toBeVisible();
      await expect(cards).toHaveCount(0);
    }

    // MULTI: found by name, shown with a route-A branch; its route-B branch never surfaces.
    const multi = world.customer('MULTI');
    await search(multi.legalName);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Way 3012, Al Ghubra North, Muscat');
    expect(await page.content()).not.toContain(B1_ADDRESS);
    for (const q of [world.branch('MULTI.B1').name, world.branch('MULTI.B1').code]) {
      await search(q);
      await expect(page.getByText('No customers match', { exact: true }), `"${q}" is route B's branch`).toBeVisible();
    }

    // Clear empties the box and the chips.
    await search(full.code);
    await expect(page.getByRole('button', { name: `Remove filter Search: ${full.code}`, exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Clear', exact: true }).click();
    await landsOn(page, net, /\/customers$/, 'Clear');
    await expect(box).toHaveValue('');
    await expect(page.getByRole('button', { name: /^Remove filter / })).toHaveCount(0);
    await expect(cards).toHaveCount(mine);
  });

  test('his filter bar, a saved view, and URLs that try to widen his scope (SM-FILTERS)', async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const net = trackRequests(page);
    const general = await generalTrade();
    await page.goto('/customers');
    await settled(page);

    // Shown: Status, Channels, Score, More filters. Not shown: Regions, Routes, Supervisor, Salesman, Export.
    const status = page.locator('label').filter({ hasText: /^Status/ }).locator('select');
    await expect(status).toBeVisible();
    const channels = page.getByRole('button', { name: /^Channels/ });
    await expect(channels).toBeVisible();
    await expect(page.getByLabel('Minimum completeness score')).toBeVisible();
    await expect(page.getByLabel('Maximum completeness score')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Regions/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Routes/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export filtered' })).toHaveCount(0);
    await page.getByRole('button', { name: 'More filters', exact: true }).click();
    await expect(page.getByLabel('Payment terms', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Supervisor', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Salesman', { exact: true })).toHaveCount(0);

    // Status Closed, a channel, CREDIT and score 0–50: the chips say so, and that nothing is applied yet.
    await status.selectOption('CLOSED');
    await channels.click();
    const panel = page.getByRole('dialog', { name: 'Channels' });
    await panel.getByRole('checkbox', { name: general.label, exact: true }).check();
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByLabel('Payment terms', { exact: true }).selectOption('CREDIT');
    await page.getByLabel('Minimum completeness score').fill('0');
    await page.getByLabel('Maximum completeness score').fill('50');
    for (const chip of ['Status: Closed', `Channel: ${general.label}`, 'Payment: Credit', 'Score: 0–50']) {
      await expect(page.getByRole('button', { name: `Remove filter ${chip}`, exact: true })).toBeVisible();
    }
    const hint = page.getByText('Not applied yet — press Filter', { exact: true });
    await expect(hint).toBeVisible();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await landsOn(page, net, (u) => u.searchParams.get('status') === 'CLOSED', 'Filter with four filters');
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
      status: 'CLOSED',
      channel: general.id,
      paymentTerms: 'CREDIT',
      minScore: '0',
      maxScore: '50',
    });
    await expect(hint).toHaveCount(0);

    // One chip off: not applied until Filter.
    await page.getByRole('button', { name: 'Remove filter Status: Closed', exact: true }).click();
    await expect(hint).toBeVisible();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await landsOn(page, net, (u) => u.pathname === '/customers' && u.search !== '' && u.searchParams.get('status') === null, 'Filter with one chip off');
    await expect(hint).toHaveCount(0);

    // Saved view: saved, listed, applied, deleted.
    const params = `channel=${general.id}&paymentTerms=CREDIT&minScore=0&maxScore=50`;
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    const save = page.getByRole('dialog', { name: 'Save current filter as a view' });
    await save.getByLabel('View name').fill('Low scores');
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    const menu = page.getByRole('button', { name: /^Saved views \(1\)/ });
    const views = () => db.savedView.count({ where: { userId: sa.id } });
    await shownAfterRefresh(net, menu, 'Save view', async () => (await views()) === 1);
    expect(await db.savedView.findMany({ where: { userId: sa.id }, select: { name: true, urlParams: true } })).toEqual([
      { name: 'Low scores', urlParams: params },
    ]);
    await page.getByRole('link', { name: 'Clear', exact: true }).click();
    await landsOn(page, net, /\/customers$/, 'Clear');
    await menu.click();
    await page.getByRole('menuitem', { name: 'Low scores', exact: true }).click();
    await landsOn(page, net, (u) => u.search === `?${params}`, 'the saved view');
    await expect(page.getByRole('button', { name: 'Remove filter Payment: Credit', exact: true })).toBeVisible();
    await menu.click();
    await page.getByRole('button', { name: 'Delete saved view Low scores', exact: true }).click();
    await shownAfterRefresh(net, page.getByText('No saved views', { exact: true }), 'Delete saved view', async () => (await views()) === 0);
    expect(await views()).toBe(0);

    // Tampered URLs never show route B: empty, and no chip prints a database id.
    const routeB = world.route('B').id;
    for (const qs of [`route=${routeB}`, `salesman=${world.user('SB').id}`, `region=${world.region('R2').id}`, `status=closed&route=${routeB}`]) {
      await page.goto(`/customers?${qs}`);
      await expect(page.getByText('No customers match', { exact: true }), qs).toBeVisible();
      await expect(page.locator('main').getByText(world.customer('BONLY').legalName), qs).toHaveCount(0);
      const html = await page.content();
      expect(html, qs).not.toContain(B1_ADDRESS);
      expect(html, qs).not.toContain(world.customer('BONLY').code);
      await expect(page.getByRole('button', { name: /^Remove filter (Route|Salesman|Region): outside your access$/ }).first(), qs).toBeVisible();
    }
  });

  test('the customer page: only his branches, photos and maps, his actions, recent activity; the CR lock on a credit customer (SM-CUSTOMER-PAGE)', async ({ browser }) => {
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const main = page.locator('main');

    // FULL: identity, contact, one branch with GPS and photos, Enrich, Mark closed, no Archive.
    const full = world.customer('FULL');
    await page.goto(`/customers/${full.id}`);
    await expect(page.getByRole('heading', { level: 1, name: full.legalName, exact: true })).toBeVisible();
    await expect(main.getByText('Identity', { exact: true })).toBeVisible();
    await expect(main.getByText(full.crNumber!, { exact: true })).toBeVisible();
    await expect(main.getByText('Channel & Contact', { exact: true })).toBeVisible();
    await expect(main.getByRole('link', { name: full.phone!, exact: true })).toHaveAttribute('href', `tel:${full.phone}`);
    await expect(main.getByText('Branches (1)', { exact: true })).toBeVisible();
    const pin = main.getByRole('link', { name: 'Open in Maps', exact: true });
    await expect(pin).toHaveAttribute('href', 'https://www.google.com/maps?q=23.588100,58.382900');
    await expect(pin).toHaveAttribute('target', '_blank');
    await expect(main.getByRole('link', { name: 'Directions', exact: true })).toHaveAttribute('href', DIRECTIONS_HREF);
    await expect(main.getByRole('link', { name: 'Enrich', exact: true })).toHaveAttribute('href', `/customers/${full.id}/edit`);
    await expect(main.getByRole('button', { name: 'Mark closed', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /archive/i })).toHaveCount(0);
    if (hasR2) {
      const cr = full.photos.find((p) => p.wire === 'CR')!;
      const shop = full.photos.find((p) => p.wire === 'SHOP')!;
      const sign = full.photos.find((p) => p.wire === 'SIGNBOARD')!;
      // The CR document tile, and the branch tiles, all through the scope-checked route.
      await expect(main.locator(`a[href="/api/photos/${cr.id}"]`)).toContainText('View');
      await expect(main.getByRole('link', { name: 'Shop photo', exact: true })).toHaveAttribute('href', `/api/photos/${shop.id}`);
      await expect(main.getByRole('link', { name: 'Signboard photo', exact: true })).toHaveAttribute('href', `/api/photos/${sign.id}`);
      for (const p of [cr, shop, sign]) {
        const res = await fetchAs(page, `/api/photos/${p.id}`);
        expect(res.status, `${p.wire} photo`).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
      }
      const img = main.locator(`img[src="/api/photos/${shop.id}"]`);
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBe(16);
    }

    // MULTI: his two branches; nothing of route B's branch is in the HTML.
    const multi = world.customer('MULTI');
    const b1 = world.branch('MULTI.B1');
    await page.goto(`/customers/${multi.id}`);
    await expect(main.getByText('Branches (2)', { exact: true })).toBeVisible();
    for (const k of ['A1', 'A2']) await expect(main.getByText(world.branch(`MULTI.${k}`).name, { exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Mark closed', exact: true })).toHaveCount(2);
    const html = await page.content();
    const b1Photos = multi.photos.filter((p) => p.branchId === b1.id).map((p) => p.id);
    for (const needle of [b1.id, b1.code, b1.name, B1_ADDRESS, '23.600500', '23.60050', ...b1Photos]) {
      expect(html, `route B's branch leaks: ${needle}`).not.toContain(needle);
    }

    // CLOSEDB: a closed branch offers reactivation, not closing.
    await page.goto(`/customers/${world.customer('CLOSEDB').id}`);
    await expect(main.getByRole('button', { name: 'Request reactivation', exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Mark closed' })).toHaveCount(0);

    // CRED: Recent activity lists his request (wave 1: no drafts, no "0 change(s)").
    const cred = world.customer('CRED');
    await page.goto(`/customers/${cred.id}`);
    const activity = main.locator('section').filter({ has: page.getByText('Recent activity', { exact: true }) });
    await expect(activity.getByText(`${sa.fullName} submitted 1 change(s)`, { exact: true })).toBeVisible();
    await expect(activity.getByText('Pending review', { exact: true })).toBeVisible();
    await expect(activity.getByText('draft', { exact: true })).toHaveCount(0);

    // Wave 2, decision 2: a credit customer's CR document is shown, never taken, replaced or removed by him.
    await page.goto(`/customers/${cred.id}/edit`);
    await expect(page.getByText(CR_DOCUMENT_LOCKED_MESSAGE, { exact: true })).toBeVisible();
    const crSlot = photoSlot(page, 'CR document');
    await expect(crSlot).toBeVisible();
    await expect(crSlot.locator('label[aria-label="Capture photo"], label[aria-label="Retake photo"]')).toHaveCount(0);
    // …while a cash customer's CR slot is his to fill.
    await page.goto(`/customers/${world.customer('DUE1').id}/edit`);
    await expect(page.getByText(CR_DOCUMENT_LOCKED_MESSAGE, { exact: true })).toHaveCount(0);
    await expect(photoSlot(page, 'CR document').locator('label[aria-label="Capture photo"]')).toBeVisible();
  });

  test('the visit-day job from the no-day list: setting the day holds only that shop to complete (critic; wave 2, decision 4)', async ({ browser }) => {
    test.skip(FULL_GATE, CORE_ONLY);
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const noday = world.customer('NODAY1');
    await page.goto('/today?view=no-day');
    await page.locator('main article').getByRole('link', { name: `${noday.legalName} · ${noday.code}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${noday.id}$`));
    await page.locator('main').getByRole('link', { name: 'Enrich', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${noday.id}/edit$`));
    await settled(page);

    const day = omanDayAfter(3);
    await page.getByLabel('Day of visit', { exact: true }).selectOption(day);
    const submit = page.getByRole('button', { name: SUBMIT, exact: true });
    const missing = page.getByText('Cannot submit yet — missing:', { exact: true }).locator('xpath=..');
    // NODAY1 has no contact person: not asked for — the day is a branch change, only that shop is held complete.
    await expect(missing).toHaveText(
      'Cannot submit yet — missing: Branch 1 GPS, Branch 1 shop photo. Save as a draft and finish the rest before submitting.'
    );
    await expect(submit).toBeDisabled();
    await page.getByRole('button', { name: /^Capture GPS/ }).click();
    await expect(page.getByText(GPS_TEXT)).toBeVisible();
    await expect(missing).toHaveText('Cannot submit yet — missing: Branch 1 shop photo. Save as a draft and finish the rest before submitting.');
    test.skip(!hasR2, 'the shop photo needs R2');
    const shop = photoSlot(page, 'Shop front');
    await pickFile(shop, pngFile('shop'));
    await expect(retakeOf(shop)).toBeVisible({ timeout: 120_000 });
    await expect(missing).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(new RegExp(`/customers/${noday.id}$`), { timeout: 30_000 });
    const edit = await db.customerEdit.findFirstOrThrow({
      where: { customerId: noday.id, submittedById: sa.id, state: 'SUBMITTED' },
      select: { fieldChanges: true },
    });
    const fields = (edit.fieldChanges as Array<{ field: string; after: unknown }>).map((c) => c.field);
    expect(fields).toContain(`branch.${noday.branch.id}.dayOfVisit`);
    expect(fields.some((f) => f.startsWith('customer.')), 'no customer-level change was needed').toBe(false);
  });

  test('phone layout: a 56 px tab bar, the sticky Submit bar above it; the sidebar from 768 px (SM-TABBAR-STICKY)', async ({ browser }) => {
    test.setTimeout(480_000);
    const full = world.customer('FULL');
    const due2 = world.customer('DUE2');
    // The list pages' side scroll is the next test's (a reported bug); the other pages must not scroll sideways.
    const LISTS = ['/today', '/customers', '/work'];
    const pages: Array<[string, 'Today' | 'Customers' | 'Work' | 'Me' | null]> = [
      ['/today', 'Today'],
      ['/customers', 'Customers'],
      [`/customers/${full.id}`, 'Customers'],
      [`/customers/${due2.id}/edit`, 'Customers'],
      ['/customers/new', 'Customers'],
      ['/work', 'Work'],
      ['/notifications', null],
      ['/profile', 'Me'],
    ];
    for (const device of ['phone', 'phone360'] as const) {
      const page = await (await contextAs(browser, sa, { device })).newPage();
      for (const [url, active] of pages) {
        await page.goto(url);
        // Measured once the page has settled (fonts, hydration): not mid-load.
        await settled(page);
        const bar = tabBar(page);
        await expect(bar, `${device} ${url}`).toBeVisible();
        const box = (await bar.boundingBox())!;
        const bottom = Math.round(box.y + box.height);
        // The bottom of the layout viewport: a page wider than the phone is shown zoomed out, the bar still at its bottom.
        const screenBottom = await page.evaluate(() => window.innerHeight);
        const why = bottom === screenBottom ? '' : ` — ${await layoutDiagnosis(page)}`;
        expect(Math.round(box.height), `${device} ${url}: the bar is 56 px`).toBe(56);
        expect(bottom, `${device} ${url}: fixed to the bottom${why}`).toBe(screenBottom);
        for (const tab of ['Today', 'Customers', 'Work', 'Me'] as const) {
          const link = bar.getByRole('link', { name: tab, exact: true });
          await expect(link).toBeVisible();
          if (tab === active) await expect(link, `${device} ${url}: ${tab} is highlighted`).toHaveClass(/text-brand-700/);
          else await expect(link, `${device} ${url}: ${tab} is not highlighted`).not.toHaveClass(/text-brand-700/);
        }
        if (!LISTS.includes(url)) await expectNoSideScroll(page);
      }

      // Both forms: Submit and Save draft are on top (never under "Today") in the middle, at the end, and with the keyboard up.
      for (const url of [`/customers/${due2.id}/edit`, '/customers/new']) {
        await page.goto(url);
        await settled(page);
        const submit = page.getByRole('button', { name: SUBMIT, exact: true });
        const draft = page.getByRole('button', { name: 'Save draft', exact: true });
        for (const where of ['middle', 'end'] as const) {
          await page.evaluate((w) => {
            const h = document.documentElement.scrollHeight;
            window.scrollTo(0, w === 'end' ? h : h / 2);
          }, where);
          await expect.poll(() => hitTest(page, submit), { message: `${device} ${url} ${where}: Submit is on top` }).toBe(true);
          await expect.poll(() => hitTest(page, draft), { message: `${device} ${url} ${where}: Save draft is on top` }).toBe(true);
        }
        if (url === '/customers/new') {
          // At the end of the page the missing list is readable, not under the tab bar.
          const missing = page.getByText('Cannot submit yet — missing:', { exact: true });
          await expect.poll(() => hitTest(page, missing), { message: `${device}: the missing list is readable` }).toBe(true);
        }
        await page.getByLabel('Address *', { exact: true }).focus();
        await expect.poll(() => hitTest(page, submit), { message: `${device} ${url}: Submit with the Address box focused` }).toBe(true);
      }

      if (device === 'phone360' && !FULL_GATE) {
        // An enabled Submit, tapped at 360 px, submits — it never lands on the tab bar.
        await page.goto(`/customers/${due2.id}/edit`);
        await settled(page);
        await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Yusuf Al Kindi'));
        const submit = page.getByRole('button', { name: SUBMIT, exact: true });
        await expect(submit).toBeEnabled();
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
        await submit.tap();
        await expect(page).toHaveURL(new RegExp(`/customers/${due2.id}$`), { timeout: 30_000 });
        expect(await db.customerEdit.count({ where: { customerId: due2.id, submittedById: sa.id, state: 'SUBMITTED' } })).toBe(1);
      }
    }

    // From 768 px: no tab bar; the sidebar has Today, Customers, New customer, Work items and Needs correction.
    const wide = await (await contextAs(browser, sa, { device: 'desktop', extra: { viewport: { width: 800, height: 1000 } } })).newPage();
    await wide.goto('/today');
    const sidebar = wide.getByRole('navigation').filter({ has: wide.getByRole('link', { name: 'Work items', exact: true }) });
    for (const label of ['Today', 'Customers', 'New customer', 'Work items', 'Needs correction']) {
      await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(tabBar(wide)).toBeHidden();
  });

  test('his lists fit the phone with real-length customer names: no side scroll at 412 and 360 px (SM-TABBAR-STICKY, MOBILE-LAYOUT)', async ({ browser }) => {
    // Was a BUG (runs of 8 Oct), fixed by da59a76: the list pages put their cards in a `grid` with an auto column, which no
    // card's truncated (nowrap) name could undercut — a name over ~25 characters made the page wider than the phone.
    test.setTimeout(240_000);
    for (const device of ['phone', 'phone360'] as const) {
      const page = await (await contextAs(browser, sa, { device })).newPage();
      for (const url of ['/customers', '/today', '/work']) {
        await page.goto(url);
        await settled(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const why = overflow > 1 ? ` — ${await layoutDiagnosis(page)}` : '';
        expect.soft(overflow, `${device} ${url}: px wider than the phone${why}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Edges: no route, a switched-off route, more than 200 visits (P2) — and the
//    gaps found before launch (fixed), each in its own test (not serial)
// ════════════════════════════════════════════════════════════════════════════

test.describe('salesman phone: no route, a switched-off route, 201 visits (SM-TODAY-EDGES)', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // Route BIG: 51 customers, 201 branches due today (50 × 4 + 1).
    const big = Array.from({ length: 51 }, (_, i) => ({
      key: `BIG${i + 1}`,
      branches: Array.from({ length: i < 50 ? 4 : 1 }, (_, j) => ({ key: `S${j + 1}`, route: 'BIG', day: 'TODAY' as const })),
    }));
    world = await createWorld('spe', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'BIG', region: 'R1' },
        { key: 'OFF', region: 'R1', isActive: false },
        { key: 'K', region: 'R1' },
      ],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SBIG', role: 'SALESMAN', route: 'BIG', supervisor: 'M1' },
        { key: 'SOFF', role: 'SALESMAN', route: 'OFF', supervisor: 'M1' },
        { key: 'SNONE', role: 'SALESMAN', supervisor: 'M1' },
        { key: 'SK', role: 'SALESMAN', route: 'K', supervisor: 'M1' },
      ],
      customers: [
        ...big,
        { key: 'OFF1', phone: true, contact: 'Rashid Al Wahaibi', branches: [{ key: 'S', route: 'OFF', day: 'TODAY' }] },
        { key: 'K1', phone: true, contact: 'Talib Al Maskari', branches: [{ key: 'S', route: 'K' }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (!world) return;
    await dropDraftBuckets(world);
    await world.cleanup();
  });

  test('no route: Today says so, Customers is empty, New customer shows no form', async ({ browser }) => {
    const u = world.user('SNONE');
    const page = await (await contextAs(browser, u, { device: 'phone' })).newPage();
    await page.goto('/today');
    // Critic: the route-less Today is 'Welcome, <name>' with an empty state titled 'No route assigned'.
    await expect(page.getByRole('heading', { level: 1, name: `Welcome, ${u.fullName}`, exact: true })).toBeVisible();
    await expect(page.getByText('No route assigned', { exact: true })).toBeVisible();
    await expect(page.getByText("Ask a Manager to assign you to a route. You'll see your customers here once that's done.", { exact: true })).toBeVisible();
    await page.goto('/customers');
    await expect(page.getByText('0 total', { exact: true })).toBeVisible();
    await expect(page.getByText('No customers match', { exact: true })).toBeVisible();
    await page.goto('/customers/new');
    await expect(page.getByText('You have no route assigned — ask your supervisor before registering new customers.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: SUBMIT })).toHaveCount(0);
  });

  test('a switched-off route: New customer refuses with "Your route is inactive…"', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SOFF'), { device: 'phone' })).newPage();
    await page.goto('/customers/new');
    await expect(page.getByText('Your route is inactive — ask your supervisor before registering new customers.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: SUBMIT })).toHaveCount(0);
  });

  test('a switched-off route: Today tells him so, and the enrich form locks its photo slots up front', async ({ browser }) => {
    // Was a P2 (critic, route switched off mid-week), fixed by 804bda1 / 9a0e253 / 38e530a: /today listed an inactive
    // route's branches with no notice, and only /customers/new refused.
    const page = await (await contextAs(browser, world.user('SOFF'), { device: 'phone' })).newPage();
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 3, name: world.customer('OFF1').legalName, exact: true })).toBeVisible();
    await expect(
      page
        .locator('main')
        .getByText(
          'Your route is inactive — ask your supervisor. Until it is active again, you cannot submit an enrichment, add or remove photos, mark a shop closed, request a reactivation or register a new customer. An enrichment you start stays saved on this phone.',
          { exact: true }
        )
    ).toBeVisible();
    // New customer is shown switched off too, not as a link to a form that would refuse him.
    await expect(page.locator('main').getByRole('button', { name: 'New customer' })).toBeDisabled();
    await expect(page.locator('main').getByRole('link', { name: 'New customer' })).toHaveCount(0);

    // The enrich form says so before he fills it, and no photo slot offers a capture, a retake or Remove.
    await page.goto(`/customers/${world.customer('OFF1').id}/edit`);
    await settled(page);
    await expect(
      page.getByText(
        'Your route is inactive — ask your supervisor. You can save a draft, but you cannot add or remove photos or submit until the route is active again.',
        { exact: true }
      )
    ).toBeVisible();
    await expect(photoSlot(page, 'Shop front')).toBeVisible();
    await expect(page.locator('label[aria-label="Capture photo"], label[aria-label="Retake photo"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove photo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  });

  test('201 visits today: 200 cards on page 1, Next and Previous work; Customers pages 50 at a time', async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await (await contextAs(browser, world.user('SBIG'), { device: 'phone' })).newPage();
    const net = trackRequests(page);
    const cards = page.locator('main article');
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 2, name: "Today's visits (201)", exact: true })).toBeVisible();
    await expect(page.getByText('Showing 200 of 201 visits · Page 1 of 2', { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(200);
    const nav = page.getByRole('navigation', { name: 'Visit pages' });
    await expect(nav.getByRole('link', { name: 'Previous', exact: true })).toHaveCount(0);
    await nav.getByRole('link', { name: 'Next', exact: true }).click();
    await landsOn(page, net, /\/today\?page=2$/, 'Next');
    await expect(page.getByText('Showing 1 of 201 visits · Page 2 of 2', { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(1);
    await nav.getByRole('link', { name: 'Previous', exact: true }).click();
    await landsOn(page, net, /\/today\?page=1$/, 'Previous');
    await expect(cards).toHaveCount(200);

    await page.goto('/customers');
    await expect(page.getByText('51 total', { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(50);
    await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Next →', exact: true }).click();
    await landsOn(page, net, (u) => u.pathname === '/customers' && u.searchParams.get('page') === '2', 'Next → on Customers');
    await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(1);
  });

  test('a photo the phone cannot decode (HEIC, a broken JPEG) says why on its slot, and he can pick again', async ({ browser }) => {
    // Was a BUG (found by static read, 7 Oct), fixed by 287bdc0 / 41d81ec: PhotoCaptureSlot rendered `error` only while
    // progress !== 'error' or with a retained blob, so a decode failure left a red slot with no words. A HEIC gets the
    // HEIC hint; any other photo it cannot read gets one sentence of what to do; both are read out (role=alert).
    const u = world.user('SK');
    const page = await (await contextAs(browser, u, { device: 'phone' })).newPage();
    await openEnrich(page, world.customer('K1').id);
    const shop = photoSlot(page, 'Shop front');
    await pickFile(shop, { name: 'IMG_0001.heic', mimeType: 'image/heic', buffer: fakeHeic() });
    await expect(shop.getByRole('alert').filter({ hasText: HEIC_MESSAGE })).toHaveText(HEIC_MESSAGE, { timeout: 10_000 });
    const sign = photoSlot(page, 'Signboard');
    await pickFile(sign, { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a jpeg') });
    await expect(sign.getByRole('alert').filter({ hasText: UNREADABLE_PHOTO_MESSAGE })).toHaveText(UNREADABLE_PHOTO_MESSAGE, { timeout: 10_000 });
    // No Retry upload for a photo that never went up: he picks again from the same slot.
    for (const slot of [shop, sign]) {
      await expect(slot.getByRole('button', { name: 'Retry upload' })).toHaveCount(0);
      await expect(slot.locator('label[aria-label="Capture photo"]')).toBeVisible();
    }
    expect(await db.attachment.count({ where: { capturedById: u.id } }), 'nothing was uploaded').toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Work items and Needs correction — seeded on SA2, so SA's lists stay small
// ════════════════════════════════════════════════════════════════════════════

test.describe('salesman phone: Work items and Needs correction (SM-WORK-ITEMS, SM-REJECTED-LIST)', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  const ids = { wsub: '', wnc: '', wreact: '', cfm: '', cdraft: '', cnc: '' };
  const names = { cfm: '', cdraft: '', cnc: '' };
  const reasons = { wnc: '', cnc: '' };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    world = await createWorld('spw', {
      regions: [{ key: 'R1' }],
      routes: [
        { key: 'A2', region: 'R1' },
        { key: 'E', region: 'R1' },
      ],
      users: [
        { key: 'M2', role: 'MANAGER', regions: ['R1'] },
        { key: 'ACC', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'SA2', role: 'SALESMAN', route: 'A2', supervisor: 'M2' },
        { key: 'SE', role: 'SALESMAN', route: 'E', supervisor: 'M2' },
      ],
      customers: [
        { key: 'WSUB', phone: true, contact: 'Ali Al Amri', branches: [{ key: 'S', route: 'A2' }] },
        { key: 'WNC', phone: true, contact: 'Badr Al Hinai', branches: [{ key: 'S', route: 'A2' }] },
        {
          key: 'WREACT',
          phone: true,
          contact: 'Saif Al Abri',
          branches: [{ key: 'S', route: 'A2', status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 2 * 3_600_000) }],
        },
        { key: 'EONE', phone: true, branches: [{ key: 'S', route: 'E' }] },
      ],
    });
    reasons.wnc = world.name('The phone number belongs to the owner’s brother');
    reasons.cnc = world.name('Add the signboard photo');
    names.cfm = world.name('Al Wadi Credit Store');
    names.cdraft = world.name('Al Wadi Draft Store');
    names.cnc = world.name('Al Wadi Returned Store');
    ids.wsub = (await seedUpdateEdit(world, { customer: 'WSUB', submitter: 'SA2', patch: { customer: { contactPerson: world.name('Ali Al Amri') } } })).id;
    ids.wnc = (
      await seedUpdateEdit(world, {
        customer: 'WNC',
        submitter: 'SA2',
        patch: { customer: { contactPerson: world.name('Badr Al Hinai') } },
        state: 'NEEDS_CORRECTION',
        decision: { by: 'M2', reason: reasons.wnc },
      })
    ).id;
    ids.wreact = await seedReactivationRow(world, { branch: 'WREACT', submitter: 'SA2' });
    // New-customer requests through the app's own route (as SA2), then moved to the state each row needs.
    const ctx = await contextAs(browser, world.user('SA2'), { device: 'phone' });
    try {
      const page = await ctx.newPage();
      await page.goto('/today');
      ids.cfm = await seedCreateRequest(page, world, { legalName: names.cfm, paymentTerms: 'CREDIT', state: 'SUBMITTED', pendingRole: 'FINANCE_MANAGER' });
      ids.cdraft = await seedCreateRequest(page, world, { legalName: names.cdraft, state: 'DRAFT' });
      ids.cnc = await seedCreateRequest(page, world, { legalName: names.cnc, state: 'NEEDS_CORRECTION', reviewer: 'M2', reason: reasons.cnc });
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (!world) return;
    await dropDraftBuckets(world);
    await world.cleanup();
  });

  test('Work lists every state of his requests, and each row opens the right page (SM-WORK-ITEMS)', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, world.user('SA2'), { device: 'phone' })).newPage();
    const wsub = world.customer('WSUB');
    const wnc = world.customer('WNC');
    const wreact = world.customer('WREACT');
    await page.goto('/work');
    await expect(page.getByRole('heading', { level: 1, name: 'Work items', exact: true })).toBeVisible();
    // Wave 1: Work links to Needs correction (a phone has no menu entry for it).
    await expect(page.getByRole('link', { name: 'Sent back to you (2) — see why', exact: true })).toHaveAttribute('href', '/rejected');

    const row = (title: string) => page.locator('main li').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
    const when = async (id: string, f: 'submittedAt' | 'reviewedAt' | 'updatedAt') =>
      omanDate(
        (await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { submittedAt: true, reviewedAt: true, updatedAt: true } }))[f]!
      );
    const rows = [
      // Wave 1: a sent-back update is "Needs correction" (was "Rejected") and opens the form with ?returned=.
      { title: wnc.legalName, category: 'Needs correction', subtitle: reasons.wnc, href: `/customers/${wnc.id}/edit?returned=${ids.wnc}`, date: await when(ids.wnc, 'reviewedAt') },
      { title: names.cnc, category: 'New customer — needs correction', subtitle: reasons.cnc, href: `/customers/new?edit=${ids.cnc}`, date: await when(ids.cnc, 'reviewedAt') },
      { title: wsub.legalName, category: 'Awaiting approval', subtitle: 'Submitted to your supervisor', href: `/customers/${wsub.id}`, date: await when(ids.wsub, 'submittedAt') },
      // Wave 1: a reactivation is a Manager's decision.
      { title: wreact.legalName, category: 'Awaiting approval', subtitle: 'Sent to a Manager', href: `/customers/${wreact.id}`, date: await when(ids.wreact, 'submittedAt') },
      { title: names.cfm, category: 'New customer — in approval', subtitle: 'In review — current step: FINANCE MANAGER', href: `/customers/new?edit=${ids.cfm}`, date: await when(ids.cfm, 'submittedAt') },
      { title: names.cdraft, category: 'New customer — draft', subtitle: 'Unfinished create request — tap to continue', href: `/customers/new?edit=${ids.cdraft}`, date: await when(ids.cdraft, 'updatedAt') },
    ];
    await expect(page.locator('main li')).toHaveCount(rows.length);
    for (const r of rows) {
      const li = row(r.title);
      await expect(li.locator('p').nth(0), r.title).toHaveText(r.category);
      await expect(li.locator('p').nth(1), r.title).toHaveText(r.subtitle);
      await expect(li.getByRole('link'), r.title).toHaveAttribute('href', r.href);
      await expect(li.getByText(r.date, { exact: true }), `${r.title}: the Oman date`).toBeVisible();
    }

    // Each row opens its page.
    await row(wnc.legalName).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/customers/${wnc.id}/edit\\?returned=${ids.wnc}$`));
    // The banner reads "Sent back to you by <who>, <when>: <reason>" in one line.
    await expect(page.getByText(reasons.wnc)).toBeVisible();
    // Wave 1: what he sent is filled in.
    await expect(page.getByText('What you sent is filled in below. Change what was asked, then submit again.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(world.name('Badr Al Hinai'));

    await page.goto('/work');
    await row(names.cnc).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${ids.cnc}$`));
    await expect(page.getByText('Returned for correction:', { exact: true })).toBeVisible();
    await expect(page.getByText(reasons.cnc)).toBeVisible();
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(names.cnc);

    await page.goto('/work');
    await row(names.cfm).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${ids.cfm}$`));
    await expect(page.getByText(/^This request is in review — current step:/)).toContainText('FINANCE MANAGER');
    await expect(page.getByRole('button', { name: SUBMIT })).toHaveCount(0);

    await page.goto('/work');
    await row(names.cdraft).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/customers/new\\?edit=${ids.cdraft}$`));
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(names.cdraft);
    await expect(page.getByRole('button', { name: 'Discard this draft', exact: true })).toBeVisible();

    for (const c of [wsub, wreact]) {
      await page.goto('/work');
      await row(c.legalName).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`));
      await expect(page.getByRole('heading', { level: 1, name: c.legalName, exact: true })).toBeVisible();
    }
  });

  test('Work with nothing on it reads "All clear"', async ({ browser }) => {
    const page = await (await contextAs(browser, world.user('SE'), { device: 'phone' })).newPage();
    await page.goto('/work');
    await expect(page.getByText('All clear', { exact: true })).toBeVisible();
    await expect(page.getByText('Nothing is waiting on you right now.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Sent back to you/ })).toHaveCount(0);
  });

  test('Needs correction: from the sidebar at 1280 px, and on a phone from the Today tile and from Work (SM-REJECTED-LIST)', async ({ browser }) => {
    const sa2 = world.user('SA2');
    const m2 = world.user('M2');
    const wnc = world.customer('WNC');
    const decided = async (id: string) => omanDate((await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { reviewedAt: true } })).reviewedAt!);

    const desk = await (await contextAs(browser, sa2, { device: 'desktop' })).newPage();
    await desk.goto('/today');
    await desk.getByRole('navigation').getByRole('link', { name: 'Needs correction', exact: true }).click();
    await expect(desk).toHaveURL(/\/rejected$/);
    // Wave 1: not "your supervisor" — each card names who sent it back.
    await expect(desk.getByText('2 submission(s) sent back to you', { exact: true })).toBeVisible();
    const card = (title: string) => desk.locator('main li').filter({ has: desk.getByRole('heading', { level: 3, name: title, exact: true }) });
    const update = card(wnc.legalName);
    await expect(update.getByText(wnc.code, { exact: true })).toBeVisible();
    await expect(update.getByText(reasons.wnc, { exact: true })).toBeVisible();
    await expect(update.getByText(`Sent back by ${m2.fullName} · ${await decided(ids.wnc)}`, { exact: true })).toBeVisible();
    await expect(update.getByRole('link')).toHaveAttribute('href', `/customers/${wnc.id}/edit?returned=${ids.wnc}`);
    await expect(update.getByRole('button', { name: 'Nothing to send again — clear this', exact: true })).toBeVisible();
    const create = card(names.cnc);
    await expect(create.getByText('New customer request', { exact: true })).toBeVisible();
    await expect(create.getByText(reasons.cnc, { exact: true })).toBeVisible();
    await expect(create.getByText(`Sent back by ${m2.fullName} · ${await decided(ids.cnc)}`, { exact: true })).toBeVisible();
    await expect(create.getByRole('link')).toHaveAttribute('href', `/customers/new?edit=${ids.cnc}`);
    // A new-customer request is withdrawn from its own page, not cleared here.
    await expect(create.getByRole('button', { name: 'Nothing to send again — clear this' })).toHaveCount(0);

    // Wave 1: a phone reaches it from the Today tile and from Work (no tab, no drawer).
    const phone = await (await contextAs(browser, sa2, { device: 'phone' })).newPage();
    await phone.goto('/today');
    await expect(todayStat(phone, 'Needs correction')).toHaveText('2');
    await phone.locator('main').getByRole('link').filter({ hasText: 'Needs correction' }).click();
    await expect(phone).toHaveURL(/\/rejected$/);
    await expect(phone.getByText('2 submission(s) sent back to you', { exact: true })).toBeVisible();
    await phone.goto('/work');
    await phone.getByRole('link', { name: 'Sent back to you (2) — see why', exact: true }).click();
    await expect(phone).toHaveURL(/\/rejected$/);
  });

  test('a sent-back update he will not send again is cleared from every list, and stays sent back on record (wave 1)', async ({ browser }) => {
    const sa2 = world.user('SA2');
    const wnc = world.customer('WNC');
    const page = await (await contextAs(browser, sa2, { device: 'phone' })).newPage();
    await page.goto('/rejected');
    const card = (title: string) => page.locator('main li').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
    await card(wnc.legalName).getByRole('button', { name: 'Nothing to send again — clear this', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear this from Needs correction?' });
    await dialog.getByRole('button', { name: 'Clear it', exact: true }).click();
    await expect(page.getByText('1 submission(s) sent back to you', { exact: true })).toBeVisible();
    await expect(card(wnc.legalName)).toHaveCount(0);
    await expect(card(names.cnc)).toBeVisible();
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: ids.wnc }, select: { state: true } })).state).toBe('NEEDS_CORRECTION');
    expect((await auditFor({ entityId: ids.wnc, actorId: sa2.id })).filter((a) => a.reason === RETURNED_CLEARED_REASON)).toHaveLength(1);
    await page.goto('/today');
    await expect(todayStat(page, 'Needs correction')).toHaveText('1');
    await page.goto('/work');
    await expect(page.getByRole('link', { name: 'Sent back to you (1) — see why', exact: true })).toBeVisible();
    await expect(page.locator('main li').filter({ hasText: reasons.wnc })).toHaveCount(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. The bell and the inbox
// ════════════════════════════════════════════════════════════════════════════

test.describe('salesman phone: the bell and the inbox (SM-NOTIFICATIONS)', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  const seeded = { correction0: '', approved: '', progress: '', corrections: [] as string[] };
  const at = { correction0: new Date(), approved: new Date(), progress: new Date() };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('spn', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
      customers: [
        { key: 'C1', phone: true, contact: 'Zahir Al Lamki', branches: [{ key: 'S', route: 'A' }] },
        { key: 'C2', phone: true, contact: 'Juma Al Farsi', branches: [{ key: 'S', route: 'A' }] },
      ],
    });
    const now = Date.now();
    at.correction0 = new Date(now - 60_000);
    at.approved = new Date(now - 120_000);
    at.progress = new Date(now - 180_000);
    // Ten returned requests (the red count); the newest is an UPDATE of C1, the rest are new-customer requests.
    for (let i = 0; i < 10; i++) {
      seeded.corrections.push(
        await seedNotification(world, {
          user: 'SA',
          kind: 'EDIT_NEEDS_CORRECTION',
          title: world.name(`Correction ${i}`),
          body: world.name(`Sent back ${i}`),
          customerId: i === 0 ? world.customer('C1').id : undefined,
          createdAt: i === 0 ? at.correction0 : new Date(now - 600_000 - i * 60_000),
        })
      );
    }
    seeded.correction0 = seeded.corrections[0]!;
    // An approved new customer (it has its customer now) and a new-customer request moving on (none yet).
    seeded.approved = await seedNotification(world, {
      user: 'SA',
      kind: 'EDIT_APPROVED_FINAL',
      title: world.name('Approved'),
      customerId: world.customer('C2').id,
      createdAt: at.approved,
    });
    seeded.progress = await seedNotification(world, { user: 'SA', kind: 'EDIT_STAGE_ADVANCED', title: world.name('Progress'), createdAt: at.progress });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('the bell, the inbox newest first, tap-through marks read and opens the right page, Mark all read', async ({ browser }) => {
    test.setTimeout(240_000);
    const sa = world.user('SA');
    const page = await (await contextAs(browser, sa, { device: 'phone' })).newPage();
    const readAt = async (id: string) => (await db.notification.findUniqueOrThrow({ where: { id }, select: { readAt: true } })).readAt;
    const bell = page.getByRole('link', { name: /^Notifications/ });

    await page.goto('/today');
    // Wave 1: his red count is returned work only; "approved" and "advanced" are for information.
    await expect(bell).toHaveAttribute('aria-label', 'Notifications (10 unread, 2 for information)');
    await expect(bell).toHaveText('9+');
    await expect(bell.locator('span')).toHaveClass(/bg-red-500/);

    await bell.click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByText('10 unread · 2 for information', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark information read', exact: true })).toBeVisible();
    const items = page.locator('main li');
    await expect(items).toHaveCount(12);
    await expect(items.nth(0)).toContainText(world.name('Correction 0'));
    await expect(items.nth(0)).toContainText('Correction');
    await expect(items.nth(0)).toContainText(omanDayTime(at.correction0));
    await expect(items.nth(1)).toContainText(world.name('Approved'));
    await expect(items.nth(1)).toContainText('Approved');
    await expect(items.nth(2)).toContainText(world.name('Progress'));
    await expect(items.nth(2)).toContainText('Progress');
    await expect(items.nth(3)).toContainText(world.name('Correction 1'));

    // An UPDATE sent back: its customer. Marked read; after Back (and a fresh load: mark-read is fire-and-forget) the bell drops by one.
    await items.nth(0).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/customers/${world.customer('C1').id}$`));
    await expect.poll(() => readAt(seeded.correction0)).not.toBeNull();
    await page.goBack();
    await expect(page).toHaveURL(/\/notifications$/);
    await reloadUntil(page, async () => (await bell.getAttribute('aria-label')) === 'Notifications (9 unread, 2 for information)');
    await expect(bell).toHaveText('9');
    await expect(page.getByText('9 unread · 2 for information', { exact: true })).toBeVisible();

    // An approved new customer: the new customer.
    await items.nth(1).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/customers/${world.customer('C2').id}$`));
    await expect.poll(() => readAt(seeded.approved)).not.toBeNull();
    await page.goBack();
    await reloadUntil(page, async () => (await bell.getAttribute('aria-label')) === 'Notifications (9 unread, 1 for information)');

    // A new-customer request with no customer yet: Work.
    await items.nth(2).getByRole('link').click();
    await expect(page).toHaveURL(/\/work$/);
    await expect.poll(() => readAt(seeded.progress)).not.toBeNull();
    await page.goBack();
    await reloadUntil(page, async () => (await bell.getAttribute('aria-label')) === 'Notifications (9 unread)');

    // Mark all read clears the badge.
    await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(page.getByText('All caught up', { exact: true })).toBeVisible();
    await expect(bell).toHaveAttribute('aria-label', 'Notifications');
    await expect(bell.locator('span')).toHaveCount(0);
    expect(await db.notification.count({ where: { userId: sa.id, readAt: null } })).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. The safety of every send: double tap, no signal, a lost reply, signed out,
//    the rate limit — on the enrich, new-customer and close forms. Each test has
//    a salesman, route and customer of its own (one open request per customer).
// ════════════════════════════════════════════════════════════════════════════

test.describe('salesman phone: every send is safe — double tap, no signal, lost reply, signed out', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let since: Date;
  let audience: string[];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await createWorld('sps', {
      regions: [{ key: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
      ],
    });
    audience = [world.user('M1').id, world.user('ACC1').id];
  });

  test.afterEach(async () => {
    if (world) await adoptSalesmanWork(world, since);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (!world) return;
    await adoptSalesmanWork(world, since);
    await dropDraftBuckets(world);
    await world.cleanup();
  });

  // ── enrich ──────────────────────────────────────────────────────────────────

  test('enrich: a double tap writes one request; "Submitting…" then "Sent ✓"; Back skips the form; reopened, it is pending (SM-SUBMIT-DOUBLE-TAP)', async ({ browser }) => {
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'E1');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const posts = countRequests(page, '/api/forms/customer-edit');
    await page.goto('/today');
    const submit = await openEnrich(page, customer.id);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Majid Al Shukaili'));
    await expect(submit).toBeEnabled();
    await delayPosts(page, '/api/forms/customer-edit', 1_500);
    await delayDocument(page, `/customers/${customer.id}`, 2_500);
    // Read as they appear: the form leaves by a document load, and a locator would wait for that load.
    const shown = await watchTexts(page);
    await submit.dblclick();
    await expect.poll(() => shown.saw('Submitting…'), { message: '"Submitting…" on the button' }).toBe(true);
    await expect.poll(() => shown.saw('Sent ✓'), { timeout: 30_000, message: '"Sent ✓" on the button' }).toBe(true);
    await expect
      .poll(() => shown.saw('✓ Submitted for approval. It arrived — nothing more to do.'), { message: 'it says it arrived' })
      .toBe(true);
    await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 30_000 });
    expect(posts.count, 'one submit left the phone').toBe(1);
    const edits = await db.customerEdit.findMany({ where: { customerId: customer.id, submittedById: user.id }, select: { id: true, state: true } });
    expect(edits.map((e) => e.state)).toEqual(['SUBMITTED']);
    await expectOneSet(edits[0]!.id, audience);
    // The form replaced itself: Back goes to where he was before it.
    await page.goBack();
    await expect(page).toHaveURL(/\/today$/);
    await page.goto(`/customers/${customer.id}/edit`);
    await expect(
      page.getByText(/^Your changes sent at \d{2}:\d{2} arrived and are waiting for approval\. You cannot submit again until they are decided\.$/)
    ).toBeVisible();
    await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toBeDisabled();
  });

  test('enrich: with no signal nothing is sent and nothing typed is lost; Try again sends it once (SM-SUBMIT-OFFLINE)', async ({ browser }) => {
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'E2');
    await resetLimits({ users: [user] });
    const ctx = await contextAs(browser, user, { device: 'phone' });
    const page = await ctx.newPage();
    const submit = await openEnrich(page, customer.id);
    const contact = world.name('Majid Al Shukaili');
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await ctx.setOffline(true);
    await submit.click();
    await expect(page.getByText(OFFLINE_MESSAGE, { exact: true })).toBeVisible();
    expect(await db.customerEdit.count({ where: { customerId: customer.id } }), 'nothing arrived').toBe(0);
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(contact);
    await ctx.setOffline(false);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 30_000 });
    const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true } });
    expect(edits.map((e) => e.state)).toEqual(['SUBMITTED']);
    await expectOneSet(edits[0]!.id, audience);
  });

  test('enrich: the reply is lost — "No answer"; Try again says "Already received" and nothing is written twice (SM-SUBMIT-NO-ANSWER)', async ({ browser }) => {
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'E3');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const submit = await openEnrich(page, customer.id);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Majid Al Shukaili'));
    const lost = await loseFirstReply(page, '/api/forms/customer-edit');
    await submit.click();
    await expect(page.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible({ timeout: 45_000 });
    const sid = String(lost.body?.submissionId ?? '');
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(lost.status, 'the server did answer — the phone never heard').toBe(200);
    expect(await db.customerEdit.count({ where: { submissionId: sid } }), 'it arrived').toBe(1);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText(ALREADY_RECEIVED)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sent ✓', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname, 'nothing more to send: it stays').toBe(`/customers/${customer.id}/edit`);
    const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, submissionId: true } });
    expect(edits).toEqual([{ id: expect.any(String), state: 'SUBMITTED', submissionId: sid }]);
    await expectOneSet(edits[0]!.id, audience);
  });

  test('enrich: signed out mid-form — told to sign in elsewhere, a photo picked then says so; after signing in, Retry upload and Try again work (SM-SESSION-EXPIRY-MIDFORM, AUTH-EXPIRED-MID-FORM)', async ({ browser }) => {
    test.setTimeout(300_000);
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'E4');
    const ip = world.ip(4);
    await resetLimits({ users: [user], ips: [ip] });
    const ctx = await contextAs(browser, user, { device: 'phone' });
    const page = await ctx.newPage();
    const submit = await openEnrich(page, customer.id);
    const [phone] = await world.allocPhones(1);
    await page.getByLabel('Primary phone *', { exact: true }).fill(phone!);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Hilal Al Busaidi'));
    if (hasR2) {
      // The branch too: address, a GPS fix and the shop photo (attached as soon as it is up).
      await page.getByLabel('Address *', { exact: true }).fill(world.name('Way 2817, Al Khuwair, Muscat'));
      await page.getByRole('button', { name: /^Capture GPS/ }).click();
      await expect(page.getByText(GPS_TEXT)).toBeVisible();
      const shop = photoSlot(page, 'Shop front');
      await pickFile(shop, pngFile('shop'));
      await expect(retakeOf(shop)).toBeVisible({ timeout: 120_000 });
    }
    await expect(submit).toBeEnabled();

    await ctx.clearCookies();
    await submit.click();
    await expect(page.getByText(SIGNED_OUT_MESSAGE, { exact: true })).toBeVisible();
    expect(await db.customerEdit.count({ where: { customerId: customer.id } }), 'nothing was sent').toBe(0);
    let sign: Locator | null = null;
    if (hasR2) {
      // Wave 1: a photo picked while signed out says to sign in (it said "Could not get upload URL.").
      sign = photoSlot(page, 'Signboard');
      await pickFile(sign, pngFile('sign'));
      await expect(sign.getByText(UPLOAD_SIGNED_OUT, { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(sign.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
    }

    await signInInAnotherTab(ctx, user, ip);
    if (sign) {
      await sign.getByRole('button', { name: 'Retry upload', exact: true }).click();
      await expect(retakeOf(sign)).toBeVisible({ timeout: 120_000 });
    }
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 30_000 });
    const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, fieldChanges: true } });
    expect(edits.map((e) => e.state)).toEqual(['SUBMITTED']);
    const fields = (edits[0]!.fieldChanges as Array<{ field: string }>).map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(['customer.primaryPhone', 'customer.contactPerson']));
    if (hasR2) {
      expect(fields).toEqual(expect.arrayContaining([`branch.${customer.branch.id}.address`, `branch.${customer.branch.id}.gpsLat`]));
      const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true, signboardPhotoId: true } });
      expect(b.shopPhotoId && b.signboardPhotoId, 'both photos are on the branch').toBeTruthy();
    }
    await expectOneSet(edits[0]!.id, audience);
    await page.goto('/work');
    await expect(page.locator('main li').filter({ hasText: customer.legalName })).toContainText('Awaiting approval');
  });

  test('enrich: signed out, a tap on Today goes to sign-in and then Today; the edit page brings back what he typed and the GPS point (SM-SESSION-EXPIRY-MIDFORM c)', async ({ browser }) => {
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'E5');
    const ip = world.ip(5);
    await resetLimits({ users: [user], ips: [ip] });
    const ctx = await contextAs(browser, user, { device: 'phone' });
    const page = await ctx.newPage();
    await openEnrich(page, customer.id);
    const contact = world.name('Nabil Al Zadjali');
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await page.getByRole('button', { name: /^Capture GPS/ }).click();
    await expect(page.getByText(GPS_TEXT)).toBeVisible();
    const key = `nmwc:draft:${user.id}:${customer.id}`;
    const phoneCopy = () => page.evaluate((k) => window.localStorage.getItem(k) ?? '', key);
    await expect.poll(phoneCopy, { message: 'the phone copy holds what he typed' }).toContain(contact);
    await expect.poll(phoneCopy, { message: 'the phone copy holds the GPS point' }).toContain('23.5881');

    await ctx.clearCookies();
    await tabBar(page).getByRole('link', { name: 'Today', exact: true }).click();
    await expect(page).toHaveURL(/\/login(\?|$)/);
    await signInViaUi(page, user.username, user.password, { ip });
    await expect(page, 'he lands on Today, not back on the form').toHaveURL(/\/today(\?|$)/);
    await page.goto(`/customers/${customer.id}/edit`);
    await expect(page.getByText('Restored a local draft from your last visit.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(contact);
    await expect(page.getByText(GPS_TEXT)).toBeVisible();
    expect(await db.customerEdit.count({ where: { customerId: customer.id } }), 'nothing was sent').toBe(0);
  });

  test('enrich: with the hourly submit bucket empty, Submit says "Slow down — try again in Ns." and sends nothing (SM-RATE-LIMITS)', async ({ browser }) => {
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'E6');
    await resetLimits({ users: [user] });
    await drainLimit(`edit:${user.id}`);
    try {
      const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
      const submit = await openEnrich(page, customer.id);
      await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Majid Al Shukaili'));
      await submit.click();
      await expect(page.getByText(/^Slow down — try again in \d+s\.$/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' }), 'a wait, not a retry').toHaveCount(0);
      expect(await db.customerEdit.count({ where: { customerId: customer.id } })).toBe(0);
    } finally {
      await resetLimits({ users: [user] });
    }
  });

  // ── new customer ────────────────────────────────────────────────────────────

  test('new customer: a double tap writes one request; "Submitting…" then "Sent ✓"; Back skips the form; reopened, it is in review (SM-SUBMIT-DOUBLE-TAP)', async ({ browser }) => {
    test.skip(!hasR2, 'the new-customer form needs three photos (R2)');
    test.setTimeout(360_000);
    const { user } = await addFieldSalesman(world, 'C1');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const posts = countRequests(page, '/api/forms/customer-create');
    const ch = await channelWithSubs();
    const [phone] = await world.allocPhones(1);
    const name = world.name('Al Noor Grocery');
    await page.goto('/today');
    await fillCreateForm(page, {
      legalName: name,
      crNumber: `CR${world.SFX}C1`,
      phone: phone!,
      contact: 'Saleh Al Rashdi',
      channelLabel: ch.label,
      day: OMAN_TODAY,
      address: world.name('Way 4410, Al Hail South, Seeb'),
    });
    await delayPosts(page, '/api/forms/customer-create', 1_500);
    await delayDocument(page, '/work', 2_500);
    // Read as they appear: the form leaves by a document load, and a locator would wait for that load.
    const shown = await watchTexts(page);
    await page.getByRole('button', { name: SUBMIT, exact: true }).dblclick();
    await expect.poll(() => shown.saw('Submitting…'), { message: '"Submitting…" on the button' }).toBe(true);
    await expect.poll(() => shown.saw('Sent ✓'), { timeout: 30_000, message: '"Sent ✓" on the button' }).toBe(true);
    await expect
      .poll(() => shown.saw('✓ Submitted for approval. It arrived — nothing more to do.'), { message: 'it says it arrived' })
      .toBe(true);
    await expect(page).toHaveURL(/\/work$/, { timeout: 30_000 });
    expect(posts.count, 'one submit left the phone').toBe(1);
    const reqs = await db.customerEdit.findMany({
      where: { submittedById: user.id, process: 'CREATE' },
      select: { id: true, state: true, customerDraft: { select: { legalName: true } } },
    });
    expect(reqs.map((r) => [r.state, r.customerDraft?.legalName])).toEqual([['SUBMITTED', name]]);
    await expectOneSet(reqs[0]!.id, audience);
    await page.goBack();
    await expect(page).toHaveURL(/\/today$/);
    await page.goto(`/customers/new?edit=${reqs[0]!.id}`);
    await expect(page.getByText(/^This request is in review — current step:/)).toContainText('SUPERVISOR');
    await expect(page.getByRole('button', { name: SUBMIT })).toHaveCount(0);
  });

  test('new customer: no signal, then signed out — nothing sent, nothing lost; after signing in, Try again sends it once (SM-SUBMIT-OFFLINE, AUTH-EXPIRED-MID-FORM)', async ({ browser }) => {
    test.skip(!hasR2, 'the new-customer form needs three photos (R2)');
    test.setTimeout(360_000);
    const { user } = await addFieldSalesman(world, 'C2');
    const ip = world.ip(6);
    await resetLimits({ users: [user], ips: [ip] });
    const ctx = await contextAs(browser, user, { device: 'phone' });
    const page = await ctx.newPage();
    const ch = await channelWithSubs();
    const [phone] = await world.allocPhones(1);
    const name = world.name('Al Huda Stores');
    await fillCreateForm(page, {
      legalName: name,
      crNumber: `CR${world.SFX}C2`,
      phone: phone!,
      contact: 'Khamis Al Mamari',
      channelLabel: ch.label,
      day: OMAN_TODAY,
      address: world.name('Way 1520, Bowsher'),
    });
    const submit = page.getByRole('button', { name: SUBMIT, exact: true });
    const creates = () => db.customerEdit.count({ where: { submittedById: user.id, process: 'CREATE' } });

    await ctx.setOffline(true);
    await submit.click();
    await expect(page.getByText(OFFLINE_MESSAGE, { exact: true })).toBeVisible();
    expect(await creates()).toBe(0);
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(name);
    await ctx.setOffline(false);

    await ctx.clearCookies();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText(SIGNED_OUT_MESSAGE, { exact: true })).toBeVisible();
    expect(await creates()).toBe(0);
    await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(name);

    await signInInAnotherTab(ctx, user, ip);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page).toHaveURL(/\/work$/, { timeout: 30_000 });
    const reqs = await db.customerEdit.findMany({ where: { submittedById: user.id, process: 'CREATE' }, select: { id: true, state: true } });
    expect(reqs.map((r) => r.state)).toEqual(['SUBMITTED']);
    await expectOneSet(reqs[0]!.id, audience);
  });

  test('new customer: the reply is lost and he reloads — "Your last send arrived after all", no call to rebuild; the receipt lookup is null before and the receipt after (SM-SUBMIT-NO-ANSWER)', async ({ browser }) => {
    test.skip(!hasR2, 'the new-customer form needs three photos (R2)');
    test.setTimeout(360_000);
    const { user } = await addFieldSalesman(world, 'C3');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const ch = await channelWithSubs();
    const [phone] = await world.allocPhones(1);
    await fillCreateForm(page, {
      legalName: world.name('Al Saada Mart'),
      crNumber: `CR${world.SFX}C3`,
      phone: phone!,
      contact: 'Mubarak Al Habsi',
      channelLabel: ch.label,
      day: OMAN_TODAY,
      address: world.name('Way 3307, Ruwi'),
    });
    const lookup = async (sid: string) => (await page.request.get(`/api/forms/customer-create?submissionId=${sid}`)).json() as Promise<unknown>;
    let before: unknown = 'not asked';
    const lost = await loseFirstReply(page, '/api/forms/customer-create', async (body) => {
      before = await lookup(String(body?.submissionId ?? ''));
    });
    await page.getByRole('button', { name: SUBMIT, exact: true }).click();
    await expect(page.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible({ timeout: 45_000 });
    expect(lost.error).toBeNull();
    const sid = String(lost.body?.submissionId ?? '');
    expect(before, 'before the send, the id is unknown').toEqual({ ok: true, data: null });
    expect(lost.status).toBe(200);
    const landed = await db.customerEdit.findMany({ where: { submissionId: sid }, select: { id: true, state: true } });
    expect(landed.map((e) => e.state), 'it arrived').toEqual(['SUBMITTED']);

    await page.reload();
    await expect(
      page.getByText(/^Your last send arrived after all\. ✓ Already received at \d{2}:\d{2} — it is waiting for approval\. Nothing more to do\.$/)
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/add them again/)).toHaveCount(0);
    expect(await lookup(sid)).toMatchObject({ ok: true, data: { editId: landed[0]!.id, state: 'SUBMITTED' } });
    expect(await db.customerEdit.count({ where: { submittedById: user.id, process: 'CREATE' } }), 'never twice').toBe(1);
    await expectOneSet(landed[0]!.id, audience);
  });

  // ── close a shop ─────────────────────────────────────────────────────────────

  test('close: a double tap on "Submit closure" writes one request; reopened, the edit page says it waits (SM-SUBMIT-DOUBLE-TAP)', async ({ browser }) => {
    test.skip(!hasR2, 'the closure needs a fresh evidence photo (R2)');
    test.setTimeout(300_000);
    const { user, customer } = await addFieldSalesman(world, 'X1');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const posts = countRequests(page, '/api/forms/branch-close');
    const { form, submit } = await openCloseForm(page, customer.id, world.name('Shop shut for good, shutters welded'));
    await delayPosts(page, '/api/forms/branch-close', 1_500);
    await submit.dblclick();
    await expect(form.getByRole('button', { name: 'Submitting…', exact: true })).toBeVisible();
    await expect(page.getByText('✓ Closure sent for approval.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Mark this branch closed' })).toHaveCount(0);
    // The close form has no click lock of its own (the edit and create forms do): a second
    // tap that got through would carry the same submission id and be answered from the
    // first. What must hold is one request and one set of notifications.
    test.info().annotations.push({ type: 'close submits sent', description: String(posts.count) });
    expect(posts.count).toBeGreaterThanOrEqual(1);
    const reqs = await db.customerEdit.findMany({
      where: { branchId: customer.branch.id, submittedById: user.id },
      select: { id: true, state: true, target: true, isReactivation: true },
    });
    expect(reqs.map((r) => [r.state, r.target, r.isReactivation])).toEqual([['SUBMITTED', 'BRANCH', false]]);
    await expectOneSet(reqs[0]!.id, audience);
    await page.goto(`/customers/${customer.id}/edit`);
    await expect(
      page.getByText(/^Your request to mark a branch closed, sent at \d{2}:\d{2}, is waiting for review\. You cannot submit changes until it is decided\.$/)
    ).toBeVisible();
    await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toBeDisabled();
  });

  test('close: with no signal nothing is sent and the reason stays; Try again sends it once (SM-SUBMIT-OFFLINE)', async ({ browser }) => {
    test.skip(!hasR2, 'the closure needs a fresh evidence photo (R2)');
    test.setTimeout(300_000);
    const { user, customer } = await addFieldSalesman(world, 'X2');
    await resetLimits({ users: [user] });
    const ctx = await contextAs(browser, user, { device: 'phone' });
    const page = await ctx.newPage();
    const reason = world.name('Owner moved the shop to Barka');
    const { form, submit } = await openCloseForm(page, customer.id, reason);
    await ctx.setOffline(true);
    await submit.click();
    await expect(form.getByText(OFFLINE_MESSAGE, { exact: true })).toBeVisible();
    expect(await db.customerEdit.count({ where: { branchId: customer.branch.id } })).toBe(0);
    await expect(form.getByPlaceholder('Shop is permanently closed, signage removed.')).toHaveValue(reason);
    await ctx.setOffline(false);
    await form.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('✓ Closure sent for approval.', { exact: true })).toBeVisible({ timeout: 30_000 });
    const reqs = await db.customerEdit.findMany({ where: { branchId: customer.branch.id }, select: { id: true, state: true } });
    expect(reqs.map((r) => r.state)).toEqual(['SUBMITTED']);
    await expectOneSet(reqs[0]!.id, audience);
  });

  test('close: the reply is lost — Try again says "Already received" and the form closes (SM-SUBMIT-NO-ANSWER)', async ({ browser }) => {
    test.skip(!hasR2, 'the closure needs a fresh evidence photo (R2)');
    test.setTimeout(300_000);
    const { user, customer } = await addFieldSalesman(world, 'X3');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const { form, submit } = await openCloseForm(page, customer.id, world.name('Building demolished'));
    const lost = await loseFirstReply(page, '/api/forms/branch-close');
    await submit.click();
    await expect(form.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible({ timeout: 45_000 });
    const sid = String(lost.body?.submissionId ?? '');
    expect(await db.customerEdit.count({ where: { submissionId: sid } }), 'it arrived').toBe(1);
    await form.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText(ALREADY_RECEIVED)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Mark this branch closed' }), 'the form closes').toHaveCount(0);
    const reqs = await db.customerEdit.findMany({ where: { branchId: customer.branch.id }, select: { id: true, submissionId: true } });
    expect(reqs).toEqual([{ id: expect.any(String), submissionId: sid }]);
    await expectOneSet(reqs[0]!.id, audience);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Photos on a weak link, real camera files, the photo rate limit (R2)
// ════════════════════════════════════════════════════════════════════════════

test.describe('salesman phone: photos on a weak link and real camera files (SM-PHOTO-WEAK-NETWORK, UPLOAD-PHONE-REAL-PHOTOS)', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.skip(!hasR2, 'photo uploads need R2');

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await createWorld('spp', {
      regions: [{ key: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
      ],
    });
  });

  test.afterEach(async () => {
    if (world) await adoptSalesmanWork(world, since);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (!world) return;
    await adoptSalesmanWork(world, since);
    await dropDraftBuckets(world);
    await world.cleanup();
  });

  const shopPhotoOf = async (branchId: string) =>
    (await db.branch.findUniqueOrThrow({ where: { id: branchId }, select: { shopPhotoId: true } })).shopPhotoId;

  test('every PUT dropped: three silent tries, then "Retry upload"; Submit is not held; once the link is back the kept photo goes up without a new pick', async ({ browser }) => {
    test.setTimeout(240_000);
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'P1');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const submit = await openEnrich(page, customer.id);
    const presigns = countRequests(page, '/api/photos/presign');
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Majid Al Shukaili'));
    await expect(submit).toBeEnabled();

    await page.route(R2_HOST, (route) => route.abort('failed'));
    const shop = photoSlot(page, 'Shop front');
    await pickFile(shop, pngFile('shop'));
    await expect(submit, 'held while the photo is going up').toBeDisabled();
    await expect(page.getByText(PHOTO_UPLOADING_MESSAGE, { exact: true })).toBeVisible();
    // f960612: in the app's words, not the XHR's "Network error".
    await expect(shop.getByText(UPLOAD_NO_CONNECTION, { exact: true })).toBeVisible({ timeout: 60_000 });
    const retry = shop.getByRole('button', { name: 'Retry upload', exact: true });
    await expect(retry).toBeVisible();
    expect(presigns.count, 'three tries, each on a URL of its own').toBe(3);
    await expect(submit, 'the failed slot is no longer busy').toBeEnabled();
    await expect(page.getByText(PHOTO_UPLOADING_MESSAGE, { exact: true })).toHaveCount(0);
    expect(await shopPhotoOf(customer.branch.id)).toBeNull();

    await page.unroute(R2_HOST);
    await retry.click();
    await expect(retakeOf(shop)).toBeVisible({ timeout: 90_000 });
    expect(presigns.count, 'one more try, with the photo it kept').toBe(4);
    const atts = await db.attachment.findMany({ where: { capturedById: user.id, deletedAt: null }, select: { id: true } });
    expect(atts).toHaveLength(1);
    expect(await shopPhotoOf(customer.branch.id)).toBe(atts[0]!.id);
  });

  test('the attach gets no answer: "attaching it got no answer"; Retry sends only the attach; one Attachment, on the slot', async ({ browser }) => {
    const { user, customer } = await addFieldSalesman(world, 'P2');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    await openEnrich(page, customer.id);
    const presigns = countRequests(page, '/api/photos/presign');
    const finalizes = countRequests(page, '/api/photos/finalize');
    const attaches = countRequests(page, '/api/photos/attach');
    await loseFirstReply(page, '/api/photos/attach');
    const shop = photoSlot(page, 'Shop front');
    await pickFile(shop, pngFile('shop'));
    await expect(shop.getByText(ATTACH_NO_ANSWER, { exact: true })).toBeVisible({ timeout: 90_000 });
    await shop.getByRole('button', { name: 'Retry upload', exact: true }).click();
    await expect(retakeOf(shop)).toBeVisible({ timeout: 60_000 });
    expect([presigns.count, finalizes.count, attaches.count], 'presign, finalize, attach').toEqual([1, 1, 2]);
    const atts = await db.attachment.findMany({ where: { capturedById: user.id }, select: { id: true } });
    expect(atts, 'no duplicate').toHaveLength(1);
    expect(await shopPhotoOf(customer.branch.id)).toBe(atts[0]!.id);
  });

  test('a real camera JPEG on a slow phone (50 kbps up, 400 ms, 4× CPU): compressed to ≤1920 px and <3 MB, progress shown, Submit held, it arrives', async ({ browser }) => {
    test.setTimeout(600_000);
    test.skip(FULL_GATE, CORE_ONLY);
    const { user, customer } = await addFieldSalesman(world, 'P3');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    const submit = await openEnrich(page, customer.id);
    const camera = await cameraJpeg(page, 4000, 3000);
    test.info().annotations.push({ type: 'camera JPEG', description: `${camera.length} bytes, 4000×3000` });
    expect(jpegSize(camera)).toEqual({ width: 4000, height: 3000 });
    expect(camera.length, 'bigger than the 3 MB upload cap as it leaves the camera').toBeGreaterThan(3 * 1024 * 1024);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Majid Al Shukaili'));
    await expect(submit).toBeEnabled();

    const cdp = await throttle(page, { upKbps: 50, downKbps: 400, latencyMs: 400, cpu: 4 });
    const shop = photoSlot(page, 'Shop front');
    try {
      await pickFile(shop, { name: 'IMG_20261007_101500.jpg', mimeType: 'image/jpeg', buffer: camera });
      await expect(submit, 'held while the photo is going up').toBeDisabled();
      await expect(page.getByText(PHOTO_UPLOADING_MESSAGE, { exact: true })).toBeVisible();
      await expect(shop.getByText(/^Uploading… \d+%$/)).toBeVisible({ timeout: 120_000 });
      // It finishes on its own: no "Upload failed", no Retry, while the bytes move.
      await expect(retakeOf(shop)).toBeVisible({ timeout: 480_000 });
    } finally {
      await unthrottle(cdp);
    }
    await expect(shop.getByRole('button', { name: 'Retry upload' })).toHaveCount(0);
    await expect(submit).toBeEnabled();
    const att = await db.attachment.findFirstOrThrow({
      where: { capturedById: user.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, mimeType: true, bytes: true },
    });
    test.info().annotations.push({ type: 'uploaded', description: `${att.bytes} bytes` });
    expect(att.mimeType).toBe('image/jpeg');
    expect(att.bytes).toBeLessThan(3 * 1024 * 1024);
    const served = await fetchAs(page, `/api/photos/${att.id}`);
    expect(served.status).toBe(200);
    const size = jpegSize(served.body);
    expect(size, 'a JPEG').not.toBeNull();
    expect(Math.max(size!.width, size!.height), 'long side').toBeLessThanOrEqual(1920);
    expect(await shopPhotoOf(customer.branch.id)).toBe(att.id);
  });

  test('a PNG screenshot uploads as a JPEG; a PDF is refused as not an image and nothing is uploaded', async ({ browser }) => {
    const { user, customer } = await addFieldSalesman(world, 'P4');
    await resetLimits({ users: [user] });
    const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
    await openEnrich(page, customer.id);
    const shop = photoSlot(page, 'Shop front');
    await pickFile(shop, pngFile('Screenshot_20261007-101500'));
    await expect(retakeOf(shop)).toBeVisible({ timeout: 90_000 });
    const atts = await db.attachment.findMany({ where: { capturedById: user.id }, select: { id: true, mimeType: true } });
    expect(atts.map((a) => a.mimeType)).toEqual(['image/jpeg']);
    expect(await shopPhotoOf(customer.branch.id)).toBe(atts[0]!.id);

    const sign = photoSlot(page, 'Signboard');
    await pickFile(sign, { name: 'guarantee.pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
    await expect(sign.getByText('That file is not an image.', { exact: true })).toBeVisible();
    expect(await db.attachment.count({ where: { capturedById: user.id } }), 'the PDF never left the phone').toBe(1);
  });

  test('with the photo bucket empty the slot counts down, then uploads by itself (SM-RATE-LIMITS, wave 1)', async ({ browser }) => {
    // Was a BUG (run 8 Oct), fixed by fa80408: a refused presign always answers 31–60 s (lib/rate-limit.ts debits a
    // refused call to −1 token), more than the 30 s PhotoCaptureSlot waited out, so the countdown never ran. The slot
    // now waits out up to 60 s, counting down, then sends the photo itself.
    test.setTimeout(240_000);
    const { user, customer } = await addFieldSalesman(world, 'P6');
    await resetLimits({ users: [user] });
    await drainLimit(`photo:${user.id}`);
    try {
      const page = await (await contextAs(browser, user, { device: 'phone' })).newPage();
      await openEnrich(page, customer.id);
      const shop = photoSlot(page, 'Shop front');
      await pickFile(shop, pngFile('shop'));
      const countdown = shop.getByRole('status').filter({ hasText: RATE_WAIT });
      await expect(countdown).toBeVisible({ timeout: 30_000 });
      const left = Number(/in (\d+) s/.exec((await countdown.textContent()) ?? '')?.[1]);
      expect(left, 'the wait is counted down, and it is at most a minute').toBeGreaterThan(0);
      expect(left).toBeLessThanOrEqual(60);
      await expect(retakeOf(shop)).toBeVisible({ timeout: 120_000 });
      await expect(shop.getByText(/then tap Retry upload/), 'never told to wait and tap Retry upload himself').toHaveCount(0);
      expect(await shopPhotoOf(customer.branch.id)).not.toBeNull();
    } finally {
      await resetLimits({ users: [user] });
    }
  });
});
