/**
 * HARNESS PROOF — the launch suite's own ground truth, on the phone AND the
 * desktop project (each builds its own standard world):
 *
 *   - every role signs in through the real login page and lands on its home;
 *   - a minted session opens every fixture user's home without signing in;
 *   - the salesman sees exactly his DUE customers on Today (and the no-day list);
 *   - a seeded photo streams back through /api/photos/<id>, scope-checked;
 *   - a seeded update request matches the live row: the app's planner applies
 *     every change, and the supervisor approves it through the UI;
 *   - the API helpers: a photo through presign → R2 PUT → finalize → attach, an
 *     enrich request through /api/forms, and a captured server action that is
 *     refused for the Viewer and runs for the supervisor;
 *   - cleanup leaves zero rows (by suffix and by id, every table touched) and
 *     zero R2 objects under the fixture users' folders;
 *   - cleanup deletes only what is the world's: a bare two-character route code
 *     or username in a registry finds nothing, and rows another world made with
 *     this world's users, route and region are reported and kept — with the
 *     users, route and region they point at — until their owner removes them.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts harness --project=phone --project=desktop
 */
import { expect, request as pwRequest, test } from '@playwright/test';
import type { Role } from '@prisma/client';
import {
  BASE_URL,
  SESSION_COOKIE,
  actionIdFor,
  approvalPlanFor,
  auditFor,
  captureServerAction,
  contextAs,
  createWorld,
  db,
  fetchAs,
  hasR2,
  notRunHere,
  homePathFor,
  installLaunchHooks,
  mintingProven,
  newId,
  notificationsFor,
  receiptEditId,
  replayServerAction,
  requireLaunchEnv,
  seedUpdateEdit,
  signInViaUi,
  snapshot,
  standardWorld,
  submitEnrichViaApi,
  totalOf,
  uploadPhotoViaApi,
  type World,
} from './support';

/** The h1 each role's landing page shows (lib/role-home.ts sends each role there). */
const HOME_HEADING: Record<Role, RegExp> = {
  SALESMAN: /^Good day, Salim$/,
  SUPERVISOR: /^Approval queue$/,
  ACCOUNTANT: /^Approval queue$/,
  FINANCE_MANAGER: /^Approval queue$/,
  GM: /^Approval queue$/,
  MANAGER: /^Dashboard$/,
  VIEWER: /^Dashboard$/,
  STEWARD: /^Import Excel$/,
};

/** One account of every role. */
const ONE_PER_ROLE = ['SA', 'SUP', 'ACC1', 'FM1', 'GM1', 'M1', 'STW', 'VW'];

const homeUrl = (role: Role) => new RegExp(`${homePathFor(role).replace(/\//g, '\\/')}(\\?|$)`);

