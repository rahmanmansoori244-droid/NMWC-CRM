/**
 * THE 8-HOUR SIGN-IN LIMIT — the owner's answer of 2026-11-11 (A6): a sign-in
 * lasts at most 8 hours from the moment of signing in, whatever the activity,
 * for every role; then the person signs in again.
 *
 *   - a sign-in past the limit lands on the sign-in page, which says why when
 *     the hint the sign-in left is there, and says nothing when it is not;
 *   - a sign-in through the form sets ONE session cookie that ends no later than
 *     8 hours after it, and more page visits do not move that end; Sign out
 *     removes the hint;
 *   - what happens to work in progress at the limit, on each form, as it really
 *     is: the salesman's new-customer form and customer edit form (kept, and
 *     sent by Try again after signing in in another tab), a photo upload
 *     (presign, finalize and attach answering 401, then Retry upload), and an
 *     approver's typed reason (kept only while the page stays open). The import
 *     promote stopped by the limit is in backoffice.spec.ts, so that its promote
 *     lease never stops another back-office promote.
 *
 * The limit is reached by swapping the context's session for one signed in more
 * than 8 hours ago (support/sign-in-limit-helpers.ts runOutSignIn): the server's
 * own refusal is what the page meets. Nothing waits 8 hours.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts sign-in-limit --project=phone --project=desktop
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  contextAs,
  createWorld,
  db,
  hasR2,
  installLaunchHooks,
  notRunHere,
  OMAN_TODAY,
  requireLaunchEnv,
  resetLimits,
  seedUpdateEdit,
  signInViaUi,
  type World,
} from './support';
import {
  ATTACH_SIGNED_OUT,
  NOT_SIGNED_IN,
  SIGNED_OUT_MESSAGE,
  SIGN_IN_LIMIT_MESSAGE,
  SIGN_IN_LIMIT_MS,
  UPLOAD_SIGNED_OUT,
  dropSignIn,
  hintOf,
  loginNotice,
  runOutSignIn,
  sessionCookies,
  signInInAnotherTab,
} from './support/sign-in-limit-helpers';
import {
  SUBMIT,
  addFieldSalesman,
  adoptSalesmanWork,
  contactBox,
  dropDraftBuckets,
  isR2,
  openEnrich,
  pathIs,
  phoneCopy,
  photoSlot,
  photosBy,
  pickFile,
  pngFile,
  retryOf,
  sentOrAlreadyReceived,
  slotMessage,
  slotState,
  tryAgain,
} from './support/field-faults-helpers';
import { channelWithSubs, deviceCopyKeys, fillCreateForm } from './support/salesman-phone-helpers';
import { approvableCustomer } from './support/approvals-queue-helpers';

/** The salesman's home. */
const TODAY = /\/today(\?|$)/;
const LOGIN = /\/login(\?|$)/;

