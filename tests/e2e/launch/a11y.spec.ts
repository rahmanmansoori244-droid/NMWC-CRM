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
 *   Manager    the approvals queue and a review page (a seeded request waits on
 *              him), reactivations (a real one, when R2 is configured), dashboard;
 *   Steward    users, import, Temix.
 *
 * LAUNCH POLICY — REPORT ONLY. Each scan's axe JSON is attached to its test,
 * each test is annotated with what axe found, and the run's summary (rule,
 * impact, count, page; per project) is written to the report and to
 * test-results/launch-a11y-summary.json. A violation fails nothing, with ONE
 * exception, the last test: on the phone project, a `critical` violation of
 *
 *   label · select-name · button-name · input-button-name
 *
 * (a form field or a button with no accessible name) on one of the salesman's
 * screens. These make a control unusable rather than harder — TalkBack says
 * "edit box" / "button", voice control cannot reach it, nothing says which box
 * takes the phone number — and they are deterministic DOM checks that do not
 * flake; the app already labels its fields (UAT-07), so a hit is a regression.
 * The reasons are written per rule in support/a11y-helpers.ts (GATE_RULES) and
 * into the summary file. A page that cannot be reached or scanned fails its
 * test (after the other pages of that test have been scanned): that is a broken
 * page or fixture, not a finding.
 *
 * Nothing here types a password, so no scanned DOM holds one.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts a11y --project=phone --project=desktop
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import {
  contextAs,
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
import {
  A11Y_PAGES,
  GATE_IMPACT,
  GATE_PROJECT,
  GATE_RULES,
  GATED_PAGES,
  SUMMARY_FILE,
  a11yScans,
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
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    if (world) await world.cleanup();
  });

  test('the Manager’s screens: approvals queue, a review page, reactivations, dashboard (report only)', async ({ browser }) => {
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

    await scans.page('review', async () => {
      await page.goto(`/approvals/${pendingId}`);
      await expect(page.getByRole('button', { name: /^✓ Approve$/ })).toBeVisible();
      await scanPage(page, 'review', { heading: full.legalName });
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

    scans.done();
  });

  test('the Steward’s screens: users, import, Temix (report only)', async ({ browser }) => {
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

  test('the salesman’s screens, from sign-in to notifications (report; the phone gate is the last test)', async ({ browser }) => {
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
      // React #418 on this page is a known, allow-listed bug (KNOWN_BUGS.notificationsHydration).
      await page.goto('/notifications');
      await expect(page.getByText(world.name('Sent back for correction')).first()).toBeVisible();
      await scanPage(page, 'notifications', { heading: 'Notifications' });
    });

    scans.done();
  });
});

test.describe('a11y report: the summary and the salesman’s phone gate', { tag: ['@phone', '@desktop'] }, () => {
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
    const gate = project === GATE_PROJECT ? `${gateFindings(scanned).length} gate finding(s)` : 'not gated (report only)';
    info.annotations.push({
      type: 'a11y-summary',
      description:
        `${project}: ${scanned.length}/${Object.keys(A11Y_PAGES).length} pages scanned; ${rules.size} rule(s) broken on ` +
        `${scanned.filter((s) => s.violations.length > 0).length} page(s); nodes ${byImpact}; ${gate}. ` +
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
});
