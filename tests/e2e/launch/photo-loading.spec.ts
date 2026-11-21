/**
 * PHOTO LOADING — the photo route's HEAD and its store connection, and the
 * paced loading of a page with more than 40 photos (branch
 * claude/large-customer-photos, spec section 6, the launch cases):
 *
 *   1. HEAD /api/photos/<id> is a view without a body: 200, the GET's five
 *      serving headers, one more PHOTO_VIEW row (@desktop; 1 upload);
 *   2. the photo store's connection comes back after every HEAD: 55 HEAD in a
 *      row (the store client has 50 connections; the route before this branch
 *      kept one per HEAD for good, so the 51st failed), then a full GET and a
 *      new upload still work (@exclusive: its own server; 2 uploads);
 *   3. a customer profile with 41 photos loads them through the paced queue:
 *      placeholders first, never more than 6 at a time, the same address with
 *      no query, one photo that fails four times ends "Not loaded" with
 *      "1 photo did not load." and "Try again", and one click loads it; its
 *      retries start 1x, 2x and 4x PACE_MS apart, and the paced line "Showing
 *      … photos." shows while it waits;
 *   3b. the same profile with one EARLY photo failing once: every photo still
 *      waiting behind it starts paced, at least about PACE_MS apart, and the
 *      retry goes last (the case above checks only one photo's own retries);
 *   4. the Data Steward's edit form of that customer: every slot's photo loads
 *      through the queue; with one photo that never loads, its slot says it is
 *      still attached, stays filled, and a text change still submits;
 *   5. an update request's approval page for that customer is queued too.
 *   (3 to 5: @desktop; NO upload. The 41 photo rows have no object in the
 *   store and the test answers every photo request itself with page.route, so
 *   neither the app server nor the store sees one: spec amendment M3.)
 *   Start times are read in the page (support/photo-queue-helpers.ts
 *   recordPhotoEvents), not when the route hears a request.
 *
 * The 35-shop case of the spec (about 71 real uploads) is left out under M3.
 * The zero-upload method above covers what it would show on the three pages
 * (all photos loaded, the paced line, Try again). What it cannot show is the
 * real limiter's 429s driving the queue: page.route answers every photo
 * request, and with real photos the case needs the uploads M3 forbids.
 * A 502 answered by page.route makes Chrome log "Failed to load resource";
 * that line is not one the console check fails on (support/checks.ts
 * FATAL_CONSOLE), so nothing is muted here.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts photo-loading --project=phone --project=desktop
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts photo-loading --project=exclusive --workers=1
 */
import { expect, test } from '@playwright/test';
import {
  auditFor,
  contextAs,
  createWorld,
  db,
  hasR2,
  installLaunchHooks,
  notRunHere,
  requireLaunchEnv,
  seedUpdateEdit,
  uploadPhotoViaApi,
  type SeededPhoto,
  type World,
} from './support';
import {
  MAX_FAILURES,
  MAX_IN_FLIGHT,
  NOT_LOADED,
  PACE_MS,
  PHOTO_QUEUE_FROM,
  REMOTE_PHOTO_FAILED_MESSAGE,
  TRY_AGAIN,
  answerPhotos,
  expectAllPhotos,
  liveSlotOf,
  loadedImages,
  pacedSentence,
  photoEvents,
  photoStates,
  photosNotLoadedText,
  recordPhotoEvents,
  gapsAfter,
  seedManyPhotoCustomer,
  statusSentence,
} from './support/photo-queue-helpers';
import {
  branchSection,
  editsOn,
  expectMissing,
  photoSlot,
  slowNextDocument,
  submitButton,
  waitHydrated,
  watchForText,
} from './support/update-flow-helpers';

const R2_SKIP = 'R2 is not configured: the photo route reads the photo store';
/** The five headers HEAD must share with GET (app/api/photos/[id]/route.ts). */
const SERVING_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'content-length', 'etag'] as const;
/**
 * The starts after a failure are PACE_MS apart, the pace doubling while
 * photos started paced keep failing. Gaps are read in the page (the moment
 * each try's <img> is added), so a route event Playwright delivers late does
 * not shorten one; 100 ms of slack is left for the page's own rendering.
 */
const PACED_GAP_MIN_MS = PACE_MS - 100;

