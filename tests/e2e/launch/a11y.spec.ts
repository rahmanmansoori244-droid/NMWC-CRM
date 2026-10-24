/**
 * ACCESSIBILITY REPORT — Deque's axe-core (@axe-core/playwright 4.13.0, WCAG
 * 2.0 and 2.1, levels A and AA) over the screens people use every day, each
 * signed in as the role that uses it, on the phone AND the desktop project (each
 * builds its own standard world; every context takes the project's device, on
 * purpose — the same screens are scanned at 412 px and at 1280 px):
 *
 *   salesman   sign-in, forced password change, Today, customer search, a
 *              customer page, the enrich form, the new-customer form, Needs
 *              correction, notifications;
 *   Manager    the approvals queue (as it loads, and with a card ticked so the
 *              bulk bar shows), a review page (as it loads, with its Reject form
 *              open, and with its Approve dialog open — closed with Escape, never
 *              confirmed), reactivations (a real one, when R2 is configured),
 *              dashboard, users;
 *   Steward    users (and its Edit account dialog, closed with Escape), routes,
 *              import and a seeded batch, audit, export, Temix (and its Mark
 *              loaded dialog, closed with Escape), duplicates (a seeded pair),
 *              service status, integrity, a customer's history.
 *
 * LAUNCH POLICY — REPORT, AND TWO GATES. Each scan's axe JSON is attached to its
 * test, each test is annotated with what axe found, and the run's summary (rule,
 * impact, count, page; per project) is written to the report and to
 * test-results/launch-a11y-summary.json. A violation fails no scanning test. The
 * last tests are the gates:
 *
 *   the salesman's phone gate — on the phone project, a `critical` violation of
 *
 *     label · select-name · button-name · input-button-name
 *
 *   (a form field or a button with no accessible name) on one of the salesman's
 *   screens. These make a control unusable rather than harder — TalkBack says
 *   "edit box" / "button", voice control cannot reach it, nothing says which box
 *   takes the phone number — and they are deterministic DOM checks that do not
 *   flake; the app already labels its fields (UAT-07), so a hit is a regression.
 *   The reasons are written per rule in support/a11y-helpers.ts (GATE_RULES).
 *
 *   the back-office gate — on BOTH projects, any violation axe rates critical or
 *   serious (contrast included) on a Manager's or a Data Steward's screen
 *   (BACKOFFICE_PAGES). The accessibility pass of October 2026 brought those
 *   screens to none, so one is a change that brought it back.
 *
 * Both are written into the summary file. A page that cannot be reached or
 * scanned fails its test (after the other pages of that test have been
 * scanned): that is a broken page or fixture, not a finding.
 *
 * Nothing here types a password, so no scanned DOM holds one. Nothing is
 * approved, rejected, generated or marked loaded: every dialog opened to be
 * scanned is closed with Escape or Cancel, and the database says so after.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts a11y --project=phone --project=desktop
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import {
  contextAs,
  db,
  hasR2,
  installLaunchHooks,
  requestReactivationViaApi,
  requireLaunchEnv,
  seedNotification,
  seedUpdateEdit,
  standardWorld,
  uploadPhotoViaApi,
  type World,
} from './support';
import { hydrated, seedImportBatch, seedTemixBatch } from './support/access-control-helpers';
import {
  A11Y_PAGES,
  BACKOFFICE_GATE_IMPACTS,
  BACKOFFICE_PAGES,
  GATE_IMPACT,
  GATE_PROJECT,
  GATE_RULES,
  GATED_PAGES,
  SUMMARY_FILE,
  a11yScans,
  backofficeFindings,
  describeFinding,
  gateFindings,
  projectScans,
  scanPage,
  summaryMarkdown,
  type Impact,
} from './support/a11y-helpers';

test.describe('a11y report: the main screens, each signed in as its role', { tag: ['@phone', '@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  let world: World;
  /** A SUBMITTED update on FULL by SA, waiting on his supervisor M1. */
  let pendingId = '';
  /** An update on NODAY1 that M1 sent back to SA (Needs correction). */
  let returnedId = '';
  /** A promoted customer batch of STW's, for the batch page. */
  let batchId = '';
  let batchName = '';
  /** A Temix batch awaiting STW's "loaded" confirmation, for the Mark loaded dialog. */
  let temixBatchId = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await standardWorld('ay', {
      // FRESH: a salesman still on the hand-out password — held on the forced change.
      routes: [{ key: 'NEW', region: 'R1' }],
      users: [{ key: 'FRESH', role: 'SALESMAN', route: 'NEW', supervisor: 'M1', mustChangePassword: true }],
    });
    // The queue and the review page are scanned with work on them, not empty.
    pendingId = (
      await seedUpdateEdit(world, {
        customer: 'FULL',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('Contact') }, branches: [{ branch: 'FULL', openingHours: '07:00-23:00' }] },
      })
    ).id;
    returnedId = (
      await seedUpdateEdit(world, {
        customer: 'NODAY1',
        submitter: 'SA',
        patch: { customer: { contactPerson: world.name('Contact to fix') } },
        state: 'NEEDS_CORRECTION',
        decision: { by: 'M1', reason: 'Photo is blurry, retake', category: 'bad_photo' },
      })
    ).id;
    // SA's inbox: unread and read rows of the kinds a salesman receives; M1's bell is lit.
    await seedNotification(world, {
      user: 'SA',
      kind: 'EDIT_NEEDS_CORRECTION',
      title: world.name('Sent back for correction'),
      editId: returnedId,
      customerId: world.customer('NODAY1').id,
    });
    await seedNotification(world, { user: 'SA', kind: 'TEMIX_SYNC_ACKED', title: world.name('Customer landed in Temix'), customerId: world.customer('DUE1').id });
    await seedNotification(world, {
      user: 'SA',
      kind: 'EDIT_APPROVED_FINAL',
      title: world.name('Your edit was approved'),
      customerId: world.customer('FULL').id,
      read: true,
    });
    await seedNotification(world, {
      user: 'M1',
      kind: 'EDIT_SUBMITTED',
      title: world.name('Edit awaiting your review'),
      editId: pendingId,
      customerId: world.customer('FULL').id,
    });
    // The Steward's screens with something on them: a suspected pair (same CR
    // number) on /duplicates, a promoted batch, and a Temix batch to confirm.
    const cr = `CR${world.SFX}D1`;
    await world.addCustomer({ key: 'DUPA', phone: true, crNumber: cr, branches: [{ key: 'S', route: 'A' }] });
    await world.addCustomer({ key: 'DUPB', phone: true, crNumber: cr, branches: [{ key: 'S', route: 'A' }] });
    batchName = `${world.name('a11y batch')}.xlsx`;
    batchId = await seedImportBatch(world, { uploader: 'STW', filename: batchName, status: 'PROMOTED' });
    temixBatchId = await seedTemixBatch(world, { creator: 'STW' });
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('the Manager’s screens: approvals queue, a review page and its decisions, reactivations, dashboard, users (report; the back-office gate is a last test)', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const scans = a11yScans();
    const full = world.customer('FULL');
    const m1 = await contextAs(browser, world.user('M1'));
    const page = await m1.newPage();

    await scans.page('approvals', async () => {
      await page.goto('/approvals');
      await expect(page.getByText(full.legalName).first()).toBeVisible();
      await scanPage(page, 'approvals', { heading: 'Approval queue' });
    });

    await scans.page('approvalsSelected', async () => {
      // One card ticked: the bulk bar (Reject n / Approve n) is on screen. Unticked after; nothing is decided.
      if (new URL(page.url()).pathname !== '/approvals') await page.goto('/approvals');
      const tick = page.getByRole('checkbox', { name: `Select edit for ${full.legalName}`, exact: true });
      await hydrated(tick);
      await tick.check();
      await expect(page.getByRole('button', { name: /^✓ Approve \d+$/ })).toBeVisible();
      await scanPage(page, 'approvalsSelected', { heading: 'Approval queue' });
      await tick.uncheck();
      await expect(page.getByRole('button', { name: /^✓ Approve \d+$/ })).toHaveCount(0);
    });

    await scans.page('review', async () => {
      await page.goto(`/approvals/${pendingId}`);
      await expect(page.getByRole('button', { name: /^✓ Approve$/ })).toBeVisible();
      await scanPage(page, 'review', { heading: full.legalName });
    });

    await scans.page('reviewReject', async () => {
      // ✗ Reject swaps in the form; focus follows to its heading, and Cancel puts it back.
      if (new URL(page.url()).pathname !== `/approvals/${pendingId}`) await page.goto(`/approvals/${pendingId}`);
      const reject = page.getByRole('button', { name: '✗ Reject', exact: true });
      await hydrated(reject);
      await reject.click();
      const heading = page.getByRole('heading', { name: 'Reject this submission', exact: true });
      await expect(heading).toBeFocused();
      await scanPage(page, 'reviewReject', { heading: full.legalName });
      await page.locator('form').filter({ has: heading }).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(heading).toHaveCount(0);
      await expect(reject).toBeFocused();
    });

    await scans.page('reviewConfirm', async () => {
      // The Approve dialog, scanned open and closed with Escape — never Enter, never its confirm button.
      if (new URL(page.url()).pathname !== `/approvals/${pendingId}`) await page.goto(`/approvals/${pendingId}`);
      const approve = page.getByRole('button', { name: /^✓ Approve$/ });
      await hydrated(approve);
      await approve.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await scanPage(page, 'reviewConfirm', { heading: full.legalName });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      const edit = await db.customerEdit.findUniqueOrThrow({ where: { id: pendingId }, select: { state: true } });
      expect(edit.state, 'the dialog closed with Escape and approved nothing').toBe('SUBMITTED');
    });

    await scans.page('reactivations', async () => {
      const closed = world.customer('CLOSEDB');
      if (hasR2) {
        // A reactivation waiting on M1: SA's fresh evidence photo (presign → R2 → finalize), then the request.
        const sa = await contextAs(browser, world.user('SA'));
        const saPage = await sa.newPage();
        await saPage.goto('/today');
        const photo = await uploadPhotoViaApi(saPage, world, { kind: 'FREE' });
        const sent = await requestReactivationViaApi(
          saPage,
          { branchId: closed.branch.id, reason: world.name('Shop reopened under the same owner'), attachmentId: photo.attachmentId },
          world
        );
        expect(sent, JSON.stringify(sent).slice(0, 300)).toMatchObject({ status: 200, ok: true });
        await saPage.close();
      } else {
        test.info().annotations.push({ type: 'a11y', description: 'Reactivations: R2 is not configured — the empty queue is scanned' });
      }
      await page.goto('/reactivations');
      if (hasR2) await expect(page.getByText(closed.legalName).first()).toBeVisible();
      await scanPage(page, 'reactivations', { heading: 'Reactivation queue' });
    });

    await scans.page('dashboard', async () => {
      await page.goto('/dashboard');
      await scanPage(page, 'dashboard', { heading: 'Dashboard' });
    });

    await scans.page('usersManager', async () => {
      await page.goto('/users');
      await scanPage(page, 'usersManager', { heading: 'Users' });
    });

    scans.done();
  });

  test('the Steward’s screens: users, import, Temix (report; the back-office gate is a last test)', async ({ browser }) => {
    test.setTimeout(600_000);
    const scans = a11yScans();
    const stw = await contextAs(browser, world.user('STW'));
    const page = await stw.newPage();

    await scans.page('users', async () => {
      await page.goto('/users');
      await scanPage(page, 'users', { heading: 'Users' });
    });

    await scans.page('import', async () => {
      await page.goto('/import');
      await scanPage(page, 'import', { heading: 'Import Excel' });
    });

    await scans.page('temix', async () => {
      await page.goto('/temix');
      await scanPage(page, 'temix', { heading: 'Temix sync' });
    });

    scans.done();
  });

  test('the Steward’s records and set-up screens, and its two dialogs (report; the back-office gate is a last test)', async ({ browser }) => {
    test.setTimeout(600_000);
    const scans = a11yScans();
    const stw = await contextAs(browser, world.user('STW'));
    const page = await stw.newPage();

    await scans.page('routes', async () => {
      await page.goto('/routes');
      await scanPage(page, 'routes', { heading: 'Routes & Regions' });
    });

    await scans.page('audit', async () => {
      await page.goto('/audit');
      await scanPage(page, 'audit', { heading: 'Audit log' });
    });

    await scans.page('export', async () => {
      await page.goto('/export');
      await scanPage(page, 'export', { heading: 'Export to Excel' });
    });

    await scans.page('importBatch', async () => {
      await page.goto(`/import/${batchId}`);
      await scanPage(page, 'importBatch', { heading: batchName });
    });

    await scans.page('duplicates', async () => {
      await page.goto('/duplicates');
      await expect(page.getByRole('heading', { level: 1, name: 'Duplicate review', exact: true })).toBeVisible();
      // The seeded pair puts the merge buttons on the scanned page. The page shows the first 50 pairs of
      // all of UAT, so on a crowded UAT it can be past them: then the pairs shown carry the same form.
      if (!(await page.getByText(world.customer('DUPA').legalName).first().isVisible())) {
        test.info().annotations.push({ type: 'a11y', description: 'Duplicates: the seeded pair is not among the first 50 shown; the page is scanned as it is' });
      }
      await scanPage(page, 'duplicates', { heading: 'Duplicate review' });
    });

    await scans.page('status', async () => {
      await page.goto('/status');
      await scanPage(page, 'status', { heading: 'Service status' });
    });

    await scans.page('integrity', async () => {
      await page.goto('/status/integrity');
      await scanPage(page, 'integrity', { heading: 'Integrity' });
    });

    await scans.page('history', async () => {
      await page.goto(`/customers/${world.customer('FULL').id}/history`);
      await scanPage(page, 'history', { heading: 'History' });
    });

    await scans.page('temixConfirm', async () => {
      // The Mark loaded dialog on the seeded batch, scanned open and closed with Escape.
      await page.goto('/temix');
      const row = page.getByRole('row').filter({ hasText: `…${temixBatchId.slice(-6)}` });
      const markLoaded = row.getByRole('button', { name: 'Mark loaded', exact: true });
      await hydrated(markLoaded);
      await markLoaded.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await scanPage(page, 'temixConfirm', { heading: 'Temix sync' });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      const batch = await db.temixSyncBatch.findUniqueOrThrow({ where: { id: temixBatchId }, select: { markedLoadedAt: true } });
      expect(batch.markedLoadedAt, 'the dialog closed with Escape and marked nothing loaded').toBeNull();
    });

    await scans.page('usersEdit', async () => {
      // The Edit account dialog on SA's row: focus moves into it, and Escape closes it with focus back on Edit.
      await page.goto('/users');
      const sa = world.user('SA');
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: sa.username, exact: true }) });
      const edit = row.getByRole('button', { name: 'Edit', exact: true });
      await hydrated(edit);
      await edit.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Role', { exact: true })).toBeFocused();
      await scanPage(page, 'usersEdit', { heading: 'Users' });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(edit).toBeFocused();
    });

    scans.done();
  });

  test('the salesman’s screens, from sign-in to notifications (report; the phone gate is a last test)', async ({ browser }) => {
    test.setTimeout(600_000);
    const scans = a11yScans();

    await scans.page('signIn', async () => {
      const anon = await contextAs(browser, null);
      const page = await anon.newPage();
      await page.goto('/login');
      // Hydrated: the form a salesman can actually use (the button is inert before).
      await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
      await scanPage(page, 'signIn', { heading: 'NMWC' });
    });

    await scans.page('forcedChange', async () => {
      const fresh = await contextAs(browser, world.user('FRESH'));
      const page = await fresh.newPage();
      await page.goto('/today');
      await expect(page, 'a must-change account is held on the change-password page').toHaveURL(/\/profile\/change-password(\?|$)/);
      await expect(page.getByText('You must change your password before continuing.')).toBeVisible();
      await scanPage(page, 'forcedChange', { heading: 'Change password' });
    });

    const sa = await contextAs(browser, world.user('SA'));
    const page = await sa.newPage();

    await scans.page('today', async () => {
      await page.goto('/today');
      await expect(page.getByRole('heading', { level: 3, name: world.customer('DUE1').legalName, exact: true })).toBeVisible();
      await scanPage(page, 'today', { heading: /^Good day, / });
    });

    await scans.page('search', async () => {
      // Every world customer's legal name carries the suffix: the search returns his route's.
      await page.goto(`/customers?q=${encodeURIComponent(world.sfx)}`);
      await expect(page.getByText(world.customer('DUE1').legalName).first()).toBeVisible();
      await scanPage(page, 'search', { heading: 'Customers' });
    });

    await scans.page('customer', async () => {
      const full = world.customer('FULL');
      await page.goto(`/customers/${full.id}`);
      await scanPage(page, 'customer', { heading: full.legalName });
    });

    await scans.page('enrich', async () => {
      // GAPS: phone, contact and photos missing — the form as the salesman meets it.
      const gaps = world.customer('GAPS');
      await page.goto(`/customers/${gaps.id}/edit`);
      await expect(page.getByText('Enrich missing data').first()).toBeVisible();
      await scanPage(page, 'enrich', { heading: gaps.legalName });
    });

    await scans.page('newCustomer', async () => {
      await page.goto('/customers/new');
      await scanPage(page, 'newCustomer', { heading: 'New customer' });
    });

    await scans.page('needsCorrection', async () => {
      await page.goto('/rejected');
      await expect(page.getByText(world.customer('NODAY1').legalName).first()).toBeVisible();
      await scanPage(page, 'needsCorrection', { heading: 'Needs correction' });
    });

    await scans.page('notifications', async () => {
      // React #418 here was KNOWN_BUGS.notificationsHydration, fixed in wave 1: no longer allow-listed, so a
      // hydration error on this page fails the test (installLaunchHooks).
      await page.goto('/notifications');
      await expect(page.getByText(world.name('Sent back for correction')).first()).toBeVisible();
      await scanPage(page, 'notifications', { heading: 'Notifications' });
    });

    scans.done();
  });
});

