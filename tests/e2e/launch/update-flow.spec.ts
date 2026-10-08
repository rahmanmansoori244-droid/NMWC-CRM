/**
 * LAUNCH E2E — the enrichment (UPDATE) request, end to end, as the launch build
 * intends it (production main + the four features + the wave-1 launch fixes +
 * the owner decisions of 7 Oct):
 *
 *   SM-ENRICH-HAPPY, MGR-APPROVE-UPDATE-FALLBACK  a salesman fills the gaps, captures GPS
 *       and three photos, submits; M2 — a Manager of the region who is NOT his
 *       supervisor — reviews the evidence and approves (desktop, and at 412 px);
 *   SM-PENDING-LOCK  one open request per customer, in his own words, Save draft
 *       still works, Mark closed refused;
 *   SM-ENRICH-GATE-LOCKS  the CORE gate item by item, locked fields, the server's
 *       own gate; owner decision 4 (only what a request changes must be complete)
 *       and decision 2 (a CREDIT customer's CR document is locked for salesmen);
 *   SM-ENRICH-MULTIBRANCH  own shops only, decision 4 per shop, the other
 *       salesman's lock, decision 3 (a Manager decides only his regions' shops);
 *   SM-GPS-BANDS, SM-GPS-MANUAL, SM-GPS-MOVE  the ±30 / ±100 m standard, a typed
 *       point with its reason (Arabic digits too), moving a saved point;
 *   MGR-GPS-PHOTO-EVIDENCE  the decision page's bands, typed-point note, map links;
 *   SM-PHOTOS-LIVE  photos go live at once; retake, remove, a non-image;
 *   SM-ENRICH-DRAFT  the phone copy, ONE server draft per salesman (launch fix),
 *       a newer server value drops the copy, per-user keys, Sign out deletes them;
 *   MGR-REJECT-UPDATE, SM-NEEDS-CORRECTION-UPDATE  reject with a category, the
 *       salesman sees why everywhere, the returned values come back filled in,
 *       the resubmit clears the lists (launch fix), "Nothing to send again";
 *   MGR-DIRECT-EDIT, SV-STEWARD-DIRECT-EDIT  direct writes, region-bound, refused
 *       while a salesman's request waits, Temix queued; decision 7 on a direct
 *       write (a customer follows its shops);
 *   critic P0  what changed after a request was sent: STALE_BEFORE, NEEDS_REUPLOAD,
 *       a shop deleted meanwhile;
 *   critic P2  a route switched off mid-week: his enrichment, his close request,
 *       his reactivation request (804bda1) and a photo attach (5e8929b) are
 *       refused in the route's words, and nothing is written.
 *
 * R2 is required (every enrichment carries photos): those describes skip without
 * it, listed as NOT RUN ON UAT (notRunHere).
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts update-flow --project=phone --project=desktop
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  MUSCAT,
  auditFor,
  contextAs,
  createWorld,
  db,
  expectNoSideScroll,
  fetchAs,
  hasR2,
  installLaunchHooks,
  mintSessionCookie,
  mintingProven,
  notRunHere,
  notificationsFor,
  postForm,
  postJson,
  receiptEditId,
  requestReactivationViaApi,
  requireLaunchEnv,
  seedUpdateEdit,
  signInViaUi,
  standardWorld,
  submitEnrichViaApi,
  textFile,
  uniquePng,
  uploadPhotoViaApi,
  type World,
} from './support';
import {
  ROUTE_INACTIVE_MESSAGE,
  activityLine,
  bell,
  branchSection,
  channelId,
  cleanupUpdateWorld,
  editsOn,
  expectMissing,
  gpsButton,
  gpsChip,
  holdNextRequest,
  missingBox,
  omanDateTime,
  omanWhen,
  photoSlot,
  pickFile,
  rewriteNextEditSubmit,
  saveDraftButton,
  sleep,
  slowNextDocument,
  stat,
  submitButton,
  submittedEditOn,
  waitForBranchPhoto,
  waitForCrPhoto,
  waitHydrated,
  watchForText,
} from './support/update-flow-helpers';

const R2_SKIP = 'R2 is not configured: photos are part of every enrichment';
/** The salesman's submit gate these expectations describe: CORE (lib/submit-gate.ts), the go-live setting. */
const FULL_GATE = process.env.SALESMAN_SUBMIT_GATE === 'FULL';
const CORE_ONLY = 'these expectations are the CORE submit gate (SALESMAN_SUBMIT_GATE unset); this run sets FULL';
const CR_LOCKED = 'The CR document of a credit customer is changed by your manager or the Data Steward.';
const UPLOADING = 'Wait — a photo is still uploading.';
const FIX_FIELDS = 'Not sent — fix what is marked in red, then submit again.';
const ARRIVED = '✓ Submitted for approval. It arrived — nothing more to do.';

type Change = { field: string; before: unknown; after: unknown; gpsSource?: string; gpsManualReason?: string };
const changesOf = (e: { fieldChanges: unknown }) => e.fieldChanges as Change[];
const changeOf = (e: { fieldChanges: unknown }, field: string) => changesOf(e).find((c) => c.field === field);

/** A camera PNG with unique bytes (the browser re-encodes it to JPEG). */
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: uniquePng() });
/** '+96891234567' as a salesman types it: '+968 9123 4567'. */
const spaced = (p: string) => `${p.slice(0, 4)} ${p.slice(4, 8)} ${p.slice(8)}`;
const mapPin = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
const directions = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;

/** Opens a request's decision page and approves it ('Approve this edit?' → Approve → back to /approvals). */
async function approveOnPage(page: Page, editId: string): Promise<void> {
  await page.goto(`/approvals/${editId}`);
  const approve = page.getByRole('button', { name: '✓ Approve' });
  await waitHydrated(approve);
  await approve.click();
  const dialog = page.getByRole('dialog', { name: 'Approve this edit?' });
  await expect(dialog).toContainText('Changes will go live on the customer immediately.');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page).toHaveURL(/\/approvals(\?|$)/);
}