test.describe('the 8-hour sign-in limit (owner, 2026-11-11)', () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await createWorld('sil', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'A', region: 'R1' }],
      users: [
        { key: 'M1', role: 'MANAGER', regions: ['R1'] },
        { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
        { key: 'S', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      ],
      customers: [
        {
          key: 'C1',
          phone: true,
          contact: 'Yusuf Al Kindi',
          branches: [{ key: 'S', route: 'A', day: 'TODAY' }],
        },
        approvableCustomer('AP1', 'A'),
        approvableCustomer('AP2', 'A'),
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

  /** A signed-out context of this project's device, with a page. */
  async function blankPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await contextAs(browser, null);
    return { ctx, page: await ctx.newPage() };
  }

  // ── 1. The sign-in page ─────────────────────────────────────────────────────

  test(
    'past the limit he lands on the sign-in page: with the sentence when the hint is there, without it when it is not; a sign-in just inside the limit still opens his home',
    { tag: ['@phone', '@desktop'] },
    async ({ browser }) => {
      const s = world.user('S');

      // The server refuses a cookie the browser still sends.
      const a = await blankPage(browser);
      await runOutSignIn(a.ctx, s);
      await a.page.goto('/today');
      await expect(a.page).toHaveURL(LOGIN);
      await expect(loginNotice(a.page), 'one plain sentence, not an error').toHaveText(
        SIGN_IN_LIMIT_MESSAGE
      );
      // No refusal in the form (the route announcer is a role=alert of its own: scoped to main).
      await expect(a.page.getByRole('main').getByRole('alert'), 'no error on the page').toHaveCount(
        0
      );
      await expect(a.page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();

      // The same refused sign-in with no hint (a browser that never had one): the page says nothing about why.
      const b = await blankPage(browser);
      await runOutSignIn(b.ctx, s, { hint: false });
      await b.page.goto(`/customers/${world.customer('C1').id}`);
      await expect(b.page).toHaveURL(LOGIN);
      await b.page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
      await expect(loginNotice(b.page)).toHaveCount(0);

      // As in the field: the browser dropped the cookie at the limit itself, the hint stays.
      const c = await blankPage(browser);
      await dropSignIn(c.ctx);
      await c.page.goto('/today');
      await expect(c.page).toHaveURL(LOGIN);
      await expect(loginNotice(c.page)).toHaveText(SIGN_IN_LIMIT_MESSAGE);

      // Three minutes inside the limit: still signed in, and the sign-in page would not blame the limit.
      const d = await blankPage(browser);
      await runOutSignIn(d.ctx, s, { agoMs: SIGN_IN_LIMIT_MS - 3 * 60_000 });
      await d.page.goto('/today');
      await expect(d.page).toHaveURL(TODAY);
      await expect(d.page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  );

  test(
    'a sign-in through the form sets one session cookie that ends no later than 8 hours after it and does not move with more visits; Sign out removes the hint',
    { tag: ['@phone', '@desktop'] },
    async ({ browser }) => {
      const s = world.user('S');
      const ip = world.ip(test.info().project.name === 'phone' ? 1 : 2);
      await resetLimits({ users: [s], ips: [ip] });
      const { ctx, page } = await blankPage(browser);

      const t0 = Date.now();
      await signInViaUi(page, s.username, s.password, { ip, expectUrl: TODAY });
      const t1 = Date.now();
      const first = await sessionCookies(ctx);
      expect(
        first.map((c) => c.name),
        'one session cookie, no chunks'
      ).toHaveLength(1);
      const ends = first[0]!.expires;
      expect(first[0]!.httpOnly).toBe(true);
      test
        .info()
        .annotations.push({
          type: 'session cookie',
          description: `ends ${Math.round(ends - t1 / 1000)} s after the sign-in (8 h = ${SIGN_IN_LIMIT_MS / 1000} s)`,
        });
      expect(ends, 'never later than 8 hours after the sign-in').toBeLessThanOrEqual(
        (t1 + SIGN_IN_LIMIT_MS) / 1000 + 1
      );
      expect(ends, 'and not much earlier').toBeGreaterThanOrEqual(
        (t0 + SIGN_IN_LIMIT_MS) / 1000 - 5
      );
      // The hint names the same end, for the sign-in page.
      const hint = await hintOf(ctx);
      expect(hint, 'the sign-in left the hint').toBeDefined();
      expect(hint!.httpOnly).toBe(true);
      expect(
        Math.abs(Number(hint!.value) - ends * 1000),
        'the hint ends with the cookie'
      ).toBeLessThan(2_000);

      // More visits, a reload, another page: the end does not move (no sliding 8 hours).
      for (const path of ['/customers', '/today', `/customers/${world.customer('C1').id}`]) {
        await page.goto(path);
        await expect(page, path).not.toHaveURL(LOGIN);
      }
      await page.reload();
      const later = await sessionCookies(ctx);
      expect(
        later.map((c) => [c.name, c.expires]),
        'the same single cookie, the same end'
      ).toEqual([[first[0]!.name, ends]]);

      // Sign out: the hint goes with the session, so the sign-in page does not blame the limit.
      await page.goto('/today');
      await page.getByRole('banner').getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page).toHaveURL(LOGIN);
      expect(await hintOf(ctx), 'Sign out removes the hint').toBeUndefined();
      expect(
        (await sessionCookies(ctx)).filter((c) => c.value !== ''),
        'and the session'
      ).toEqual([]);
      await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
      await expect(loginNotice(page)).toHaveCount(0);
    }
  );

  // ── 2. Work in progress at the limit ────────────────────────────────────────

  test(
    'new customer: the sign-in runs out before Submit — told to sign in in another tab, nothing sent, what he typed kept; after signing in there, Try again sends it once',
    { tag: ['@phone'] },
    async ({ browser }) => {
      notRunHere(!hasR2, 'the new-customer form needs three photos (R2)');
      test.setTimeout(360_000);
      const { user } = await addFieldSalesman(world, 'NC');
      const ip = world.ip(3);
      await resetLimits({ users: [user], ips: [ip] });
      const ctx = await contextAs(browser, user, { device: 'phone' });
      const page = await ctx.newPage();
      const ch = await channelWithSubs();
      const [phone] = await world.allocPhones(1);
      const name = world.name('Al Noor Stores');
      await fillCreateForm(page, {
        legalName: name,
        crNumber: `CR${world.SFX}L1`,
        phone: phone!,
        contact: 'Salim Al Hinai',
        channelLabel: ch.label,
        day: OMAN_TODAY,
        address: world.name('Way 3310, Al Khoud'),
      });
      const creates = () =>
        db.customerEdit.count({ where: { submittedById: user.id, process: 'CREATE' } });
      const copyKeys = () => deviceCopyKeys(page, `nmwc:create:${user.id}:`);
      expect(await copyKeys(), 'the form keeps a copy on the phone').not.toEqual([]);

      await runOutSignIn(ctx, user);
      await page.getByRole('button', { name: SUBMIT, exact: true }).click();
      await expect(page.getByText(SIGNED_OUT_MESSAGE, { exact: true })).toBeVisible();
      await expect(tryAgain(page)).toBeEnabled();
      expect(await creates(), 'nothing was sent').toBe(0);
      await expect(page, 'he stays on the form').toHaveURL(/\/customers\/new/);
      await expect(page.getByLabel('Legal name *', { exact: true })).toHaveValue(name);
      await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(
        'Salim Al Hinai'
      );
      expect(await copyKeys(), 'the copy on the phone is still there').not.toEqual([]);

      const said = await signInInAnotherTab(ctx, user, ip);
      expect(said, 'the other tab’s sign-in page says why').toBe(SIGN_IN_LIMIT_MESSAGE);
      expect(await sessionCookies(ctx), 'one session again, the new one').toHaveLength(1);
      await tryAgain(page).click();
      await expect(page).toHaveURL(/\/work$/, { timeout: 30_000 });
      const reqs = await db.customerEdit.findMany({
        where: { submittedById: user.id, process: 'CREATE' },
        select: { state: true, customerDraft: { select: { legalName: true } } },
      });
      expect(
        reqs.map((r) => [r.state, r.customerDraft?.legalName]),
        'sent once, as typed'
      ).toEqual([['SUBMITTED', name]]);
    }
  );

  test(
    'customer edit: the sign-in runs out before Submit — told to sign in in another tab, the edit kept on the phone; Try again sends it once',
    { tag: ['@phone'] },
    async ({ browser }) => {
      const { user, customer } = await addFieldSalesman(world, 'ED');
      const ip = world.ip(4);
      await resetLimits({ users: [user], ips: [ip] });
      const ctx = await contextAs(browser, user, { device: 'phone' });
      const page = await ctx.newPage();
      const submit = await openEnrich(page, customer.id);
      const contact = world.name('Rashid Al Amri');
      await contactBox(page).fill(contact);
      await expect(submit).toBeEnabled();
      await expect
        .poll(() => phoneCopy(page, user.id, customer.id), {
          message: 'the edit is kept on the phone',
        })
        .toContain(contact);

      await runOutSignIn(ctx, user);
      await submit.click();
      await expect(page.getByText(SIGNED_OUT_MESSAGE, { exact: true })).toBeVisible();
      expect(
        await db.customerEdit.count({ where: { customerId: customer.id } }),
        'nothing was sent'
      ).toBe(0);
      await expect(contactBox(page)).toHaveValue(contact);
      expect(
        await phoneCopy(page, user.id, customer.id),
        'the copy on the phone is still there'
      ).toContain(contact);

      expect(await signInInAnotherTab(ctx, user, ip)).toBe(SIGN_IN_LIMIT_MESSAGE);
      await tryAgain(page).click();
      expect(await sentOrAlreadyReceived(page, customer.id)).toBe('sent');
      const edits = await db.customerEdit.findMany({
        where: { customerId: customer.id },
        select: { state: true, submittedById: true },
      });
      expect(edits).toEqual([{ state: 'SUBMITTED', submittedById: user.id }]);
    }
  );

  test(
    'a photo at the limit: presign, finalize or attach answering 401 says to sign in in another tab and keeps the photo; Retry upload then attaches it once',
    { tag: ['@phone'] },
    async ({ browser }) => {
      notRunHere(!hasR2, 'photo uploads need R2');
      test.setTimeout(300_000);
      const { user, customer } = await addFieldSalesman(world, 'PH');
      const ip = world.ip(5);
      await resetLimits({ users: [user], ips: [ip] });
      const ctx = await contextAs(browser, user, { device: 'phone' });
      const page = await ctx.newPage();
      await openEnrich(page, customer.id);
      const status = (path: string) => {
        const seen: number[] = [];
        page.on('response', (r) => {
          if (new URL(r.url()).pathname === path) seen.push(r.status());
        });
        return seen;
      };
      const presign = status('/api/photos/presign');
      const finalize = status('/api/photos/finalize');
      const attach = status('/api/photos/attach');
      const untilState = async (slot: ReturnType<typeof photoSlot>, want: RegExp, what: string) =>
        expect.poll(() => slotState(slot), { timeout: 90_000, message: what }).toMatch(want);

      // (1) Presign: the sign-in ran out before the photo was picked.
      const shop = photoSlot(page, 'Shop front');
      await runOutSignIn(ctx, user);
      await pickFile(shop, pngFile('limit-presign'));
      await untilState(shop, /^retry$/, 'presign 401: Retry upload');
      expect(await slotMessage(shop)).toBe(UPLOAD_SIGNED_OUT);
      expect(presign, 'presign answered 401').toContain(401);
      expect(await photosBy(user.id), 'nothing was stored').toHaveLength(0);
      expect(await signInInAnotherTab(ctx, user, ip)).toBe(SIGN_IN_LIMIT_MESSAGE);
      await retryOf(shop).click();
      await untilState(shop, /^attached$/, 'Retry upload attaches it');

      // (2) Finalize: the sign-in runs out while the photo goes up to storage (the PUT needs no sign-in).
      const sign = photoSlot(page, 'Signboard');
      let swapped = false;
      const r2 = (u: URL) => isR2(u);
      await page.route(r2, async (route) => {
        if (route.request().method() === 'PUT' && !swapped) {
          swapped = true;
          await runOutSignIn(ctx, user);
        }
        await route.continue();
      });
      await pickFile(sign, pngFile('limit-finalize'));
      await untilState(sign, /^retry$/, 'finalize 401: Retry upload');
      await page.unroute(r2);
      expect(await slotMessage(sign)).toBe(UPLOAD_SIGNED_OUT);
      expect(finalize, 'finalize answered 401').toContain(401);
      expect(
        (await photosBy(user.id)).map((p) => p.kind),
        'only the first photo is stored'
      ).toEqual(['SHOP']);
      await signInInAnotherTab(ctx, user, ip);
      await retryOf(sign).click();
      await untilState(sign, /^attached$/, 'Retry upload attaches it');

      // (3) Attach: the photo is stored, and the sign-in runs out before it is put on its slot.
      const other = photoSlot(page, 'Other');
      let held = false;
      const fin = pathIs('/api/photos/finalize');
      await page.route(fin, async (route) => {
        const res = await route.fetch();
        if (!held) {
          held = true;
          await runOutSignIn(ctx, user);
        }
        await route.fulfill({ response: res });
      });
      await pickFile(other, pngFile('limit-attach'));
      await untilState(other, /^retry$/, 'attach 401: Retry upload');
      await page.unroute(fin);
      expect(await slotMessage(other)).toBe(ATTACH_SIGNED_OUT);
      expect(attach, 'attach answered 401').toContain(401);
      await signInInAnotherTab(ctx, user, ip);
      await retryOf(other).click();
      await untilState(other, /^attached$/, 'Retry upload attaches it');

      // One photo per slot, each attached once.
      const photos = await photosBy(user.id);
      expect(photos.map((p) => p.kind).sort()).toEqual(['FREE', 'SHOP', 'SIGNBOARD']);
      const b = await db.branch.findUniqueOrThrow({
        where: { id: customer.branch.id },
        select: { shopPhotoId: true, signboardPhotoId: true },
      });
      expect(b.shopPhotoId).toBe(photos.find((p) => p.kind === 'SHOP')!.id);
      expect(b.signboardPhotoId).toBe(photos.find((p) => p.kind === 'SIGNBOARD')!.id);
      expect(photos.find((p) => p.kind === 'FREE')!.branchExtraId).toBe(customer.branch.id);
    }
  );

  test(
    'an approver’s typed reason at the limit: "Not signed in.", the reason stays while the page is open and goes after signing in elsewhere; a reload loses it (recorded)',
    { tag: ['@desktop'] },
    async ({ browser }) => {
      test.info().annotations.push({
        type: 'recorded behaviour',
        description:
          'The reject reason is not kept on the device (ApproveRejectActions.tsx keeps it in the page only). Past the limit the action answers "Not signed in."; the reason survives only if the approver keeps the page open, signs in in another tab and presses the button again. A reload goes to the sign-in page and then to his home page, and the reason is gone. Reported to the owner by the A6 build; not changed.',
      });
      const m1 = world.user('M1');
      const ip = world.ip(6);
      await resetLimits({ users: [m1], ips: [ip] });
      const kept = (
        await seedUpdateEdit(world, {
          customer: 'AP1',
          submitter: 'S',
          patch: { customer: { contactPerson: world.name('Kept reason') } },
        })
      ).id;
      const lost = (
        await seedUpdateEdit(world, {
          customer: 'AP2',
          submitter: 'S',
          patch: { customer: { contactPerson: world.name('Lost reason') } },
        })
      ).id;
      const reason = world.name('The contact person is the shop owner’s brother, please check');
      const stateOf = (id: string) =>
        db.customerEdit.findUniqueOrThrow({
          where: { id },
          select: { state: true, decisionReason: true },
        });

      // (a) He keeps the page open.
      const ctx = await contextAs(browser, m1, { device: 'desktop' });
      const page = await ctx.newPage();
      await page.goto(`/approvals/${kept}`);
      await page.getByRole('button', { name: /^✗ Reject$/ }).click();
      const box = page.locator('textarea[name="reason"]');
      await box.fill(reason);
      await runOutSignIn(ctx, m1);
      await page.getByRole('button', { name: /^✗ Send back to / }).click();
      await expect(page.getByRole('alert').filter({ hasText: NOT_SIGNED_IN })).toHaveText(
        NOT_SIGNED_IN
      );
      await expect(page, 'he stays on the request').toHaveURL(new RegExp(`/approvals/${kept}$`));
      await expect(box, 'what he typed is still there').toHaveValue(reason);
      expect(await stateOf(kept), 'nothing was decided').toMatchObject({ state: 'SUBMITTED' });
      expect(await signInInAnotherTab(ctx, m1, ip)).toBe(SIGN_IN_LIMIT_MESSAGE);
      await page.getByRole('button', { name: /^✗ Send back to / }).click();
      await expect(page).toHaveURL(/\/approvals(\?|$)/, { timeout: 60_000 });
      expect(await stateOf(kept)).toEqual({ state: 'NEEDS_CORRECTION', decisionReason: reason });

      // (b) He reloads instead: the sign-in page, then his home page, and the reason is gone.
      await page.goto(`/approvals/${lost}`);
      await page.getByRole('button', { name: /^✗ Reject$/ }).click();
      await box.fill(reason);
      await runOutSignIn(ctx, m1);
      await page.getByRole('button', { name: /^✗ Send back to / }).click();
      await expect(page.getByRole('alert').filter({ hasText: NOT_SIGNED_IN })).toBeVisible();
      page.once('dialog', (d) => void d.accept().catch(() => undefined));
      await page.reload();
      await expect(page).toHaveURL(LOGIN);
      await expect(loginNotice(page)).toHaveText(SIGN_IN_LIMIT_MESSAGE);
      await signInViaUi(page, m1.username, m1.password, { ip, expectUrl: /\/dashboard(\?|$)/ });
      await page.goto(`/approvals/${lost}`);
      await page.getByRole('button', { name: /^✗ Reject$/ }).click();
      await expect(page.locator('textarea[name="reason"]'), 'the typed reason is gone').toHaveValue(
        ''
      );
      expect(await stateOf(lost)).toMatchObject({ state: 'SUBMITTED' });
    }
  );
});