test.describe('a11y report: the summary, the salesman’s phone gate and the back-office gate', { tag: ['@phone', '@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();

  test('the summary — rule, impact, count, page — goes into the report and test-results/launch-a11y-summary.json', async () => {
    const info = test.info();
    const project = info.project.name;
    const scans = await projectScans(project);
    await info.attach('a11y-summary.md', { body: summaryMarkdown(project, scans), contentType: 'text/markdown' });
    await info.attach('a11y-summary.json', { body: JSON.stringify(scans, null, 2), contentType: 'application/json' });

    const scanned = scans.filter((s) => !s.error);
    const nodes = new Map<Impact, number>();
    const rules = new Set<string>();
    for (const s of scanned) {
      for (const v of s.violations) {
        nodes.set(v.impact, (nodes.get(v.impact) ?? 0) + v.count);
        rules.add(v.rule);
      }
    }
    const byImpact = [...nodes.entries()].map(([i, n]) => `${i} ${n}`).join(', ') || 'none';
    const gate = project === GATE_PROJECT ? `${gateFindings(scanned).length} salesman gate finding(s)` : 'salesman gate not applied';
    info.annotations.push({
      type: 'a11y-summary',
      description:
        `${project}: ${scanned.length}/${Object.keys(A11Y_PAGES).length} pages scanned; ${rules.size} rule(s) broken on ` +
        `${scanned.filter((s) => s.violations.length > 0).length} page(s); nodes ${byImpact}; ${gate}; ` +
        `${backofficeFindings(scanned).length} back-office gate finding(s). ` +
        `Run summary: ${path.relative(process.cwd(), SUMMARY_FILE)}`,
    });
    expect(scans.length, `${path.basename(SUMMARY_FILE)} holds this run's ${project} scans`).toBeGreaterThan(0);
  });

  test(`the gate: no ${GATE_IMPACT} unlabeled field or nameless button on the salesman’s phone screens`, async () => {
    test.skip(test.info().project.name !== GATE_PROJECT, `the gate holds on the ${GATE_PROJECT} project; the desktop scans are report only`);
    const scans = await projectScans(GATE_PROJECT);
    const missing = GATED_PAGES.filter((k) => !scans.some((s) => s.key === k && !s.error)).map((k) => A11Y_PAGES[k].label);
    expect.soft(missing, 'salesman screens not scanned on the phone (see the salesman test)').toEqual([]);
    expect(
      gateFindings(scans).map(describeFinding),
      `${GATE_IMPACT} ${Object.keys(GATE_RULES).join(' / ')} violations on the salesman’s phone screens (must not ship)`
    ).toEqual([]);
  });

  test('the back-office gate: no critical or serious violation on the Manager’s and the Steward’s screens', async () => {
    const project = test.info().project.name;
    const scans = await projectScans(project);
    const missing = BACKOFFICE_PAGES.filter((k) => !scans.some((s) => s.key === k && !s.error)).map((k) => A11Y_PAGES[k].label);
    expect.soft(missing, `back-office screens not scanned on ${project} (see the Manager’s and the Steward’s tests)`).toEqual([]);
    expect(
      backofficeFindings(scans).map(describeFinding),
      `${BACKOFFICE_GATE_IMPACTS.join(' or ')} violations on the Manager’s and the Steward’s screens (${project}; must not ship)`
    ).toEqual([]);
  });
});