/** A small world: one salesman whose shop has one real photo in the store. */
async function onePhotoWorld(tag: string): Promise<World> {
  return createWorld(tag, {
    regions: [{ key: 'R1' }],
    routes: [{ key: 'A', region: 'R1' }],
    users: [{ key: 'SA', role: 'SALESMAN', route: 'A' }],
    customers: [{ key: 'PIC', phone: true, contact: 'Rashid Al Amri', branches: [{ key: 'S', route: 'A', photos: ['SHOP'] }] }],
  });
}

// ── 1. HEAD ───────────────────────────────────────────────────────────────────

test.describe('photo loading: HEAD of a photo', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    if (!hasR2) return;
    world = await onePhotoWorld('phd');
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test.beforeEach(() => {
    notRunHere(!hasR2, R2_SKIP);
  });

  test("HEAD of a photo answers 200 with the GET's headers and no body, and is recorded as one more view", async ({ browser }) => {
    const sa = world.user('SA');
    const shop = world.customer('PIC').photos.find((p) => p.wire === 'SHOP')!;
    const views = async () => (await auditFor({ entityId: shop.id, action: 'PHOTO_VIEW' })).length;
    const ctx = await contextAs(browser, sa, { device: 'desktop' });
    expect(await views(), 'no view before the test').toBe(0);

    const get = await ctx.request.get(`/api/photos/${shop.id}`, { failOnStatusCode: false });
    expect(get.status()).toBe(200);
    expect(Buffer.compare(await get.body(), shop.bytes), 'the GET sends the stored bytes').toBe(0);
    const afterGet = await views();
    expect(afterGet, 'the GET is one view').toBe(1);

    const head = await ctx.request.head(`/api/photos/${shop.id}`, { failOnStatusCode: false });
    expect(head.status()).toBe(200);
    expect((await head.body()).length, 'HEAD sends no body').toBe(0);
    const g = get.headers();
    const h = head.headers();
    for (const name of SERVING_HEADERS) {
      expect(g[name], `GET ${name}`).toBeTruthy();
      expect(h[name], `HEAD ${name}`).toBe(g[name]);
    }
    expect(g['content-length']).toBe(String(shop.size));

    expect(await views(), 'the HEAD is exactly one more view').toBe(afterGet + 1);
    const rows = await auditFor({ entityId: shop.id, action: 'PHOTO_VIEW' });
    expect(rows.map((r) => r.actorId)).toEqual([sa.id, sa.id]);
    // Written before the answer, never after it: still one row for the HEAD a moment later.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await views()).toBe(afterGet + 1);
  });
});

// ── 2. the store connection after HEAD ───────────────────────────────────────