test.describe('launch harness', { tag: ['@phone', '@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('hn');
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    // Idempotent: a no-op after the last test cleaned up; the real cleanup when a test failed first.
    if (world) await world.cleanup();
  });

  test('every role signs in through the login page and lands on its home page', async ({ browser }) => {
    test.setTimeout(420_000);
    for (const [i, key] of ONE_PER_ROLE.entries()) {
      const u = world.user(key);
      const ctx = await contextAs(browser, null);
      const page = await ctx.newPage();
      await signInViaUi(page, u.username, u.password, { ip: world.ip(i + 1) });
      await expect(page, `${key} (${u.role}) lands on ${homePathFor(u.role)}`).toHaveURL(homeUrl(u.role));
      await expect(page.getByRole('heading', { level: 1, name: HOME_HEADING[u.role] })).toBeVisible();
      const cookie = (await ctx.cookies()).find((c) => c.name === SESSION_COOKIE);
      expect(cookie, `${key}: the session cookie is stored`).toBeTruthy();
      expect(cookie!.secure && cookie!.httpOnly, `${key}: the session cookie is Secure and HttpOnly`).toBe(true);
      await ctx.close();
    }
    // Each real sign-in wrote its own LOGIN audit row (the cleanup must remove them).
    const logins = await db.auditLog.count({
      where: { action: 'LOGIN', actorId: { in: ONE_PER_ROLE.map((k) => world.user(k).id) } },
    });
    expect(logins).toBe(ONE_PER_ROLE.length);
  });

  test('a minted session opens every fixture user’s home without a sign-in', async ({ browser }) => {
    notRunHere(!mintingProven(), 'global setup could not prove minted cookies on this server');
    test.setTimeout(300_000);
    for (const u of world.users()) {
      const ctx = await contextAs(browser, u, { auth: 'mint' });
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page, `${u.key} (${u.role})`).toHaveURL(homeUrl(u.role));
      await expect(page.getByRole('heading', { level: 1, name: HOME_HEADING[u.role] })).toBeVisible();
      await ctx.close();
    }
  });

  test('the salesman sees his DUE customers on Today, and nothing off his route or day', async ({ browser }) => {
    const ctx = await contextAs(browser, world.user('SA'));
    const page = await ctx.newPage();
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 2, name: "Today's visits (2)", exact: true })).toBeVisible();
    for (const k of ['DUE1', 'DUE2']) {
      await expect(page.getByRole('heading', { level: 3, name: world.customer(k).legalName, exact: true })).toBeVisible();
    }
    for (const k of ['OTHERDAY', 'NODAY1', 'NODAY2', 'GAPS', 'FULL', 'CRED', 'MULTI', 'CLOSEDB', 'ARCH', 'DELETED', 'BONLY']) {
      await expect(page.getByText(world.customer(k).legalName), `${k} is not due today on route A`).toHaveCount(0);
    }
    // Live branches on route A of live customers: everything but ARCH, DELETED and the route-B shops.
    await expect(page.getByText('Route branches', { exact: true }).locator('xpath=..')).toContainText('11');

    await page.goto('/today?view=no-day');
    await expect(page.getByRole('heading', { level: 2, name: 'Branches with no visit day (7)', exact: true })).toBeVisible();
    for (const k of ['NODAY1', 'NODAY2', 'GAPS']) {
      await expect(page.getByText(world.customer(k).legalName, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText(world.customer('DUE1').legalName)).toHaveCount(0);

    // The other region's salesman: his own route-B shop, nobody else's.
    const sb = await contextAs(browser, world.user('SB'));
    const sbPage = await sb.newPage();
    await sbPage.goto('/today');
    await expect(sbPage.getByRole('heading', { level: 2, name: "Today's visits (1)", exact: true })).toBeVisible();
    await expect(sbPage.getByRole('heading', { level: 3, name: world.customer('BONLY').legalName, exact: true })).toBeVisible();
    await expect(sbPage.getByText(world.customer('DUE1').legalName)).toHaveCount(0);
  });

  test('a seeded photo streams back through /api/photos/<id>, scope-checked', async ({ browser }) => {
    notRunHere(!hasR2, 'R2 is not configured');
    const full = world.customer('FULL');
    expect(full.photos.map((p) => p.wire).sort()).toEqual(['CR', 'SHOP', 'SIGNBOARD']);
    const shop = full.photos.find((p) => p.wire === 'SHOP')!;

    const ctx = await contextAs(browser, world.user('SA'));
    const page = await ctx.newPage();
    await page.goto(`/customers/${full.id}`);
    const res = await fetchAs(page, `/api/photos/${shop.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(Number(res.headers['content-length'])).toBe(shop.size);
    expect(res.body.equals(shop.bytes), 'the bytes stored in R2 come back unchanged').toBe(true);

    // The profile renders it: a real, decodable image.
    const img = page.locator(`img[src="/api/photos/${shop.id}"]`);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBe(16);

    // Out of scope (route B, region R2): the same id is "not found".
    const sb = await contextAs(browser, world.user('SB'));
    const sbPage = await sb.newPage();
    await sbPage.goto('/today');
    expect((await fetchAs(sbPage, `/api/photos/${shop.id}`)).status).toBe(404);

    // Signed out: refused.
    const anon = await pwRequest.newContext({ baseURL: BASE_URL });
    expect((await anon.get(`/api/photos/${shop.id}`)).status()).toBe(401);
    await anon.dispose();
  });

  test('a seeded update request matches the live row: it plans clean and the supervisor approves it', async ({ browser }) => {
    notRunHere(!hasR2, 'the approval gate needs FULL’s shop photo, which needs R2');
    const contact = world.name('Contact');
    const { id, fieldChanges } = await seedUpdateEdit(world, {
      customer: 'FULL',
      submitter: 'SA',
      patch: { customer: { contactPerson: contact }, branches: [{ branch: 'FULL', openingHours: '07:00-23:00' }] },
    });
    expect(fieldChanges.map((c) => c.field)).toEqual(['customer.contactPerson', `branch.${world.branch('FULL').id}.openingHours`]);
    expect(await approvalPlanFor(id)).toEqual({ apply: fieldChanges.map((c) => c.field), stale: [], dropped: [] });

    // M1 is SA's supervisor; his queue shows it, M5's (the other region) does not.
    const m5 = await contextAs(browser, world.user('M5'));
    const m5Page = await m5.newPage();
    await m5Page.goto('/approvals');
    await expect(m5Page.getByRole('heading', { level: 1, name: 'Approval queue' })).toBeVisible();
    await expect(m5Page.getByText(world.customer('FULL').legalName)).toHaveCount(0);

    const ctx = await contextAs(browser, world.user('M1'));
    const page = await ctx.newPage();
    await page.goto('/approvals');
    await expect(page.getByText(world.customer('FULL').legalName).first()).toBeVisible();
    await page.goto(`/approvals/${id}`);
    await page.getByRole('button', { name: /^✓ Approve$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Approve this edit?');
    await dialog.getByRole('button', { name: /^Approve$/ }).click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/);

    const after = await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true, reviewedById: true } });
    expect(after).toEqual({ state: 'APPROVED', reviewedById: world.user('M1').id });
    const live = await db.customer.findUniqueOrThrow({
      where: { id: world.customer('FULL').id },
      select: { contactPerson: true, branches: { select: { openingHours: true } } },
    });
    expect(live.contactPerson).toBe(contact);
    expect(live.branches[0]!.openingHours).toBe('07:00-23:00');
  });

  test('the API helpers upload a photo and send an enrich request; a captured approval replays as the right user only', async ({ browser }) => {
    notRunHere(!hasR2, 'the upload and the approval gate need R2');
    test.setTimeout(300_000);
    const sa = world.user('SA');
    const m1 = world.user('M1');
    const full = world.customer('FULL');
    const saCtx = await contextAs(browser, sa);
    const saPage = await saCtx.newPage();
    await saPage.goto('/today');

    // 1. presign → PUT to R2 → finalize → attach, as the phone does it; the key is SA's own folder.
    const noDay = world.branch('NODAY1');
    const up = await uploadPhotoViaApi(saPage, world, { kind: 'SHOP', attach: { branchId: noDay.id, slot: 'SHOP' } });
    expect(up.key).toMatch(new RegExp(`^\\d{4}/\\d{2}/\\d{2}/${sa.id}/SHOP/[0-9a-f-]{36}\\.jpg$`));
    expect(up.deduped).toBe(false);
    expect(up.attached).toMatchObject({ status: 200, ok: true });
    const slot = await db.branch.findUniqueOrThrow({ where: { id: noDay.id }, select: { shopPhotoId: true } });
    expect(slot.shopPhotoId).toBe(up.attachmentId);
    const back = await fetchAs(saPage, `/api/photos/${up.attachmentId}`);
    expect(back.status).toBe(200);
    expect(back.body.equals(up.bytes), 'the uploaded bytes come back unchanged').toBe(true);

    // 2. An enrich request over /api/forms/customer-edit (FULL's seeded request was approved above).
    const contact = world.name('Api contact');
    const sent = await submitEnrichViaApi(saPage, { customerId: full.id, customer: { contactPerson: contact } }, { world });
    expect(sent, JSON.stringify(sent)).toMatchObject({ status: 200, ok: true });
    const editId = receiptEditId(sent)!;
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true, pendingRole: true, submittedById: true } })).toEqual({
      state: 'SUBMITTED',
      pendingRole: 'SUPERVISOR',
      submittedById: sa.id,
    });
    await expect.poll(async () => (await notificationsFor({ editId })).map((n) => n.userId)).toContain(m1.id);

    // 3. M1 presses Approve; the POST is captured and aborted in the browser — it never reaches the server.
    const m1Ctx = await contextAs(browser, m1);
    const m1Page = await m1Ctx.newPage();
    await m1Page.goto(`/approvals/${editId}`);
    await m1Page.getByRole('button', { name: /^✓ Approve$/ }).click();
    const dialog = m1Page.getByRole('dialog');
    await expect(dialog).toContainText('Approve this edit?');
    const action = await captureServerAction(m1Page, () => dialog.getByRole('button', { name: /^Approve$/ }).click());
    await m1Page.close();
    expect(action.url).toBe(`${BASE_URL}/approvals/${editId}`);
    expect(action.actionId).toBe(actionIdFor('approveEditAndGoAction', 'app/(app)/approvals/[id]/page'));
    // Still pending a few seconds later: the captured click did not run.
    await new Promise((r) => setTimeout(r, 3_000));
    const pending = { state: 'SUBMITTED', reviewedById: null };
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true, reviewedById: true } })).toEqual(pending);
    const rows = { CustomerEdit: { id: editId }, Customer: { id: full.id } };
    const untouched = await snapshot(['CustomerEdit', 'Customer'], rows);

    // Replayed by the Viewer: refused for his role, and nothing changed.
    const vw = await contextAs(browser, world.user('VW'));
    const asViewer = await replayServerAction(vw.request, action);
    expect(asViewer, asViewer.text.slice(0, 300)).toMatchObject({ refused: true, notFound: false });
    expect(asViewer.code).not.toBe('NOT_PENDING');
    expect(asViewer.message ?? '').not.toBe('');
    expect(await snapshot(['CustomerEdit', 'Customer'], rows)).toBe(untouched);

    // Replayed by M1 himself: it runs, exactly as the click would have.
    const asM1 = await replayServerAction(m1Ctx.request, action);
    expect(asM1, asM1.text.slice(0, 300)).toMatchObject({ refused: false, notFound: false });
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true, reviewedById: true } })).toEqual({
      state: 'APPROVED',
      reviewedById: m1.id,
    });
    expect((await db.customer.findUniqueOrThrow({ where: { id: full.id }, select: { contactPerson: true } })).contactPerson).toBe(contact);
    expect((await auditFor({ entityId: editId, actorId: m1.id })).length).toBeGreaterThan(0);
  });

  test('cleanup leaves zero rows and zero R2 objects behind', async () => {
    test.setTimeout(300_000);
    const out = await world.cleanup();
    expect(out.warnings, 'cleanup warnings').toEqual([]);
    expect(out.deleted.User).toBe(world.users().length);
    expect(out.deleted.Customer).toBe(world.customers().length);
    // FULL's three seeded photos and the one uploaded through the API.
    if (hasR2) expect(out.deleted.r2Objects).toBe(4);
    // Counted again, independently: by id and by suffix in every table the suite touches.
    const left = await world.residue();
    expect(left, 'residue by suffix and id').toEqual(Object.fromEntries(Object.keys(left).map((k) => [k, 0])));
    expect(totalOf(left)).toBe(0);
    expect(world.registry.data.clean).toBe(true);
  });
});

test.describe('launch harness: cleanup deletes only the world’s own rows', { tag: ['@phone', '@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  /** A: a two-character route (no suffix in its code or its salesman's username), a steward, a manager. */
  let a: World;
  /** B: a world whose registry wrongly names A's bare code and username (the old two-world race). */
  let b: World;
  /** C: rows made WITH A's users, route and region — foreign to A, C's own. */
  let c: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    a = await createWorld('oa', {
      regions: [{ key: 'R' }],
      routes: [{ key: 'TWO', region: 'R', twoChar: true }],
      users: [
        { key: 'S', role: 'SALESMAN', route: 'TWO' },
        { key: 'STW', role: 'STEWARD' },
        { key: 'M', role: 'MANAGER', regions: ['R'] },
      ],
    });
    b = await createWorld('ob', { regions: [{ key: 'R' }], routes: [{ key: 'X', region: 'R' }] });
    c = await createWorld('oc', { regions: [{ key: 'R' }] });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    // C before A: A's rows are held while C's rows point at them.
    for (const w of [b, c, a]) if (w) await w.cleanup();
  });

  test('a bare two-character code or username in a registry finds nothing', async () => {
    const two = a.route('TWO');
    const s = a.user('S');
    expect(two.code).toMatch(/^[ZY][0-9A-Z]$/);
    expect(s.username).toBe(two.code.toLowerCase());
    expect(a.carriesSuffix(s.username), 'the salesman of a two-character route carries no suffix').toBe(false);
    expect(a.registry.data.routeIds).toContain(two.id);
    expect(a.registry.data.userIds).toContain(s.id);

    // Adopting such a value is refused…
    expect(() => b.adopt.routeCode(two.code)).toThrow(/does not carry the world suffix/);
    expect(() => b.adopt.user(s.username)).toThrow(/does not carry the world suffix/);
    // …and one that got into a registry anyway (as the old allocator left it after a P2002) finds nothing.
    b.registry.add('routeCodes', two.code);
    b.registry.add('usernames', s.username);
    const out = await b.cleanup();
    expect(out.warnings).toEqual([]);
    expect(out.deleted.Route).toBe(1);
    expect(out.deleted.User ?? 0).toBe(0);
    expect(b.registry.data.clean).toBe(true);
    expect(b.registry.data.userIds, 'nothing of A was written back into B').toEqual([]);
    expect(b.registry.data.routeIds).not.toContain(two.id);
    // A's route and salesman are untouched — not even deactivated.
    expect(await db.route.findUnique({ where: { id: two.id }, select: { code: true } })).toEqual({ code: two.code });
    expect(await db.user.findUnique({ where: { id: s.id }, select: { isActive: true, ownedRouteId: true } })).toEqual({
      isActive: true,
      ownedRouteId: two.id,
    });
  });

  test('rows another world made with this world’s users, route and region are reported and kept, not deleted', async () => {
    test.setTimeout(300_000);
    const s = a.user('S');
    const stw = a.user('STW');
    const m = a.user('M');
    const two = a.route('TWO');
    const region = a.region('R');
    // C's rows, in C's registry BEFORE the insert (C's cleanup, or the sweep, removes them).
    const ids = { customer: newId(), branch: newId(), edit: newId(), batch: newId(), route: newId() };
    c.adopt.customer(ids.customer);
    c.registry.add('branchIds', ids.branch);
    c.adopt.edit(ids.edit);
    c.adopt.importBatch(ids.batch);
    c.adopt.routeId(ids.route);
    await db.customer.create({
      data: { id: ids.customer, nmwcCode: `000E2E${c.SFX}-901`, legalName: c.name('Foreign Trading'), createdById: s.id },
    });
    await db.branch.create({
      data: {
        id: ids.branch,
        customerId: ids.customer,
        branchCode: `000E2E${c.SFX}-901-01`,
        branchName: c.name('Foreign shop'),
        regionId: region.id,
        routeId: two.id,
        address: 'Way 3012, Al Ghubra North, Muscat',
      },
    });
    await db.route.create({ data: { id: ids.route, code: `E2${c.SFX}9`, name: c.name('Route in A'), regionId: region.id } });
    // A request about C's customer, submitted by A's salesman and decided by A's manager.
    await db.customerEdit.create({
      data: {
        id: ids.edit,
        target: 'CUSTOMER',
        customerId: ids.customer,
        state: 'APPROVED',
        submittedById: s.id,
        submittedAt: new Date(),
        reviewedById: m.id,
        reviewedAt: new Date(),
        fieldChanges: [],
        attachmentChanges: [],
      },
    });
    await db.editApproval.create({
      data: { editId: ids.edit, cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', actorId: m.id },
    });
    await db.importBatch.create({ data: { id: ids.batch, filename: c.name('foreign.xlsx'), uploadedById: stw.id, status: 'READY' } });
    await db.auditLog.create({ data: { actorId: stw.id, action: 'UPDATE', entityType: 'Customer', entityId: ids.customer } });

    // A's cleanup: nothing of C's is deleted; A's users, route and region they point at are kept.
    const out = await a.cleanup();
    expect(a.registry.data.clean).toBe(false);
    const nonZero = Object.fromEntries(Object.entries(out.leftovers).filter(([, n]) => n !== 0));
    expect(nonZero).toEqual({
      User: 3,
      Route: 1,
      Region: 1,
      foreignRoute: 1,
      foreignBranch: 1,
      foreignCustomer: 1,
      foreignCustomerEdit: 1,
      foreignEditApproval: 1,
      foreignImportBatch: 1,
      foreignAuditLog: 1,
    });
    expect(out.warnings.join('\n')).toMatch(/kept 3 world user\(s\)/);
    expect(await db.customer.count({ where: { id: ids.customer } })).toBe(1);
    expect(await db.branch.count({ where: { id: ids.branch } })).toBe(1);
    expect(await db.customerEdit.findUnique({ where: { id: ids.edit }, select: { submittedById: true, reviewedById: true } })).toEqual({
      submittedById: s.id,
      reviewedById: m.id,
    });
    expect(await db.editApproval.count({ where: { editId: ids.edit, actorId: m.id } })).toBe(1);
    expect(await db.importBatch.count({ where: { id: ids.batch } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: ids.customer, actorId: stw.id } })).toBe(1);
    expect(await db.route.count({ where: { id: ids.route } })).toBe(1);
    // A's users are out of every audience, but still there.
    expect(await db.user.count({ where: { id: { in: [s.id, stw.id, m.id] }, isActive: false } })).toBe(3);

    // C removes its own rows; then A cleans to zero, its two-character route found by id.
    const cOut = await c.cleanup();
    expect(cOut.warnings).toEqual([]);
    expect(c.registry.data.clean).toBe(true);
    expect(cOut.deleted).toMatchObject({ Customer: 1, Branch: 1, CustomerEdit: 1, EditApproval: 1, ImportBatch: 1, Route: 1, Region: 1 });
    const again = await a.cleanup();
    expect(again.warnings).toEqual([]);
    expect(again.deleted).toMatchObject({ User: 3, Route: 1, Region: 1 });
    expect(a.registry.data.clean).toBe(true);
    expect(totalOf(await a.residue())).toBe(0);
    expect(await db.route.count({ where: { id: two.id } })).toBe(0);
  });
});
