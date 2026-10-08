/**
 * FIELD FAULTS ON A PHONE — what the salesman's phone does when the link, the
 * GPS or the phone itself lets him down at a shop. @phone only (Pixel 5,
 * 412×915, Chromium). The tests that drive the DevTools protocol are tagged
 * @cdp as well (Chromium only: no WebKit project may run them).
 *
 *   (a) a submit held past 70 s — past the phone's own 30 s limit and Vercel's 60 s
 *       maxDuration — then let go, timed out, or read at once with its reply held
 *   (b) dropped connections (timedout, connectionreset, internetdisconnected) on the
 *       submit and on each photo step (presign, the R2 PUT, finalize)
 *   (c) the R2 PUT at a crawl (@cdp)
 *   (d) going offline mid-form, and the tab reloaded with no signal
 *   (e) GPS denied, unavailable (@cdp) and timed out (init script) — and the
 *       typed-coordinates-with-reason path after each
 *   (f) a slow phone: CPU ×6, two cores, Slow 4G (@cdp) — timings as annotations,
 *       generous budgets (report, do not gate)
 *   (g) the tab frozen mid-upload and resumed (@cdp)
 *
 * The field forms submit through fetch (/api/forms/<form>, lib/submit-client.ts),
 * not a server action: a stalled submit is held there. What must hold whatever
 * the fault: the screen never says "saved" when the phone does not know it, at
 * most one request lands, and the salesman is told what to do next.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts field-faults --project=phone
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  BASE_URL,
  contextAs,
  createWorld,
  db,
  fetchAs,
  hasR2,
  notRunHere,
  installLaunchHooks,
  listFixturePrefix,
  notificationsFor,
  requireLaunchEnv,
  resetLimits,
  type FixtureCustomer,
  type FixtureRoute,
  type FixtureUser,
  type World,
} from './support';
import {
  ALREADY_RECEIVED,
  ATTACH_PATH,
  DRAFT_RESTORED,
  FIELD_ABORTS,
  FINALIZE_PATH,
  FORM_PATH,
  GPS_DENIED,
  GPS_MANUAL_NUMBERS,
  GPS_MANUAL_PANEL,
  GPS_MANUAL_REASON,
  GPS_TIMEOUT,
  GPS_UNAVAILABLE,
  OFFLINE_MESSAGE,
  PHOTO_TRIES,
  PHOTO_UPLOADING_MESSAGE,
  PRESIGN_PATH,
  UPLOAD_NO_CONNECTION,
  SLOW_PHONE,
  SUBMIT,
  SUBMIT_TIMEOUT_MS,
  UNCONFIRMED_MESSAGE,
  UPLOAD_STALL_MS,
  VERCEL_MAX_DURATION_MS,
  addFieldSalesman,
  adoptSalesmanWork,
  cameraJpeg,
  cdpFor,
  compressedSizeInBrowser,
  contactBox,
  countRequests,
  crawlUplink,
  dropDraftBuckets,
  editsOf,
  emulateNetwork,
  failRequests,
  fmtTimings,
  freezeFor,
  geoCalls,
  holdFirstPost,
  isR2,
  jpegSize,
  neverFixGeolocation,
  note,
  noteR2CorsRefusal,
  notesBox,
  openEnrich,
  pageTimings,
  pathIs,
  phoneCopy,
  photoSlot,
  photosBy,
  pickControlOf,
  pickFile,
  pngFile,
  restoreDevice,
  retakeOf,
  retryOf,
  sentOrAlreadyReceived,
  settled,
  sleep,
  slotMessage,
  slotState,
  slowPhone,
  tryAgain,
  uploadPct,
  watchSavedClaims,
  ymdOf,
  type FieldAbort,
  type UrlMatch,
} from './support/field-faults-helpers';

/**
 * The salesman's submit gate the server runs with (lib/submit-gate.ts): CORE, the
 * launch default, unless SALESMAN_SUBMIT_GATE=FULL in the .env both read. The
 * submit tests change a customer-level field of a customer complete under CORE
 * (channel, phone, contact) or a branch's GPS (address, GPS, shop photo); under
 * FULL Submit would stay off.
 */
const FULL_GATE = process.env.SALESMAN_SUBMIT_GATE === 'FULL';
const CORE_ONLY = 'written for the CORE submit gate (the launch default)';

/** (a): past the phone's 30 s and Vercel's 60 s. */
const HOLD_MS = 70_000;

/**
 * (f): generous budgets on a CPU ×6, two-core phone on Slow 4G against a local
 * server on the UAT database — they catch a page that hangs or a regression by
 * a factor, not a few seconds. The real numbers are in each test's annotations.
 */
const BUDGET = {
  todayFirstMs: 45_000,
  todayReloadMs: 30_000,
  customersListMs: 45_000,
  searchMs: 30_000,
  enrichUsableMs: 60_000,
  submitToNextPageMs: 60_000,
  compressMs: 60_000,
  photoMs: 300_000,
};

/** One chain of the photo upload, as request counts. */
type Chain = { presign: number; put: number; finalize: number; attach: number };