test.describe('photo loading: the photo store connection after HEAD', { tag: ['@exclusive'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  /** More than the store client's 50 connections; with the GET, 56 photo requests: inside the limiter's 60. */
  const HEADS = 55;
  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    if (!hasR2) return;
    world = await onePhotoWorld('pcx');
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test.beforeEach(() => {
    notRunHere(!hasR2, R2_SKIP);
  });

  test('55 HEAD requests in a row each give the store connection back: every one 200, then a full GET and a new upload still work', async ({ browser }) => {
    test.setTimeout(300_000);
    const shop = world.customer('PIC').photos.find((p) => p.wire === 'SHOP')!;
    const ctx = await contextAs(browser, world.user('SA'), { device: 'desktop' });

    const statuses: Array<number | string> = [];
    for (let i = 0; i < HEADS; i++) {
      const s = await ctx.request
        .head(`/api/photos/${shop.id}`, { failOnStatusCode: false, timeout: 45_000 })
        .then((r) => r.status())
        .catch((e: Error) => `no answer (${e.name})`);
      statuses.push(s);
      if (s !== 200) break; // a held connection fails every later one too: stop here
    }
    expect(
      statuses.findIndex((s) => s !== 200),
      `the first HEAD that did not answer 200 (1-based: +1); answers: ${statuses.join(',')}`
    ).toBe(-1);
    expect(statuses).toHaveLength(HEADS);

    const get = await ctx.request.get(`/api/photos/${shop.id}`, { failOnStatusCode: false, timeout: 45_000 });
    expect(get.status()).toBe(200);
    const body = await get.body();
    expect(body.length, 'every byte').toBe(shop.size);
    expect(Buffer.compare(body, shop.bytes)).toBe(0);

    // finalize reads the store too (HeadObject): a pinned pool answers 503 there.
    const page = await ctx.newPage();
    const up = await uploadPhotoViaApi(page, world, { kind: 'SHOP' });
    expect(up.deduped).toBe(false);
    expect(await db.attachment.count({ where: { id: up.attachmentId, deletedAt: null } })).toBe(1);
  });
});

// ── 3 and 4. a customer with 41 photos ───────────────────────────────────────

test.describe('photo loading: a customer with more than 40 photos', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  /** 20 shops × (shop + signboard) + the CR document = 41: one more than PHOTO_QUEUE_FROM. */
  const SHOPS = 20;
  const TOTAL = SHOPS * 2 + 1;
  let world: World;
  let customerId: string;
  let photos: SeededPhoto[];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    expect(TOTAL).toBeGreaterThan(PHOTO_QUEUE_FROM);
    world = await createWorld('plq', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'SA', role: 'SALESMAN', route: 'A' },
        { key: 'STW', role: 'STEWARD' },
        { key: 'MGR', role: 'MANAGER', regions: ['R1'] },
      ],
    });
    ({ customerId, photos } = await seedManyPhotoCustomer(world, {
      key: 'BIG',
      shops: SHOPS,
      route: 'A',
      capturedBy: 'SA',
      contact: 'Yaqoob Al Farsi',
    }));
    expect(photos).toHaveLength(TOTAL);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('a profile with 41 photos loads them paced: placeholders first, at most 6 at a time, one photo failing 4 times shows "Not loaded" and "Try again" loads it', async ({ browser }) => {
    test.setTimeout(180_000);
    const started = Date.now();
    const page = await (await contextAs(browser, world.user('STW'), { device: 'desktop' })).newPage();
    const answered = await answerPhotos(page, photos, { delayMs: 150, hold: true, fail: { times: MAX_FAILURES } });
    await recordPhotoEvents(page);

    // The server renders a placeholder per photo and no photo address at all. (Not 'load':
    // with an <img> per photo that load would wait for the held requests.)
    const res = await page.goto(`/customers/${customerId}`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(200);
    const html = (await res!.text()) ?? '';
    expect(html.match(/data-photo-state="waiting"/g) ?? [], 'a placeholder per photo in the server HTML').toHaveLength(TOTAL);
    expect(html).not.toContain('src="/api/photos/');

    // Held at the route: the queue starts 6 and no more; the rest wait as placeholders with no <img>.
    await expect.poll(() => answered.requests.length, { timeout: 60_000 }).toBe(MAX_IN_FLIGHT);
    await page.waitForTimeout(1_000);
    expect(answered.requests.length, 'nothing more starts while 6 are in flight').toBe(MAX_IN_FLIGHT);
    await expect(page.locator('[data-photo-state="loading"]')).toHaveCount(MAX_IN_FLIGHT);
    await expect(page.locator('img[src^="/api/photos/"]')).toHaveCount(MAX_IN_FLIGHT);
    const waiting = page.locator('[data-photo-state="waiting"]');
    await expect(waiting).toHaveCount(TOTAL - MAX_IN_FLIGHT);
    expect(await waiting.evaluateAll((els) => els.map((e) => `${e.tagName} ${e.getAttribute('role')} ${e.querySelectorAll('img').length}`))).toEqual(
      Array(TOTAL - MAX_IN_FLIGHT).fill('SPAN img 0')
    );
    answered.release();

    // While the failing photo waits for its next try, the paced line shows; it goes when the photo gives up.
    await expect(pacedSentence(page, TOTAL)).toBeVisible({ timeout: 60_000 });
    expect(answered.firstFailureAt(), 'the paced line shows only after a failure').not.toBeNull();

    // The last photo asked for fails 4 times: its tile gives up, the status line says so.
    const failed = page.locator('[data-photo-state="failed"]');
    await expect(failed).toHaveCount(1, { timeout: 60_000 });
    await expect(failed).toHaveText(NOT_LOADED);
    const failId = answered.failId()!;
    expect(failId).toBeTruthy();
    await expect(statusSentence(page, photosNotLoadedText(1))).toBeVisible();
    await expect(page.getByRole('button', { name: TRY_AGAIN, exact: true })).toBeVisible();
    await expect(pacedSentence(page, TOTAL)).toHaveCount(0);
    await expect(page.locator(`img[src="/api/photos/${failId}"]`)).toHaveCount(0);
    expect((await photoStates(page)).filter((s) => s === 'loaded'), 'every other photo is loaded').toHaveLength(TOTAL - 1);
    const shown = await loadedImages(page);
    expect(shown.map((i) => i.src).sort()).toEqual(photos.filter((p) => p.id !== failId).map((p) => `/api/photos/${p.id}`).sort());
    expect(shown.every((i) => i.state === 'loaded' && i.width > 0), 'each a decoded picture').toBe(true);

    const failRequests = () => answered.requests.filter((r) => r.id === failId);
    expect(failRequests().map((r) => r.status)).toEqual(Array(MAX_FAILURES).fill(502));
    const gotUpToHere = answered.requests.length;
    expect(gotUpToHere).toBe(TOTAL - 1 + MAX_FAILURES);

    // One click: the photo is asked for again (answered 200 now) and the status line goes.
    await page.getByRole('button', { name: TRY_AGAIN, exact: true }).click();
    await expectAllPhotos(page, TOTAL, 'loaded');
    await expect(page.getByRole('button', { name: TRY_AGAIN, exact: true })).toHaveCount(0);
    await expect(statusSentence(page, photosNotLoadedText(1))).toHaveCount(0);
    await expect(page.locator(`img[src="/api/photos/${failId}"][data-photo-state="loaded"]`)).toHaveCount(1);

    // What the page asked for, all of it.
    const r = answered.requests;
    expect(r.filter((x) => x.id === null || x.search !== ''), 'every request is /api/photos/<id> with no query').toEqual([]);
    expect(r.every((x) => /^\/api\/photos\/[^/?]+$/.test(x.path))).toBe(true);
    expect(answered.maxInFlight(), 'never more than 6 in flight').toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(failRequests().map((x) => x.status)).toEqual([...Array(MAX_FAILURES).fill(502), 200]);
    for (const p of photos) expect(answered.okCount(p.id), `200s for ${p.id}`).toBe(1);
    expect(r).toHaveLength(TOTAL + MAX_FAILURES);

    // The pace, as the page saw it: every try of the failing photo is a new <img>; the first
    // failure paces the queue at PACE_MS, and each failure of a try started paced doubles it.
    const ev = await photoEvents(page);
    expect(ev.starts, 'one <img> per request').toHaveLength(r.length);
    const firstError = ev.errors.find((e) => e.id === failId);
    expect(firstError, 'the page saw the failing photo fail').toBeTruthy();
    expect(ev.errors.map((e) => e.id), 'only the failing photo failed').toEqual(Array(MAX_FAILURES).fill(failId));
    const gaps = gapsAfter(ev.starts, firstError!.t);
    const paceMsg = `starts after the first failure, ms apart: ${gaps.join(', ')} (pace ${PACE_MS})`;
    expect(gaps.length, 'the three retries and the one after Try again').toBe(MAX_FAILURES);
    // Retries 2, 3 and 4 at 1x, 2x and 4x the pace; Try again puts the pace back to PACE_MS.
    expect(gaps[0]!, paceMsg).toBeGreaterThanOrEqual(PACED_GAP_MIN_MS);
    expect(gaps[1]!, paceMsg).toBeGreaterThanOrEqual(2 * PACE_MS - 100);
    expect(gaps[2]!, paceMsg).toBeGreaterThanOrEqual(4 * PACE_MS - 100);
    expect(gaps[3]!, paceMsg).toBeGreaterThanOrEqual(PACED_GAP_MIN_MS);
    test.info().annotations.push({ type: 'paced', description: `gaps after the first failure ${gaps.join(', ')} ms; test ${Date.now() - started} ms` });
  });

  test('after one early failure, the photos still waiting start one at a time, at least about a second apart, and the paced line shows meanwhile', async ({ browser }) => {
    test.setTimeout(180_000);
    const started = Date.now();
    // The photo that fails once is the AT-th asked for: about 7 photos still wait behind it,
    // so the paced part stays near 9 s (7 fresh starts and the retry, PACE_MS apart).
    const AT = TOTAL - 12;
    const page = await (await contextAs(browser, world.user('STW'), { device: 'desktop' })).newPage();
    const answered = await answerPhotos(page, photos, { delayMs: 150, fail: { times: 1, at: AT, alone: true } });
    await recordPhotoEvents(page);
    await page.goto(`/customers/${customerId}`);

    await expect(pacedSentence(page, TOTAL)).toBeVisible({ timeout: 60_000 });
    await expectAllPhotos(page, TOTAL, 'loaded');
    await expect(pacedSentence(page, TOTAL)).toHaveCount(0);
    await expect(page.getByRole('button', { name: TRY_AGAIN, exact: true })).toHaveCount(0);
    await expect(page.locator('[data-photo-state="failed"]')).toHaveCount(0);

    const failId = answered.failId()!;
    expect(failId).toBeTruthy();
    const r = answered.requests;
    expect(r.filter((x) => x.id === null || x.search !== ''), 'every request is /api/photos/<id> with no query').toEqual([]);
    expect(answered.maxInFlight(), 'never more than 6 in flight').toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(r.filter((x) => x.id === failId).map((x) => x.status)).toEqual([502, 200]);
    for (const p of photos) expect(answered.okCount(p.id), `200s for ${p.id}`).toBe(1);
    expect(r).toHaveLength(TOTAL + 1);

    const ev = await photoEvents(page);
    expect(ev.starts, 'one <img> per request').toHaveLength(r.length);
    expect(ev.errors.map((e) => e.id), 'only the chosen photo failed, once').toEqual([failId]);
    const failedAt = ev.errors[0]!.t;
    const after = ev.starts.filter((s) => s.t > failedAt).sort((a, b) => a.t - b.t);
    // The failing photo and the 5 that filled the other slots started before the failure:
    // every other photo waits, and starts after it, paced.
    const fresh = after.filter((s) => s.id !== failId);
    expect(fresh.map((s) => s.id).sort(), 'the photos that were still waiting').toEqual(
      photos.map((p) => p.id).filter((id) => !ev.starts.some((s) => s.id === id && s.t <= failedAt)).sort()
    );
    expect(fresh.length, 'photos still waiting when the failure came').toBe(TOTAL - AT - (MAX_IN_FLIGHT - 1));
    // The retry goes to the back of the line: it starts after every one of them.
    expect(after.at(-1)!.id, 'the retry starts last').toBe(failId);
    const gaps = gapsAfter(ev.starts, failedAt);
    expect(gaps, 'a gap before each start after the failure').toHaveLength(after.length);
    expect(Math.min(...gaps), `starts after the failure, ms apart: ${gaps.join(', ')} (pace ${PACE_MS})`).toBeGreaterThanOrEqual(PACED_GAP_MIN_MS);
    test.info().annotations.push({ type: 'paced', description: `fresh starts after the failure ${fresh.length}; gaps ${gaps.join(', ')} ms; test ${Date.now() - started} ms` });
  });

  test("the Steward's edit form of that customer: every slot's photo loads through the queue", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await (await contextAs(browser, world.user('STW'), { device: 'desktop' })).newPage();
    const answered = await answerPhotos(page, photos, { delayMs: 150 });
    await page.goto(`/customers/${customerId}/edit`);
    await waitHydrated(page);
    await expectAllPhotos(page, TOTAL, 'loaded');
    const shown = await loadedImages(page);
    expect(shown.map((i) => i.src).sort()).toEqual(photos.map((p) => `/api/photos/${p.id}`).sort());
    expect(shown.every((i) => i.width > 0)).toBe(true);
    expect(answered.requests.filter((x) => x.id === null || x.search !== '')).toEqual([]);
    expect(answered.maxInFlight()).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    for (const p of photos) expect(answered.okCount(p.id), `200s for ${p.id}`).toBe(1);
    await expect(page.getByText(REMOTE_PHOTO_FAILED_MESSAGE, { exact: true })).toHaveCount(0);
  });

  test('the edit form with one photo that never loads: its slot says it is still attached, stays filled, and a text change still submits', async ({ browser }) => {
    test.setTimeout(180_000);
    const stw = world.user('STW');
    const c = world.customer('BIG');
    const wiredBefore = await wiring(customerId);
    const page = await (await contextAs(browser, stw, { device: 'desktop' })).newPage();
    const answered = await answerPhotos(page, photos, { delayMs: 150, fail: { times: Number.POSITIVE_INFINITY } });
    await page.goto(`/customers/${customerId}/edit`);
    await waitHydrated(page);

    await expect(page.locator('[data-photo-state="failed"]')).toHaveCount(1, { timeout: 60_000 });
    const failId = answered.failId()!;
    expect((await photoStates(page)).filter((s) => s === 'loaded')).toHaveLength(TOTAL - 1);
    await expect(page.getByText(REMOTE_PHOTO_FAILED_MESSAGE, { exact: true })).toHaveCount(1);
    expect(answered.requests.filter((r) => r.id === failId).map((r) => r.status)).toEqual(Array(MAX_FAILURES).fill(502));

    // The slot that holds it: by where the photo is wired, never by guessing the order.
    const live = await liveSlotOf(failId);
    const branch = Object.values(c.branches).find((b) => b.id === (live.shopOf ?? live.signboardOf));
    const slot = live.crOf
      ? photoSlot(page, 'CR document')
      : photoSlot((await branchSection(page, branch!.name)).section, live.shopOf ? 'Shop front' : 'Signboard');
    await expect(slot.getByText(REMOTE_PHOTO_FAILED_MESSAGE, { exact: true })).toHaveCount(1);
    await expect(slot.locator('[data-photo-state="failed"]')).toHaveCount(1);
    await expect(slot.locator('img')).toHaveCount(0);
    // Still filled: the check icon and the filled colours, as for any attached photo.
    await expect(slot.locator('svg.lucide-check')).toHaveCount(1);
    await expect(slot).toHaveClass(/border-emerald-300/);

    // A text change, and the form submits as the Steward's direct write.
    const contact = world.name('Steward contact');
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();
    const release = await slowNextDocument(page, new RegExp(`/customers/${customerId}$`));
    const saved = await watchForText(page, '✓ Saved (auto-approved as STEWARD).');
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${customerId}$`), { timeout: 30_000 });
    await release();
    expect(saved(), 'the form said it was saved before it left').not.toBeNull();

    const edits = await editsOn(customerId);
    expect(edits.map((e) => ({ state: e.state, submittedById: e.submittedById, reviewedById: e.reviewedById }))).toEqual([
      { state: 'APPROVED', submittedById: stw.id, reviewedById: stw.id },
    ]);
    world.adopt.edit(edits[0]!.id);
    expect((await db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { contactPerson: true } })).contactPerson).toBe(contact);
    expect((await auditFor({ entityId: customerId, actorId: stw.id, action: 'UPDATE' })).map((a) => a.reason)).toContain(
      'direct-write: applied by STEWARD with no approval chain'
    );
    // The photo that did not load is still attached where it was, and so is every other.
    expect(await liveSlotOf(failId)).toEqual(live);
    expect(live.deletedAt).toBeNull();
    expect(await wiring(customerId)).toEqual(wiredBefore);
  });

  // Last in this group: it adds a waiting update request to the customer.
  test("an update request's approval page for that customer loads its 41 photos through the queue too", async ({ browser }) => {
    test.setTimeout(180_000);
    const edit = await seedUpdateEdit(world, { customer: 'BIG', submitter: 'SA', patch: { customer: { contactPerson: world.name('Approval contact') } } });
    const page = await (await contextAs(browser, world.user('MGR'), { device: 'desktop' })).newPage();
    const answered = await answerPhotos(page, photos, { delayMs: 150, hold: true });

    // Queued: a placeholder per photo in the server HTML (the CR document and each shop's two), no address.
    const res = await page.goto(`/approvals/${edit.id}`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(200);
    const html = (await res!.text()) ?? '';
    expect(html.match(/data-photo-state="waiting"/g) ?? [], 'a placeholder per photo in the server HTML').toHaveLength(TOTAL);
    expect(html).not.toContain('src="/api/photos/');
    await expect.poll(() => answered.requests.length, { timeout: 60_000 }).toBe(MAX_IN_FLIGHT);
    await page.waitForTimeout(1_000);
    expect(answered.requests.length, 'nothing more starts while 6 are in flight').toBe(MAX_IN_FLIGHT);
    await expect(page.locator('[data-photo-state="waiting"]')).toHaveCount(TOTAL - MAX_IN_FLIGHT);
    answered.release();

    await expectAllPhotos(page, TOTAL, 'loaded');
    const shown = await loadedImages(page);
    expect(shown.map((i) => i.src).sort()).toEqual(photos.map((p) => `/api/photos/${p.id}`).sort());
    expect(shown.every((i) => i.width > 0), 'each a decoded picture').toBe(true);
    expect(answered.requests.filter((x) => x.id === null || x.search !== ''), 'every request is /api/photos/<id> with no query').toEqual([]);
    expect(answered.maxInFlight(), 'never more than 6 in flight').toBeLessThanOrEqual(MAX_IN_FLIGHT);
    for (const p of photos) expect(answered.okCount(p.id), `200s for ${p.id}`).toBe(1);
    expect(answered.requests).toHaveLength(TOTAL);
    await expect(pacedSentence(page, TOTAL)).toHaveCount(0);
  });
});

/** Every photo slot of a customer, as wired now. */
async function wiring(customerId: string) {
  return db.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { crPhotoId: true, branches: { orderBy: { id: 'asc' }, select: { id: true, shopPhotoId: true, signboardPhotoId: true } } },
  });
}
