/**
 * APPROVALS QUEUE — the Supervisor-step queue as the four Managers who share one
 * region use it; bulk approve and reject; two Managers on one request; close-shop
 * and reactivation requests from the salesman's phone to the decision; who is
 * told; the approval loop on a 360 px phone; Work items and Service status; the
 * photo burst; and the SLA escalation sweep (exclusive).
 *
 * What is asserted is the LAUNCH build's behaviour:
 *   - wave 1: the salesman is told how a reactivation and a close request ended;
 *     "Keep closed" and a refused close are final (REJECTED) and keep his own
 *     reason; a decision settles every other approver's alert for it; a missing
 *     or unusable supervisor falls back to the region's Managers; an escalation
 *     goes only to people who can open the request (never a Steward); the close
 *     form counts its reason trimmed and wires its photo only with an accepted
 *     request;
 *   - the owner decisions of 7 Oct: a Manager sees and decides a request only
 *     when he manages every branch it is about; the dashboard's Pending approval
 *     is his queue; Work's stale list is what he can decide; a customer closes
 *     with its last open shop and is active again when one reopens; late
 *     requests go to the e-mail outbox (e-mail itself stays off in the run).
 *
 * Fixed in the launch candidate and asserted as fixed (no test here is test.fail): after a
 * successful approve or send-back on /approvals/[id] the page no longer prints "NEXT_REDIRECT" in
 * red until the queue loads (aad7065). Owner decision 8 Oct (the Temix code at a new customer's
 * last step) changes nothing here: no test approves a new customer at the Accountant's step.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts approvals-queue --project=phone --project=desktop
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts approvals-queue --project=exclusive --workers=1
 */
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  MUSCAT,
  PORT,
  auditFor,
  closeBranchViaApi,
  contextAs,
  createWorld,
  db,
  expectNoSideScroll,
  fetchAs,
  hasR2,
  hitTest,
  installLaunchHooks,
  notificationsFor,
  receiptEditId,
  requestReactivationViaApi,
  requireLaunchEnv,
  seedPhoto,
  seedUpdateEdit,
  submitCreateViaApi,
  submitEnrichViaApi,
  uniquePng,
  uploadPhotoViaApi,
  workingMinutesAgo,
  type CustomerSpec,
  type DeviceKind,
  type UserSpec,
  type World,
} from './support';
import {
  approvableCustomer,
  bell,
  createRequestViaApi,
  imagesLoaded,
  kpiTile,
  kpiValue,
  queueCard,
  queueOrder,
  seedBranchRequest,
  seedCreateRequest,
  slaBudgetMin,
  slaSweepImpact,
  tallyPhotoResponses,
} from './support/approvals-queue-helpers';

// ── the organisation of the brief ────────────────────────────────────────────
// R1 is shared by four Managers (MCT-like), R2 has its own (M5). S1 reports to
// M1, S2 to M2, S3 to M5.

const GPS = { lat: MUSCAT.lat, lng: MUSCAT.lng, accuracy: MUSCAT.accuracy };
const REGIONS = [{ key: 'R1' }, { key: 'R2' }];
const ROUTES = [
  { key: 'R1a', region: 'R1' },
  { key: 'R1b', region: 'R1' },
  { key: 'R2a', region: 'R2' },
];
const mgr = (key: string, region = 'R1'): UserSpec => ({ key, role: 'MANAGER', regions: [region] });
const S1: UserSpec = { key: 'S1', role: 'SALESMAN', route: 'R1a', supervisor: 'M1' };
const S2: UserSpec = { key: 'S2', role: 'SALESMAN', route: 'R1b', supervisor: 'M2' };
const S3: UserSpec = { key: 'S3', role: 'SALESMAN', route: 'R2a', supervisor: 'M5' };
const ACC1: UserSpec = { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] };
const FOUR = ['M1', 'M2', 'M3', 'M4'];

/** A shop with one ACTIVE branch (a close request's subject). */
const openShop = (key: string, route: string, extra: Partial<CustomerSpec> = {}): CustomerSpec => ({
  key,
  phone: true,
  contact: 'Hamed Al Siyabi',
  branches: [{ key: 'S', route, gps: GPS }],
  ...extra,
});
/** A shop whose only branch is CLOSED (a reactivation's subject); closed `hoursAgo`. */
const closedShop = (key: string, route: string, hoursAgo = 2, photos = false): CustomerSpec => ({
  key,
  phone: true,
  contact: 'Yusuf Al Kindi',
  branches: [
    {
      key: 'S',
      route,
      gps: GPS,
      status: 'CLOSED',
      lastStatusChangeAt: new Date(Date.now() - hoursAgo * 3_600_000),
      ...(photos ? { photos: ['SHOP', 'SIGNBOARD'] as ('SHOP' | 'SIGNBOARD')[] } : {}),
    },
  ],
});

// ── the app's words (read from the code under test) ──────────────────────────

/** services/edits.ts: a decision on a request someone else has just decided. */
const DECIDED = /Edit is in state (APPROVED|NEEDS_CORRECTION|REJECTED)\.|just decided by another reviewer/;
/** lib/decision-token.ts STALE_VIEW_MESSAGE. */
const STALE_VIEW = 'This request changed since you opened it. Reload the page and review it again.';
/** services/reactivations.ts: evidence older than the closure. */
const OLD_PHOTO = 'Photo was captured before the last status change. Take a new photo at the shop today.';
/** lib/status-evidence.ts EVIDENCE_REMOVED_MESSAGE (the approvals queue's words). */
const EVIDENCE_REMOVED =
  'The photo sent with this request has been removed. Reject it so the salesman can send it again with a new photo.';

// ── small helpers ────────────────────────────────────────────────────────────

/**
 * Landing on /approvals: a decision's answer carries the queue rendered on the server
 * (approveEditAndGoAction / rejectEditAndGoAction redirect). From this PC, about 270 ms a
 * round trip to UAT's database, a close-shop approval took 18–20 s to come back.
 */
const BACK_TO_QUEUE = { timeout: 90_000 };

async function pageAs(browser: Browser, w: World, key: string, device?: DeviceKind): Promise<Page> {
  const ctx = await contextAs(browser, w.user(key), device ? { device } : {});
  return ctx.newPage();
}

/** ✓ Approve on /approvals/<id>, then the confirmation's own button. */
async function approveHere(page: Page, confirm: RegExp = /^Approve$/): Promise<void> {
  await page.getByRole('button', { name: /^✓ Approve$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirm }).click();
}

/** ✗ Reject on /approvals/<id> with `reason`, sent back (to the salesman at the first step). */
async function sendBackHere(page: Page, reason: string): Promise<void> {
  await page.getByRole('button', { name: /^✗ Reject$/ }).click();
  await page.locator('textarea[name="reason"]').fill(reason);
  await page.getByRole('button', { name: /^✗ Send back to / }).click();
}

/** The branded not-found page (app/not-found.tsx). */
async function expectNotFound(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
  await expect(page.getByText(/isn.t available to your account/)).toBeVisible();
}

const contact = (w: World, label: string) => ({ customer: { contactPerson: w.name(label) } });
const idsOf = (w: World, keys: string[]) => keys.map((k) => w.user(k).id).sort();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function stateOf(id: string) {
  return db.customerEdit.findUniqueOrThrow({
    where: { id },
    select: {
      state: true,
      pendingRole: true,
      currentStepIndex: true,
      cycle: true,
      reviewedById: true,
      decisionReason: true,
      decisionCategory: true,
      escalationLevel: true,
      slaBreachedAt: true,
      lastEscalatedAt: true,
    },
  });
}

/** Who a request's SLA_BREACH rows went to (sorted user ids). */
async function breachRecipients(editId: string): Promise<string[]> {
  const rows = await db.notification.findMany({ where: { editId, kind: 'SLA_BREACH' }, select: { userId: true } });
  return rows.map((r) => r.userId).sort();
}

/** A close / reactivation form on a customer's profile (components/nmwc/BranchStatusActions.tsx). */
async function openStatusForm(page: Page, opener: 'Mark closed' | 'Request reactivation'): Promise<Locator> {
  await page.getByRole('button', { name: opener, exact: true }).click();
  const heading = opener === 'Mark closed' ? 'Mark this branch closed' : 'Reactivate this branch';
  const form = page.locator('form').filter({ has: page.getByRole('heading', { level: 4, name: heading }) });
  await expect(form).toBeVisible();
  await expect(form.getByText('Photo evidence (must be fresh — captured today)')).toBeVisible();
  return form;
}

/** Takes the evidence photo in the form: the camera input, compressed and uploaded by the page. */
async function takeEvidence(form: Locator): Promise<void> {
  await form.locator('input[type="file"]').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: uniquePng() });
  // PhotoCaptureSlot offers "Retake photo" once the upload is finished and attached to the form.
  await expect(form.locator('label[aria-label="Retake photo"]')).toBeVisible({ timeout: 90_000 });
}

/**
 * Photos the user captured that the world does not know yet — the page's own
 * uploads — adopted so cleanup owns them (an unattached photo is otherwise
 * foreign to it). By the registry, not by a time: the database's clock is not
 * this PC's.
 */