/** Clicks Approve and confirms, expecting the refusal shown above the buttons; the request stays SUBMITTED. */
async function approveExpectingRefusal(page: Page, editId: string, message: string): Promise<void> {
  const approve = page.getByRole('button', { name: '✓ Approve' });
  await waitHydrated(approve);
  await approve.click();
  await page.getByRole('dialog', { name: 'Approve this edit?' }).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/approvals/${editId}$`));
  expect((await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { state: true } })).state).toBe('SUBMITTED');
}

/** Opens the reject form of the page's request; returns the form. */
async function openRejectForm(page: Page) {
  const reject = page.getByRole('button', { name: '✗ Reject' });
  await waitHydrated(reject);
  await reject.click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Reject this submission' }) });
  await expect(form).toBeVisible();
  return form;
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: a salesman enriches a customer, a Manager who is not his supervisor approves', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;
  let editId = '';
  let phone = '';
  let contact = '';
  let cr = '';
  let address = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('uh', {
      customers: [
        // Imported with gaps: no phone, no contact, no CR, no GPS, no photos.
        { key: 'HAPPY', phone: null, contact: null, branches: [{ key: 'S', route: 'A', address: 'Imported address' }] },
        // Complete, three photos on file: the 412 px repeat of the decision.
        {
          key: 'REPEAT',
          phone: true,
          contact: 'Khalid Al Harthy',
          crNumber: true,
          crPhoto: true,
          branches: [{ key: 'S', route: 'A', gps: { ...MUSCAT }, photos: ['SHOP', 'SIGNBOARD'] }],
        },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('the salesman searches, fills the gaps, captures GPS and three photos, and submits — the gate clears without a reload', async ({ browser }) => {
    test.setTimeout(300_000);
    const sa = world.user('SA');
    const c = world.customer('HAPPY');
    const b = c.branch;
    [phone] = await world.allocPhones(1);
    contact = world.name('Salim Contact');
    cr = `CR${world.SFX}77`;
    address = world.name('Way 3012, Al Ghubra North, opposite the bakery');

    const page = await (await contextAs(browser, sa)).newPage();
    await page.goto(`/customers?q=${encodeURIComponent(c.legalName)}`);
    await page.getByRole('link', { name: `${c.legalName} · ${c.code}` }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`));
    await page.getByRole('link', { name: 'Enrich' }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}/edit$`));
    await waitHydrated(page);
    const { section, tag } = await branchSection(page, b.name);

    // Customer-level changes put the customer's mandatory fields in scope (owner decision 4).
    await page.getByLabel('Sub-channel', { exact: true }).selectOption({ index: 1 });
    await expectMissing(page, ['Primary phone', 'Contact person']);
    await page.getByLabel('Primary phone *', { exact: true }).fill(spaced(phone));
    await expectMissing(page, ['Contact person']);
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await page.getByLabel('CR number', { exact: true }).fill(cr);
    await expectMissing(page, []);
    // A change to the branch puts the branch in scope: it must be complete.
    await section.getByLabel('Address *', { exact: true }).fill(address);
    await expectMissing(page, [`${tag} GPS`, `${tag} shop photo`]);
    await section.getByLabel('Day of visit', { exact: true }).selectOption('SUN');
    await gpsButton(section).click();
    await expect(gpsChip(section)).toContainText('23.588100, 58.382900');
    await expect(gpsChip(section)).toContainText('±9m');
    await expect(gpsChip(section)).toHaveAttribute('data-accuracy-band', 'good');
    await expectMissing(page, [`${tag} shop photo`]);

    // Photos: CR (identity), then shop + signboard — presign → R2 PUT → finalize → attach.
    await pickFile(photoSlot(page, 'CR document'), png('cr.png'));
    await pickFile(photoSlot(section, 'Shop front'), png('shop.png'));
    await pickFile(photoSlot(section, 'Signboard'), png('sign.png'));
    const crId = await waitForCrPhoto(c.id);
    const shopId = await waitForBranchPhoto(b.id, 'shop');
    const signId = await waitForBranchPhoto(b.id, 'signboard');
    await expect(page.getByText(/upload failed|could not get upload url|finalize failed/i)).toHaveCount(0);

    // The gate clears as the photos land — no reload.
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();
    const release = await slowNextDocument(page, new RegExp(`/customers/${c.id}$`));
    const arrived = await watchForText(page, ARRIVED);
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });
    await release();
    // Said beside the button BEFORE the page moved on (item 22): on the form's own page.
    expect(arrived(), `"${ARRIVED}" was shown on the form before it left`).not.toBeNull();

    const edit = await submittedEditOn(c.id);
    editId = edit.id;
    world.adopt.edit(editId);
    await expect(page.getByText(activityLine(sa.fullName, edit.fieldChanges), { exact: true })).toBeVisible();

    expect(edit).toMatchObject({ process: 'UPDATE', target: 'CUSTOMER', pendingRole: 'SUPERVISOR', submittedById: sa.id });
    expect(edit.submitGate, 'the request records the branches it was gated on').toMatchObject({ v: 1, branchIds: [b.id] });
    expect(changeOf(edit, 'customer.primaryPhone')?.after, 'the phone is stored normalised').toBe(phone);
    expect(changeOf(edit, 'customer.contactPerson')?.after).toBe(contact);
    expect(changeOf(edit, 'customer.crNumber')?.after).toBe(cr);
    expect(changeOf(edit, `branch.${b.id}.address`)?.after).toBe(address);
    expect(changeOf(edit, `branch.${b.id}.dayOfVisit`)?.after).toBe('SUN');
    expect(changeOf(edit, `branch.${b.id}.gpsLat`)?.after as number).toBeCloseTo(MUSCAT.lat, 4);
    expect(changeOf(edit, `branch.${b.id}.gpsAccuracy`)?.after).toBe(9);
    const atts = await db.attachment.findMany({ where: { id: { in: [crId, shopId, signId] } } });
    expect(atts.map((a) => a.kind).sort()).toEqual(['CR', 'SHOP', 'SIGNBOARD']);
    for (const a of atts) expect(a.mimeType, `${a.kind} is compressed to JPEG in the browser`).toBe('image/jpeg');
    for (const a of atts.filter((x) => x.kind !== 'CR')) expect(a.capturedLat, `${a.kind} carries the capture position`).toBeCloseTo(MUSCAT.lat, 3);

    // Told: his supervisor M1 must act; the region's Accountant for information. Nobody else (not M2).
    const m1 = world.user('M1');
    await expect
      .poll(async () => (await notificationsFor({ editId })).map((n) => `${n.kind}:${n.userId}`).sort())
      .toEqual([`EDIT_SUBMITTED:${m1.id}`, `REQUEST_FYI:${world.user('ACC1').id}`].sort());
    const toM1 = (await notificationsFor({ editId, userId: m1.id }))[0]!;
    expect(toM1.title).toBe('Edit awaiting your review');
  });

  test('while it waits: Today and Work say so, the form says it in his words, Save draft still works, Mark closed is refused', async ({ browser }) => {
    test.setTimeout(240_000);
    expect(editId, 'the first test submitted a request').toBeTruthy();
    const c = world.customer('HAPPY');
    const page = await (await contextAs(browser, world.user('SA'))).newPage();

    await page.goto('/today');
    await expect(stat(page, 'Pending approval')).toHaveText('1');
    await page.goto('/work');
    await expect(page.locator(`a[href="/customers/${c.id}"]`).filter({ hasText: 'Awaiting approval' })).toContainText(c.legalName);

    const sent = await db.customerEdit.findUniqueOrThrow({ where: { id: editId }, select: { submittedAt: true } });
    const at = omanWhen(sent.submittedAt!);
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    await expect(
      page.getByText(`Your changes sent at ${at} arrived and are waiting for approval. You cannot submit again until they are decided.`)
    ).toBeVisible();
    await expect(submitButton(page)).toBeDisabled();
    await expect(submitButton(page)).toHaveAttribute('title', 'Pending edit already in review');
    await expect(missingBox(page)).toHaveCount(0);
    await expect(saveDraftButton(page)).toBeEnabled();
    await saveDraftButton(page).click();
    await expect(page.getByText('✓ Draft saved on this phone. If the changes already waiting are approved first, they replace it.')).toBeVisible();
    expect(await editsOn(c.id, 'DRAFT')).toHaveLength(1);

    // Mark closed on the same customer: refused, naming HIS waiting request; nothing written.
    await page.goto(`/customers/${c.id}`);
    const markClosed = page.getByRole('button', { name: 'Mark closed' });
    await waitHydrated(markClosed);
    await markClosed.click();
    const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Mark this branch closed' }) });
    await pickFile(photoSlot(form, 'Other'), png('closed.png'));
    await expect(form.locator('img[alt="Other"]')).toBeVisible({ timeout: 120_000 });
    await form.getByRole('textbox').fill('Shop shut, signage removed');
    const before = await db.customerEdit.count({ where: { customerId: c.id } });
    await form.getByRole('button', { name: 'Submit closure' }).click();
    await expect(
      form.getByText(
        `Your changes to this customer, sent at ${at}, are still waiting for approval, so this request was NOT sent. Send it once that is decided.`
      )
    ).toBeVisible();
    expect(await db.customerEdit.count({ where: { customerId: c.id } })).toBe(before);
    expect(await db.customerEdit.count({ where: { customerId: c.id, target: 'BRANCH' } })).toBe(0);
    expect((await db.branch.findUniqueOrThrow({ where: { id: c.branch.id }, select: { status: true } })).status).toBe('ACTIVE');
  });

  test('M2, a Manager of the region who is not his supervisor, reviews the evidence on a desktop and approves; the values go live', async ({ browser }) => {
    test.setTimeout(240_000);
    expect(editId, 'the first test submitted a request').toBeTruthy();
    const sa = world.user('SA');
    const m2 = world.user('M2');
    const c = world.customer('HAPPY');
    const page = await (await contextAs(browser, m2, { device: 'desktop' })).newPage();

    await page.goto('/approvals');
    await page.locator(`a[href="/approvals/${editId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${editId}$`));

    const chain = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Approval chain' }) });
    await expect(chain.getByText('SUPERVISOR', { exact: true }), 'the current step is highlighted').toHaveClass(/bg-brand-600/);
    const diff = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Customer', exact: true }) });
    await expect(diff).toContainText('primaryPhone');
    await expect(diff.getByText(phone, { exact: true })).toBeVisible();
    await expect(diff.getByText('Before').first()).toBeVisible();
    await expect(diff.getByText('After').first()).toBeVisible();

    const onFile = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Photos & location on file (current)' }) });
    const imgs = onFile.locator('img[src^="/api/photos/"]');
    await expect(imgs).toHaveCount(3);
    for (const src of await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''))) {
      const res = await fetchAs(page, src);
      expect(res.status, src).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    }
    await expect(onFile.getByText('No GPS on file')).toBeVisible();
    const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    const lat = changeOf(edit, `branch.${c.branch.id}.gpsLat`)!.after as number;
    const lng = changeOf(edit, `branch.${c.branch.id}.gpsLng`)!.after as number;
    await expect(page.getByText('±9 m: within the 30 m target', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View proposed location on map' })).toHaveAttribute('href', mapPin(lat, lng));

    await approveOnPage(page, editId);
    await expect(page.locator(`a[href="/approvals/${editId}"]`)).toHaveCount(0);

    const after = await db.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    expect(after).toMatchObject({ state: 'APPROVED', reviewedById: m2.id });
    const steps = await db.editApproval.findMany({ where: { editId } });
    expect(steps.map((s) => ({ decision: s.decision, actorId: s.actorId, role: s.role }))).toEqual([
      { decision: 'APPROVED', actorId: m2.id, role: 'SUPERVISOR' },
    ]);
    expect((await auditFor({ entityId: editId, actorId: m2.id, action: 'APPROVE' })).map((a) => a.entityType)).toEqual(['CustomerEdit']);
    const live = await db.customer.findUniqueOrThrow({ where: { id: c.id }, include: { branches: true } });
    expect(live).toMatchObject({ primaryPhone: phone, contactPerson: contact, crNumber: cr });
    expect(live.subChannelId).not.toBeNull();
    expect(live.branches[0]).toMatchObject({ address, dayOfVisit: 'SUN' });
    expect(live.branches[0]!.gpsLat).toBeCloseTo(MUSCAT.lat, 4);

    // The salesman is told; the direct supervisor's review row is settled by M2's decision (wave 1).
    await expect
      .poll(async () => (await notificationsFor({ editId, userId: sa.id })).map((n) => `${n.kind}:${n.title}`))
      .toContain('EDIT_APPROVED_FINAL:Edit approved');
    const m1Rows = await notificationsFor({ editId, userId: world.user('M1').id });
    expect(m1Rows.map((n) => n.kind)).toEqual(['EDIT_SUBMITTED']);
    expect(m1Rows[0]!.readAt, "M1's review row stops counting in his red bell").not.toBeNull();

    // Reopened: the decision, by whom and when (Oman time).
    await page.goto(`/approvals/${editId}`);
    await expect(page.getByText(`Decision: APPROVED by ${m2.fullName} on ${omanDateTime(after.reviewedAt!)}`)).toBeVisible();
    await expect(page.getByRole('button', { name: '✓ Approve' })).toHaveCount(0);

    // His bell counts an approval as information, not as work waiting on him (wave 1).
    const saPage = await (await contextAs(browser, sa)).newPage();
    await saPage.goto('/today');
    await expect(bell(saPage)).toHaveAttribute('aria-label', 'Notifications (1 for information)');
  });

  test('the same decision at 412 px: the Manager approves from a phone without sideways scrolling', async ({ browser }) => {
    test.setTimeout(180_000);
    const m2 = world.user('M2');
    const c = world.customer('REPEAT');
    const repeatContact = world.name('Repeat contact');
    const { id } = await seedUpdateEdit(world, { customer: 'REPEAT', submitter: 'SA', patch: { customer: { contactPerson: repeatContact } } });
    const page = await (await contextAs(browser, m2, { device: 'phone' })).newPage();
    await page.goto(`/approvals/${id}`);
    const onFile = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Photos & location on file (current)' }) });
    await expect(onFile.locator('img[src^="/api/photos/"]')).toHaveCount(3);
    await expect(page.getByRole('heading', { name: 'Approval chain' })).toBeVisible();
    await expectNoSideScroll(page);
    await approveOnPage(page, id);
    expect(await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true, reviewedById: true } })).toEqual({
      state: 'APPROVED',
      reviewedById: m2.id,
    });
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { contactPerson: true } })).contactPerson).toBe(repeatContact);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: the submit gate and the locked fields', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('ug', {
      customers: [
        // Nothing on file but the address: no channel, phone, contact, GPS or photo.
        // (A live branch always has one: CHECK "Branch_address_minlength", length(btrim(address)) >= 3.)
        { key: 'GATE', channel: null, phone: null, contact: null, branches: [{ key: 'S', route: 'A' }] },
        { key: 'GATE2', channel: null, phone: null, contact: null, branches: [{ key: 'S', route: 'A' }] },
        // A complete shop on a customer missing phone and contact: a visit day alone.
        { key: 'VISIT', phone: null, contact: null, branches: [{ key: 'S', route: 'A', gps: { ...MUSCAT }, photos: ['SHOP'] }] },
        // A customer with an incomplete shop: a phone fix alone.
        { key: 'PHONEFIX', phone: null, contact: 'Hamad Al Busaidi', branches: [{ key: 'S', route: 'A' }] },
        // A CREDIT customer whose CR document the salesman himself took.
        { key: 'CREDCR', paymentTerms: 'CREDIT', phone: true, contact: 'Saif Al Hinai', crNumber: true, crPhoto: true, branches: [{ key: 'S', route: 'A' }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('the CORE gate lists exactly what a changed customer and shop miss, clears item by item; optional fields carry no *', async ({ browser }) => {
    test.setTimeout(300_000);
    const c = world.customer('GATE');
    const b = c.branch;
    const [phone] = await world.allocPhones(1);
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    const { section, tag } = await branchSection(page, b.name);

    // Locks and labels (CORE gate: SALESMAN_SUBMIT_GATE unset).
    await expect(page.getByLabel('Legal name *', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('CR number', { exact: true }), 'CR number is open on a CASH customer').toBeEnabled();
    await expect(page.getByLabel('Sub-channel', { exact: true })).toHaveCount(1);
    await expect(section.getByLabel('Day of visit', { exact: true })).toHaveCount(1);
    await expect(page.getByText('CR document photo', { exact: true })).toBeVisible();
    await expect(photoSlot(page, 'CR document').locator('label[aria-label="Capture photo"]')).toHaveCount(1);
    await expect(photoSlot(section, 'Shop front')).toContainText('Shop front *');
    await expect(photoSlot(section, 'Signboard')).not.toContainText('Signboard *');
    await expect(page.getByLabel('Status', { exact: true }), 'no Status select for a salesman').toHaveCount(0);
    await expect(saveDraftButton(page)).toBeEnabled();
    await expectMissing(page, []);

    // A change to the customer AND to Branch 1: both in scope.
    await page.getByLabel('Notes', { exact: true }).fill(world.name('Gate check'));
    await section.getByLabel('Opening hours', { exact: true }).fill('08:00-22:00');
    await expectMissing(page, ['Channel', 'Primary phone', 'Contact person', `${tag} GPS`, `${tag} shop photo`]);
    // An emptied address is missing too (a live branch always has one, so only the form can empty it).
    await section.getByLabel('Address *', { exact: true }).fill('');
    await expectMissing(page, ['Channel', 'Primary phone', 'Contact person', `${tag} address`, `${tag} GPS`, `${tag} shop photo`]);
    await expect(saveDraftButton(page), 'Save draft is always open').toBeEnabled();

    await page.getByLabel('Channel *', { exact: true }).selectOption(await channelId());
    await expectMissing(page, ['Primary phone', 'Contact person', `${tag} address`, `${tag} GPS`, `${tag} shop photo`]);
    await page.getByLabel('Primary phone *', { exact: true }).fill(spaced(phone));
    await expectMissing(page, ['Contact person', `${tag} address`, `${tag} GPS`, `${tag} shop photo`]);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Gate contact'));
    await expectMissing(page, [`${tag} address`, `${tag} GPS`, `${tag} shop photo`]);
    await section.getByLabel('Address *', { exact: true }).fill(world.name('Way 1, Ruwi'));
    await expectMissing(page, [`${tag} GPS`, `${tag} shop photo`]);
    await gpsButton(section).click();
    await expectMissing(page, [`${tag} shop photo`]);
    await pickFile(photoSlot(section, 'Shop front'), png('shop.png'));
    await waitForBranchPhoto(b.id, 'shop');
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();

    // The server's own checks, reached by bodies the form would never build, each
    // error where the form can show it. 1) The phone taken off in flight: the
    // CORE gate refuses it under its field.
    let undo = await rewriteNextEditSubmit(page, (body) => {
      delete body.customer.primaryPhone;
      delete body.customerBase.primaryPhone;
    });
    await submitButton(page).click();
    await expect(page.getByText(FIX_FIELDS)).toBeVisible();
    await expect(page.getByLabel('Primary phone *', { exact: true }).locator('xpath=following-sibling::p[1]')).toHaveText('Primary phone is required.');
    await undo();
    // 2) The address removed in flight: refused, and shown at the top (a branch address has no error slot).
    undo = await rewriteNextEditSubmit(page, (body) => {
      body.branches.find((x) => x.branchId === b.id)!.address = null;
    });
    await submitButton(page).click();
    const addressError = page.getByText('Address cannot be removed — correct it instead.', { exact: true });
    await expect(addressError).toBeVisible();
    await expect(page.getByText(FIX_FIELDS)).toBeVisible();
    const errorBox = await addressError.boundingBox();
    const identity = await page.getByRole('heading', { name: 'Identity', exact: true }).boundingBox();
    expect(errorBox!.y, 'the address error is shown at the top of the form').toBeLessThan(identity!.y);
    await undo();
    expect(await editsOn(c.id, 'SUBMITTED'), 'nothing was written').toHaveLength(0);
  });

  test('a body that skips the form is refused by the server field by field (the CORE gate on what it changes)', async ({ browser }) => {
    const c = world.customer('GATE2');
    const b = c.branch;
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/today');
    const res = await submitEnrichViaApi(
      page,
      { customerId: c.id, customer: { notes: world.name('Bypass') }, branches: [{ branchId: b.id, openingHours: '09:00-21:00' }] },
      { world }
    );
    expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    // The address is on file (a live branch always has one), so it is not asked for.
    expect(Object.keys(res.fields ?? {}).sort()).toEqual(
      ['customer.channelId', 'customer.primaryPhone', 'customer.contactPerson', `branch.${b.id}.gps`, `branch.${b.id}.shopPhoto`].sort()
    );
    expect(res.fields!['customer.primaryPhone']).toBe('Primary phone is required.');
    expect(res.fields![`branch.${b.id}.gps`]).toBe(`Branch ${b.code}: GPS coordinates are required.`);
    expect(res.fields![`branch.${b.id}.shopPhoto`]).toBe(`Branch ${b.code}: shop photo is required.`);
    // …and one that removes it is refused before the gate.
    const removed = await submitEnrichViaApi(page, { customerId: c.id, branches: [{ branchId: b.id, address: null }] }, { world });
    expect(removed, JSON.stringify(removed)).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fields: { [`branch.${b.id}.address`]: 'Address cannot be removed — correct it instead.' },
    });
    expect(await editsOn(c.id)).toHaveLength(0);
  });

  test('owner decision 4: a visit day alone, or a phone fix alone, goes through — only what the request changes must be complete', async ({ browser }) => {
    test.info().annotations.push({ type: 'owner decision', description: '4 (7 Oct): completeness is required only for the shop(s) and fields a request changes' });
    test.setTimeout(240_000);
    const page = await (await contextAs(browser, world.user('SA'))).newPage();

    // The visit-day job: a complete shop of a customer still missing phone and contact.
    const visit = world.customer('VISIT');
    await page.goto(`/customers/${visit.id}/edit`);
    await waitHydrated(page);
    const v = await branchSection(page, visit.branch.name);
    await v.section.getByLabel('Day of visit', { exact: true }).selectOption('MON');
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${visit.id}$`), { timeout: 30_000 });
    const visitEdit = await submittedEditOn(visit.id);
    world.adopt.edit(visitEdit.id);
    expect(changesOf(visitEdit).map((x) => x.field)).toEqual([`branch.${visit.branch.id}.dayOfVisit`]);

    // A phone fix on a customer whose only shop has no GPS and no photo yet.
    const fix = world.customer('PHONEFIX');
    const [phone] = await world.allocPhones(1);
    await page.goto(`/customers/${fix.id}/edit`);
    await waitHydrated(page);
    await page.getByLabel('Primary phone *', { exact: true }).fill(spaced(phone));
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${fix.id}$`), { timeout: 30_000 });
    const fixEdit = await submittedEditOn(fix.id);
    world.adopt.edit(fixEdit.id);
    expect(changesOf(fixEdit).map((x) => `${x.field}=${String(x.after)}`)).toEqual([`customer.primaryPhone=${phone}`]);
  });

  test('a CREDIT customer: legal name, CR number and (owner decision 2) the CR document are locked for the salesman, and the server agrees', async ({ browser }) => {
    test.info().annotations.push({ type: 'owner decision', description: "2 (7 Oct): the CR document of a CREDIT customer is locked for salesmen" });
    test.setTimeout(180_000);
    const sa = world.user('SA');
    const cred = world.customer('CRED');
    const page = await (await contextAs(browser, sa)).newPage();
    await page.goto(`/customers/${cred.id}/edit`);
    await waitHydrated(page);
    await expect(page.getByText('Legal name and CR are locked — only the Steward can change them. Fill the rest below.')).toBeVisible();
    await expect(page.getByLabel('Legal name *', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('CR number', { exact: true })).toBeDisabled();
    await expect(page.getByText(CR_LOCKED)).toBeVisible();
    const crSlot = photoSlot(page, 'CR document');
    await expect(crSlot.locator('label[aria-label="Capture photo"]'), 'no camera on the locked CR slot').toHaveCount(0);
    await expect(page.getByText('CR document photo', { exact: true })).toBeVisible();

    // The server: his CR attach on a CREDIT customer is refused …
    const up = await uploadPhotoViaApi(page, world, { kind: 'CR', attach: { customerId: cred.id, slot: 'CR' } });
    expect(up.attached, JSON.stringify(up.attached)).toMatchObject({ ok: false, code: 'FORBIDDEN', message: CR_LOCKED });
    expect((await db.customer.findUniqueOrThrow({ where: { id: cred.id }, select: { crPhotoId: true } })).crPhotoId).toBeNull();
    // … and so is removing the CR document of one, even one he took himself.
    const own = world.customer('CREDCR').photos.find((p) => p.wire === 'CR')!;
    expect(own.capturedById).toBe(sa.id);
    const detach = await postJson(page, '/api/photos/detach', { attachmentId: own.id });
    expect(await detach.json()).toMatchObject({ ok: false, message: CR_LOCKED });
    expect((await db.customer.findUniqueOrThrow({ where: { id: world.customer('CREDCR').id }, select: { crPhotoId: true } })).crPhotoId).toBe(own.id);

    // A Manager of the region may replace it.
    const m1Page = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await m1Page.goto('/approvals');
    const byManager = await uploadPhotoViaApi(m1Page, world, { kind: 'CR', attach: { customerId: cred.id, slot: 'CR' } });
    expect(byManager.attached, JSON.stringify(byManager.attached)).toMatchObject({ ok: true });
    expect((await db.customer.findUniqueOrThrow({ where: { id: cred.id }, select: { crPhotoId: true } })).crPhotoId).toBe(byManager.attachmentId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: a customer with shops on two routes', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;
  let editId = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('umb');
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test("SA sees his two shops only; a change to one needs only that shop complete (owner decision 4), and he submits", async ({ browser }) => {
    test.info().annotations.push({ type: 'owner decision', description: '4 (7 Oct): every branch need NOT be complete — only the branch(es) a request changes' });
    test.setTimeout(300_000);
    const multi = world.customer('MULTI');
    const A1 = world.branch('MULTI.A1');
    const A2 = world.branch('MULTI.A2');
    const B1 = world.branch('MULTI.B1');
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto(`/customers/${multi.id}/edit`);
    await waitHydrated(page);
    const a1 = await branchSection(page, A1.name);
    const a2 = await branchSection(page, A2.name);
    expect([a1.n, a2.n].sort()).toEqual([1, 2]);
    await expect(page.getByText(B1.name), "the other route's shop is not on his form").toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: /^Branch 3:/ })).toHaveCount(0);

    // A change on A2 asks for A2 only …
    await a2.section.getByLabel('Day of visit', { exact: true }).selectOption('TUE');
    await expectMissing(page, [`${a2.tag} GPS`, `${a2.tag} shop photo`]);
    await a2.section.getByLabel('Day of visit', { exact: true }).selectOption('');
    await expectMissing(page, []);
    // … and one on A1 asks for A1 only: completed, it submits with A2 still incomplete.
    await a1.section.getByLabel('Day of visit', { exact: true }).selectOption('MON');
    await expectMissing(page, [`${a1.tag} GPS`, `${a1.tag} shop photo`]);
    await gpsButton(a1.section).click();
    await expect(gpsChip(a1.section)).toContainText('±9m');
    await pickFile(photoSlot(a1.section, 'Shop front'), png('a1-shop.png'));
    await waitForBranchPhoto(A1.id, 'shop');
    await expectMissing(page, []);
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${multi.id}$`), { timeout: 30_000 });

    const edit = await submittedEditOn(multi.id);
    editId = edit.id;
    world.adopt.edit(editId);
    expect(changesOf(edit).every((x) => x.field.startsWith(`branch.${A1.id}.`)), JSON.stringify(changesOf(edit))).toBe(true);
    expect((edit.submitGate as unknown as { branchIds: string[] }).branchIds.sort(), 'gated on his own shops, never B1').toEqual([A1.id, A2.id].sort());
    await expect
      .poll(async () => (await notificationsFor({ editId })).filter((n) => n.kind === 'EDIT_SUBMITTED').map((n) => n.userId))
      .toEqual([world.user('M1').id]);
  });

  test("SB, who works the third shop, sees someone else's request waiting and cannot submit", async ({ browser }) => {
    expect(editId).toBeTruthy();
    const multi = world.customer('MULTI');
    const page = await (await contextAs(browser, world.user('SB'))).newPage();
    await page.goto(`/customers/${multi.id}/edit`);
    await waitHydrated(page);
    await expect(
      page.getByText(
        `A submission is already pending review (by ${world.user('SA').fullName}). You can save drafts but cannot submit until the supervisor decides.`
      )
    ).toBeVisible();
    await expect(submitButton(page)).toBeDisabled();
    await expect(submitButton(page)).toHaveAttribute('title', 'Pending edit already in review');
    await expect(saveDraftButton(page)).toBeEnabled();
    const b1 = await branchSection(page, world.branch('MULTI.B1').name);
    expect(b1.n).toBe(1);
    await expect(page.getByText(world.branch('MULTI.A1').name)).toHaveCount(0);
    await expect(page.getByText(world.branch('MULTI.A2').name)).toHaveCount(0);
  });

  test("owner decision 3: only Managers of the changed shop's region see and decide it; the other region's Manager reads it only", async ({ browser }) => {
    test.info().annotations.push({ type: 'owner decision', description: "3 (7 Oct): a Manager approves only his own regions' branches" });
    expect(editId).toBeTruthy();
    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await m1.goto('/approvals');
    await expect(m1.locator(`a[href="/approvals/${editId}"]`)).toBeVisible();

    const m5 = await (await contextAs(browser, world.user('M5'), { device: 'desktop' })).newPage();
    await m5.goto('/approvals');
    await expect(m5.getByRole('heading', { level: 1, name: 'Approval queue' })).toBeVisible();
    await expect(m5.locator(`a[href="/approvals/${editId}"]`), 'not in the other region’s queue').toHaveCount(0);
    await m5.goto(`/approvals/${editId}`);
    await expect(m5.getByRole('note').filter({ hasText: 'For your information: this request is waiting at the' })).toContainText(
      'SUPERVISOR step, which you cannot decide.'
    );
    await expect(m5.getByText("Not shown: the changes to 1 branch outside your regions. Their region's Manager decides them.")).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: GPS — the accuracy standard, a typed point, a moved point', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;
  const MOVED = { lat: MUSCAT.lat + 0.0018, lng: MUSCAT.lng };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    // Complete apart from GPS: only the location decides whether they submit.
    const shopOnly = (key: string) => ({ key, phone: true, contact: 'Ali Al Lawati', branches: [{ key: 'S', route: 'A', photos: ['SHOP' as const] }] });
    world = await standardWorld('ugp', {
      customers: [
        shopOnly('BANDS'),
        shopOnly('MAN'),
        shopOnly('OUTSIDE'),
        // An imported point at ±150 m.
        { key: 'MOVE', phone: true, contact: 'Ali Al Lawati', branches: [{ key: 'S', route: 'A', photos: ['SHOP'], gps: { lat: MUSCAT.lat, lng: MUSCAT.lng, accuracy: 150 } }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('accuracy bands: green to ±30 m, amber to ±100 m, a fresh capture over ±100 m is refused — on the phone and by the server', async ({ browser }) => {
    test.setTimeout(240_000);
    const c = world.customer('BANDS');
    const b = c.branch;
    const ctx = await contextAs(browser, world.user('SA'));
    const page = await ctx.newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    const { section, tag } = await branchSection(page, b.name);
    const advice = section.getByText(/^(Aim for ±30 m or better|Over ±100 m)/);
    const capture = async (accuracy: number, shown: number, band: 'good' | 'fair' | 'poor') => {
      await ctx.setGeolocation({ latitude: MUSCAT.lat, longitude: MUSCAT.lng, accuracy });
      await gpsButton(section).click();
      await expect(gpsChip(section)).toContainText(`±${shown}m`);
      await expect(gpsChip(section)).toHaveAttribute('data-accuracy-band', band);
    };

    await capture(12, 12, 'good');
    await expect(advice).toHaveCount(0);
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();

    await capture(60, 60, 'fair');
    await expect(advice).toHaveText('Aim for ±30 m or better: step outside and recapture if you can.');
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();

    await capture(150, 150, 'poor');
    await expect(advice).toHaveText('Over ±100 m: this cannot be submitted. Step outside and recapture, or enter the location by hand with a reason.');
    await expectMissing(page, [`${tag} GPS within 100 m`]);

    await capture(100.4, 100, 'fair');
    await expectMissing(page, []);
    await capture(100.6, 101, 'poor');
    await expectMissing(page, [`${tag} GPS within 100 m`]);

    await capture(25, 25, 'good');
    await expect(submitButton(page)).toBeEnabled();
    // A hand-made body at ±150 (the form would never send it): refused under Location.
    const undo = await rewriteNextEditSubmit(page, (body) => {
      body.branches.find((x) => x.branchId === b.id)!.gpsAccuracy = 150;
    });
    await submitButton(page).click();
    await expect(
      section.getByText(
        `Branch ${b.code}: the GPS reading is ±150 m, over the 100 m limit. Step outside and recapture, or enter the location by hand with a reason.`
      )
    ).toBeVisible();
    await expect(page.getByText(FIX_FIELDS)).toBeVisible();
    await undo();
    expect(await editsOn(c.id, 'SUBMITTED')).toHaveLength(0);

    // At ±25 it goes.
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });
    const edit = await submittedEditOn(c.id);
    world.adopt.edit(edit.id);
    expect(changeOf(edit, `branch.${b.id}.gpsAccuracy`)?.after).toBe(25);

    // The Manager's decision page shows the band.
    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await m1.goto(`/approvals/${edit.id}`);
    await expect(m1.getByText('±25 m: within the 30 m target', { exact: true })).toBeVisible();
  });

  test('the same ±150 m capture is refused on New customer', async ({ browser }) => {
    const sa = world.user('SA');
    const page = await (await contextAs(browser, sa, { geolocation: { latitude: MUSCAT.lat, longitude: MUSCAT.lng, accuracy: 150 } })).newPage();
    await page.goto('/customers/new');
    const capture = page.getByRole('button', { name: /^Capture GPS/ });
    await waitHydrated(capture);
    await capture.click();
    await expect(page.locator('[data-accuracy-band="poor"]')).toContainText('±150m');
    await expect(
      page.getByText('Over ±100 m: this cannot be submitted. Step outside and recapture, or enter the location by hand with a reason.')
    ).toBeVisible();
    await expect(missingBox(page)).toContainText('Branch 1 GPS within 100 m');
    expect(await db.customerEdit.count({ where: { submittedById: sa.id, process: 'CREATE' } }), 'nothing was sent').toBe(0);
  });

  test('location denied: a typed point with its reason is flagged MANUAL for the approver; the Manager reads why', async ({ browser }) => {
    test.setTimeout(240_000);
    const c = world.customer('MAN');
    const b = c.branch;
    const reason = 'Phone GPS broken at this shop';
    const page = await (await contextAs(browser, world.user('SA'), { geolocation: null })).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    const { section } = await branchSection(page, b.name);

    await gpsButton(section).click();
    await expect(section.getByText('Location permission denied. Tap below to enter coordinates manually.')).toBeVisible();
    await section.getByLabel('Latitude (16–27 in Oman)').fill('23,5880');
    await section.getByLabel('Longitude (51–60 in Oman)').fill('58.3829');
    await section.getByLabel("Why didn't GPS work? *").fill('abc');
    await section.getByRole('button', { name: 'Save manual location' }).click();
    await expect(section.getByText('Tell us why GPS did not work (5+ characters).')).toBeVisible();
    await section.getByLabel("Why didn't GPS work? *").fill(reason);
    await section.getByRole('button', { name: 'Save manual location' }).click();
    await expect(gpsChip(section)).toHaveAttribute('data-accuracy-band', 'manual');
    await expect(gpsChip(section)).toContainText('23.588000, 58.382900');
    await expect(gpsChip(section)).toContainText('Manual');
    await expect(gpsChip(section)).not.toContainText('±');
    await expectMissing(page, []);
    await expect(submitButton(page)).toBeEnabled();
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });

    const edit = await submittedEditOn(c.id);
    world.adopt.edit(edit.id);
    expect(changeOf(edit, `branch.${b.id}.gpsLat`)).toMatchObject({ after: 23.588, gpsSource: 'MANUAL', gpsManualReason: reason });
    expect(changeOf(edit, `branch.${b.id}.gpsLng`)).toMatchObject({ after: 58.3829, gpsSource: 'MANUAL', gpsManualReason: reason });
    const acc = changeOf(edit, `branch.${b.id}.gpsAccuracy`);
    expect(acc === undefined || acc.after === null, 'a typed point carries no accuracy').toBe(true);

    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await m1.goto('/approvals');
    await expect(m1.locator(`a[href="/approvals/${edit.id}"]`)).toContainText('Typed GPS');
    await m1.goto(`/approvals/${edit.id}`);
    await expect(m1.getByText(`Location typed in by hand. GPS did not work: “${reason}”`)).toBeVisible();
    await expect(m1.locator('[data-accuracy-band]'), 'no accuracy badge for a typed point').toHaveCount(0);
  });

  test('a typed point must be just the number (Arabic digits read, junk refused); one outside Oman is warned, then refused by the server', async ({ browser }) => {
    test.setTimeout(180_000);
    const c = world.customer('OUTSIDE');
    const b = c.branch;
    const page = await (await contextAs(browser, world.user('SA'), { geolocation: null })).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    const { section } = await branchSection(page, b.name);
    const lat = section.getByLabel('Latitude (16–27 in Oman)');
    const save = section.getByRole('button', { name: 'Save manual location' });

    await section.getByRole('button', { name: 'Enter coordinates manually' }).click();
    await lat.fill('23.5 N');
    await section.getByLabel('Longitude (51–60 in Oman)').fill('58.3829');
    await section.getByLabel("Why didn't GPS work? *").fill('No fix inside the market');
    await save.click();
    await expect(section.getByText('Enter valid latitude and longitude numbers.')).toBeVisible();
    // Arabic-Indic digits and the Arabic decimal mark (wave 1).
    await lat.fill('٢٣٫٥٨٨');
    await save.click();
    await expect(gpsChip(section)).toContainText('23.588000, 58.382900');

    await section.getByRole('button', { name: 'Enter coordinates manually' }).click();
    await lat.fill('15.5');
    await save.click();
    await expect(section.getByText('Saved, but the coordinates fall outside Oman. Double-check before submitting.')).toBeVisible();
    await expect(gpsChip(section)).toContainText('15.500000, 58.382900');
    await submitButton(page).click();
    await expect(section.getByText('Latitude must be inside Oman (≥16°N).')).toBeVisible();
    expect(await editsOn(c.id, 'SUBMITTED')).toHaveLength(0);
  });

  test('a saved ±150 m point never blocks a submit; a recapture 200 m away records the whole point, and Directions follows it', async ({ browser }) => {
    test.setTimeout(300_000);
    const c = world.customer('MOVE');
    const b = c.branch;
    const ctx = await contextAs(browser, world.user('SA'));
    const page = await ctx.newPage();
    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();

    // 1. Untouched point: advice, no refusal.
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    let s = await branchSection(page, b.name);
    await expect(gpsChip(s.section)).toHaveAttribute('data-accuracy-band', 'poor');
    await expect(gpsChip(s.section)).toContainText('±150m');
    await expect(s.section.getByText("Over ±100 m, the standard's limit. Recapture it outdoors at the shop if you can.")).toBeVisible();
    await s.section.getByLabel('Opening hours', { exact: true }).fill('07:00-23:00');
    await expectMissing(page, []);
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });
    const first = await submittedEditOn(c.id);
    world.adopt.edit(first.id);
    expect(changesOf(first).some((x) => /\.gps/.test(x.field)), 'the point was not sent').toBe(false);
    await m1.goto(`/approvals/${first.id}`);
    await expect(m1.getByText('±150 m: over the 100 m limit (the point on file; a recapture at the shop fixes it)')).toBeVisible();
    await approveOnPage(m1, first.id);

    // 2. A recapture 200 m away at ±10.
    await ctx.setGeolocation({ latitude: MOVED.lat, longitude: MOVED.lng, accuracy: 10 });
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    s = await branchSection(page, b.name);
    await gpsButton(s.section).click();
    await expect(gpsChip(s.section)).toContainText('±10m');
    await expect(gpsChip(s.section)).toHaveAttribute('data-accuracy-band', 'good');
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });
    const moved = await submittedEditOn(c.id);
    world.adopt.edit(moved.id);
    const lat = changeOf(moved, `branch.${b.id}.gpsLat`)!;
    const lng = changeOf(moved, `branch.${b.id}.gpsLng`)!;
    expect(lat.before).toBeCloseTo(MUSCAT.lat, 6);
    expect(lat.after as number).toBeCloseTo(MOVED.lat, 6);
    expect(lng, 'the unmoved coordinate is recorded with the point').toMatchObject({ before: MUSCAT.lng });
    expect(lng.after as number).toBeCloseTo(MOVED.lng, 6);
    expect(changeOf(moved, `branch.${b.id}.gpsAccuracy`)).toMatchObject({ before: 150, after: 10 });
    expect(changeOf(moved, `branch.${b.id}.gpsCapturedAt`)?.after).toBeTruthy();

    await approveOnPage(m1, moved.id);
    const live = await db.branch.findUniqueOrThrow({ where: { id: b.id }, select: { gpsLat: true, gpsLng: true, gpsAccuracy: true } });
    expect(live.gpsLat!).toBeCloseTo(MOVED.lat, 6);
    expect(live.gpsAccuracy).toBe(10);
    await page.goto(`/customers/${c.id}`);
    await expect(page.getByRole('link', { name: 'Directions' })).toHaveAttribute('href', directions(live.gpsLat!, live.gpsLng!));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: GPS and photo evidence on the decision page', { tag: ['@phone', '@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;
  const ids: Record<string, string> = {};
  const P = {
    EV12: { lat: 23.5891, lng: 58.3839, accuracy: 12 },
    EV60: { lat: 23.5892, lng: 58.384, accuracy: 60 },
    EV150: { lat: 23.5893, lng: 58.3841, accuracy: 150 },
    EVT: { lat: 23.5894, lng: 58.3842 },
  };
  const ON_FILE = { lat: 23.5871, lng: 58.3819, accuracy: 20 };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('uev', {
      customers: [
        { key: 'EV12', phone: true, contact: 'Badr Al Amri', branches: [{ key: 'S', route: 'A', gps: ON_FILE }] },
        { key: 'EV60', phone: true, contact: 'Badr Al Amri', branches: [{ key: 'S', route: 'A' }] },
        { key: 'EV150', phone: true, contact: 'Badr Al Amri', branches: [{ key: 'S', route: 'A' }] },
        { key: 'EVT', phone: true, contact: 'Badr Al Amri', branches: [{ key: 'S', route: 'A', photos: ['SHOP'] }] },
      ],
    });
    const at = new Date().toISOString();
    // Seeded: the submit gate would refuse ±150 m, which is exactly what an older request can carry.
    for (const key of ['EV12', 'EV60', 'EV150'] as const) {
      const p = P[key];
      ids[key] = (
        await seedUpdateEdit(world, {
          customer: key,
          submitter: 'SA',
          patch: { branches: [{ branch: key, gpsLat: p.lat, gpsLng: p.lng, gpsAccuracy: p.accuracy, gpsCapturedAt: at }] },
        })
      ).id;
    }
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('each band is said on the decision page, only the typed point is flagged in the queue, and every map link points where it should', async ({ browser }) => {
    test.setTimeout(240_000);
    // The typed point goes through the real submit (it carries the reason).
    const sa = await (await contextAs(browser, world.user('SA'))).newPage();
    await sa.goto('/today');
    const evt = world.customer('EVT');
    const typed = await submitEnrichViaApi(
      sa,
      {
        customerId: evt.id,
        branches: [
          { branchId: evt.branch.id, gpsLat: P.EVT.lat, gpsLng: P.EVT.lng, gpsAccuracy: null, gpsCapturedAt: new Date().toISOString(), gpsManualReason: 'No signal inside mall' },
        ],
      },
      { world }
    );
    expect(typed, JSON.stringify(typed)).toMatchObject({ ok: true });
    ids.EVT = receiptEditId(typed)!;

    const page = await (await contextAs(browser, world.user('M1'))).newPage();
    await page.goto('/approvals');
    for (const key of ['EV12', 'EV60', 'EV150'] as const) {
      const card = page.locator(`a[href="/approvals/${ids[key]}"]`);
      await expect(card).toContainText(world.customer(key).legalName);
      await expect(card).not.toContainText('Typed GPS');
    }
    await expect(page.locator(`a[href="/approvals/${ids.EVT}"]`)).toContainText('Typed GPS');

    const detail = async (key: keyof typeof P, badge: string | null, onFile: 'maps' | 'none') => {
      await page.goto(`/approvals/${ids[key]}`);
      const diff = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Branch: / }) });
      if (badge) await expect(diff.locator('[data-accuracy-band]')).toHaveText(badge);
      else await expect(diff.locator('[data-accuracy-band]')).toHaveCount(0);
      await expect(diff.getByRole('link', { name: 'View proposed location on map' })).toHaveAttribute('href', mapPin(P[key].lat, P[key].lng));
      const current = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Photos & location on file (current)' }) });
      if (onFile === 'maps') {
        await expect(current.getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute('href', mapPin(ON_FILE.lat, ON_FILE.lng));
      } else {
        await expect(current.getByText('No GPS on file')).toBeVisible();
      }
      return diff;
    };
    await detail('EV12', '±12 m: within the 30 m target', 'maps');
    await detail('EV60', '±60 m: acceptable, above the 30 m target', 'none');
    await detail('EV150', '±150 m: over the 100 m limit. Reject unless the reason explains it.', 'none');
    const typedDiff = await detail('EVT', null, 'none');
    await expect(typedDiff.getByText('Location typed in by hand. GPS did not work: “No signal inside mall”')).toBeVisible();
  });

  test('the ±150 m request is sent back with a category and a quick reason at this viewport', async ({ browser }) => {
    const m1 = world.user('M1');
    const page = await (await contextAs(browser, m1)).newPage();
    await page.goto(`/approvals/${ids.EV150}`);
    const form = await openRejectForm(page);
    await form.locator('select[name="category"]').selectOption('wrong_gps');
    await form.getByRole('button', { name: 'Re-capture GPS while standing at the entrance' }).click();
    await expect(form.locator('textarea[name="reason"]')).toHaveValue('Re-capture GPS while standing at the entrance');
    await form.getByRole('button', { name: '✗ Send back to salesman' }).click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/);
    expect(
      await db.customerEdit.findUniqueOrThrow({ where: { id: ids.EV150 }, select: { state: true, decisionCategory: true, reviewedById: true } })
    ).toEqual({ state: 'NEEDS_CORRECTION', decisionCategory: 'wrong_gps', reviewedById: m1.id });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: photos go live the moment they are up', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('uph', { customers: [{ key: 'PH', phone: true, contact: 'Mazin Al Kalbani', branches: [{ key: 'S', route: 'A' }] }] });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('a shop photo is live before any request (audit, score, a Manager sees it); retake replaces it, Remove empties the slot, a .txt is refused', async ({ browser }) => {
    test.setTimeout(300_000);
    const sa = world.user('SA');
    const c = world.customer('PH');
    const b = c.branch;
    const scoreBefore = await db.branch.findUniqueOrThrow({ where: { id: b.id }, select: { completenessScore: true } });
    const custBefore = await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { completenessScore: true } });
    const page = await (await contextAs(browser, sa)).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    const { section } = await branchSection(page, b.name);
    const shop = photoSlot(section, 'Shop front');

    // While it uploads (presign held a few seconds), Submit waits for it.
    const release = await holdNextRequest(page, '**/api/photos/presign', 4_000);
    await pickFile(shop, png('shop.png'));
    await expect(shop).toContainText(/Uploading… \d+%/);
    await expect(page.getByText(UPLOADING, { exact: true })).toBeVisible();
    await expect(submitButton(page)).toBeDisabled();
    await expect(submitButton(page)).toHaveAttribute('title', UPLOADING);
    const shopId = await waitForBranchPhoto(b.id, 'shop');
    await release();
    await expect(shop.locator('label[aria-label="Retake photo"]')).toBeVisible();
    await expect(page.getByText(UPLOADING, { exact: true })).toHaveCount(0);

    // Live now, with no request at all.
    expect(await db.attachment.findUniqueOrThrow({ where: { id: shopId } })).toMatchObject({
      kind: 'SHOP',
      mimeType: 'image/jpeg',
      capturedById: sa.id,
      branchId: b.id,
      deletedAt: null,
    });
    const attachedAudit = (await auditFor({ entityId: b.id, action: 'UPDATE' })).filter(
      (a) => a.reason === 'photo attached' && (a.after as unknown as { attachmentId?: string } | null)?.attachmentId === shopId
    );
    expect(attachedAudit).toHaveLength(1);
    const scoreAfter = await db.branch.findUniqueOrThrow({ where: { id: b.id }, select: { completenessScore: true } });
    const custAfter = await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { completenessScore: true } });
    expect(scoreAfter.completenessScore).toBeGreaterThan(scoreBefore.completenessScore);
    expect(custAfter.completenessScore).toBeGreaterThan(custBefore.completenessScore);
    expect(await editsOn(c.id)).toHaveLength(0);

    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await m1.goto(`/customers/${c.id}`);
    await expect(m1.locator(`img[src="/api/photos/${shopId}"]`)).toBeVisible();

    // Retake: the new photo replaces it, the old one is soft-deleted.
    await pickFile(shop, png('retake.png'));
    const retakeId = await waitForBranchPhoto(b.id, 'shop', shopId);
    await expect.poll(async () => (await db.attachment.findUniqueOrThrow({ where: { id: shopId }, select: { deletedAt: true } })).deletedAt).not.toBeNull();

    // Remove (signboard): asked first, then emptied live.
    const sign = photoSlot(section, 'Signboard');
    await pickFile(sign, png('sign.png'));
    const signId = await waitForBranchPhoto(b.id, 'signboard');
    await sign.getByRole('button', { name: 'Remove photo' }).click();
    await expect(sign).toContainText('Remove this Signboard photo?');
    await sign.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect
      .poll(async () => (await db.branch.findUniqueOrThrow({ where: { id: b.id }, select: { signboardPhotoId: true } })).signboardPhotoId)
      .toBeNull();
    expect((await db.attachment.findUniqueOrThrow({ where: { id: signId }, select: { deletedAt: true } })).deletedAt).not.toBeNull();
    await expect(sign.locator('label[aria-label="Capture photo"]')).toBeVisible();

    // Not an image.
    const other = photoSlot(section, 'Other');
    await pickFile(other, { name: 'notes.txt', mimeType: 'text/plain', buffer: textFile() });
    await expect(other).toContainText('That file is not an image.');

    // Leave without submitting: the photo stays live, and no request exists.
    await page.goto('/today');
    expect((await db.branch.findUniqueOrThrow({ where: { id: b.id }, select: { shopPhotoId: true } })).shopPhotoId).toBe(retakeId);
    expect(await editsOn(c.id)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: drafts on the phone and on the server', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('udr', {
      // SD signs out at the end (which ends all his sessions): his own route and customer.
      routes: [{ key: 'D', region: 'R1' }],
      users: [{ key: 'SD', role: 'SALESMAN', route: 'D', supervisor: 'M1' }],
      customers: [
        { key: 'DR', phone: null, contact: null, branches: [{ key: 'S', route: 'A', address: 'Imported address' }] },
        { key: 'DRD', phone: true, contact: 'Talal Al Rashdi', branches: [{ key: 'S', route: 'D' }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('a reload restores the typing and the GPS point; Save draft keeps ONE server draft; a newer server value drops the phone copy', async ({ browser }) => {
    test.setTimeout(240_000);
    const sa = world.user('SA');
    const c = world.customer('DR');
    const [phone] = await world.allocPhones(1);
    const contact = world.name('Draft contact');
    const address = world.name('Way 77, Al Khuwair');
    const page = await (await contextAs(browser, sa)).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    let s = await branchSection(page, c.branch.name);
    await page.getByLabel('Primary phone *', { exact: true }).fill(spaced(phone));
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await s.section.getByLabel('Address *', { exact: true }).fill(address);
    await gpsButton(s.section).click();
    await expect(gpsChip(s.section)).toContainText('±9m');
    await sleep(1_200); // the autosave runs 500 ms after the last change

    await page.reload();
    await waitHydrated(page);
    s = await branchSection(page, c.branch.name);
    await expect(page.getByText('Restored a local draft from your last visit.')).toBeVisible();
    await expect(page.getByLabel('Primary phone *', { exact: true })).toHaveValue(spaced(phone));
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(contact);
    await expect(s.section.getByLabel('Address *', { exact: true })).toHaveValue(address);
    await expect(gpsChip(s.section)).toContainText('23.588100, 58.382900');
    await expect(gpsChip(s.section)).toContainText('±9m');

    // Save draft: said, and ONE draft row per salesman and customer, saved over in place (launch fix).
    await saveDraftButton(page).click();
    await expect(page.getByText('✓ Draft saved. It stays on this phone until you submit.')).toBeVisible();
    await expect.poll(async () => (await editsOn(c.id, 'DRAFT')).length).toBe(1);
    const second = world.name('Draft contact two');
    await page.getByLabel('Contact person *', { exact: true }).fill(second);
    await saveDraftButton(page).click();
    await expect(page.getByText('✓ Draft saved. It stays on this phone until you submit.')).toBeVisible();
    await expect.poll(async () => changeOf((await editsOn(c.id, 'DRAFT'))[0] ?? { fieldChanges: [] }, 'customer.contactPerson')?.after).toBe(second);
    expect(await editsOn(c.id, 'DRAFT')).toHaveLength(1);
    expect(await editsOn(c.id, 'SUBMITTED')).toHaveLength(0);
    // Recent activity lists no draft (and nothing was sent).
    await page.goto(`/customers/${c.id}`);
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toHaveCount(0);

    // A Manager changes the contact directly: the phone copy is older than the server now.
    const m1 = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await m1.goto(`/customers/${c.id}`);
    const direct = world.name('Contact set by M1');
    const res = await submitEnrichViaApi(m1, { customerId: c.id, customer: { contactPerson: direct } }, { world });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });

    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    await expect(
      page.getByText('Your offline draft is older than the latest server changes. The form has been refreshed — re-enter anything you still need.')
    ).toBeVisible();
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(direct);
    await expect(page.getByLabel('Primary phone *', { exact: true })).toHaveValue('');
  });

  test("another salesman on the same phone never sees the first one's copy", async ({ browser }) => {
    test.setTimeout(180_000);
    const sa = world.user('SA');
    const sb = world.user('SB');
    const multi = world.customer('MULTI');
    const ctx = await contextAs(browser, sa);
    const page = await ctx.newPage();
    await page.goto(`/customers/${multi.id}/edit`);
    await waitHydrated(page);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Typed by SA'));
    await sleep(1_200);
    const saKey = `nmwc:draft:${sa.id}:${multi.id}`;
    expect(await page.evaluate((k) => localStorage.getItem(k) !== null, saKey)).toBe(true);

    // The same browser, now SB (shares MULTI through B1).
    await ctx.clearCookies();
    if (mintingProven()) await ctx.addCookies([await mintSessionCookie(sb)]);
    else await signInViaUi(page, sb.username, sb.password, { ip: world.ip(1) });
    await page.goto(`/customers/${multi.id}/edit`);
    await waitHydrated(page);
    await expect(page.getByText('Restored a local draft from your last visit.')).toHaveCount(0);
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue('Nasser Al Rawahi');
    expect(await page.evaluate((k) => localStorage.getItem(k)?.includes('Typed by SA') ?? false, saKey), "SA's copy is untouched, and not shown").toBe(true);
  });

  test("Sign out asks before it deletes this user's unsent copies from the device, then deletes them (launch fix)", async ({ browser }) => {
    const sd = world.user('SD');
    const c = world.customer('DRD');
    const page = await (await contextAs(browser, sd)).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    await page.getByLabel('Contact person *', { exact: true }).fill(world.name('Unsent'));
    await sleep(1_200);
    const prefix = `nmwc:draft:${sd.id}:`;
    const keys = () => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)), prefix);
    expect(await keys()).toHaveLength(1);

    let asked = '';
    page.once('dialog', async (d) => {
      asked = d.message();
      await d.accept();
    });
    const signOut = page.getByRole('button', { name: 'Sign out' });
    await waitHydrated(signOut);
    await signOut.click();
    await expect(page).toHaveURL(/\/login(\?|$)/);
    expect(asked).toBe('1 unsent form is saved on this device. Signing out deletes it, so the next person to use this device cannot read it. Sign out?');
    expect(await keys()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: sent back, fixed, sent again', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;
  let rejectedId = '';
  let resentId = '';
  const REASON = 'Contact role is wrong — ask the owner again';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('urj', {
      customers: [
        { key: 'RJ', phone: true, contact: 'Old Contact', branches: [{ key: 'S', route: 'A' }] },
        { key: 'RJ2', phone: true, contact: 'Old Contact', branches: [{ key: 'S', route: 'A' }] },
      ],
    });
    rejectedId = (
      await seedUpdateEdit(world, {
        customer: 'RJ',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('Wrong Contact'), contactRole: 'Owner' } },
      })
    ).id;
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('M1 sends it back from his phone: a category, a quick reason, and nothing under 5 characters', async ({ browser }) => {
    const m1 = world.user('M1');
    const c = world.customer('RJ');
    const page = await (await contextAs(browser, m1, { device: 'phone' })).newPage();
    await page.goto(`/approvals/${rejectedId}`);
    const form = await openRejectForm(page);
    await form.locator('select[name="category"]').selectOption('bad_photo');
    await form.getByRole('button', { name: 'Photo is blurry, retake' }).click();
    const reason = form.locator('textarea[name="reason"]');
    await expect(reason).toHaveValue('Photo is blurry, retake');
    await expect(form.getByText('Reason for the salesman *', { exact: true })).toBeVisible();
    const send = form.getByRole('button', { name: '✗ Send back to salesman' });
    await reason.fill('abc');
    await expect(send).toBeDisabled();
    await reason.fill(REASON);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/);

    expect(
      await db.customerEdit.findUniqueOrThrow({
        where: { id: rejectedId },
        select: { state: true, decisionCategory: true, decisionReason: true, pendingRole: true, reviewedById: true },
      })
    ).toEqual({ state: 'NEEDS_CORRECTION', decisionCategory: 'bad_photo', decisionReason: REASON, pendingRole: null, reviewedById: m1.id });
    const steps = await db.editApproval.findMany({ where: { editId: rejectedId } });
    expect(steps.map((s) => ({ decision: s.decision, actorId: s.actorId, reason: s.reason }))).toEqual([
      { decision: 'REJECTED', actorId: m1.id, reason: REASON },
    ]);
    const told = (await notificationsFor({ editId: rejectedId, userId: world.user('SA').id })).filter((n) => n.kind === 'EDIT_NEEDS_CORRECTION');
    expect(told.map((n) => ({ title: n.title, body: n.body }))).toEqual([{ title: 'Needs correction', body: `${c.legalName} — returned to you: ${REASON}` }]);
  });

  test('the salesman sees why everywhere: the red bell, the inbox, the profile, Today, Work and Needs correction', async ({ browser }) => {
    const c = world.customer('RJ');
    const m1 = world.user('M1');
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/today');
    await expect(bell(page)).toHaveAttribute('aria-label', /^Notifications \(1 unread/);
    await expect(stat(page, 'Needs correction')).toHaveText('1');
    // The tile itself links to /rejected (the desktop sidebar has an entry of its own).
    const tile = stat(page, 'Needs correction').locator('xpath=..');
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('href', '/rejected');

    await page.goto('/work');
    await expect(page.getByRole('link', { name: 'Sent back to you (1) — see why' })).toHaveAttribute('href', '/rejected');
    const row = page.locator(`a[href="/customers/${c.id}/edit?returned=${rejectedId}"]`);
    await expect(row).toContainText('Needs correction');
    await expect(row).toContainText(c.legalName);
    await expect(row).toContainText(REASON);

    await page.goto('/rejected');
    const card = page.locator('li').filter({ hasText: c.legalName });
    await expect(card).toContainText(REASON);
    await expect(card).toContainText(`Sent back by ${m1.fullName}`);
    await expect(card.getByRole('button', { name: 'Nothing to send again — clear this' })).toBeVisible();

    await page.goto('/notifications');
    const inbox = page.getByRole('link').filter({ hasText: `${c.legalName} — returned to you: ${REASON}` });
    await expect(inbox).toContainText('Correction');
    await inbox.click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`));
    await expect(page.getByText(`Your changes were sent back by ${m1.fullName}`)).toBeVisible();
    await expect(page.getByText(REASON)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the form to fix it' })).toHaveAttribute('href', `/customers/${c.id}/edit?returned=${rejectedId}`);
  });

  test('the form says why and fills in what he sent when he asks; the fix goes as a NEW request that answers the old one', async ({ browser }) => {
    test.setTimeout(180_000);
    const c = world.customer('RJ');
    const sent = await db.customerEdit.findUniqueOrThrow({ where: { id: rejectedId } });
    const sentContact = changeOf(sent, 'customer.contactPerson')!.after as string;
    const page = await (await contextAs(browser, world.user('SA'))).newPage();

    // A plain visit: the reason, and the customer as it is.
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    await expect(page.getByText(`Sent back to you by ${world.user('M1').fullName}`)).toBeVisible();
    await expect(page.getByText('The form below shows the customer as it is now.')).toBeVisible();
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue('Old Contact');
    await expect(page.getByRole('link', { name: 'Fill in what I sent' })).toHaveAttribute('href', `/customers/${c.id}/edit?returned=${rejectedId}`);

    // From Work: what he sent, filled in.
    await page.goto('/work');
    await page.locator(`a[href="/customers/${c.id}/edit?returned=${rejectedId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}/edit\\?returned=${rejectedId}$`));
    await waitHydrated(page);
    await expect(page.getByText('What you sent is filled in below. Change what was asked, then submit again.')).toBeVisible();
    await expect(page.getByLabel('Contact person *', { exact: true })).toHaveValue(sentContact);
    await expect(page.getByLabel('Contact role', { exact: true })).toHaveValue('Owner');
    await page.getByLabel('Contact role', { exact: true }).fill('Shop manager');
    await expect(submitButton(page)).toBeEnabled();
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });

    const resent = await submittedEditOn(c.id);
    resentId = resent.id;
    world.adopt.edit(resentId);
    expect(resentId).not.toBe(rejectedId);
    expect(changeOf(resent, 'customer.contactPerson')?.after).toBe(sentContact);
    expect(changeOf(resent, 'customer.contactRole')?.after).toBe('Shop manager');
    // The old row stays the record of the decision, and says what answered it.
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: rejectedId }, select: { state: true } })).state).toBe('NEEDS_CORRECTION');
    const answered = (await auditFor({ entityId: rejectedId, action: 'UPDATE' })).filter((a) => a.reason === 'resubmitted: answered by a new request');
    expect(answered).toHaveLength(1);
    expect((answered[0]!.after as unknown as { answeredBy?: string }).answeredBy).toBe(resentId);
  });

  test('M1 approves the corrected request and its values go live', async ({ browser }) => {
    expect(resentId).toBeTruthy();
    const c = world.customer('RJ');
    const page = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await approveOnPage(page, resentId);
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id: resentId }, select: { state: true } })).state).toBe('APPROVED');
    const live = await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { contactPerson: true, contactRole: true } });
    expect(live.contactRole).toBe('Shop manager');
    expect(live.contactPerson).toBe(changeOf(await db.customerEdit.findUniqueOrThrow({ where: { id: resentId } }), 'customer.contactPerson')?.after);
  });

  test('once answered, the returned item leaves Today, Work and Needs correction (launch fix)', async ({ browser }) => {
    const c = world.customer('RJ');
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/today');
    await expect(stat(page, 'Needs correction')).toHaveText('0');
    await page.goto('/work');
    await expect(page.getByRole('link', { name: /^Sent back to you/ })).toHaveCount(0);
    await expect(page.locator(`a[href="/customers/${c.id}/edit?returned=${rejectedId}"]`)).toHaveCount(0);
    await page.goto('/rejected');
    await expect(page.getByText('Nothing to correct', { exact: true })).toBeVisible();
    await expect(page.getByText(c.legalName)).toHaveCount(0);
  });

  test('one he will not send again he clears himself; the request stays sent back on record', async ({ browser }) => {
    const c = world.customer('RJ2');
    const { id } = await seedUpdateEdit(world, {
      customer: 'RJ2',
      submitter: 'SA',
      state: 'NEEDS_CORRECTION',
      patch: { customer: { contactPerson: world.name('Second contact') } },
      decision: { by: 'M1', reason: 'The contact on file is already right', category: 'wrong_info' },
    });
    const page = await (await contextAs(browser, world.user('SA'))).newPage();
    await page.goto('/today');
    await expect(stat(page, 'Needs correction')).toHaveText('1');
    await page.goto('/rejected');
    const clear = page.locator('li').filter({ hasText: c.legalName }).getByRole('button', { name: 'Nothing to send again — clear this' });
    await waitHydrated(clear);
    await clear.click();
    const dialog = page.getByRole('dialog', { name: 'Clear this from Needs correction?' });
    await dialog.getByRole('button', { name: 'Clear it' }).click();
    await expect(page.getByText('Nothing to correct', { exact: true })).toBeVisible();
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true } })).state).toBe('NEEDS_CORRECTION');
    expect((await auditFor({ entityId: id })).map((a) => a.reason)).toContain('cleared by the salesman: nothing to send again');
    await page.goto('/today');
    await expect(stat(page, 'Needs correction')).toHaveText('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: direct edits by a Manager and the Data Steward', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    world = await standardWorld('udw', {
      customers: [
        { key: 'DW1', phone: true, contact: 'Yaqoob Al Farsi', branches: [{ key: 'S', route: 'A' }] },
        { key: 'DW2', phone: true, contact: 'Yaqoob Al Farsi', branches: [{ key: 'S', route: 'A' }] },
        // Synced with Temix (temixCode set, SYNCED).
        { key: 'DW3', phone: true, contact: 'Yaqoob Al Farsi', branches: [{ key: 'S', route: 'A' }] },
        { key: 'DW4', phone: true, contact: 'Yaqoob Al Farsi', branches: [{ key: 'X', route: 'A' }, { key: 'Y', route: 'A' }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test("M1's own edit and photo are live at once, with no approval and nothing in any queue", async ({ browser }) => {
    test.setTimeout(240_000);
    const m1 = world.user('M1');
    const c = world.customer('DW1');
    const contact = world.name('Direct contact');
    const page = await (await contextAs(browser, m1, { device: 'desktop' })).newPage();
    await page.goto(`/customers/${c.id}`);
    await page.getByRole('link', { name: 'Enrich' }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}/edit$`));
    await waitHydrated(page);
    const { section } = await branchSection(page, c.branch.name);
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await pickFile(photoSlot(section, 'Shop front'), png('m1-shop.png'));
    const shopId = await waitForBranchPhoto(c.branch.id, 'shop');
    await expect(missingBox(page)).toHaveCount(0);
    const release = await slowNextDocument(page, new RegExp(`/customers/${c.id}$`));
    const saved = await watchForText(page, '✓ Saved (auto-approved as MANAGER).');
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });
    await release();
    expect(saved(), 'the form said it was saved before it left').not.toBeNull();
    await expect(page.locator(`img[src="/api/photos/${shopId}"]`)).toBeVisible();

    const edits = await editsOn(c.id);
    expect(edits.map((e) => ({ state: e.state, submittedById: e.submittedById, reviewedById: e.reviewedById }))).toEqual([
      { state: 'APPROVED', submittedById: m1.id, reviewedById: m1.id },
    ]);
    world.adopt.edit(edits[0]!.id);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { contactPerson: true } })).contactPerson).toBe(contact);
    const audit = await auditFor({ entityId: c.id, actorId: m1.id, action: 'UPDATE' });
    expect(audit.map((a) => a.reason)).toContain('direct-write: applied by MANAGER with no approval chain');
    expect(await notificationsFor({ customerId: c.id }), 'nobody is asked to review a direct write').toEqual([]);
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1, name: 'Approval queue' })).toBeVisible();
    await expect(page.getByText(c.legalName)).toHaveCount(0);
  });

  test("on a customer with a shop in another region, M1 edits his region's shops only", async ({ browser }) => {
    const m1 = world.user('M1');
    const multi = world.customer('MULTI');
    const A1 = world.branch('MULTI.A1');
    const B1 = world.branch('MULTI.B1');
    const page = await (await contextAs(browser, m1, { device: 'desktop' })).newPage();
    await page.goto(`/customers/${multi.id}/edit`);
    await waitHydrated(page);
    await branchSection(page, A1.name);
    await branchSection(page, world.branch('MULTI.A2').name);
    await expect(page.getByText(B1.name)).toHaveCount(0);

    const b1Before = await db.branch.findUniqueOrThrow({ where: { id: B1.id }, select: { address: true } });
    const refused = await submitEnrichViaApi(page, { customerId: multi.id, branches: [{ branchId: B1.id, address: world.name('B1 by M1') }] }, { world });
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'You can only edit branches in a region you manage.' });
    expect(await db.branch.findUniqueOrThrow({ where: { id: B1.id }, select: { address: true } })).toEqual(b1Before);

    const a1Address = world.name('A1 by M1');
    const ok = await submitEnrichViaApi(page, { customerId: multi.id, branches: [{ branchId: A1.id, address: a1Address }] }, { world });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, data: { state: 'APPROVED' } });
    expect((await db.branch.findUniqueOrThrow({ where: { id: A1.id }, select: { address: true } })).address).toBe(a1Address);
  });

  test("while a salesman's request waits, a direct edit of that customer is refused (form and server, Manager and Steward)", async ({ browser }) => {
    const c = world.customer('DW2');
    await seedUpdateEdit(world, { customer: 'DW2', submitter: 'SA', patch: { customer: { contactPerson: world.name('Waiting change') } } });
    const page = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    await expect(page.getByText(`A submission is already pending review (by ${world.user('SA').fullName}).`)).toBeVisible();
    await expect(submitButton(page)).toBeDisabled();
    await expect(submitButton(page)).toHaveAttribute('title', 'Pending edit already in review');

    const asManager = await submitEnrichViaApi(page, { customerId: c.id, customer: { contactPerson: world.name('M1 over it') } }, { world });
    expect(asManager, JSON.stringify(asManager)).toMatchObject({
      ok: false,
      code: 'EDIT_LOCKED',
      message: 'A submitted edit is already pending review for this customer.',
    });
    const stw = await (await contextAs(browser, world.user('STW'), { device: 'desktop' })).newPage();
    await stw.goto('/import');
    const asSteward = await submitEnrichViaApi(stw, { customerId: c.id, customer: { contactPerson: world.name('STW over it') } }, { world });
    expect(asSteward, JSON.stringify(asSteward)).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { contactPerson: true } })).contactPerson).toBe('Yaqoob Al Farsi');
  });

  test("the Steward's correction of a synced customer is live at once, audited, and queued for Temix", async ({ browser }) => {
    test.setTimeout(180_000);
    const stw = world.user('STW');
    const c = world.customer('DW3');
    expect(await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { temixSyncState: true } })).toEqual({ temixSyncState: 'SYNCED' });
    const contact = world.name('Steward contact');
    const address = world.name('Way 9, Bausher');
    const page = await (await contextAs(browser, stw, { device: 'desktop' })).newPage();
    await page.goto(`/customers/${c.id}/edit`);
    await waitHydrated(page);
    const { section } = await branchSection(page, c.branch.name);
    await page.getByLabel('Contact person *', { exact: true }).fill(contact);
    await section.getByLabel('Address *', { exact: true }).fill(address);
    const release = await slowNextDocument(page, new RegExp(`/customers/${c.id}$`));
    const saved = await watchForText(page, '✓ Saved (auto-approved as STEWARD).');
    await submitButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}$`), { timeout: 30_000 });
    await release();
    expect(saved(), 'the form said it was saved before it left').not.toBeNull();

    const [edit] = await editsOn(c.id);
    world.adopt.edit(edit!.id);
    expect(edit).toMatchObject({ state: 'APPROVED', submittedById: stw.id, reviewedById: stw.id });
    const live = await db.customer.findUniqueOrThrow({
      where: { id: c.id },
      select: { contactPerson: true, temixSyncState: true, temixSyncPendingSince: true, branches: { select: { address: true } } },
    });
    expect(live.contactPerson).toBe(contact);
    expect(live.branches[0]!.address).toBe(address);
    // In the database, not on the org-wide /temix tile (real UAT rows share it).
    expect(live.temixSyncState).toBe('PENDING_UPLOAD');
    expect(live.temixSyncPendingSince).not.toBeNull();
    expect((await auditFor({ entityId: c.id, actorId: stw.id, action: 'UPDATE' })).map((a) => a.reason)).toContain(
      'direct-write: applied by STEWARD with no approval chain'
    );
  });

  test('owner decision 7 on a direct write: the customer closes with its last open shop and is active again when one reopens', async ({ browser }) => {
    test.info().annotations.push({ type: 'owner decision', description: '7 (7 Oct): a customer becomes CLOSED when its last open shop closes, ACTIVE again on reopen' });
    const stw = world.user('STW');
    const c = world.customer('DW4');
    const X = world.branch('DW4.X');
    const Y = world.branch('DW4.Y');
    const page = await (await contextAs(browser, stw, { device: 'desktop' })).newPage();
    await page.goto('/import');
    const setStatus = async (branchId: string, status: 'ACTIVE' | 'CLOSED') => {
      const res = await submitEnrichViaApi(page, { customerId: c.id, branches: [{ branchId, status }] }, { world });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { state: 'APPROVED' } });
      return (await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } })).status;
    };
    expect(await setStatus(X.id, 'CLOSED'), 'one shop still open').toBe('ACTIVE');
    expect(await setStatus(Y.id, 'CLOSED'), 'its last open shop closed').toBe('CLOSED');
    expect(await setStatus(X.id, 'ACTIVE'), 'a shop reopened').toBe('ACTIVE');
    const moves = (await auditFor({ entityId: c.id, entityType: 'Customer' })).filter((a) => a.action === 'CLOSE' || a.action === 'REACTIVATE');
    expect(moves.map((a) => ({ action: a.action, before: a.before, after: a.after }))).toEqual([
      { action: 'CLOSE', before: { status: 'ACTIVE' }, after: { status: 'CLOSED' } },
      { action: 'REACTIVATE', before: { status: 'CLOSED' }, after: { status: 'ACTIVE' } },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('update flow: what changed after a request was sent', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });
  notRunHere(!hasR2, R2_SKIP);
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;
  let since: Date;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    since = new Date();
    const shop = { route: 'A', gps: { ...MUSCAT }, photos: ['SHOP' as const] };
    world = await standardWorld('ust', {
      customers: [
        { key: 'ST1', phone: true, contact: 'Original contact', branches: [{ key: 'S', route: 'A' }] },
        { key: 'ST2', phone: true, contact: 'Original contact', branches: [{ key: 'S', ...shop }] },
        { key: 'ST3', phone: true, contact: 'Original contact', branches: [{ key: 'P', ...shop }, { key: 'Q', ...shop }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await cleanupUpdateWorld(world, since);
  });

  test('a load that changed the same field meanwhile: the page warns, Approve is refused (STALE_BEFORE), Reject still works', async ({ browser }) => {
    const c = world.customer('ST1');
    const { id } = await seedUpdateEdit(world, { customer: 'ST1', submitter: 'SA', patch: { customer: { contactPerson: world.name('Salesman contact') } } });
    // A Steward import lands on the same field while the request waits (promote does not look at open requests).
    const imported = world.name('Imported contact');
    await db.customer.update({ where: { id: c.id }, data: { contactPerson: imported } });

    const page = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await page.goto(`/approvals/${id}`);
    await expect(page.getByText('Changed on the customer since this request was sent: Contact person.')).toBeVisible();
    await approveExpectingRefusal(
      page,
      id,
      'Changed on the customer after this request was sent: contact person. Approving would overwrite the newer values, so nothing was approved. Reject it so the salesman can check and send it again.'
    );
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { contactPerson: true } })).contactPerson).toBe(imported);

    const form = await openRejectForm(page);
    await form.locator('textarea[name="reason"]').fill('The contact changed since — check it and send again');
    await form.getByRole('button', { name: '✗ Send back to salesman' }).click();
    await expect(page).toHaveURL(/\/approvals(\?|$)/);
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true } })).state).toBe('NEEDS_CORRECTION');
  });

  test('the shop photo removed after the request was sent: Approve is refused (NEEDS_REUPLOAD) and nothing is written', async ({ browser }) => {
    const c = world.customer('ST2');
    const shopPhoto = c.photos.find((p) => p.wire === 'SHOP')!;
    const { id } = await seedUpdateEdit(world, { customer: 'ST2', submitter: 'SA', patch: { branches: [{ branch: 'ST2', openingHours: '07:00-23:00' }] } });
    // The salesman removes the shop photo after he submitted (the real detach route).
    const sa = await (await contextAs(browser, world.user('SA'))).newPage();
    await sa.goto('/today');
    expect(await (await postJson(sa, '/api/photos/detach', { attachmentId: shopPhoto.id })).json()).toMatchObject({ ok: true });

    const page = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await page.goto(`/approvals/${id}`);
    await expect(page.getByText('No shop photo yet')).toBeVisible();
    await approveExpectingRefusal(
      page,
      id,
      `Required fields are now missing on this customer (1 missing). Reject the edit so the salesman can refill: Branch ${c.branch.code}: shop photo is required.`
    );
    expect((await db.branch.findUniqueOrThrow({ where: { id: c.branch.id }, select: { openingHours: true } })).openingHours).toBeNull();
  });

  test('a shop deleted after the request was sent: its changes are dropped and the rest is approved', async ({ browser }) => {
    const P = world.branch('ST3.P');
    const Q = world.branch('ST3.Q');
    const { id } = await seedUpdateEdit(world, {
      customer: 'ST3',
      submitter: 'SA',
      patch: { branches: [{ branch: 'ST3.P', openingHours: '06:00-14:00' }, { branch: 'ST3.Q', openingHours: '14:00-23:00' }] },
    });
    // A Steward load removes shop Q meanwhile.
    await db.branch.update({ where: { id: Q.id }, data: { deletedAt: new Date() } });

    const page = await (await contextAs(browser, world.user('M1'), { device: 'desktop' })).newPage();
    await approveOnPage(page, id);
    expect((await db.customerEdit.findUniqueOrThrow({ where: { id }, select: { state: true } })).state).toBe('APPROVED');
    expect((await db.branch.findUniqueOrThrow({ where: { id: P.id }, select: { openingHours: true } })).openingHours).toBe('06:00-14:00');
    expect((await db.branch.findUniqueOrThrow({ where: { id: Q.id }, select: { openingHours: true } })).openingHours, 'the deleted shop is untouched').toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A gap the critic found (P2), fixed in the launch candidate: its own non-serial test.
test.describe('update flow: a route switched off mid-week', { tag: ['@phone'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  notRunHere(FULL_GATE, CORE_ONLY);

  let world: World;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await createWorld('uoff', {
      regions: [{ key: 'R' }],
      routes: [{ key: 'OFF', region: 'R', isActive: false }],
      users: [
        { key: 'M', role: 'MANAGER', regions: ['R'] },
        { key: 'S', role: 'SALESMAN', route: 'OFF', supervisor: 'M' },
      ],
      customers: [
        { key: 'C', phone: true, contact: 'Rashid Al Maskari', branches: [{ key: 'S', route: 'OFF' }] },
        // A shop on the same route, closed yesterday: what a reactivation request would be about.
        { key: 'CL', phone: true, branches: [{ key: 'S', route: 'OFF', status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) }] },
      ],
    });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    await world?.cleanup();
  });

  const REFUSED = { ok: false, code: 'FORBIDDEN', message: ROUTE_INACTIVE_MESSAGE };

  test('an enrichment, a close request and a reactivation request on a switched-off route are refused, as New customer refuses one; nothing is written', async ({ browser }) => {
    // Was a P2 (critic), fixed by 804bda1: services/edits.ts never checked route.isActive, so this submit went through.
    // Enrichments, closes and reactivations are refused now in New customer's words (lib/errors.ts ROUTE_INACTIVE_MESSAGE).
    const c = world.customer('C');
    const cl = world.customer('CL');
    const s = world.user('S');
    const page = await (await contextAs(browser, s)).newPage();
    await page.goto('/today');
    const sent = await submitEnrichViaApi(page, { customerId: c.id, customer: { contactPerson: world.name('New contact') } }, { world });
    expect(sent, JSON.stringify(sent)).toMatchObject(REFUSED);
    // A close request: the route is the first refusal, before its evidence photo is even looked at.
    const close = await postForm(page, 'branch-close', {
      submissionId: randomUUID(),
      branchId: c.branch.id,
      reason: 'The shop has shut for good.',
      attachmentId: randomUUID(),
    });
    expect(close, JSON.stringify(close)).toMatchObject(REFUSED);
    // A reactivation request for his closed shop (services/reactivations.ts): refused on the route, before the
    // evidence photo is looked at.
    const reopen = await requestReactivationViaApi(
      page,
      { branchId: cl.branch.id, reason: 'The shop has opened again.', attachmentId: randomUUID() },
      world
    );
    expect(reopen, JSON.stringify(reopen)).toMatchObject(REFUSED);
    expect(await db.customerEdit.count({ where: { submittedById: s.id, state: { not: 'DRAFT' } } }), 'no request was filed').toBe(0);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id }, select: { contactPerson: true } })).contactPerson).toBe('Rashid Al Maskari');
    expect(await db.branch.findUniqueOrThrow({ where: { id: c.branch.id }, select: { status: true } }), 'the open shop stays open').toEqual({ status: 'ACTIVE' });
    expect(await db.branch.findUniqueOrThrow({ where: { id: cl.branch.id }, select: { status: true } }), 'the closed shop stays closed').toEqual({ status: 'CLOSED' });
  });

  test('a photo attached to his shop on a switched-off route is refused; the slot and the photo are untouched', async ({ browser }) => {
    // 5e8929b: the attach route refuses a salesman on a switched-off route, after the answer to a re-sent attach that
    // already landed and before anything is written. The upload itself (presign, R2, finalize) is not route-checked.
    notRunHere(!hasR2, 'the photo goes up through R2 before its attach is refused');
    const c = world.customer('C');
    const s = world.user('S');
    const page = await (await contextAs(browser, s)).newPage();
    await page.goto('/today');
    const slotBefore = await db.branch.findUniqueOrThrow({ where: { id: c.branch.id }, select: { shopPhotoId: true, signboardPhotoId: true } });
    const up = await uploadPhotoViaApi(page, world, { kind: 'SHOP' });
    const attached = await postJson(page, '/api/photos/attach', { attachmentId: up.attachmentId, branchId: c.branch.id, slot: 'SHOP' });
    expect(attached.status(), 'the attach route answers with the refusal (200)').toBe(200);
    const answer = (await attached.json()) as unknown;
    expect(answer, JSON.stringify(answer)).toMatchObject(REFUSED);
    expect(await db.branch.findUniqueOrThrow({ where: { id: c.branch.id }, select: { shopPhotoId: true, signboardPhotoId: true } }), 'the slot is untouched').toEqual(slotBefore);
    expect(
      await db.attachment.findUniqueOrThrow({ where: { id: up.attachmentId }, select: { customerId: true, branchId: true, branchExtraId: true, editId: true } }),
      'the photo is on no slot'
    ).toEqual({ customerId: null, branchId: null, branchExtraId: null, editId: null });
    expect(await auditFor({ entityId: c.branch.id, actorId: s.id }), 'no audit row: the attach did not happen').toEqual([]);
  });
});