test.describe('field faults on a phone', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let since: Date;
  /** Who a salesman's request notifies: his supervisor (must act) and the region Accountant (FYI). */
  let audience: string[];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await createWorld('ff', {
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

  /** A salesman of his own with one customer, on a phone, his buckets full. */
  async function phoneOf(
    browser: Browser,
    key: string,
    branch?: NonNullable<Parameters<typeof addFieldSalesman>[2]>['branch']
  ): Promise<{ user: FixtureUser; route: FixtureRoute; customer: FixtureCustomer; ctx: BrowserContext; page: Page }> {
    const s = await addFieldSalesman(world, key, { branch });
    await resetLimits({ users: [s.user] });
    const ctx = await contextAs(browser, s.user, { device: 'phone' });
    const page = await ctx.newPage();
    noteR2CorsRefusal(page);
    return { ...s, ctx, page };
  }

  /** Every request notifies exactly its audience, once each — a replayed submit never notifies twice. */
  async function expectOneSet(editId: string): Promise<void> {
    await expect
      .poll(async () => (await notificationsFor({ editId })).map((n) => n.userId).sort(), {
        message: 'one set of notifications: his supervisor and the region Accountant',
      })
      .toEqual([...audience].sort());
  }

  /** The upload chain's requests on a page, counted from now. */
  function chainCounter(page: Page): () => Chain {
    const n = {
      presign: countRequests(page, pathIs(PRESIGN_PATH)),
      put: countRequests(page, isR2, 'PUT'),
      finalize: countRequests(page, pathIs(FINALIZE_PATH)),
      attach: countRequests(page, pathIs(ATTACH_PATH)),
    };
    return () => ({ presign: n.presign.count, put: n.put.count, finalize: n.finalize.count, attach: n.attach.count });
  }
  const minus = (b: Chain, a: Chain): Chain => ({
    presign: b.presign - a.presign,
    put: b.put - a.put,
    finalize: b.finalize - a.finalize,
    attach: b.attach - a.attach,
  });
  const ONE_CLEAN_CHAIN: Chain = { presign: 1, put: 1, finalize: 1, attach: 1 };

  /** Every R2 object in the user's day folders of these keys (the only listing the suite performs). */
  async function r2ObjectsOf(userId: string, keys: string[]): Promise<string[]> {
    const days = [...new Set(keys.map(ymdOf))];
    return (await Promise.all(days.map((d) => listFixturePrefix(d, userId, world.fixtureUserIds())))).flat();
  }

  /** The submission ids of the page's form POSTs, in order. */
  function submissionIdsSent(page: Page): string[] {
    const ids: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' || new URL(r.url()).pathname !== FORM_PATH) return;
      try {
        const body = r.postDataJSON() as { submissionId?: unknown } | null;
        ids.push(String(body?.submissionId ?? ''));
      } catch {
        ids.push('(not JSON)');
      }
    });
    return ids;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // (a) A submit held past 70 s
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(a) a submit held past 70 s', () => {
    /**
     * Taps Submit and waits out the phone's own limit: "Submitting…" at once, then
     * after its 30 s — and before Vercel's 60 s would have ended the request —
     * "No answer — we cannot tell if it arrived", with Try again.
     */
    async function outwait(page: Page, t0: number): Promise<void> {
      await expect(page.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible({ timeout: SUBMIT_TIMEOUT_MS + 20_000 });
      const ms = Date.now() - t0;
      note('the phone gave up after', `${ms} ms`);
      expect(ms, 'it waits its own limit').toBeGreaterThanOrEqual(SUBMIT_TIMEOUT_MS - 1_000);
      expect(ms, "and gives up before Vercel's 60 s maxDuration would").toBeLessThan(VERCEL_MAX_DURATION_MS);
      await expect(tryAgain(page), 'told what to do: Try again').toBeEnabled();
      await expect(page.getByRole('button', { name: SUBMIT, exact: true }), 'the form is his again').toBeEnabled();
    }

    async function tapAndOutwait(page: Page, submit: Locator): Promise<void> {
      const t0 = Date.now();
      await submit.click();
      await expect(page.getByRole('button', { name: 'Submitting…', exact: true }), 'the tap is acknowledged').toBeVisible();
      await outwait(page, t0);
    }

    test('held 70 s, then let go: "No answer" at 30 s and never "saved"; at most one request lands; Try again ends with exactly one', async ({ browser }) => {
      test.setTimeout(300_000);
      notRunHere(FULL_GATE, CORE_ONLY);
      const { customer, page } = await phoneOf(browser, 'H1');
      const posts = countRequests(page, pathIs(FORM_PATH));
      const submit = await openEnrich(page, customer.id);
      const contact = world.name('Rashid Al Amri');
      await contactBox(page).fill(contact);
      await expect(submit).toBeEnabled();
      const claims = await watchSavedClaims(page);
      expect(await claims(), 'nothing says saved before the tap').toEqual([]);
      const held = await holdFirstPost(page, FORM_PATH, { holdMs: HOLD_MS, then: 'continue' });

      await tapAndOutwait(page, submit);
      expect(await editsOf(customer.id), 'still held: nothing has reached the server').toBe(0);
      await expect(contactBox(page), 'what he typed is still there').toHaveValue(contact);

      await held.released;
      // A let-go request that Chromium still sent would land within seconds.
      await sleep(5_000);
      const landed = await editsOf(customer.id);
      note('the held request, let go after 70 s', landed ? 'reached the server' : `never arrived — the phone had abandoned it${held.error ? ` (${held.error})` : ''}`);
      expect(landed, 'none or one').toBeLessThanOrEqual(1);
      expect(await claims(), 'no "saved" at any moment of the stall').toEqual([]);
      await expect(page.getByText(UNCONFIRMED_MESSAGE, { exact: true }), 'it still says it cannot tell').toBeVisible();

      await tryAgain(page).click();
      const how = await sentOrAlreadyReceived(page, customer.id);
      note('Try again', how);
      if (landed) expect(how, 'it had landed: the retry is answered from it').toBe('already received');
      const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, submissionId: true } });
      expect(edits.map((e) => [e.state, e.submissionId]), 'exactly one request, under the held try’s id').toEqual([
        ['SUBMITTED', held.body?.submissionId],
      ]);
      expect(posts.count, 'the held try and one Try again').toBe(2);
      await expectOneSet(edits[0]!.id);
    });

    test('held 70 s, then timed out: "No answer" (the phone cannot know), nothing written; Try again sends it once under the same id', async ({ browser }) => {
      test.setTimeout(300_000);
      notRunHere(FULL_GATE, CORE_ONLY);
      const { customer, page } = await phoneOf(browser, 'H2');
      const posts = countRequests(page, pathIs(FORM_PATH));
      const submit = await openEnrich(page, customer.id);
      await contactBox(page).fill(world.name('Sultan Al Ghafri'));
      await expect(submit).toBeEnabled();
      const claims = await watchSavedClaims(page);
      const held = await holdFirstPost(page, FORM_PATH, { holdMs: HOLD_MS, then: 'abort', abortCode: 'timedout' });

      await tapAndOutwait(page, submit);
      await held.released;
      await sleep(3_000);
      expect(await editsOf(customer.id), 'the held try never reached the server').toBe(0);
      expect(await claims(), 'no "saved" at any moment of the stall').toEqual([]);
      await expect(page.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible();

      await tryAgain(page).click();
      await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 45_000 });
      const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, submissionId: true } });
      expect(edits.map((e) => [e.state, e.submissionId]), 'one request, the retry reusing the same id').toEqual([
        ['SUBMITTED', held.body?.submissionId],
      ]);
      expect(posts.count).toBe(2);
      await expectOneSet(edits[0]!.id);
    });

    test('read at once, its reply held 70 s: "No answer", not "saved"; Try again during the stall says "Already received"; the late reply changes nothing', async ({ browser }) => {
      test.setTimeout(300_000);
      notRunHere(FULL_GATE, CORE_ONLY);
      const { customer, page } = await phoneOf(browser, 'H3');
      const posts = countRequests(page, pathIs(FORM_PATH));
      const submit = await openEnrich(page, customer.id);
      await contactBox(page).fill(world.name('Hamood Al Habsi'));
      await expect(submit).toBeEnabled();
      const claims = await watchSavedClaims(page);
      const held = await holdFirstPost(page, FORM_PATH, { holdMs: HOLD_MS, then: 'answerLate' });

      const t0 = Date.now();
      await submit.click();
      await expect.poll(() => editsOf(customer.id), { timeout: 20_000, message: 'the server read it at once' }).toBe(1);
      // The row is committed a moment before the answer reaches the hold: wait for the answer itself.
      await expect.poll(() => held.serverStatus, { timeout: 20_000, message: 'and answered' }).toBe(200);
      await expect(page.getByRole('button', { name: 'Submitting…', exact: true }), 'saved on the server; the phone has heard nothing').toBeVisible();
      await outwait(page, t0);
      expect(await claims(), 'the phone does not know, so it does not say "saved"').toEqual([]);

      expect(held.releasedAt, 'the first reply is still held').toBeNull();
      await tryAgain(page).click();
      await expect(page.getByText(ALREADY_RECEIVED)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Sent ✓', exact: true })).toBeVisible();
      expect(new URL(page.url()).pathname, 'nothing more to send: it stays').toBe(`/customers/${customer.id}/edit`);

      await held.released;
      await sleep(2_000);
      await expect(page.getByText(ALREADY_RECEIVED), 'the late reply, which nobody waits for, changes nothing').toBeVisible();
      await expect(page.getByRole('button', { name: 'Sent ✓', exact: true })).toBeVisible();
      const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, submissionId: true } });
      expect(edits.map((e) => [e.state, e.submissionId]), 'never twice').toEqual([['SUBMITTED', held.body?.submissionId]]);
      expect(posts.count).toBe(2);
      await expectOneSet(edits[0]!.id);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // (b) Dropped connections: timedout, connectionreset, internetdisconnected
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(b) dropped connections', () => {
    for (const [i, code] of FIELD_ABORTS.entries()) {
      test(`submit, ${code}: "No answer" at once, nothing written, no resend behind his back; Try again sends it once under the same id`, async ({ browser }) => {
        notRunHere(FULL_GATE, CORE_ONLY);
        const { customer, page } = await phoneOf(browser, `D${i}`);
        const posts = countRequests(page, pathIs(FORM_PATH));
        const sids = submissionIdsSent(page);
        const submit = await openEnrich(page, customer.id);
        const contact = world.name('Said Al Maskari');
        await contactBox(page).fill(contact);
        await expect(submit).toBeEnabled();
        const fault = await failRequests(page, { match: pathIs(FORM_PATH), method: 'POST', code, times: 1 });

        const t0 = Date.now();
        await submit.click();
        // The phone still reports a network (navigator.onLine): it cannot tell a drop
        // after sending from one before, so it says "cannot tell", never "nothing was sent".
        await expect(page.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible({ timeout: 15_000 });
        note('told after', `${Date.now() - t0} ms`);
        await expect(tryAgain(page)).toBeEnabled();
        await sleep(3_000);
        expect(fault.aborted).toBe(1);
        expect(posts.count, 'one tap, one POST: the phone does not resend by itself').toBe(1);
        expect(await editsOf(customer.id), 'nothing arrived').toBe(0);
        await expect(contactBox(page)).toHaveValue(contact);

        await tryAgain(page).click();
        await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 45_000 });
        expect(sids, 'Try again sends the same payload under the same id').toEqual([sids[0], sids[0]]);
        const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, submissionId: true } });
        expect(edits.map((e) => [e.state, e.submissionId])).toEqual([['SUBMITTED', sids[0]]]);
        await expectOneSet(edits[0]!.id);
      });
    }

    /**
     * Each photo step, as the page.route fault matches it, and the drops it is
     * tested with. The R2 PUT's "timedout" has a test of its own below (it was a
     * bug, fixed by da545ac: it must now fail over as fast as the other drops).
     */
    const STEPS: Record<'presign' | 'R2 PUT' | 'finalize', { match: UrlMatch; method: string; codes: readonly FieldAbort[]; failed: Chain; once: Chain }> = {
      // presign and the PUT are retried together (each try gets a URL of its own).
      presign: {
        match: pathIs(PRESIGN_PATH),
        method: 'POST',
        codes: FIELD_ABORTS,
        failed: { presign: PHOTO_TRIES, put: 0, finalize: 0, attach: 0 },
        once: { presign: 2, put: 1, finalize: 1, attach: 1 },
      },
      'R2 PUT': {
        match: isR2,
        method: 'PUT',
        codes: FIELD_ABORTS.filter((c) => c !== 'timedout'),
        failed: { presign: PHOTO_TRIES, put: PHOTO_TRIES, finalize: 0, attach: 0 },
        once: { presign: 2, put: 2, finalize: 1, attach: 1 },
      },
      finalize: {
        match: pathIs(FINALIZE_PATH),
        method: 'POST',
        codes: FIELD_ABORTS,
        failed: { presign: 1, put: 1, finalize: PHOTO_TRIES, attach: 0 },
        once: { presign: 1, put: 1, finalize: 2, attach: 1 },
      },
    };
    /** The slot each drop is tried on, in order, and its kind. */
    const DROP_SLOTS = [
      { label: 'Shop front', nth: 0, kind: 'SHOP' },
      { label: 'Signboard', nth: 0, kind: 'SIGNBOARD' },
      { label: 'Other', nth: 0, kind: 'FREE' },
    ] as const;

    for (const [i, step] of (['presign', 'R2 PUT', 'finalize'] as const).entries()) {
      test(`photo, ${step} dropped (${STEPS[step].codes.join(', ')}): three silent tries, then "Retry upload" with the photo kept; Retry attaches it once; a single drop is retried without a word`, async ({ browser }) => {
        notRunHere(!hasR2, 'photo uploads need R2');
        test.setTimeout(300_000);
        const s = STEPS[step];
        const { user, customer, page } = await phoneOf(browser, `P${i}`);
        const counts = chainCounter(page);
        const submit = await openEnrich(page, customer.id);
        const used = DROP_SLOTS.slice(0, s.codes.length);
        const words: string[] = [];

        for (const [k, code] of s.codes.entries()) {
          const slot = photoSlot(page, used[k]!.label, used[k]!.nth);
          const fault = await failRequests(page, { match: s.match, method: s.method, code });
          const before = counts();
          await pickFile(slot, pngFile(`${step.replace(' ', '-')}-${code}`));
          // As a poll, so a slot that never gets there says where it stood and what was sent.
          await expect
            .poll(async () => `${await slotState(slot)} · sent ${JSON.stringify(minus(counts(), before))} · faulted ${fault.aborted}`, {
              timeout: 90_000,
              message: `${code}: Retry upload once the last try failed`,
            })
            .toMatch(/^retry /);
          const msg = await slotMessage(slot);
          words.push(`${code}: "${msg}"`);
          expect(msg, `${code}: the slot says why, in the app's words (f960612)`).toBe(UPLOAD_NO_CONNECTION);
          expect(minus(counts(), before), `${code}: ${PHOTO_TRIES} tries, then it stops`).toEqual(s.failed);
          await expect(page.getByText(PHOTO_UPLOADING_MESSAGE, { exact: true }), `${code}: the slot is no longer busy`).toHaveCount(0);
          await expect(submit, `${code}: a failed photo does not hold Submit`).toBeEnabled();
          expect(await photosBy(user.id), `${code}: nothing was finalized`).toHaveLength(k);

          await fault.stop();
          const again = counts();
          await retryOf(slot).click();
          await expect
            .poll(async () => `${await slotState(slot)} · sent ${JSON.stringify(minus(counts(), again))}`, {
              timeout: 90_000,
              message: `${code}: Retry upload sends the kept photo — no new pick`,
            })
            .toMatch(/^attached /);
          expect(minus(counts(), again), `${code}: one clean chain`).toEqual(ONE_CLEAN_CHAIN);
          expect(await photosBy(user.id), `${code}: one Attachment more`).toHaveLength(k + 1);
        }
        note('what the slot said', words.join(' · '));

        // One drop only: retried behind the scenes, no message, no Retry upload.
        const other = photoSlot(page, 'Other', 1);
        const once = await failRequests(page, { match: s.match, method: s.method, code: 'connectionreset', times: 1 });
        const before = counts();
        await pickFile(other, pngFile(`${step.replace(' ', '-')}-once`));
        await expect(retakeOf(other)).toBeVisible({ timeout: 90_000 });
        await expect(retryOf(other)).toHaveCount(0);
        expect(once.aborted).toBe(1);
        expect(minus(counts(), before), 'the dropped step tried once more').toEqual(s.once);
        await once.stop();

        // One photo per drop and the single drop's, each on its slot once.
        const photos = await photosBy(user.id);
        const kinds: string[] = [...used.map((u) => u.kind), 'FREE'];
        expect(photos.map((p) => p.kind).sort()).toEqual(kinds.sort());
        const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true, signboardPhotoId: true } });
        expect(b.shopPhotoId).toBe(photos.find((p) => p.kind === 'SHOP')!.id);
        expect(b.signboardPhotoId).toBe(photos.find((p) => p.kind === 'SIGNBOARD')!.id);
        expect(photos.filter((p) => p.kind === 'FREE').map((p) => p.branchExtraId)).toEqual(
          kinds.filter((k) => k === 'FREE').map(() => customer.branch.id)
        );
        const objects = await r2ObjectsOf(user.id, photos.map((p) => p.r2Key));
        expect(objects).toEqual(expect.arrayContaining(photos.map((p) => p.r2Key)));
        note(
          'R2 objects / attachments',
          `${objects.length} / ${photos.length}${
            objects.length > photos.length
              ? ' — a Retry after a dropped finalize sends the photo again; the first copy stays in R2 unreferenced'
              : ''
          }`
        );
      });
    }

    test('photo, R2 PUT timed out (net::ERR_TIMED_OUT): three tries at once — not each after 45 s of silence — then "Retry upload"; Retry attaches it once', async ({ browser }) => {
      // Was a BUG (found by this file), fixed by da545ac: PhotoCaptureSlot's putWithProgress listened for the XHR's
      // error, abort and load events only. Chromium reports a PUT that fails with net::ERR_TIMED_OUT as the XHR
      // "timeout" event (even with xhr.timeout unset), so each try was ended only by the 45 s stall watchdog: three
      // tries took about 2¼ minutes of "Uploading… 0%" with Submit held. It has an ontimeout now: noticed at once.
      notRunHere(!hasR2, 'photo uploads need R2');
      test.setTimeout(300_000);
      const s = STEPS['R2 PUT'];
      const { user, customer, page } = await phoneOf(browser, 'PT');
      const counts = chainCounter(page);
      const submit = await openEnrich(page, customer.id);
      const slot = photoSlot(page, 'Shop front');
      const fault = await failRequests(page, { match: s.match, method: s.method, code: 'timedout' });
      const before = counts();
      await pickFile(slot, pngFile('R2-PUT-timedout'));
      // The same budget as every other drop: three tries and their 0.5 s + 1.5 s backoff.
      await expect
        .poll(async () => `${await slotState(slot)} · sent ${JSON.stringify(minus(counts(), before))} · faulted ${fault.aborted}`, {
          timeout: 90_000,
          message: 'timedout: Retry upload once the last try failed',
        })
        .toMatch(/^retry /);
      const msg = await slotMessage(slot);
      note('what the slot said', `timedout: "${msg}"`);
      expect(msg, 'the slot says why, as for any dropped connection').toBe(UPLOAD_NO_CONNECTION);
      expect(minus(counts(), before), `${PHOTO_TRIES} tries, then it stops`).toEqual(s.failed);
      await expect(page.getByText(PHOTO_UPLOADING_MESSAGE, { exact: true }), 'the slot is no longer busy').toHaveCount(0);
      await expect(submit, 'a failed photo does not hold Submit').toBeEnabled();
      expect(await photosBy(user.id), 'nothing was finalized').toHaveLength(0);

      await fault.stop();
      const again = counts();
      await retryOf(slot).click();
      await expect
        .poll(async () => `${await slotState(slot)} · sent ${JSON.stringify(minus(counts(), again))}`, {
          timeout: 90_000,
          message: 'Retry upload sends the kept photo — no new pick',
        })
        .toMatch(/^attached /);
      expect(minus(counts(), again), 'one clean chain').toEqual(ONE_CLEAN_CHAIN);
      const photos = await photosBy(user.id);
      expect(photos, 'one Attachment').toHaveLength(1);
      const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true } });
      expect(b.shopPhotoId).toBe(photos[0]!.id);
    });

    test('a presign or finalize that cannot be reached is worded for the salesman, not with the browser’s own "Failed to fetch"', async ({ browser }) => {
      // Was a bug (PhotoCaptureSlot showed fetch's own "Failed to fetch"); fixed in the launch candidate:
      // a dropped connection, three times, now reads UPLOAD_NO_CONNECTION (components/nmwc/PhotoCaptureSlot.tsx uploadChain's catch).
      notRunHere(!hasR2, 'photo uploads need R2');
      const { customer, page } = await phoneOf(browser, 'PW');
      await openEnrich(page, customer.id);
      const said: string[] = [];
      for (const [label, path] of [
        ['Shop front', PRESIGN_PATH],
        ['Signboard', FINALIZE_PATH],
      ] as const) {
        const slot = photoSlot(page, label);
        const fault = await failRequests(page, { match: pathIs(path), method: 'POST', code: 'connectionreset' });
        await pickFile(slot, pngFile(`words-${label.replace(' ', '-')}`));
        await expect(retryOf(slot)).toBeVisible({ timeout: 90_000 });
        said.push(`${path}: "${await slotMessage(slot)}"`);
        await fault.stop();
      }
      note('what the slots said', said.join(' · '));
      for (const s of said) expect(s, 'in the app’s own words (what happened, what to do), not the browser’s').not.toMatch(/failed to fetch|load failed|networkerror|typeerror/i);
      expect(said).toEqual([`${PRESIGN_PATH}: "${UPLOAD_NO_CONNECTION}"`, `${FINALIZE_PATH}: "${UPLOAD_NO_CONNECTION}"`]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // (c) The R2 PUT at a crawl
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(c) the R2 PUT at a crawl', { tag: ['@cdp'] }, () => {
    /** How long the photo's bytes take to go up. Longer than the 45 s stall limit, on purpose: moving bytes are not a stall. */
    const CRAWL_S = 60;

    test('"Uploading… n%" climbs while Submit waits and the slot takes no second pick; one presign, one PUT, one Attachment, one R2 object', async ({ browser }) => {
      notRunHere(!hasR2, 'photo uploads need R2');
      test.setTimeout(480_000);
      const { user, customer, page } = await phoneOf(browser, 'CR1');
      const counts = chainCounter(page);
      // Nothing typed: an untouched form has nothing to gate, so Submit is held by the upload alone.
      const submit = await openEnrich(page, customer.id);
      await expect(submit).toBeEnabled();
      const photo = await cameraJpeg(page, 1600, 1200);
      const size = await compressedSizeInBrowser(page, photo);
      const slot = photoSlot(page, 'Shop front');
      const cdp = await cdpFor(page);
      const seen: number[] = [];
      let tookMs = 0;
      try {
        const rate = await crawlUplink(cdp, size, CRAWL_S);
        note('the crawl', `~${Math.round(size / 1024)} KB after compression at ${Math.round((rate * 8) / 1000)} kbps up ≈ ${CRAWL_S} s (stall limit ${UPLOAD_STALL_MS / 1000} s)`);
        const t0 = Date.now();
        await pickFile(slot, { name: 'IMG_20261008_093000.jpg', mimeType: 'image/jpeg', buffer: photo });
        await expect(submit, 'Submit waits for the photo').toBeDisabled();
        await expect(page.getByText(PHOTO_UPLOADING_MESSAGE, { exact: true })).toBeVisible();
        const deadline = Date.now() + 360_000;
        // Until it is attached — or failed: a Retry upload is no crawl any more, so stop watching (asserted below).
        while (Date.now() < deadline && (await retakeOf(slot).count()) === 0 && (await retryOf(slot).count()) === 0) {
          const pct = await uploadPct(slot);
          if (pct !== null && seen[seen.length - 1] !== pct) seen.push(pct);
          if (pct !== null && pct > 0 && pct < 100) {
            expect(await pickControlOf(slot).count(), 'no second pick while it goes up').toBe(0);
            expect(await retryOf(slot).count(), 'no Retry while the bytes move').toBe(0);
          }
          await sleep(1_000);
        }
        expect(await slotState(slot), 'it arrives by itself').toBe('attached');
        tookMs = Date.now() - t0;
      } finally {
        await restoreDevice(cdp);
      }
      note('progress shown', `${seen.join('% → ')}%`);
      note('upload took', `${tookMs} ms`);
      expect(seen.filter((p) => p > 0 && p < 100).length, 'progress shown and moving').toBeGreaterThanOrEqual(3);
      expect(seen, 'never back to 0: nothing was started again').toEqual([...seen].sort((a, b) => a - b));
      await expect(retryOf(slot)).toHaveCount(0);
      await expect(submit).toBeEnabled();
      expect(counts(), 'nothing was sent twice').toEqual(ONE_CLEAN_CHAIN);
      const photos = await photosBy(user.id);
      expect(photos, 'one Attachment').toHaveLength(1);
      const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true } });
      expect(b.shopPhotoId).toBe(photos[0]!.id);
      expect(await r2ObjectsOf(user.id, [photos[0]!.r2Key]), 'one object in R2').toEqual([photos[0]!.r2Key]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // (d) Offline mid-form
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(d) offline mid-form', () => {
    test('he types on with no signal and the phone copy keeps it; the photo and Submit both say so; back online, Retry upload and Try again each send once', async ({ browser }) => {
      notRunHere(FULL_GATE, CORE_ONLY);
      test.setTimeout(240_000);
      const { user, customer, ctx, page } = await phoneOf(browser, 'O1');
      const posts = countRequests(page, pathIs(FORM_PATH));
      const submit = await openEnrich(page, customer.id);
      const contact = world.name('Hilal Al Busaidi');
      const notes = world.name('Opens after Asr; ask for the owner');
      await contactBox(page).fill(contact);

      await ctx.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine), { message: 'the phone knows it has no signal' }).toBe(false);
      await notesBox(page).fill(notes);
      await expect.poll(() => phoneCopy(page, user.id, customer.id), { message: 'typed with no signal, kept on the phone' }).toContain(notes);
      expect(await phoneCopy(page, user.id, customer.id)).toContain(contact);

      let shop: Locator | null = null;
      if (hasR2) {
        shop = photoSlot(page, 'Shop front');
        await pickFile(shop, pngFile('offline-shop'));
        await expect(retryOf(shop), 'no signal: the photo waits for Retry upload').toBeVisible({ timeout: 60_000 });
        note('the photo, with no signal', `"${await slotMessage(shop)}"`);
        expect(await photosBy(user.id)).toHaveLength(0);
      }
      await submit.click();
      await expect(page.getByText(OFFLINE_MESSAGE, { exact: true }), 'certain: nothing left the phone').toBeVisible();
      expect(await editsOf(customer.id)).toBe(0);
      await expect(contactBox(page)).toHaveValue(contact);
      await expect(notesBox(page)).toHaveValue(notes);

      await ctx.setOffline(false);
      if (shop) {
        await retryOf(shop).click();
        await expect(retakeOf(shop), 'the kept photo goes up without a new pick').toBeVisible({ timeout: 90_000 });
      }
      await tryAgain(page).click();
      await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 45_000 });
      note('form POSTs seen', String(posts.count));
      const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, fieldChanges: true } });
      expect(edits.map((e) => e.state)).toEqual(['SUBMITTED']);
      const after = Object.fromEntries((edits[0]!.fieldChanges as Array<{ field: string; after: unknown }>).map((c) => [c.field, c.after]));
      expect(after['customer.contactPerson']).toBe(contact);
      expect(after['customer.notes'], 'what he typed with no signal went too').toBe(notes);
      await expectOneSet(edits[0]!.id);
      if (shop) {
        const photos = await photosBy(user.id);
        expect(photos).toHaveLength(1);
        const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true } });
        expect(b.shopPhotoId).toBe(photos[0]!.id);
      }
    });

    test('the tab reloaded with no signal (the phone dropped it): back online, the form brings back what he typed and Submit sends it once', async ({ browser }) => {
      notRunHere(FULL_GATE, CORE_ONLY);
      const { user, customer, ctx, page } = await phoneOf(browser, 'O2');
      await openEnrich(page, customer.id);
      const contact = world.name('Khalfan Al Wahaibi');
      const notes = world.name('Back door on the side street');

      await ctx.setOffline(true);
      await contactBox(page).fill(contact);
      await notesBox(page).fill(notes);
      await expect.poll(() => phoneCopy(page, user.id, customer.id)).toContain(notes);
      expect(await phoneCopy(page, user.id, customer.id)).toContain(contact);
      const reloaded = await page.reload().then(
        () => 'the page loaded',
        (e: Error) => e.message.split('\n')[0]!.slice(0, 120)
      );
      note('reload with no signal', reloaded);

      await ctx.setOffline(false);
      const submit = await openEnrich(page, customer.id);
      await expect(page.getByText(DRAFT_RESTORED, { exact: true })).toBeVisible();
      await expect(contactBox(page)).toHaveValue(contact);
      await expect(notesBox(page)).toHaveValue(notes);
      expect(await editsOf(customer.id), 'nothing was sent').toBe(0);

      await submit.click();
      await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 45_000 });
      const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true, fieldChanges: true } });
      expect(edits.map((e) => e.state)).toEqual(['SUBMITTED']);
      const after = Object.fromEntries((edits[0]!.fieldChanges as Array<{ field: string; after: unknown }>).map((c) => [c.field, c.after]));
      expect(after['customer.contactPerson']).toBe(contact);
      expect(after['customer.notes']).toBe(notes);
      expect(await phoneCopy(page, user.id, customer.id), 'the phone copy is gone once it arrived').toBe('');
      await expectOneSet(edits[0]!.id);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // (e) GPS denied, unavailable, timed out — and the typed point
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(e) GPS denied, unavailable, timed out', () => {
    /** The point he types (in Oman, ~2 km from the fixture's Muscat point). */
    const TYPED = { lat: '23.6012', lng: '58.4105', chip: '23.601200, 58.410500' };

    /**
     * The typed-coordinates panel, after a GPS failure opened it: its refusals,
     * then a point with a reason — the chip says Manual — and, where the gate lets
     * him, the submit carries the point marked MANUAL with his reason.
     */
    async function typedPointWorks(page: Page, customer: FixtureCustomer, reason: string): Promise<void> {
      const lat = page.getByLabel(/^Latitude/);
      const lng = page.getByLabel(/^Longitude/);
      const why = page.getByLabel(/^Why didn.t GPS work\?/);
      const save = page.getByRole('button', { name: 'Save manual location', exact: true });
      await expect(lat, 'the panel is open, no extra tap').toBeVisible();
      await save.click();
      await expect(page.getByText(GPS_MANUAL_NUMBERS, { exact: true })).toBeVisible();
      await lat.fill(TYPED.lat);
      await lng.fill(TYPED.lng);
      await why.fill('gps');
      await save.click();
      await expect(page.getByText(GPS_MANUAL_REASON, { exact: true }), 'a reason of 5+ characters').toBeVisible();
      await why.fill(reason);
      await save.click();
      const chip = page.locator('[data-accuracy-band="manual"]');
      await expect(chip).toContainText(TYPED.chip);
      await expect(chip).toContainText('Manual');
      await expect(lat, 'the panel closes').toHaveCount(0);

      if (!hasR2 || FULL_GATE) {
        note('typed point', `not submitted: ${!hasR2 ? 'the branch needs its shop photo (R2)' : CORE_ONLY}`);
        return;
      }
      const submit = page.getByRole('button', { name: SUBMIT, exact: true });
      await expect(submit, 'a typed point with a reason may be submitted').toBeEnabled();
      await submit.click();
      await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 45_000 });
      const edit = await db.customerEdit.findFirstOrThrow({ where: { customerId: customer.id }, select: { id: true, state: true, fieldChanges: true } });
      expect(edit.state).toBe('SUBMITTED');
      const changes = edit.fieldChanges as Array<{ field: string; after: unknown; gpsSource?: string; gpsManualReason?: string }>;
      const b = customer.branch.id;
      expect(changes.find((c) => c.field === `branch.${b}.gpsLat`), 'marked typed, with his reason, for the approver').toMatchObject({
        after: Number(TYPED.lat),
        gpsSource: 'MANUAL',
        gpsManualReason: reason,
      });
      expect(changes.find((c) => c.field === `branch.${b}.gpsLng`)).toMatchObject({ after: Number(TYPED.lng), gpsSource: 'MANUAL', gpsManualReason: reason });
      await expectOneSet(edit.id);
    }

    test('permission denied: said at once, the typed-coordinates panel opens; a typed point with a reason goes, marked MANUAL', async ({ browser }) => {
      const s = await addFieldSalesman(world, 'G1', { branch: { photos: ['SHOP'] } });
      await resetLimits({ users: [s.user] });
      const ctx = await contextAs(browser, s.user, { device: 'phone', geolocation: null });
      await ctx.grantPermissions([], { origin: BASE_URL });
      const page = await ctx.newPage();
      await openEnrich(page, s.customer.id);
      expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)).toBe('denied');
      const capture = page.getByRole('button', { name: /^Capture GPS/ });
      await capture.click();
      await expect(page.getByText(GPS_DENIED, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(GPS_MANUAL_PANEL, { exact: true }), 'the panel').toBeVisible();
      await expect(capture, 'he may try again').toBeEnabled();
      note('observation', 'denied: nothing says how to allow location again for the next shop; the panel heading reads "Location unavailable" under "permission denied"');
      await typedPointWorks(page, s.customer, world.name('Location blocked in Chrome on this phone'));
    });

    test('position unavailable (no fix from the phone): said, and the typed point still goes', { tag: ['@cdp'] }, async ({ browser }) => {
      const s = await addFieldSalesman(world, 'G2', { branch: { photos: ['SHOP'] } });
      await resetLimits({ users: [s.user] });
      // Allowed, but no position: the DevTools override with no coordinates is Chromium's POSITION_UNAVAILABLE.
      const ctx = await contextAs(browser, s.user, { device: 'phone', geolocation: null });
      await ctx.grantPermissions(['geolocation'], { origin: BASE_URL });
      const page = await ctx.newPage();
      const cdp = await cdpFor(page);
      await cdp.send('Emulation.setGeolocationOverride', {});
      await openEnrich(page, s.customer.id);
      const capture = page.getByRole('button', { name: /^Capture GPS/ });
      await capture.click();
      // The error line, and the panel heading under it, which says the same.
      await expect(page.getByText(GPS_UNAVAILABLE, { exact: true })).toHaveCount(2, { timeout: 20_000 });
      await expect(capture).toBeEnabled();
      await typedPointWorks(page, s.customer, world.name('No GPS fix inside the souq'));
    });

    test('no fix in time: "Capturing…" until the limit, then "took too long"; the phone never waits without a limit; the typed point still goes', async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await addFieldSalesman(world, 'G3', { branch: { photos: ['SHOP'] } });
      await resetLimits({ users: [s.user] });
      const ctx = await contextAs(browser, s.user, { device: 'phone' });
      const page = await ctx.newPage();
      // Playwright cannot make the GPS time out: a stand-in that answers only when the app's own timeout runs out.
      await page.addInitScript(neverFixGeolocation);
      await openEnrich(page, s.customer.id);
      const capture = page.getByRole('button', { name: /^Capture GPS/ });
      const t0 = Date.now();
      await capture.click();
      await expect(page.getByRole('button', { name: 'Capturing…', exact: true }), 'busy, and no second tap').toBeDisabled();
      await expect(page.getByText(GPS_TIMEOUT, { exact: true })).toBeVisible({ timeout: 60_000 });
      const waited = Date.now() - t0;
      const calls = await geoCalls(page);
      note('waited for a fix', `${waited} ms; asked with ${JSON.stringify(calls)}`);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.timeout, 'a limit: he never waits for ever').not.toBeNull();
      expect(calls[0]!.timeout!, 'and a short one').toBeLessThanOrEqual(30_000);
      expect(waited).toBeGreaterThanOrEqual(calls[0]!.timeout! - 1_000);
      expect(calls[0]!.enableHighAccuracy, 'a shop needs the GPS chip, not the cell tower').toBe(true);
      await expect(capture).toBeEnabled();
      await expect(page.getByText(GPS_MANUAL_PANEL, { exact: true })).toBeVisible();
      await typedPointWorks(page, s.customer, world.name('Phone found no satellites under the roof'));
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // (f) A slow phone: CPU ×6, two cores, Slow 4G
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(f) a slow phone', { tag: ['@cdp'] }, () => {
    let sl: { user: FixtureUser; customer: FixtureCustomer };
    let due: FixtureCustomer[];
    let photoTarget: FixtureCustomer;

    test.beforeAll(async () => {
      test.setTimeout(300_000);
      const s = await addFieldSalesman(world, 'SL');
      due = [];
      for (const k of ['SLD1', 'SLD2', 'SLD3']) {
        due.push(await world.addCustomer({ key: k, phone: true, contact: 'Yusuf Al Kindi', branches: [{ key: 'S', route: s.route.key, day: 'TODAY' }] }));
      }
      photoTarget = await world.addCustomer({ key: 'SLP', phone: true, contact: 'Ahmed Al Lawati', branches: [{ key: 'S', route: s.route.key }] });
      sl = { user: s.user, customer: s.customer };
      await resetLimits({ users: [s.user] });
    });

    const device = (cores: boolean) =>
      `CPU ×${SLOW_PHONE.cpuRate}, ${cores ? `${SLOW_PHONE.cores} cores` : 'cores not overridden (this Chromium refused)'}, Slow 4G (${Math.round(
        (SLOW_PHONE.network.downBytesPerSec * 8) / 1000
      )}/${Math.round((SLOW_PHONE.network.upBytesPerSec * 8) / 1000)} kbps, ${SLOW_PHONE.network.latencyMs} ms)`;

    test('Today: the first load and a reload, timed', async ({ browser }) => {
      test.setTimeout(300_000);
      const page = await (await contextAs(browser, sl.user, { device: 'phone' })).newPage();
      const { cdp, cores } = await slowPhone(page);
      note('device', device(cores));
      let first = 0;
      let again = 0;
      try {
        const heading = page.getByRole('heading', { level: 2, name: `Today's visits (${due.length})`, exact: true });
        let t0 = Date.now();
        await page.goto('/today', { waitUntil: 'commit' });
        await expect(heading).toBeVisible({ timeout: 120_000 });
        first = Date.now() - t0;
        await page.waitForLoadState('load', { timeout: 120_000 });
        note('timing: Today, first load', `list visible ${first} ms · ${fmtTimings(await pageTimings(page))}`);
        for (const c of due) await expect(page.getByRole('heading', { level: 3, name: c.legalName, exact: true })).toBeVisible();

        t0 = Date.now();
        await page.reload({ waitUntil: 'commit' });
        await expect(heading).toBeVisible({ timeout: 120_000 });
        again = Date.now() - t0;
        await page.waitForLoadState('load', { timeout: 120_000 });
        note('timing: Today, reload', `list visible ${again} ms · ${fmtTimings(await pageTimings(page))}`);
      } finally {
        await restoreDevice(cdp);
      }
      expect(first, 'first load, within a generous budget').toBeLessThanOrEqual(BUDGET.todayFirstMs);
      expect(again, 'reload, within a generous budget').toBeLessThanOrEqual(BUDGET.todayReloadMs);
    });

    test('customer search: the list, then one shop by name, timed', async ({ browser }) => {
      test.setTimeout(300_000);
      const page = await (await contextAs(browser, sl.user, { device: 'phone' })).newPage();
      const { cdp, cores } = await slowPhone(page);
      note('device', device(cores));
      const target = sl.customer;
      let list = 0;
      let search = 0;
      try {
        const box = page.getByRole('searchbox', { name: 'Search customers' });
        const t0 = Date.now();
        await page.goto('/customers', { waitUntil: 'commit' });
        await expect(box).toBeVisible({ timeout: 120_000 });
        await expect(page.locator('main article')).toHaveCount(due.length + 2, { timeout: 120_000 });
        list = Date.now() - t0;
        await settled(page);
        note('timing: Customers, first load', `list visible ${list} ms, settled ${Date.now() - t0} ms · ${fmtTimings(await pageTimings(page))}`);

        await box.fill(target.legalName);
        const t1 = Date.now();
        await page.getByRole('button', { name: 'Filter', exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('q'), { timeout: 120_000 }).toBe(target.legalName);
        await expect(page.locator('main article')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByRole('heading', { name: target.legalName, exact: true })).toBeVisible();
        search = Date.now() - t1;
        note('timing: search', `${search} ms from Filter to the one card`);
      } finally {
        await restoreDevice(cdp);
      }
      expect(list).toBeLessThanOrEqual(BUDGET.customersListMs);
      expect(search).toBeLessThanOrEqual(BUDGET.searchMs);
    });

    test('the enrich form: open, type, the phone copy saved, Submit answered — timed', async ({ browser }) => {
      notRunHere(FULL_GATE, CORE_ONLY);
      test.setTimeout(300_000);
      const page = await (await contextAs(browser, sl.user, { device: 'phone' })).newPage();
      const { cdp, cores } = await slowPhone(page);
      note('device', device(cores));
      const { user, customer } = sl;
      const contact = world.name('Nasser Al Rawahi');
      let usable = 0;
      let submitted = 0;
      try {
        const submit = page.getByRole('button', { name: SUBMIT, exact: true });
        const t0 = Date.now();
        await page.goto(`/customers/${customer.id}/edit`, { waitUntil: 'commit' });
        await expect(submit).toBeVisible({ timeout: 120_000 });
        const shown = Date.now() - t0;
        await settled(page);
        await contactBox(page).fill(contact);
        // The autosave runs only once React has the form: the phone copy is "usable".
        await expect.poll(() => phoneCopy(page, user.id, customer.id), { timeout: 120_000 }).toContain(contact);
        usable = Date.now() - t0;
        note('timing: enrich form', `shown ${shown} ms · typed and kept on the phone ${usable} ms · ${fmtTimings(await pageTimings(page))}`);

        await expect(submit).toBeEnabled();
        const t1 = Date.now();
        await submit.click();
        await expect(page).toHaveURL(new RegExp(`/customers/${customer.id}$`), { timeout: 120_000 });
        await expect(page.getByRole('heading', { level: 1, name: customer.legalName, exact: true })).toBeVisible({ timeout: 120_000 });
        submitted = Date.now() - t1;
        note('timing: submit', `${submitted} ms from the tap to the customer page`);
      } finally {
        await restoreDevice(cdp);
      }
      const edits = await db.customerEdit.findMany({ where: { customerId: customer.id }, select: { id: true, state: true } });
      expect(edits.map((e) => e.state), 'answered inside the phone’s 30 s, once').toEqual(['SUBMITTED']);
      await expectOneSet(edits[0]!.id);
      expect(usable).toBeLessThanOrEqual(BUDGET.enrichUsableMs);
      expect(submitted).toBeLessThanOrEqual(BUDGET.submitToNextPageMs);
    });

    test('a 12 MP camera photo: compression and upload, timed', async ({ browser }) => {
      notRunHere(!hasR2, 'photo uploads need R2');
      test.setTimeout(480_000);
      const page = await (await contextAs(browser, sl.user, { device: 'phone' })).newPage();
      noteR2CorsRefusal(page);
      await page.goto('/today');
      // Made before the CPU is slowed: the camera hands over a finished file.
      const camera = await cameraJpeg(page, 4000, 3000);
      note('camera file', `${Math.round(camera.length / 1024)} KB, 4000×3000`);
      const { cdp, cores } = await slowPhone(page);
      note('device', device(cores));
      let compress = 0;
      let total = 0;
      try {
        // Not openEnrich: on this phone the page's load event may come later than its 60 s default.
        await page.goto(`/customers/${photoTarget.id}/edit`, { waitUntil: 'commit', timeout: 120_000 });
        await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toBeVisible({ timeout: 120_000 });
        await settled(page);
        const slot = photoSlot(page, 'Shop front');
        const t0 = Date.now();
        await pickFile(slot, { name: 'IMG_20261008_101500.jpg', mimeType: 'image/jpeg', buffer: camera });
        await expect(slot.getByText(/^Uploading… \d+%$/), 'compressed and hashed: the upload starts').toBeVisible({ timeout: BUDGET.compressMs + 60_000 });
        compress = Date.now() - t0;
        // Until it is up — or has failed, which no longer waiting changes.
        await expect.poll(() => slotState(slot), { timeout: BUDGET.photoMs + 60_000, message: 'the upload ends' }).not.toMatch(/^busy/);
        expect(await slotState(slot), 'up and attached').toBe('attached');
        total = Date.now() - t0;
        await expect(retryOf(slot)).toHaveCount(0);
      } finally {
        await restoreDevice(cdp);
      }
      const photos = await photosBy(sl.user.id);
      const att = photos[photos.length - 1]!;
      note('timing: photo', `compressed in ${compress} ms · up and attached in ${total} ms · ${Math.round(att.bytes / 1024)} KB sent`);
      expect(att.mimeType).toBe('image/jpeg');
      expect(att.bytes).toBeLessThan(3 * 1024 * 1024);
      const served = await fetchAs(page, `/api/photos/${att.id}`);
      expect(served.status).toBe(200);
      const size = jpegSize(served.body);
      expect(size, 'a JPEG').not.toBeNull();
      expect(Math.max(size!.width, size!.height), 'long side').toBeLessThanOrEqual(1920);
      expect(compress).toBeLessThanOrEqual(BUDGET.compressMs);
      expect(total).toBeLessThanOrEqual(BUDGET.photoMs);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // (g) The tab frozen mid-upload, then resumed
  // ════════════════════════════════════════════════════════════════════════════

  test.describe('(g) the tab frozen mid-upload', { tag: ['@cdp'] }, () => {
    /** How long the photo's bytes take to go up: long enough to freeze the tab in the middle. */
    const UPLOAD_S = 40;

    /** Picks a camera photo on a link slow enough to catch it mid-upload; returns once it is past 5 %. */
    async function startSlowUpload(page: Page, slot: Locator): Promise<{ cdp: Awaited<ReturnType<typeof cdpFor>>; pct: number }> {
      const photo = await cameraJpeg(page, 1600, 1200);
      const size = await compressedSizeInBrowser(page, photo);
      const cdp = await cdpFor(page);
      await crawlUplink(cdp, size, UPLOAD_S);
      await pickFile(slot, { name: 'IMG_20261008_111500.jpg', mimeType: 'image/jpeg', buffer: photo });
      await expect.poll(async () => (await uploadPct(slot)) ?? -1, { timeout: 90_000, message: 'mid-upload' }).toBeGreaterThanOrEqual(5);
      return { cdp, pct: (await uploadPct(slot)) ?? -1 };
    }

    test('frozen 20 s (the camera app in front), then resumed: the upload finishes by itself; one Attachment, nothing to retry', async ({ browser }) => {
      notRunHere(!hasR2, 'photo uploads need R2');
      test.setTimeout(420_000);
      const { user, customer, page } = await phoneOf(browser, 'FZ1');
      const counts = chainCounter(page);
      const submit = await openEnrich(page, customer.id);
      const slot = photoSlot(page, 'Shop front');
      const { cdp, pct } = await startSlowUpload(page, slot);
      try {
        const frozen = await freezeFor(page, cdp, 20_000);
        note('freeze', `20 s at ${pct}% · page timer ticks while frozen: ${frozen.beats} · after: ${frozen.visibility}`);
        expect(frozen.beats, 'the tab really was frozen').toBeLessThan(5);
        await page.bringToFront();
        await expect(retakeOf(slot), 'it finishes by itself').toBeVisible({ timeout: 240_000 });
        await expect(retryOf(slot)).toHaveCount(0);
      } finally {
        await restoreDevice(cdp);
      }
      const sent = counts();
      note('requests', JSON.stringify(sent));
      expect(sent.finalize, 'finalized once').toBe(1);
      expect(sent.attach, 'attached once').toBe(1);
      expect(sent.presign, 'within the automatic tries').toBeLessThanOrEqual(PHOTO_TRIES);
      const photos = await photosBy(user.id);
      expect(photos, 'one Attachment').toHaveLength(1);
      const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true } });
      expect(b.shopPhotoId).toBe(photos[0]!.id);
      note('R2 objects', String((await r2ObjectsOf(user.id, [photos[0]!.r2Key])).length));
      await expect(submit, 'nothing holds Submit any more').toBeEnabled();
    });

    test('frozen 60 s — past the 45 s stall limit — then resumed: never stuck "Uploading…"; one Attachment; reloaded, what he typed and the photo are back', async ({ browser }) => {
      notRunHere(!hasR2, 'photo uploads need R2');
      test.setTimeout(480_000);
      const { user, customer, page } = await phoneOf(browser, 'FZ2');
      const counts = chainCounter(page);
      await openEnrich(page, customer.id);
      const contact = world.name('Talib Al Hinai');
      await contactBox(page).fill(contact);
      await expect.poll(() => phoneCopy(page, user.id, customer.id)).toContain(contact);
      const slot = photoSlot(page, 'Shop front');
      const { cdp, pct } = await startSlowUpload(page, slot);
      let ended = 'busy';
      try {
        const frozen = await freezeFor(page, cdp, 60_000);
        note('freeze', `60 s at ${pct}% · page timer ticks while frozen: ${frozen.beats} · after: ${frozen.visibility}`);
        expect(frozen.beats, 'the tab really was frozen').toBeLessThan(5);
        // Back from the camera, on a good link again.
        await emulateNetwork(cdp, { latencyMs: 0, downBytesPerSec: -1, upBytesPerSec: -1 });
        await page.bringToFront();
        const state = async () => ((await retakeOf(slot).count()) ? 'attached' : (await retryOf(slot).count()) ? 'retry' : 'busy');
        await expect.poll(state, { timeout: 240_000, message: 'never stuck "Uploading…"' }).not.toBe('busy');
        ended = await state();
        if (ended === 'retry') {
          note('after the freeze', `Retry upload: "${await slotMessage(slot)}"`);
          // A click needs animation frames, which a tab the freeze hid may not get: the event itself.
          await retryOf(slot).dispatchEvent('click');
          await expect(retakeOf(slot)).toBeVisible({ timeout: 120_000 });
        }
      } finally {
        await restoreDevice(cdp);
      }
      note('after the freeze', `${ended} · requests ${JSON.stringify(counts())}`);
      const photos = await photosBy(user.id);
      expect(photos, 'one Attachment, however it got there').toHaveLength(1);
      const b = await db.branch.findUniqueOrThrow({ where: { id: customer.branch.id }, select: { shopPhotoId: true } });
      expect(b.shopPhotoId).toBe(photos[0]!.id);
      const objects = await r2ObjectsOf(user.id, [photos[0]!.r2Key]);
      expect(objects).toContain(photos[0]!.r2Key);
      note('R2 objects', `${objects.length}${objects.length > 1 ? ' — the stall limit fired on resume and the photo went up again' : ''}`);

      // The phone dropped the frozen tab: reopened, what he typed and the photo are back.
      await page.reload();
      await settled(page);
      await expect(page.getByText(DRAFT_RESTORED, { exact: true })).toBeVisible();
      await expect(contactBox(page)).toHaveValue(contact);
      await expect(retakeOf(photoSlot(page, 'Shop front')), 'the photo is on its slot').toHaveCount(1);
    });
  });
});