async function adoptNewPhotos(w: World, userKey: string) {
  const known = new Set(w.registry.data.attachmentIds);
  const rows = await db.attachment.findMany({
    where: { capturedById: w.user(userKey).id },
    select: { id: true, kind: true, customerId: true, branchId: true, branchExtraId: true, editId: true, deletedAt: true },
  });
  const fresh = rows.filter((r) => !known.has(r.id));
  fresh.forEach((r) => w.adopt.attachment(r.id));
  return fresh;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. One region, four Managers (MGR-QUEUE-SHARED-REGION; owner decision 3)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: four Managers share one region’s queue', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  const ids: Record<string, string> = {};

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('aqs', {
      regions: REGIONS,
      routes: ROUTES,
      users: [...FOUR.map((k) => mgr(k)), mgr('M5', 'R2'), ACC1, S1, S2, S3],
      customers: [
        approvableCustomer('C1', 'R1a', { branches: [{ key: 'S', route: 'R1a', gps: GPS, photos: ['SHOP'] }] }),
        approvableCustomer('C2', 'R1b'),
        approvableCustomer('C3', 'R2a'),
        // A chain: one shop on S1's route in R1, one on S3's in R2.
        approvableCustomer('CX', 'R1a', {
          branches: [
            { key: 'X1', route: 'R1a', gps: GPS },
            { key: 'X2', route: 'R2a', gps: GPS },
          ],
        }),
      ],
    });
    const now = Date.now();
    ids.c1 = (await seedUpdateEdit(w, { customer: 'C1', submitter: 'S1', patch: contact(w, 'C1 contact'), slaDueAt: workingMinutesAgo(90) })).id;
    ids.c2 = (await seedUpdateEdit(w, { customer: 'C2', submitter: 'S2', patch: contact(w, 'C2 contact'), slaDueAt: new Date(now + 2 * 3_600_000) })).id;
    // S1 changes the chain's R1 shop only: R1's request, not R2's.
    ids.cx = (
      await seedUpdateEdit(w, {
        customer: 'CX',
        submitter: 'S1',
        patch: { branches: [{ branch: 'CX.X1', openingHours: '06:00-23:00' }] },
        slaDueAt: new Date(now + 3 * 3_600_000),
      })
    ).id;
    ids.c3 = (await seedUpdateEdit(w, { customer: 'C3', submitter: 'S3', patch: contact(w, 'C3 contact') })).id;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('M1–M4 each see the same R1 cards, most overdue first; M5 sees only R2’s', async ({ browser }) => {
    test.setTimeout(240_000);
    const r1 = ['C1', 'C2', 'CX'].map((k) => w.customer(k).legalName);
    for (const key of FOUR) {
      const page = await pageAs(browser, w, key);
      await page.goto('/approvals');
      await expect(page.getByRole('heading', { level: 1, name: 'Approval queue' })).toBeVisible();
      await expect(page.getByText('3 pending', { exact: true }), `${key}: the header counts his queue`).toBeVisible();
      expect(await queueOrder(page), `${key}: one merged list, most overdue first`).toEqual(r1);
      const c1 = queueCard(page, r1[0]!);
      await expect(c1).toContainText(`Submitted by ${w.user('S1').fullName}`);
      await expect(c1, 'the SLA pill').toContainText(/OVERDUE \d+(m|h)/);
      await expect(c1, 'the age pill').toContainText(/just now|\d+h ago|\d+d ago/);
      const c2 = queueCard(page, r1[1]!);
      await expect(c2).toContainText(`Submitted by ${w.user('S2').fullName}`);
      await expect(c2).toContainText(/due in \d+(m|h)/);
      await expect(page.getByText(w.customer('C3').legalName), `${key}: R2's request is not in R1's queue`).toHaveCount(0);
      // By design there is no filter: one merged list for the region.
      await expect(page.getByRole('main').getByRole('combobox')).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('searchbox')).toHaveCount(0);
      await page.context().close();
    }

    const m5 = await pageAs(browser, w, 'M5');
    await m5.goto('/approvals');
    await expect(m5.getByText('1 pending', { exact: true })).toBeVisible();
    expect(await queueOrder(m5)).toEqual([w.customer('C3').legalName]);
    await expect(queueCard(m5, w.customer('C3').legalName)).toContainText(`Submitted by ${w.user('S3').fullName}`);
    // Owner decision 3: the chain's request changes only its R1 shop, so it is not M5's to see in his queue.
    for (const k of ['C1', 'C2', 'CX']) await expect(m5.getByText(w.customer(k).legalName)).toHaveCount(0);
  });

  test('M5’s deep links into R1 are not found; the chain’s R1 change opens read-only and cannot be approved', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M5');
    await page.goto(`/approvals/${ids.c1}`);
    await expectNotFound(page);
    await page.goto(`/customers/${w.customer('C1').id}`);
    await expectNotFound(page);
    if (hasR2) {
      const shop = w.customer('C1').photos.find((p) => p.wire === 'SHOP')!;
      const res = await fetchAs(page, `/api/photos/${shop.id}`);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'NOT_FOUND' });
    }

    // CX has a branch in R2, so M5 may open the request — read-only, without R1's change.
    await page.goto(`/approvals/${ids.cx}`);
    await expect(page.getByRole('heading', { level: 1, name: w.customer('CX').legalName })).toBeVisible();
    await expect(
      page.getByRole('note').filter({ hasText: 'For your information: this request is waiting at the SUPERVISOR step, which you cannot decide.' })
    ).toBeVisible();
    await expect(page.getByText(/Not shown: the changes to 1 branch outside your regions\. Their region.s Manager decides them\./)).toBeVisible();
    await expect(page.getByText('06:00-23:00'), 'the R1 shop’s change is not shown to R2’s Manager').toHaveCount(0);
    await approveHere(page);
    await expect(page.getByText('You are not authorized to act on this step.')).toBeVisible();
    expect((await stateOf(ids.cx)).state).toBe('SUBMITTED');
    expect(await db.editApproval.count({ where: { editId: ids.cx } })).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The dashboard's Pending approval is the queue (MGR-DASH-PENDING; decision 3)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: the dashboard’s Pending approval equals the queue', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let update: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('adp', {
      regions: REGIONS,
      routes: ROUTES,
      users: [...FOUR.map((k) => mgr(k)), mgr('M5', 'R2'), ACC1, S1, S2, S3],
      customers: [approvableCustomer('U1', 'R1a'), openShop('K2', 'R1b'), closedShop('CL', 'R1a'), approvableCustomer('R2U', 'R2a')],
    });
    // At the Supervisor step in R1: an update, a close, a cash and a credit new customer.
    update = (await seedUpdateEdit(w, { customer: 'U1', submitter: 'S1', patch: contact(w, 'Dash contact') })).id;
    await seedBranchRequest(w, { kind: 'close', branch: 'K2', submitter: 'S2' });
    await seedCreateRequest(w, { submitter: 'S1', paymentTerms: 'CASH' });
    await seedCreateRequest(w, { submitter: 'S2', paymentTerms: 'CREDIT' });
    // Waiting for the Manager himself, on /reactivations.
    await seedBranchRequest(w, { kind: 'reactivate', branch: 'CL', submitter: 'S1' });
    // Another region's request: counted nowhere for an R1 Manager.
    await seedUpdateEdit(w, { customer: 'R2U', submitter: 'S3', patch: contact(w, 'R2 contact') });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('M3 (direct supervisor of neither salesman) reads 4, the queue reads 4, then both read 3', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, w, 'M3');
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    // The region's name comes from the 5-minute reference list, which can lag a region made
    // minutes ago (README): when a name is shown it is R1's, and only R1's.
    await expect(page.getByText(new RegExp(`^Your regions(: ${esc(w.region('R1').name)})? · .+ – .+, Oman days$`))).toBeVisible();
    await expect(page.getByText(/^Figures as of .+ Oman time$/)).toBeVisible();
    await expect(kpiValue(page, 'Pending approval')).toHaveText('4');
    const tile = kpiTile(page, 'Pending approval');
    await expect(tile).toContainText('Waiting now in your approval queue, new-customer requests included');
    await expect(tile).toContainText('Not counted above:');
    await expect(tile.getByRole('link', { name: '1 reactivation waiting for your decision' })).toBeVisible();
    // Every card loaded: no "could not be loaded" notice, no failed tile.
    await expect(page.getByText('Not available just now')).toHaveCount(0);
    await expect(page.getByText(/could not be loaded just now/)).toHaveCount(0);
    await expect(page.getByText(w.customer('R2U').legalName)).toHaveCount(0);

    await tile.getByRole('link', { name: 'Open the approval queue' }).click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    await expect(page.getByText('4 pending', { exact: true })).toBeVisible();
    await expect(page.getByText(w.customer('R2U').legalName)).toHaveCount(0);

    await page.goto('/dashboard');
    await kpiTile(page, 'Pending approval').getByRole('link', { name: '1 reactivation waiting for your decision' }).click();
    await expect(page).toHaveURL(/\/reactivations(\?|$)/);
    await expect(page.getByText('1 closed shops requesting reactivation', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('listitem')).toContainText(w.customer('CL').legalName);

    // M3 approves the update (a region Manager may: owner decision 3).
    await page.goto(`/approvals/${update}`);
    await approveHere(page);
    await expect(page).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    await expect(page.getByText('3 pending', { exact: true })).toBeVisible();
    expect(await stateOf(update)).toMatchObject({ state: 'APPROVED', reviewedById: w.user('M3').id });
    await page.goto('/dashboard');
    await expect(kpiValue(page, 'Pending approval')).toHaveText('3');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Bulk decisions (MGR-BULK-APPROVE-MIXED, CONC-TWO-MANAGERS-APPROVE variant 2,
//    MGR-BULK-REJECT)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: bulk approve and bulk reject', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('abk', {
      regions: [{ key: 'R1' }],
      routes: ROUTES.filter((r) => r.region === 'R1'),
      users: [mgr('M1'), mgr('M2'), ACC1, S1, S2],
      customers: [
        approvableCustomer('U1', 'R1a'),
        approvableCustomer('U2', 'R1b'),
        approvableCustomer('U3', 'R1a'),
        approvableCustomer('U4', 'R1b'),
        approvableCustomer('U5', 'R1a'),
        openShop('K1', 'R1b'),
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('M1 approves an update, a close and a cash new customer at once; M2 decides the update first — only it fails', async ({ browser }) => {
    test.skip(!hasR2, 'the close request is approved on its evidence photo, which needs R2');
    test.setTimeout(240_000);
    const upd = (await seedUpdateEdit(w, { customer: 'U1', submitter: 'S1', patch: contact(w, 'Bulk contact') })).id;
    const close = await seedBranchRequest(w, { kind: 'close', branch: 'K1', submitter: 'S2' });
    const cash = await seedCreateRequest(w, { submitter: 'S1', paymentTerms: 'CASH' });
    // Not ticked: keeps the queue (and the outcome banner) on screen after the refresh.
    const keep = (await seedUpdateEdit(w, { customer: 'U2', submitter: 'S2', patch: contact(w, 'Untouched contact') })).id;

    const m1 = await pageAs(browser, w, 'M1');
    await m1.goto('/approvals');
    await expect(m1.getByText('4 pending', { exact: true })).toBeVisible();
    for (const name of [w.customer('U1').legalName, w.customer('K1').legalName, cash.legalName]) {
      await queueCard(m1, name).getByRole('checkbox').check();
    }
    await expect(m1.getByRole('button', { name: '✓ Approve 3' })).toBeVisible();

    // Meanwhile M2 approves the update from its own page.
    const m2 = await pageAs(browser, w, 'M2');
    await m2.goto(`/approvals/${upd}`);
    await approveHere(m2);
    await expect(m2).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);

    await m1.getByRole('button', { name: '✓ Approve 3' }).click();
    const dialog = m1.getByRole('dialog', { name: 'Approve 3 edits?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve 3', exact: true }).click();
    await expect(m1.getByText('2 processed, 1 failed.', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(
      m1.getByText(new RegExp(`^${upd.slice(-8)}: (Edit is in state APPROVED\\.|.*just decided by another reviewer.*)$`))
    ).toBeVisible();
    // The selection clears and the queue refreshes: only the untouched request is left.
    await expect(m1.getByText('0 selected', { exact: true })).toBeVisible();
    await expect(m1.getByRole('button', { name: /^✓ Approve \d+$/ })).toHaveCount(0);
    await expect(m1.getByText('1 pending', { exact: true })).toBeVisible();

    // The update: decided once, by M2.
    const steps = await db.editApproval.findMany({ where: { editId: upd }, select: { actorId: true, decision: true } });
    expect(steps).toEqual([{ actorId: w.user('M2').id, decision: 'APPROVED' }]);
    // The close: the branch is closed and, its only branch, the customer too (owner decision 7).
    const k1 = w.customer('K1');
    expect((await db.branch.findUniqueOrThrow({ where: { id: k1.branch.id }, select: { status: true } })).status).toBe('CLOSED');
    expect((await db.customer.findUniqueOrThrow({ where: { id: k1.id }, select: { status: true } })).status).toBe('CLOSED');
    expect((await auditFor({ entityId: k1.id, action: 'CLOSE' })).length).toBe(1);
    await expect
      .poll(async () => (await notificationsFor({ editId: close.id })).filter((n) => n.userId === w.user('S2').id).map((n) => n.title))
      .toContain('Close-shop request approved');
    // The cash new customer moves on to the Accountant step, and the Accountant is told.
    expect(await stateOf(cash.id)).toMatchObject({ state: 'SUBMITTED', pendingRole: 'ACCOUNTANT', currentStepIndex: 1 });
    await expect
      .poll(async () => (await notificationsFor({ editId: cash.id, userId: w.user('ACC1').id })).map((n) => n.kind))
      .toContain('EDIT_STAGE_ADVANCED');
    expect((await stateOf(keep)).state).toBe('SUBMITTED');
  });

  test('bulk reject: a keyboard-safe dialog, one reason and category for both, both salesmen told', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = (await seedUpdateEdit(w, { customer: 'U3', submitter: 'S1', patch: contact(w, 'Reject A') })).id;
    const b = (await seedUpdateEdit(w, { customer: 'U4', submitter: 'S2', patch: contact(w, 'Reject B') })).id;
    const keep = (await seedUpdateEdit(w, { customer: 'U5', submitter: 'S1', patch: contact(w, 'Kept') })).id;

    const page = await pageAs(browser, w, 'M1');
    await page.goto('/approvals');
    for (const k of ['U3', 'U4']) await queueCard(page, w.customer(k).legalName).getByRole('checkbox').check();
    await page.getByRole('button', { name: '✗ Reject 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reject 2 edits?' });
    await expect(dialog).toBeVisible();
    const reason = dialog.getByRole('textbox', { name: /Reason/ });
    await expect(reason, 'focus starts in the reason box').toBeFocused();
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement)), `${key} stays inside the dialog`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog, 'Escape cancels').toHaveCount(0);

    await page.getByRole('button', { name: '✗ Reject 2' }).click();
    await expect(dialog).toBeVisible();
    await reason.fill('abcd');
    const confirm = dialog.getByRole('button', { name: 'Reject 2', exact: true });
    await expect(confirm, 'four characters are not a reason').toBeDisabled();
    await reason.press('Enter');
    await expect(dialog, 'Enter in the reason box submits nothing').toBeVisible();
    expect((await stateOf(a)).state).toBe('SUBMITTED');
    expect((await stateOf(b)).state).toBe('SUBMITTED');

    await dialog.getByLabel('Category').selectOption({ label: 'Wrong GPS' });
    const why = w.name('GPS pin is far from the actual shop');
    await reason.fill(why);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText('2 processed.', { exact: true })).toBeVisible({ timeout: 90_000 });

    for (const [id, who] of [
      [a, 'S1'],
      [b, 'S2'],
    ] as const) {
      expect(await stateOf(id)).toMatchObject({ state: 'NEEDS_CORRECTION', decisionReason: why, decisionCategory: 'wrong_gps', reviewedById: w.user('M1').id });
      await expect
        .poll(async () => (await notificationsFor({ editId: id, userId: w.user(who).id })).map((n) => n.kind))
        .toEqual(['EDIT_NEEDS_CORRECTION']);
    }
    expect((await stateOf(keep)).state).toBe('SUBMITTED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Select all stops at 50 (MGR-SELECTALL-CAP)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: Select all stops at 50, most overdue first', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  const KEYS = Array.from({ length: 55 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`);
  let w: World;
  const edits: string[] = [];
  let credit: { id: string; legalName: string };

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    w = await createWorld('acap', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'R1a', region: 'R1' }],
      users: [mgr('M1'), { ...S1 }],
      customers: KEYS.map((k) => approvableCustomer(k, 'R1a')),
    });
    // Staggered deadlines: Q01 is the most overdue of the updates, Q55 the least.
    const base = Date.now() - 3 * 3_600_000;
    for (const [i, k] of KEYS.entries()) {
      edits.push((await seedUpdateEdit(w, { customer: k, submitter: 'S1', patch: contact(w, `Cap ${k}`), slaDueAt: new Date(base + i * 60_000) })).id);
    }
    // The most overdue card of all is a credit application, which is never ticked.
    credit = await seedCreateRequest(w, { submitter: 'S1', paymentTerms: 'CREDIT', slaDueAt: new Date(base - 60_000) });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('56 pending; Select all ticks the 50 most overdue updates; Approve 50 finishes or says to run it again', async ({ browser }) => {
    // Each "run it again" round is the 40 s budget plus the item in flight; from a PC far from
    // UAT's database (about 270 ms a round trip) one approval takes seconds, so ten rounds may be needed.
    test.setTimeout(1_200_000);
    const page = await pageAs(browser, w, 'M1');
    await page.goto('/approvals');
    await expect(page.getByText('56 pending', { exact: true })).toBeVisible();
    const creditCard = queueCard(page, credit.legalName);
    await expect(creditCard.getByRole('img', { name: 'Credit application: open it to decide' })).toBeVisible();
    await expect(creditCard.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByText('Credit applications are approved one at a time: open each card marked with a lock.')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Select up to 50 on this page' }).check();
    await expect(page.getByRole('status').filter({ hasText: 'Selected the first 50 — the limit per action.' })).toBeVisible();
    const ticked = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>('main li input[type="checkbox"]'))
        .filter((c) => c.checked)
        .map((c) => c.getAttribute('aria-label') ?? '')
    );
    const label = (k: string) => `Select edit for ${w.customer(k).legalName}`;
    expect(ticked.sort(), 'the 50 earliest deadlines').toEqual(KEYS.slice(0, 50).map(label).sort());

    // One bulk approve of the `n` ticked cards; its outcome banner, parsed. The banner of the
    // round before is told apart by its total: every round decides fewer than the one before.
    const banner = page.getByText(/^\d+ processed(, \d+ failed)?(, \d+ not attempted — run it again to finish)?\.$/);
    const parse = (t: string) => {
      const m = /^(\d+) processed(?:, (\d+) failed)?(?:, (\d+) not attempted)?/.exec(t.trim());
      return m ? { processed: Number(m[1]), failed: Number(m[2] ?? 0), notAttempted: Number(m[3] ?? 0) } : null;
    };
    const approveTicked = async (n: number) => {
      await page.getByRole('button', { name: `✓ Approve ${n}` }).click();
      const dialog = page.getByRole('dialog', { name: `Approve ${n} edit${n === 1 ? '' : 's'}?` });
      await dialog.getByRole('button', { name: `Approve ${n}`, exact: true }).click();
      const started = Date.now();
      const seen: { v: { processed: number; failed: number; notAttempted: number } | null } = { v: null };
      await expect
        .poll(
          async () => {
            const p = (await banner.allTextContents()).map(parse).find((r) => r && r.processed + r.failed + r.notAttempted === n);
            seen.v = p ?? null;
            return seen.v !== null;
          },
          { timeout: 180_000, intervals: [500] }
        )
        .toBe(true);
      return { ...seen.v!, ms: Date.now() - started };
    };

    let round = await approveTicked(50);
    const rounds = [`50 → ${round.processed} processed, ${round.notAttempted} not attempted in ${round.ms} ms`];
    expect(round.failed, 'no item failed').toBe(0);
    // "Run it again": the ones not attempted are still in the queue; decide exactly those, until none is left.
    while (round.notAttempted > 0) {
      expect(round.processed, 'every round decides at least one request, so running it again finishes').toBeGreaterThan(0);
      expect(rounds.length, 'rounds').toBeLessThan(25);
      const left = await db.customerEdit.findMany({ where: { id: { in: edits.slice(0, 50) }, state: 'SUBMITTED' }, select: { id: true } });
      expect(left.length, 'what was not attempted is exactly what still waits').toBe(round.notAttempted);
      const leftKeys = KEYS.filter((_, i) => left.some((l) => l.id === edits[i]));
      for (const k of leftKeys) await queueCard(page, w.customer(k).legalName).getByRole('checkbox').check();
      round = await approveTicked(leftKeys.length);
      rounds.push(`${leftKeys.length} → ${round.processed} processed, ${round.notAttempted} not attempted in ${round.ms} ms`);
      expect(round.failed, 'no item failed').toBe(0);
    }
    test.info().annotations.push({ type: 'bulk approve 50', description: rounds.join('; ') });

    // Each of the 50 approved exactly once; the five latest and the credit application still wait.
    const first50 = await db.customerEdit.findMany({ where: { id: { in: edits.slice(0, 50) } }, select: { state: true } });
    expect(first50.every((e) => e.state === 'APPROVED')).toBe(true);
    const decisions = await db.editApproval.groupBy({ by: ['editId'], where: { editId: { in: edits } }, _count: { _all: true } });
    expect(decisions.length).toBe(50);
    expect(decisions.every((d) => d._count._all === 1), 'no request approved twice').toBe(true);
    const last5 = await db.customerEdit.findMany({ where: { id: { in: edits.slice(50) } }, select: { state: true } });
    expect(last5.map((e) => e.state)).toEqual(Array(5).fill('SUBMITTED'));
    expect((await stateOf(credit.id)).state).toBe('SUBMITTED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Two Managers on one request (MGR-STALE-VIEW, CONC-TWO-MANAGERS-APPROVE,
//    CONC-APPROVE-VS-REJECT; critic: a Steward change landing on a waiting request)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: two Managers on one request', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  const RACES = ['P1', 'P2', 'P3', 'P4', 'P5'];
  let w: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('atm', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'R1a', region: 'R1' }],
      users: [mgr('M1'), mgr('M2'), mgr('M3'), ACC1, { ...S1 }],
      customers: ['T1', 'T2', 'ST', 'NR1', 'NR2', ...RACES].map((k) => approvableCustomer(k, 'R1a')),
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('a page opened before a colleague approved: Approve and Reject are both refused in place, nothing written twice', async ({ browser }) => {
    const id = (await seedUpdateEdit(w, { customer: 'T1', submitter: 'S1', patch: contact(w, 'Stale view') })).id;
    const m1 = await pageAs(browser, w, 'M1');
    const m3 = await pageAs(browser, w, 'M3');
    await m1.goto(`/approvals/${id}`);
    await m3.goto(`/approvals/${id}`);
    await approveHere(m1);
    await expect(m1).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);

    await approveHere(m3);
    await expect(m3.getByText('Edit is in state APPROVED.')).toBeVisible();
    await expect(m3, 'no redirect').toHaveURL(new RegExp(`/approvals/${id}$`));
    await m3.getByRole('button', { name: /^✗ Reject$/ }).click();
    await m3.locator('textarea[name="reason"]').fill(w.name('Too late to reject'));
    // Wait for the reject action's own answer (the approve refusal above is still on screen).
    await Promise.all([
      m3.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/approvals/${id}`),
      m3.getByRole('button', { name: '✗ Send back to salesman' }).click(),
    ]);
    await expect(m3.getByText('Edit is in state APPROVED.')).toBeVisible();
    await expect(m3).toHaveURL(new RegExp(`/approvals/${id}$`));

    expect(await stateOf(id)).toMatchObject({ state: 'APPROVED', reviewedById: w.user('M1').id });
    const steps = await db.editApproval.findMany({ where: { editId: id }, select: { actorId: true, decision: true } });
    expect(steps).toEqual([{ actorId: w.user('M1').id, decision: 'APPROVED' }]);
    expect((await auditFor({ entityId: id, action: 'APPROVE' })).length).toBe(1);
    expect((await auditFor({ entityId: id, action: 'REJECT' })).length).toBe(0);
  });

  test('both confirm at the same moment: exactly one decision lands, applied once, the salesman told once', async ({ browser }) => {
    const want = w.name('Race contact');
    const id = (await seedUpdateEdit(w, { customer: 'T2', submitter: 'S1', patch: { customer: { contactPerson: want } } })).id;
    const pages = { M1: await pageAs(browser, w, 'M1'), M3: await pageAs(browser, w, 'M3') };
    for (const p of Object.values(pages)) {
      await p.goto(`/approvals/${id}`);
      await p.getByRole('button', { name: /^✓ Approve$/ }).click();
      await expect(p.getByRole('dialog')).toBeVisible();
    }
    await Promise.all(Object.values(pages).map((p) => p.getByRole('dialog').getByRole('button', { name: /^Approve$/ }).click()));
    const outcome = async (p: Page) =>
      new URL(p.url()).pathname === '/approvals' ? 'won' : (await p.getByText(DECIDED).isVisible()) ? 'lost' : 'pending';
    await expect
      .poll(async () => [await outcome(pages.M1), await outcome(pages.M3)].sort().join(','), { timeout: 60_000 })
      .toBe('lost,won');

    const row = await stateOf(id);
    const winner = (await outcome(pages.M1)) === 'won' ? 'M1' : 'M3';
    expect(row).toMatchObject({ state: 'APPROVED', reviewedById: w.user(winner).id });
    expect(await db.editApproval.count({ where: { editId: id, cycle: 1, stepIndex: 0 } })).toBe(1);
    expect((await db.customer.findUniqueOrThrow({ where: { id: w.customer('T2').id }, select: { contactPerson: true } })).contactPerson).toBe(want);
    expect((await auditFor({ entityId: id, action: 'APPROVE' })).length).toBe(1);
    const told = (await notificationsFor({ editId: id, userId: w.user('S1').id })).filter((n) => n.kind === 'EDIT_APPROVED_FINAL');
    expect(told.length).toBe(1);
  });

  test('approve and reject fired together, five times: each ends in exactly one outcome, never applied-and-rejected', async ({ browser }) => {
    test.setTimeout(420_000);
    const m1 = await contextAs(browser, w.user('M1'));
    const m3 = await contextAs(browser, w.user('M3'));
    const outcomes: string[] = [];
    for (const key of RACES) {
      const want = w.name(`Race ${key}`);
      const why = w.name(`Race reject ${key}`);
      const before = (await db.customer.findUniqueOrThrow({ where: { id: w.customer(key).id }, select: { contactPerson: true } })).contactPerson;
      const id = (await seedUpdateEdit(w, { customer: key, submitter: 'S1', patch: { customer: { contactPerson: want } } })).id;
      const a = await m1.newPage();
      const r = await m3.newPage();
      await a.goto(`/approvals/${id}`);
      await r.goto(`/approvals/${id}`);
      await a.getByRole('button', { name: /^✓ Approve$/ }).click();
      await expect(a.getByRole('dialog')).toBeVisible();
      await r.getByRole('button', { name: /^✗ Reject$/ }).click();
      await r.locator('textarea[name="reason"]').fill(why);
      await Promise.all([
        a.getByRole('dialog').getByRole('button', { name: /^Approve$/ }).click(),
        r.getByRole('button', { name: '✗ Send back to salesman' }).click(),
      ]);
      await expect.poll(async () => (await stateOf(id)).state, { timeout: 60_000 }).not.toBe('SUBMITTED');
      const row = await stateOf(id);
      const live = (await db.customer.findUniqueOrThrow({ where: { id: w.customer(key).id }, select: { contactPerson: true } })).contactPerson;
      const steps = (await db.editApproval.findMany({ where: { editId: id }, select: { decision: true } })).map((s) => s.decision);
      if (row.state === 'APPROVED') {
        expect(live, `${key}: approved, so applied`).toBe(want);
        expect(steps, `${key}: no rejection row`).toEqual(['APPROVED']);
        await expect(r.getByText(DECIDED), `${key}: the rejecting Manager is told`).toBeVisible();
      } else {
        expect(row, `${key}: rejected`).toMatchObject({ state: 'NEEDS_CORRECTION', decisionReason: why, reviewedById: w.user('M3').id });
        expect(live, `${key}: rejected, so the customer is unchanged`).toBe(before);
        expect(steps).toEqual(['REJECTED']);
        await expect(a.getByText(DECIDED), `${key}: the approving Manager is told`).toBeVisible();
      }
      outcomes.push(`${key}:${row.state}`);
      await a.close();
      await r.close();
    }
    test.info().annotations.push({ type: 'approve vs reject', description: outcomes.join(', ') });
  });

  test('a new-customer page opened before a send-back round is refused as changed, then decided after a reload', async ({ browser }) => {
    test.skip(!hasR2, 'the salesman resends a complete request, whose photos need R2');
    test.setTimeout(300_000);
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    const { editId, body } = await createRequestViaApi(s1, w, { paymentTerms: 'CASH' });

    const m1 = await pageAs(browser, w, 'M1');
    await m1.goto(`/approvals/${editId}`);
    await expect(m1.getByRole('button', { name: /^✓ Approve$/ })).toBeVisible();

    const m2 = await pageAs(browser, w, 'M2');
    await m2.goto(`/approvals/${editId}`);
    await sendBackHere(m2, w.name('Recheck the signboard'));
    await expect(m2).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    expect((await stateOf(editId)).state).toBe('NEEDS_CORRECTION');

    const again = await submitCreateViaApi(s1, { ...body, editId }, { world: w });
    expect(again, JSON.stringify(again).slice(0, 300)).toMatchObject({ ok: true });
    expect(await stateOf(editId)).toMatchObject({ state: 'SUBMITTED', cycle: 2, currentStepIndex: 0 });

    await approveHere(m1, /^Approve and send on$/);
    await expect(m1.getByText(STALE_VIEW)).toBeVisible();
    expect(await stateOf(editId)).toMatchObject({ state: 'SUBMITTED', cycle: 2, currentStepIndex: 0, pendingRole: 'SUPERVISOR' });
    expect(await db.editApproval.count({ where: { editId, cycle: 2 } })).toBe(0);

    await m1.reload();
    await approveHere(m1, /^Approve and send on$/);
    await expect(m1).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    expect(await stateOf(editId)).toMatchObject({ state: 'SUBMITTED', cycle: 2, currentStepIndex: 1, pendingRole: 'ACCOUNTANT' });
    const steps = await db.editApproval.findMany({ where: { editId, cycle: 2 }, select: { actorId: true, decision: true, stepIndex: true } });
    expect(steps).toEqual([{ actorId: w.user('M1').id, decision: 'APPROVED', stepIndex: 0 }]);
  });

  test('a field changed on the customer after the request was sent: shown, Approve refused, Reject still works', async ({ browser }) => {
    const id = (await seedUpdateEdit(w, { customer: 'ST', submitter: 'S1', patch: contact(w, 'Salesman contact') })).id;
    // A Steward's import (or a Manager's direct edit) writes the same field meanwhile.
    await db.customer.update({ where: { id: w.customer('ST').id }, data: { contactPerson: w.name('Imported contact') } });
    const page = await pageAs(browser, w, 'M1');
    await page.goto(`/approvals/${id}`);
    await expect(page.getByText(/Changed on the customer since this request was sent: .*contact/i)).toBeVisible();
    await approveHere(page);
    await expect(page.getByText(/Changed on the customer after this request was sent: .*nothing was approved/i)).toBeVisible();
    expect((await stateOf(id)).state).toBe('SUBMITTED');
    expect(await db.editApproval.count({ where: { editId: id } })).toBe(0);
    await sendBackHere(page, w.name('Contact changed meanwhile, check it'));
    await expect(page).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    expect((await stateOf(id)).state).toBe('NEEDS_CORRECTION');
  });

  test('a decision that succeeds never shows the approver an error on its way back to the queue', async ({ browser }) => {
    // Was an APP BUG (P2, minor), fixed by aad7065: ApproveRejectActions caught the redirect that
    // approveEditAndGoAction / rejectEditAndGoAction throw on success and printed its message,
    // "NEXT_REDIRECT", in red under the buttons until /approvals had rendered. It rethrows it now.
    const approved = (await seedUpdateEdit(w, { customer: 'NR1', submitter: 'S1', patch: contact(w, 'Redirect approve') })).id;
    const sentBack = (await seedUpdateEdit(w, { customer: 'NR2', submitter: 'S1', patch: contact(w, 'Redirect reject') })).id;
    const page = await pageAs(browser, w, 'M1');
    const shown: string[] = [];
    for (const [id, how] of [
      [approved, 'approve'],
      [sentBack, 'send back'],
    ] as const) {
      await page.goto(`/approvals/${id}`);
      await expect(page.getByRole('button', { name: /^✓ Approve$/ })).toBeEnabled();
      // Records any red message the decision form shows until the queue has rendered.
      await page.evaluate(() => {
        const g = window as unknown as { __formErrors: string[] };
        g.__formErrors = [];
        new MutationObserver(() => {
          for (const p of Array.from(document.querySelectorAll('main p.text-red-600'))) {
            const t = (p.textContent ?? '').trim();
            if (t && !g.__formErrors.includes(t)) g.__formErrors.push(t);
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      if (how === 'approve') await approveHere(page);
      else await sendBackHere(page, w.name('Redirect check, please resend'));
      await expect(page).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
      const errors = await page.evaluate(() => (window as unknown as { __formErrors: string[] }).__formErrors);
      shown.push(...errors.map((e) => `${how}: ${e}`));
    }
    expect(await stateOf(approved)).toMatchObject({ state: 'APPROVED', reviewedById: w.user('M1').id });
    expect(await stateOf(sentBack)).toMatchObject({ state: 'NEEDS_CORRECTION', reviewedById: w.user('M1').id });
    expect(shown, 'no error text while the queue loads after a decision that went through').toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Closing a branch (SM-CLOSE-BRANCH, MGR-CLOSE-REQUEST): the salesman on a
//    phone, the Manager at a desk
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: a close-shop request from the phone to the decision', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  test.skip(!hasR2, 'the close form uploads its evidence photo to R2');

  let w: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('acl', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'R1a', region: 'R1' }],
      users: [mgr('M1'), mgr('M2'), ACC1, { ...S1 }],
      customers: [
        openShop('C1', 'R1a', { branches: [{ key: 'S', route: 'R1a', gps: GPS, photos: ['SHOP', 'SIGNBOARD'] }] }),
        openShop('C2', 'R1a'),
        openShop('C3', 'R1a'),
        approvableCustomer('C4', 'R1a'),
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('S1 marks a branch closed with fresh evidence; M1 is told, decides on the photo, and the shop and customer close', async ({ browser }) => {
    test.setTimeout(300_000);
    const c1 = w.customer('C1');
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto(`/customers/${c1.id}`);
    const form = await openStatusForm(s1, 'Mark closed');
    await takeEvidence(form);
    const reason = form.locator('textarea');
    const submit = form.getByRole('button', { name: 'Submit closure' });
    await reason.fill('abcd');
    await expect(submit, 'four characters').toBeDisabled();
    // Wave 1: counted trimmed, as the server counts it.
    await reason.fill('     ');
    await expect(submit, 'five spaces are not a reason').toBeDisabled();
    const why = w.name('Shop shut for good');
    await reason.fill(why);
    await expect(submit).toBeEnabled();
    const t0 = new Date();
    await submit.click();
    await expect(s1.getByText('✓ Closure sent for approval.')).toBeVisible();

    const edit = await db.customerEdit.findFirstOrThrow({
      where: { branchId: c1.branch.id, target: 'BRANCH', state: 'SUBMITTED' },
      select: { id: true, fieldChanges: true, attachmentChanges: true, pendingRole: true, decisionReason: true, isReactivation: true },
    });
    w.adopt.edit(edit.id);
    expect(edit).toMatchObject({ pendingRole: 'SUPERVISOR', decisionReason: why, isReactivation: false });
    expect(edit.fieldChanges).toEqual([{ field: `branch.${c1.branch.id}.status`, before: 'ACTIVE', after: 'CLOSED' }]);
    const evidence = (edit.attachmentChanges as Array<{ attachmentId: string; action: string }>)[0]!;
    expect(evidence.action).toBe('EVIDENCE');
    const photo = await db.attachment.findUniqueOrThrow({
      where: { id: evidence.attachmentId },
      select: { capturedById: true, branchExtraId: true, kind: true, createdAt: true },
    });
    w.adopt.attachment(evidence.attachmentId);
    // On the branch with the accepted request (wave 1: wired in the request's own transaction).
    expect(photo).toMatchObject({ capturedById: w.user('S1').id, branchExtraId: c1.branch.id, kind: 'FREE' });

    // M1, his supervisor, is told; the region's Accountant for information.
    await expect
      .poll(async () => (await notificationsFor({ editId: edit.id })).map((n) => `${n.userId}:${n.kind}`).sort())
      .toEqual([`${w.user('ACC1').id}:REQUEST_FYI`, `${w.user('M1').id}:EDIT_SUBMITTED`].sort());
    const m1 = await pageAs(browser, w, 'M1', 'desktop');
    await m1.goto('/dashboard');
    await expect(kpiValue(m1, 'Branches closed')).toHaveText('0');
    await m1.goto('/notifications');
    const row = m1.getByRole('main').getByRole('link').filter({ hasText: 'Close-shop request awaiting your review' });
    await expect(row).toHaveAttribute('href', `/approvals/${edit.id}`);
    await expect(row).toContainText('Review');

    await m1.goto(`/approvals/${edit.id}`);
    await expect(m1.getByRole('heading', { level: 2, name: 'Evidence sent with this request' })).toBeVisible();
    await imagesLoaded(m1.locator(`img[src="/api/photos/${evidence.attachmentId}"]`));
    const clickedAt = Date.now();
    await approveHere(m1);
    await expect(m1).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    test.info().annotations.push({ type: 'close approve → back on /approvals', description: `${Date.now() - clickedAt} ms` });

    const branch = await db.branch.findUniqueOrThrow({ where: { id: c1.branch.id }, select: { status: true, lastStatusChangeAt: true } });
    expect(branch.status).toBe('CLOSED');
    // Set by the app server, which runs on this machine's clock.
    expect(branch.lastStatusChangeAt!.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 5_000);
    // Owner decision 7: its last open shop closed, so the customer is closed too, and audited.
    expect((await db.customer.findUniqueOrThrow({ where: { id: c1.id }, select: { status: true } })).status).toBe('CLOSED');
    expect((await auditFor({ entityId: c1.id, action: 'CLOSE' })).length).toBe(1);
    await expect
      .poll(async () => (await notificationsFor({ editId: edit.id, userId: w.user('S1').id })).map((n) => `${n.kind}:${n.title}`))
      .toContain('EDIT_APPROVED_FINAL:Close-shop request approved');
    await m1.goto('/dashboard');
    await expect(kpiValue(m1, 'Branches closed')).toHaveText('1');
  });

  test('a close whose evidence was removed before the decision says so and cannot be approved', async ({ browser }) => {
    const c2 = w.customer('C2');
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    const up = await uploadPhotoViaApi(s1, w, { kind: 'FREE' });
    const out = await closeBranchViaApi(s1, { branchId: c2.branch.id, reason: w.name('Closed down'), attachmentId: up.attachmentId }, w);
    expect(out, JSON.stringify(out).slice(0, 300)).toMatchObject({ ok: true });
    const id = receiptEditId(out)!;
    await db.attachment.update({ where: { id: up.attachmentId }, data: { deletedAt: new Date() } });

    const m1 = await pageAs(browser, w, 'M1', 'desktop');
    await m1.goto(`/approvals/${id}`);
    await expect(m1.getByText('Removed since the request was sent — it cannot be approved; reject this request.')).toBeVisible();
    await approveHere(m1);
    await expect(m1.getByText(EVIDENCE_REMOVED)).toBeVisible();
    expect((await stateOf(id)).state).toBe('SUBMITTED');
    expect((await db.branch.findUniqueOrThrow({ where: { id: c2.branch.id }, select: { status: true } })).status).toBe('ACTIVE');
  });

  test('Cancel after taking the photo leaves nothing on the live branch', async ({ browser }) => {
    const c3 = w.customer('C3');
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto(`/customers/${c3.id}`);
    const form = await openStatusForm(s1, 'Mark closed');
    await takeEvidence(form);
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);
    await expect(s1.getByRole('button', { name: 'Mark closed', exact: true })).toBeVisible();
    const photos = await adoptNewPhotos(w, 'S1');
    expect(photos.length, 'the photo the form uploaded').toBe(1);
    // Wave 1: the evidence is wired only with an accepted request — after Cancel it is on no slot.
    expect(photos[0]).toMatchObject({ customerId: null, branchId: null, branchExtraId: null, editId: null });
    expect(await db.attachment.count({ where: { branchExtraId: c3.branch.id } })).toBe(0);
    expect(await db.customerEdit.count({ where: { customerId: c3.id } })).toBe(0);
  });

  test('Mark closed while his enrichment is pending is refused in words, and nothing is written', async ({ browser }) => {
    const c4 = w.customer('C4');
    await seedUpdateEdit(w, { customer: 'C4', submitter: 'S1', patch: contact(w, 'Pending contact') });
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto(`/customers/${c4.id}`);
    const form = await openStatusForm(s1, 'Mark closed');
    await takeEvidence(form);
    await form.locator('textarea').fill(w.name('Shop is shut'));
    await form.getByRole('button', { name: 'Submit closure' }).click();
    await expect(
      s1.getByText(/Your changes to this customer, sent.*, are still waiting for approval, so this request was NOT sent\. Send it once that is decided\./)
    ).toBeVisible();
    expect(await db.customerEdit.count({ where: { customerId: c4.id, target: 'BRANCH' } })).toBe(0);
    // The refused request took its photo with it: on no slot, nothing on the live branch.
    const photos = await adoptNewPhotos(w, 'S1');
    expect(photos.map((p) => p.branchExtraId)).toEqual([null]);
    expect(await db.attachment.count({ where: { branchExtraId: c4.branch.id } })).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Reactivations (SM-REACTIVATION, MGR-REACT-DECIDE)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: a reactivation from the phone to the Manager’s decision', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  test.skip(!hasR2, 'reactivation evidence is uploaded to R2');

  let w: World;
  let approved: string;
  let keptClosed: string;
  let salesmanReason: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('arc', {
      regions: REGIONS,
      routes: ROUTES,
      users: [mgr('M1'), mgr('M2'), mgr('M3'), mgr('M5', 'R2'), ACC1, { ...S1 }],
      customers: [closedShop('CL', 'R1a', 2, true), closedShop('CL2', 'R1a', 2)],
    });
    // A customer whose only shop is closed is CLOSED itself (owner decision 7).
    await db.customer.updateMany({ where: { id: { in: [w.customer('CL').id, w.customer('CL2').id] } }, data: { status: 'CLOSED' } });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('a photo taken before the closure is refused', async ({ browser }) => {
    const cl = w.customer('CL');
    // Between 24 h ago and the closure (2 h ago): fresh enough, but older than the closure.
    const old = await seedPhoto(w, {
      kind: 'FREE',
      capturedBy: 'S1',
      branchId: cl.branch.id,
      branchExtraId: cl.branch.id,
      capturedAt: new Date(Date.now() - 3 * 3_600_000),
    });
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    const out = await requestReactivationViaApi(s1, { branchId: cl.branch.id, reason: w.name('Open again'), attachmentId: old.id }, w);
    expect(out.ok).toBe(false);
    expect(out.fields?.attachmentId ?? out.message).toBe(OLD_PHOTO);
    expect(await db.customerEdit.count({ where: { branchId: cl.branch.id } })).toBe(0);
  });

  test('S1 asks on his phone; M1 is told, M5 sees nothing; M1 reactivates on the fresh evidence', async ({ browser }) => {
    test.setTimeout(300_000);
    const cl = w.customer('CL');
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto(`/customers/${cl.id}`);
    const form = await openStatusForm(s1, 'Request reactivation');
    await takeEvidence(form);
    const why = w.name('Shop reopened under the same owner');
    await form.locator('textarea').fill(why);
    await form.getByRole('button', { name: 'Request reactivation' }).click();
    await expect(s1.getByText('✓ Reactivation request sent for approval.')).toBeVisible();
    const edit = await db.customerEdit.findFirstOrThrow({
      where: { branchId: cl.branch.id, isReactivation: true, state: 'SUBMITTED' },
      select: { id: true, pendingRole: true, attachmentChanges: true },
    });
    w.adopt.edit(edit.id);
    approved = edit.id;
    expect(edit.pendingRole).toBe('MANAGER');
    const evidenceId = (edit.attachmentChanges as Array<{ attachmentId: string }>)[0]!.attachmentId;
    w.adopt.attachment(evidenceId);

    await expect
      .poll(async () => (await notificationsFor({ editId: edit.id, userId: w.user('M1').id })).map((n) => n.kind))
      .toEqual(['REACTIVATION_REQUESTED']);
    const m1 = await pageAs(browser, w, 'M1', 'desktop');
    await m1.goto('/notifications');
    const row = m1.getByRole('main').getByRole('link').filter({ hasText: 'Reactivation awaiting your decision' });
    await expect(row).toHaveAttribute('href', '/reactivations');
    await expect(row).toContainText('Reactivation');

    const m5 = await pageAs(browser, w, 'M5', 'desktop');
    await m5.goto('/reactivations');
    await expect(m5.getByText('No reactivation requests')).toBeVisible();

    await m1.goto('/reactivations');
    const card = m1.getByRole('main').getByRole('listitem').filter({ hasText: cl.legalName });
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(`${cl.legalName} — ${cl.branch.name}`);
    await expect(card).toContainText(`${cl.code} · route ${w.route('R1a').code} · submitted by ${w.user('S1').fullName}`);
    await expect(card).toContainText(`Reason: ${why}`);
    await expect(card.getByText('Fresh evidence (captured for this request)')).toBeVisible();
    await imagesLoaded(card.getByRole('img', { name: 'Reactivation evidence' }));
    await card.getByRole('button', { name: '✓ Reactivate' }).click();
    const dialog = m1.getByRole('dialog', { name: 'Reactivate this shop?' });
    await dialog.getByRole('button', { name: 'Reactivate', exact: true }).click();
    await expect(m1.getByText(cl.legalName)).toHaveCount(0);

    expect((await db.branch.findUniqueOrThrow({ where: { id: cl.branch.id }, select: { status: true } })).status).toBe('ACTIVE');
    // Owner decision 7: a shop reopened makes the customer ACTIVE again, audited on the customer.
    expect((await db.customer.findUniqueOrThrow({ where: { id: cl.id }, select: { status: true } })).status).toBe('ACTIVE');
    expect((await auditFor({ entityId: cl.branch.id, action: 'REACTIVATE', entityType: 'Branch' })).length).toBe(1);
    expect((await auditFor({ entityId: cl.id, action: 'REACTIVATE', entityType: 'Customer' })).length).toBe(1);
    expect(await stateOf(edit.id)).toMatchObject({ state: 'APPROVED', reviewedById: w.user('M1').id });
    // Wave 1: the salesman is told; M1's own request row is settled by the decision.
    await expect
      .poll(async () => (await notificationsFor({ editId: edit.id, userId: w.user('S1').id })).map((n) => `${n.kind}:${n.title}`))
      .toEqual(['EDIT_APPROVED_FINAL:Reactivation approved']);
    const m1Row = (await notificationsFor({ editId: edit.id, userId: w.user('M1').id }))[0]!;
    expect(m1Row.readAt).not.toBeNull();
  });

  test('Keep closed needs a reason, is final and keeps the salesman’s reason; a colleague’s later Reactivate is refused', async ({ browser }) => {
    test.setTimeout(240_000);
    const cl2 = w.customer('CL2');
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    const up = await uploadPhotoViaApi(s1, w, { kind: 'FREE' });
    salesmanReason = w.name('The shop is open again');
    const out = await requestReactivationViaApi(s1, { branchId: cl2.branch.id, reason: salesmanReason, attachmentId: up.attachmentId }, w);
    expect(out, JSON.stringify(out).slice(0, 300)).toMatchObject({ ok: true });
    keptClosed = receiptEditId(out)!;

    const m2 = await pageAs(browser, w, 'M2', 'desktop');
    const m3 = await pageAs(browser, w, 'M3', 'desktop');
    await m2.goto('/reactivations');
    await m3.goto('/reactivations');
    const card2 = m2.getByRole('main').getByRole('listitem').filter({ hasText: cl2.legalName });
    await card2.getByRole('button', { name: 'Keep closed' }).click();
    await card2.getByPlaceholder('Why are you keeping it closed?').fill('abcd');
    await expect(card2.getByRole('button', { name: 'Keep closed' }), 'four characters').toBeDisabled();
    const managerReason = w.name('Still shuttered, checked with the owner');
    await card2.getByPlaceholder('Why are you keeping it closed?').fill(managerReason);
    await card2.getByRole('button', { name: 'Keep closed' }).click();
    await expect(m2.getByText(cl2.legalName)).toHaveCount(0);

    // Wave 1: final, the salesman's own reason kept, the Manager's on the audit row and in his notification.
    expect(await stateOf(keptClosed)).toMatchObject({ state: 'REJECTED', decisionReason: salesmanReason, reviewedById: w.user('M2').id });
    const reject = await auditFor({ entityId: keptClosed, action: 'REJECT' });
    expect(reject.map((r) => r.reason)).toEqual([managerReason]);
    await expect
      .poll(async () => (await notificationsFor({ editId: keptClosed, userId: w.user('S1').id })).map((n) => `${n.kind}:${n.title}`))
      .toEqual(['EDIT_NEEDS_CORRECTION:Reactivation refused']);
    expect((await notificationsFor({ editId: keptClosed, userId: w.user('S1').id }))[0]!.body).toContain(managerReason);

    // M3's page still shows the request: his Reactivate is refused, the shop stays closed.
    const card3 = m3.getByRole('main').getByRole('listitem').filter({ hasText: cl2.legalName });
    await card3.getByRole('button', { name: '✓ Reactivate' }).click();
    await m3.getByRole('dialog', { name: 'Reactivate this shop?' }).getByRole('button', { name: 'Reactivate', exact: true }).click();
    await expect(card3.getByText(/Edit is in state REJECTED\.|just decided by another reviewer/)).toBeVisible();
    expect((await db.branch.findUniqueOrThrow({ where: { id: cl2.branch.id }, select: { status: true } })).status).toBe('CLOSED');
  });

  test('S1’s bell, Today, Work and Needs correction after the two decisions', async ({ browser }) => {
    expect(approved && keptClosed, 'the two decisions above ran').toBeTruthy();
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    // Wave 1: the salesman's red count is what waits on him (the refusal); the approval is information.
    await expect(bell(s1)).toHaveAccessibleName('Notifications (1 unread, 1 for information)');
    // "Keep closed" is final: nothing to correct.
    await expect(s1.getByRole('main').getByRole('link', { name: /Needs correction/ })).toContainText(/^\s*0\s*Needs correction/);
    await s1.goto('/notifications');
    await expect(s1.getByText('Reactivation approved')).toBeVisible();
    await expect(s1.getByText('Reactivation refused')).toBeVisible();
    await s1.goto('/work');
    await expect(s1.getByText(/Sent back to you/)).toHaveCount(0);
    await s1.goto('/rejected');
    await expect(s1.getByText(w.customer('CL2').legalName)).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Who is told (MGR-NOTIFY-DIRECT)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: only the direct supervisor is told, every regional Manager can act', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let update: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('ant', {
      regions: REGIONS,
      routes: ROUTES,
      users: [...FOUR.map((k) => mgr(k)), mgr('M5', 'R2'), ACC1, S1, S2],
      customers: [
        approvableCustomer('N1', 'R1a'),
        openShop('N2', 'R1a'),
        closedShop('N3', 'R1a', 24),
        openShop('N4', 'R1b'),
        approvableCustomer('N5', 'R1b'),
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('S1’s update: M1’s bell shows it with its link; M2–M4 have no row but the card; the Accountant is told for information', async ({ browser }) => {
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    const sent = await submitEnrichViaApi(s1, { customerId: w.customer('N1').id, customer: { contactPerson: w.name('Told contact') } }, { world: w });
    expect(sent, JSON.stringify(sent).slice(0, 300)).toMatchObject({ status: 200, ok: true });
    update = receiptEditId(sent)!;
    await expect
      .poll(async () => (await notificationsFor({ editId: update })).map((n) => `${n.userId}:${n.kind}`).sort())
      .toEqual([`${w.user('M1').id}:EDIT_SUBMITTED`, `${w.user('ACC1').id}:REQUEST_FYI`].sort());

    const m1 = await pageAs(browser, w, 'M1');
    await m1.goto('/approvals');
    await expect(bell(m1)).toHaveAccessibleName('Notifications (1 unread)');
    await m1.goto('/notifications');
    const row = m1.getByRole('main').getByRole('link').filter({ hasText: 'Edit awaiting your review' });
    await expect(row).toHaveAttribute('href', `/approvals/${update}`);
    await expect(row).toContainText('Review');

    for (const key of ['M2', 'M3', 'M4']) {
      const page = await pageAs(browser, w, key);
      await page.goto('/approvals');
      await expect(queueCard(page, w.customer('N1').legalName), `${key} can act on it from his queue`).toBeVisible();
      await expect(bell(page), `${key} is not told`).toHaveAccessibleName('Notifications');
      await page.context().close();
    }
    const acc = await pageAs(browser, w, 'ACC1');
    await acc.goto('/approvals');
    await expect(bell(acc)).toHaveAccessibleName('Notifications (1 for information)');
    await expect(acc.locator('[data-bell="information"]')).toHaveText('1');
  });

  test('M3 approves it: M1’s alert is settled and leaves his bell', async ({ browser }) => {
    const m3 = await pageAs(browser, w, 'M3');
    await m3.goto(`/approvals/${update}`);
    await approveHere(m3);
    await expect(m3).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    const m1Row = (await notificationsFor({ editId: update, userId: w.user('M1').id }))[0]!;
    expect(m1Row.readAt, 'wave 1: a colleague’s decision settles the supervisor’s alert').not.toBeNull();
    const m1 = await pageAs(browser, w, 'M1');
    await m1.goto('/approvals');
    await expect(bell(m1)).toHaveAccessibleName('Notifications');
  });

  test('S1’s close and reactivation: M1’s rows say what they are and land on the page that decides them', async ({ browser }) => {
    test.skip(!hasR2, 'close and reactivation requests carry an evidence photo (R2)');
    const s1 = await pageAs(browser, w, 'S1');
    await s1.goto('/today');
    const p1 = await uploadPhotoViaApi(s1, w, { kind: 'FREE' });
    const close = await closeBranchViaApi(s1, { branchId: w.branch('N2').id, reason: w.name('Shop shut'), attachmentId: p1.attachmentId }, w);
    expect(close, JSON.stringify(close).slice(0, 300)).toMatchObject({ ok: true });
    const closeId = receiptEditId(close)!;
    const p2 = await uploadPhotoViaApi(s1, w, { kind: 'FREE' });
    const react = await requestReactivationViaApi(s1, { branchId: w.branch('N3').id, reason: w.name('Shop open again'), attachmentId: p2.attachmentId }, w);
    expect(react, JSON.stringify(react).slice(0, 300)).toMatchObject({ ok: true });

    const m1 = await pageAs(browser, w, 'M1');
    await m1.goto('/notifications');
    const reactRow = m1.getByRole('main').getByRole('link').filter({ hasText: 'Reactivation awaiting your decision' });
    await expect(reactRow).toHaveAttribute('href', '/reactivations');
    await expect(reactRow).toContainText('Reactivation');
    const closeRow = m1.getByRole('main').getByRole('link').filter({ hasText: 'Close-shop request awaiting your review' });
    await expect(closeRow).toHaveAttribute('href', `/approvals/${closeId}`);
    await expect(closeRow).toContainText('Review');
    await closeRow.click();
    await expect(m1).toHaveURL(new RegExp(`/approvals/${closeId}$`));
    await expect
      .poll(async () => (await notificationsFor({ editId: closeId, userId: w.user('M1').id }))[0]?.readAt ?? null, { timeout: 20_000 })
      .not.toBeNull();
  });

  test('a salesman with no supervisor: his close and his update are told to every Manager of the region', async ({ browser }) => {
    await db.user.update({ where: { id: w.user('S2').id }, data: { supervisorId: null } });
    const s2 = await pageAs(browser, w, 'S2');
    await s2.goto('/today');
    const r1Managers = idsOf(w, FOUR);

    const upd = await submitEnrichViaApi(s2, { customerId: w.customer('N5').id, customer: { contactPerson: w.name('No supervisor') } }, { world: w });
    expect(upd, JSON.stringify(upd).slice(0, 300)).toMatchObject({ ok: true });
    const updId = receiptEditId(upd)!;
    // Wave 1: the Supervisor step falls back to the region's active Managers (it told nobody).
    await expect
      .poll(async () => (await notificationsFor({ editId: updId })).filter((n) => n.kind === 'EDIT_SUBMITTED').map((n) => n.userId).sort())
      .toEqual(r1Managers);

    if (hasR2) {
      const p = await uploadPhotoViaApi(s2, w, { kind: 'FREE' });
      const close = await closeBranchViaApi(s2, { branchId: w.branch('N4').id, reason: w.name('Closed for good'), attachmentId: p.attachmentId }, w);
      expect(close, JSON.stringify(close).slice(0, 300)).toMatchObject({ ok: true });
      const closeId = receiptEditId(close)!;
      await expect
        .poll(async () =>
          (await notificationsFor({ editId: closeId })).filter((n) => n.title === 'Close-shop request awaiting your review').map((n) => n.userId).sort()
        )
        .toEqual(r1Managers);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. The approval loop on a 360 px phone (MGR-PHONE-LAYOUT)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: the whole approval loop on a 360 px phone', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let longOne: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // 15 digits, stored as found in an old import: the diff must still fit the screen.
    const fifteen = `+968${String(Date.now()).slice(-12)}`;
    w = await createWorld('aph', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'R1a', region: 'R1' }],
      users: [mgr('M1'), { ...S1 }],
      customers: [
        approvableCustomer('L1', 'R1a'),
        approvableCustomer('L2', 'R1a'),
        approvableCustomer('L3', 'R1a'),
        approvableCustomer('LP', 'R1a', { phone: fifteen }),
        closedShop('LR', 'R1a'),
      ],
    });
    for (const k of ['L1', 'L2', 'L3']) await seedUpdateEdit(w, { customer: k, submitter: 'S1', patch: contact(w, `Phone ${k}`) });
    const [newPhone] = await w.allocPhones(1);
    const longAddress = `Building 1234, Way 3012, Block 245, Al Ghubra North, Bawshar, Muscat Governorate — opposite the big Lulu hypermarket car park entrance, second floor ${w.sfx}`;
    longOne = (
      await seedUpdateEdit(w, {
        customer: 'LP',
        submitter: 'S1',
        patch: { customer: { primaryPhone: newPhone }, branches: [{ branch: 'LP', address: longAddress }] },
      })
    ).id;
    await seedBranchRequest(w, { kind: 'reactivate', branch: 'LR', submitter: 'S1' });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('the drawer leads to Approvals; two ticked cards bring the bulk bar, which covers no card', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M1', 'phone360');
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#mobile-nav-drawer').getByRole('link', { name: 'Approvals' }).click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    await expect(page.getByRole('heading', { level: 1, name: 'Approval queue' })).toBeVisible();
    await expectNoSideScroll(page);
    for (const k of ['L1', 'L2']) await queueCard(page, w.customer(k).legalName).getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: '✓ Approve 2' })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = page.getByRole('main').getByRole('listitem').last();
    expect(await hitTest(page, last.getByRole('checkbox')), 'the last card is not under the bulk bar').toBe(true);
    expect(await hitTest(page, last.getByRole('link')), 'its link is tappable').toBe(true);
    await expectNoSideScroll(page);
  });

  test('a request with a 15-digit phone and a long address: Before/After on screen, the sticky bar tappable, modals fit, reject with a quick reason', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M1', 'phone360');
    await page.goto(`/approvals/${longOne}`);
    await expectNoSideScroll(page);
    const width = page.viewportSize()!.width;
    for (const label of ['Before', 'After']) {
      const boxes = page.getByText(label, { exact: true });
      const n = await boxes.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const box = await boxes.nth(i).locator('xpath=..').boundingBox();
        expect(box, `${label} #${i}`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${label} #${i} stays on screen`).toBeLessThanOrEqual(width + 1);
      }
    }
    const approve = page.getByRole('button', { name: /^✓ Approve$/ });
    expect(await hitTest(page, approve), 'the sticky Approve is tappable').toBe(true);
    expect(await hitTest(page, page.getByRole('button', { name: /^✗ Reject$/ })), 'the sticky Reject is tappable').toBe(true);

    await approve.click();
    const dialog = page.getByRole('dialog');
    for (const name of [/^Approve$/, /^Cancel$/]) {
      const box = await dialog.getByRole('button', { name }).boundingBox();
      expect(box!.x >= 0 && box!.x + box!.width <= width + 1, `${name} fits`).toBe(true);
    }
    await dialog.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: /^✗ Reject$/ }).click();
    await page.getByRole('button', { name: 'Please re-verify and resubmit' }).click();
    await expect(page.locator('textarea[name="reason"]')).toHaveValue('Please re-verify and resubmit');
    await expectNoSideScroll(page);
    await page.getByRole('button', { name: '✗ Send back to salesman' }).click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/, BACK_TO_QUEUE);
    expect((await stateOf(longOne)).state).toBe('NEEDS_CORRECTION');
    await expectNoSideScroll(page);
  });

  test('Reactivations and the dashboard fit: buttons and reason box on screen, two tiles a row, the map drawn', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M1', 'phone360');
    const width = 360;
    await page.goto('/reactivations');
    const card = page.getByRole('main').getByRole('listitem').filter({ hasText: w.customer('LR').legalName });
    for (const name of ['Keep closed', '✓ Reactivate']) {
      const box = await card.getByRole('button', { name }).boundingBox();
      expect(box!.x >= 0 && box!.x + box!.width <= width + 1, `${name} fits`).toBe(true);
    }
    await card.getByRole('button', { name: 'Keep closed' }).click();
    const reason = card.getByPlaceholder('Why are you keeping it closed?');
    const rbox = await reason.boundingBox();
    expect(rbox!.x >= 0 && rbox!.x + rbox!.width <= width + 1, 'the reason box fits').toBe(true);
    await expectNoSideScroll(page);
    await card.getByRole('button', { name: 'Cancel' }).click();

    await page.goto('/dashboard');
    const a = await kpiTile(page, 'New customers').boundingBox();
    const b = await kpiTile(page, 'Customers updated').boundingBox();
    const c = await kpiTile(page, 'Pending approval').boundingBox();
    expect(Math.abs(a!.y - b!.y), 'two tiles on the first row').toBeLessThan(2);
    expect(c!.y, 'the third tile starts a second row').toBeGreaterThan(a!.y + a!.height - 1);
    const map = page.getByRole('img', { name: /^Approximate map of Oman/ });
    await map.scrollIntoViewIfNeeded();
    await expect(map).toBeVisible();
    const mbox = await map.boundingBox();
    expect(mbox!.width).toBeGreaterThan(100);
    expect(mbox!.x + mbox!.width).toBeLessThanOrEqual(width + 1);
    await expectNoSideScroll(page);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Work items and Service status (MGR-WORK-STATUS; owner decision 3)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: Work items list what a Manager can decide; Service status counts his regions', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  const ids: Record<string, string> = {};
  let creditName: string;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await createWorld('aws', {
      regions: REGIONS,
      routes: ROUTES,
      // FM1 approved the credit's Finance Manager step (seeded); no GM fixture is needed.
      users: [mgr('M1'), mgr('M5', 'R2'), { key: 'FM1', role: 'FINANCE_MANAGER' }, S1, S3],
      customers: [approvableCustomer('W1', 'R1a'), closedShop('WR', 'R1a', 120), approvableCustomer('W3', 'R2a')],
    });
    const fourDays = new Date(Date.now() - 4 * 86_400_000);
    ids.update = (await seedUpdateEdit(w, { customer: 'W1', submitter: 'S1', patch: contact(w, 'Stale update'), submittedAt: fourDays })).id;
    ids.react = (await seedBranchRequest(w, { kind: 'reactivate', branch: 'WR', submitter: 'S1', submittedAt: fourDays })).id;
    ids.r2 = (await seedUpdateEdit(w, { customer: 'W3', submitter: 'S3', patch: contact(w, 'Other region'), submittedAt: fourDays })).id;
    const credit = await seedCreateRequest(w, {
      submitter: 'S1',
      paymentTerms: 'CREDIT',
      step: 'GM',
      priorApprovers: ['M1', 'FM1'],
      submittedAt: fourDays,
      stageEnteredAt: new Date(Date.now() - 2 * 86_400_000),
    });
    ids.credit = credit.id;
    creditName = credit.legalName;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (w) await w.cleanup();
  });

  test('Work lists his stale update and reactivation, not the GM-step credit or another region’s', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M1');
    await page.goto('/work');
    const item = (name: string) => page.getByRole('main').getByRole('link').filter({ hasText: name });
    const upd = item(w.customer('W1').legalName);
    const react = item(w.customer('WR').legalName);
    await expect(upd).toContainText('Stale approval (>3 days)');
    await expect(upd).toHaveAttribute('href', `/approvals/${ids.update}`);
    await expect(react).toContainText('Stale approval (>3 days)');
    await expect(react).toHaveAttribute('href', '/reactivations');
    // Owner decision 3 (fix-up): a request waiting at the GM's step is not his to decide.
    await expect(page.getByText(creditName)).toHaveCount(0);
    await expect(page.getByText(w.customer('W3').legalName)).toHaveCount(0);
    await react.click();
    await expect(page).toHaveURL(/\/reactivations(\?|$)/);

    const m5 = await pageAs(browser, w, 'M5');
    await m5.goto('/work');
    await expect(m5.getByRole('main').getByRole('link').filter({ hasText: w.customer('W3').legalName })).toHaveAttribute('href', `/approvals/${ids.r2}`);
    await expect(m5.getByText(w.customer('W1').legalName)).toHaveCount(0);
  });

  test('the GM-step credit opens read-only with its banner; the reactivation points to Reactivations', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M1');
    await page.goto(`/approvals/${ids.credit}`);
    await expect(
      page.getByRole('note').filter({ hasText: 'For your information: this request is waiting at the GM step, which you cannot decide.' })
    ).toBeVisible();
    await page.goto(`/approvals/${ids.react}`);
    const note = page.getByRole('note').filter({ hasText: 'Reactivation requests are decided on the Reactivations page by a Manager of the branch' });
    await expect(note).toBeVisible();
    await expect(note.getByRole('link', { name: 'Open Reactivations' })).toHaveAttribute('href', '/reactivations');
  });

  test('Service status counts the Supervisor step in his regions only', async ({ browser }) => {
    const page = await pageAs(browser, w, 'M1');
    await page.goto('/status');
    await expect(page.getByText(/Approvals count the Supervisor step in your regions; everything else is company-wide\./)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Approvals waiting in your regions' })).toBeVisible();
    const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: 'Supervisor', exact: true }) });
    // Only W1's update: R2's is another region's, the credit waits on the GM, the reactivation on a Manager.
    await expect(card.locator('p').first()).toHaveText('1');
    await expect(card).toContainText('1 past due');
    await expect(page.getByText(/^Measured at .+ Oman time$/)).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Photo-heavy pages (MGR-PHOTO-BURST)
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: photo-heavy pages stay under the photo rate limit', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  test.skip(!hasR2, 'the photos live in R2');

  const KEYS = Array.from({ length: 25 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`);
  let w: World;
  let create: { id: string; legalName: string; photoIds: string[] };

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    w = await createWorld('apb', {
      regions: [{ key: 'R1' }],
      routes: [{ key: 'R1a', region: 'R1' }],
      users: [mgr('M1'), { ...S1 }],
      customers: KEYS.map((k) => closedShop(k, 'R1a', 2, true)),
    });
    for (const k of KEYS) await seedBranchRequest(w, { kind: 'reactivate', branch: k, submitter: 'S1' });
    create = await seedCreateRequest(w, { submitter: 'S1', paymentTerms: 'CASH', branches: 10, photos: true });
  });

  test.afterAll(async () => {
    test.setTimeout(600_000);
    if (w) await w.cleanup();
  });

  test('25 reactivations and a 10-branch new customer: every photo answers 200, none 429', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, w, 'M1');
    const tally = tallyPhotoResponses(page);
    await page.goto('/reactivations');
    await expect(page.getByText(`${KEYS.length} closed shops requesting reactivation`, { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Reactivation evidence' })).toHaveCount(KEYS.length);
    await page.waitForLoadState('networkidle');
    test.info().annotations.push({ type: '/reactivations photo responses', description: JSON.stringify(tally.byStatus()) });

    await page.goto(`/approvals/${create.id}`);
    await expect(page.getByRole('heading', { level: 1, name: create.legalName })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const all = tally.byStatus();
    test.info().annotations.push({ type: 'all photo responses', description: JSON.stringify(all) });
    // The limiter allows 60 photos in a burst, then one a second, per user and server instance.
    expect(all[429] ?? 0, 'photos refused by the rate limit (lazy-load or paginate)').toBe(0);
    expect(Object.keys(all), 'every photo answered 200').toEqual(['200']);
    expect(tally.total()).toBeGreaterThanOrEqual(KEYS.length + create.photoIds.length);
    // And none is broken on the page.
    await imagesLoaded(page.locator('main img[src^="/api/photos/"]'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. The SLA escalation sweep (MGR-SLA-ESCALATION, FIN-17-SLA-PILL-L1,
//     FIN-18-SLA-L2-AUDIENCES) — exclusive: the sweep is company-wide
// ═════════════════════════════════════════════════════════════════════════════

test.describe('approvals: the SLA escalation sweep', { tag: ['@exclusive'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World | undefined;
  let blocked: string | null = null;
  const e: Record<string, string> = {};

  const sweep = async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new Error('CRON_SECRET is not set (run through scripts/qa/run-with-env.mjs)');
    // Node's fetch, not a Playwright request: the bearer must not become a report step.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/cron/sla-escalate`, { headers: { authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as { escalated: number; level2: number; temixPinged: number; gcDeleted: number; sweepErrors: number };
  };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // Read-only, before anything is seeded: would the sweep touch real UAT rows?
    const impact = await slaSweepImpact([]);
    if (Object.values(impact).some((n) => n > 0)) {
      blocked =
        `the sweep is company-wide and would touch real UAT rows: ${impact.overdue} overdue request(s), ` +
        `${impact.level2Candidates} level-1 request(s), ${impact.temixQueue} customer(s) in the Temix queue (pings real Stewards), ` +
        `${impact.notificationGc} read notification(s) older than 90 days (deleted) — run this describe on a Neon branch of UAT`;
      return;
    }
    w = await createWorld('asl', {
      regions: REGIONS,
      routes: [
        { key: 'R1a', region: 'R1' },
        { key: 'R2a', region: 'R2' },
      ],
      users: [
        ...FOUR.map((k) => mgr(k)),
        mgr('M5', 'R2'),
        ACC1,
        { key: 'FM1', role: 'FINANCE_MANAGER' },
        { key: 'FM2', role: 'FINANCE_MANAGER' },
        { key: 'GM1', role: 'GM' },
        { key: 'STW', role: 'STEWARD' },
        { ...S1 },
      ],
      customers: [approvableCustomer('E1', 'R1a'), approvableCustomer('E3', 'R1a'), closedShop('ER', 'R1a', 48)],
    });
    const sup = slaBudgetMin('SUPERVISOR');
    const acc = slaBudgetMin('ACCOUNTANT');
    const fm = slaBudgetMin('FINANCE_MANAGER');
    const gm = slaBudgetMin('GM');
    const mg = slaBudgetMin('MANAGER');
    // Level 1, Supervisor step: three working hours past its deadline ("OVERDUE 3h").
    e.sup1 = (
      await seedUpdateEdit(w, {
        customer: 'E1',
        submitter: 'S1',
        patch: contact(w, 'Late contact'),
        stageEnteredAt: workingMinutesAgo(sup + 180),
        slaDueAt: workingMinutesAgo(180),
      })
    ).id;
    // Level 2, Supervisor step: past twice its budget, already escalated once.
    e.sup2 = (
      await seedUpdateEdit(w, {
        customer: 'E3',
        submitter: 'S1',
        patch: contact(w, 'Very late contact'),
        escalationLevel: 1,
        stageEnteredAt: workingMinutesAgo(2 * sup + 60),
        slaDueAt: workingMinutesAgo(sup + 60),
      })
    ).id;
    e.react = (
      await seedBranchRequest(w, { kind: 'reactivate', branch: 'ER', submitter: 'S1', stageEnteredAt: workingMinutesAgo(mg + 60), slaDueAt: workingMinutesAgo(60) })
    ).id;
    const late = (role: 'ACCOUNTANT' | 'FINANCE_MANAGER' | 'GM', budget: number, level: 0 | 1) =>
      seedCreateRequest(w!, {
        submitter: 'S1',
        paymentTerms: role === 'ACCOUNTANT' ? 'CASH' : 'CREDIT',
        step: role,
        priorApprovers: role === 'ACCOUNTANT' ? ['M2'] : role === 'FINANCE_MANAGER' ? ['M2'] : ['M2', 'FM1'],
        escalationLevel: level,
        stageEnteredAt: workingMinutesAgo(level === 1 ? 2 * budget + 60 : budget + 60),
        slaDueAt: workingMinutesAgo(level === 1 ? budget + 60 : 60),
      });
    e.acc1 = (await late('ACCOUNTANT', acc, 0)).id;
    e.acc2 = (await late('ACCOUNTANT', acc, 1)).id;
    e.fm1 = (await late('FINANCE_MANAGER', fm, 0)).id;
    e.fm2 = (await late('FINANCE_MANAGER', fm, 1)).id;
    e.gm = (await late('GM', gm, 0)).id;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    // Cleanup also removes the real FMs', GMs' and Managers' SLA_BREACH rows: they are found by editId.
    if (w) await w.cleanup();
  });

  test('before the sweep the queue pill reads OVERDUE 3h', async ({ browser }) => {
    test.skip(blocked !== null, blocked ?? '');
    const page = await pageAs(browser, w!, 'M1');
    await page.goto('/approvals');
    await expect(queueCard(page, w!.customer('E1').legalName)).toContainText('OVERDUE 3h');
    await expect(queueCard(page, w!.customer('E1').legalName)).not.toContainText('⚠');
    await expect(queueCard(page, w!.customer('E3').legalName), 'already escalated once').toContainText('⚠ OVERDUE');
  });

  test('the sweep escalates each late step once, to the people who can open it, and queues the e-mail', async () => {
    test.skip(blocked !== null, blocked ?? '');
    test.setTimeout(240_000);
    const ww = w!;
    const body = await sweep();
    test.info().annotations.push({ type: 'sweep', description: JSON.stringify(body) });
    expect(body.escalated).toBeGreaterThanOrEqual(5);
    expect(body.level2).toBeGreaterThanOrEqual(3);
    expect(body.sweepErrors).toBe(0);

    // The row and its audit trail.
    const row = await stateOf(e.sup1!);
    expect(row.escalationLevel).toBe(1);
    expect(row.slaBreachedAt).not.toBeNull();
    expect(row.lastEscalatedAt).not.toBeNull();
    const audit = await auditFor({ entityId: e.sup1!, action: 'ESCALATE' });
    expect(audit.map((a) => ({ reason: a.reason, actorId: a.actorId, ip: a.ip, userAgent: a.userAgent }))).toEqual([
      { reason: 'system: sla-escalate sweep', actorId: ww.user('S1').id, ip: null, userAgent: null },
    ]);

    const r1 = idsOf(ww, FOUR);
    const has = (rows: string[], keys: string[]) => keys.every((k) => rows.includes(ww.user(k).id));
    const none = (rows: string[], keys: string[]) => keys.every((k) => !rows.includes(ww.user(k).id));
    // Supervisor step, level 1: R1's Managers only — not M5, not the GM.
    expect(await breachRecipients(e.sup1!)).toEqual(r1);
    const sup1Rows = await notificationsFor({ editId: e.sup1! });
    expect(sup1Rows.every((n) => n.title === 'SLA breached')).toBe(true);
    // Owner decision 6: a late request goes to the e-mail outbox (e-mail itself is off in this run).
    expect(sup1Rows.every((n) => n.emailedAt === null), 'SLA_BREACH rows wait in the e-mail outbox').toBe(true);
    // Supervisor step, level 2: R1's Managers plus the GM.
    const sup2 = await breachRecipients(e.sup2!);
    expect(has(sup2, [...FOUR, 'GM1'])).toBe(true);
    expect(none(sup2, ['M5', 'STW'])).toBe(true);
    expect((await notificationsFor({ editId: e.sup2! })).every((n) => n.title === 'SLA breached — second escalation')).toBe(true);
    // A late reactivation: the GM, not the Managers.
    const react = await breachRecipients(e.react!);
    expect(has(react, ['GM1'])).toBe(true);
    expect(none(react, [...FOUR, 'M5', 'STW'])).toBe(true);
    // Accountant step: the Finance Managers and the GM at both levels; never a Steward (wave 1).
    for (const id of [e.acc1!, e.acc2!]) {
      const to = await breachRecipients(id);
      expect(has(to, ['FM1', 'FM2', 'GM1'])).toBe(true);
      expect(none(to, ['STW', ...FOUR, 'M5', 'ACC1'])).toBe(true);
    }
    // Finance Manager step: the GM at both levels; never a Steward.
    for (const id of [e.fm1!, e.fm2!]) {
      const to = await breachRecipients(id);
      expect(has(to, ['GM1'])).toBe(true);
      expect(none(to, ['STW', 'FM1', 'FM2', ...FOUR, 'M5'])).toBe(true);
    }
    // GM step: the Managers of the request's region only (wave 1: not every Manager, no Steward).
    expect(await breachRecipients(e.gm!)).toEqual(r1);

    // A second call escalates nothing more.
    const before = await db.notification.count({ where: { editId: { in: Object.values(e) }, kind: 'SLA_BREACH' } });
    const again = await sweep();
    expect(again).toMatchObject({ escalated: 0, level2: 0 });
    expect(await db.notification.count({ where: { editId: { in: Object.values(e) }, kind: 'SLA_BREACH' } })).toBe(before);
    expect((await stateOf(e.sup1!)).escalationLevel).toBe(1);
  });

  test('after the sweep: the ⚠ pill, links every recipient can open, nothing for M5 or the Steward, /status counts his region', async ({ browser }) => {
    test.skip(blocked !== null, blocked ?? '');
    const ww = w!;
    const m1 = await pageAs(browser, ww, 'M1');
    await m1.goto('/approvals');
    await expect(queueCard(m1, ww.customer('E1').legalName)).toContainText('⚠ OVERDUE 3h');

    await m1.goto('/notifications');
    const breach = m1.getByRole('main').getByRole('link').filter({ hasText: 'SLA breached' }).filter({ hasText: ww.customer('E1').legalName });
    await expect(breach).toHaveAttribute('href', `/approvals/${e.sup1}`);
    // The late GM step: M1 can open it, read-only.
    await m1.goto(`/approvals/${e.gm}`);
    await expect(m1.getByRole('note').filter({ hasText: 'waiting at the GM step, which you cannot decide' })).toBeVisible();

    // The GM's breach of the reactivation opens its review page, which points to Reactivations.
    const gm = await pageAs(browser, ww, 'GM1');
    await gm.goto('/notifications');
    const gmRow = gm.getByRole('main').getByRole('link').filter({ hasText: 'SLA breached' }).filter({ hasText: ww.customer('ER').legalName });
    await expect(gmRow).toHaveAttribute('href', `/approvals/${e.react}`);
    await gmRow.click();
    await expect(gm).toHaveURL(new RegExp(`/approvals/${e.react}$`));
    await expect(gm.getByRole('note').filter({ hasText: 'Reactivation requests are decided on the Reactivations page' })).toBeVisible();

    // Neither another region's Manager nor the Steward was told anything.
    for (const key of ['M5', 'STW']) {
      expect(await db.notification.count({ where: { userId: ww.user(key).id, editId: { in: Object.values(e) } } }), key).toBe(0);
    }

    await m1.goto('/status');
    const card = m1.locator('article').filter({ has: m1.getByRole('heading', { level: 3, name: 'Supervisor', exact: true }) });
    await expect(card.locator('p').first()).toHaveText('2');
    await expect(card).toContainText('2 past due');
    await expect(m1.getByText(/^Measured at .+ Oman time$/)).toBeVisible();
  });
});
