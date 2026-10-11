/**
 * PRINTOUTS (owner decisions 2026-10-11, part C) — the launch build:
 *
 *   - the CREDIT APPLICATION of a credit new-customer request is printed by the
 *     salesman's Manager at the signed-application step, from the review page's
 *     banner, in a tab of its own; the print is recorded first (a PRINT audit row
 *     on the request, ids only) and the browser's print opens only then
 *     (window.print is stubbed: a headless browser has no print dialog);
 *   - printed, the page shows the sheet and no app chrome; printed without the
 *     button (Ctrl+P), it shows a notice instead of the form;
 *   - a salesman gets the branded 404 on both printouts;
 *   - the FINAL CUSTOMER FORM carries 2 approver boxes for a cash customer and 5
 *     for a credit one, and its print is a PRINT row on the customer.
 *
 * One world, desktop project; the request is seeded at the signed-application
 * step (support/create-chains-helpers.ts seedCreateRequest), which needs R2 for
 * its documents.
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts print --project=desktop
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  auditFor,
  contextAs,
  hasR2,
  installLaunchHooks,
  notRunHere,
  requireLaunchEnv,
  standardWorld,
  type DeviceKind,
  type FixtureUser,
  type World,
} from './support';
import { seedCreateRequest, type SeededCreate } from './support/create-chains-helpers';

const NOT_FOUND_TEXT = "That page doesn't exist or isn't available to your account.";
const BLOCKED_NOTICE = 'This printout was not recorded. Use the Print button on the page so the print is recorded.';

/** window.print, stubbed in every page of the context: it records whether the form was let through. */
async function stubPrint(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const w = window as unknown as { __prints: boolean[] };
    w.__prints = [];
    window.print = () => {
      w.__prints.push(document.documentElement.hasAttribute('data-print-ok'));
    };
  });
}
const printsOf = (page: Page) => page.evaluate(() => (window as unknown as { __prints: boolean[] }).__prints);

async function pageAs(browser: Browser, u: FixtureUser, device: DeviceKind): Promise<Page> {
  const ctx = await contextAs(browser, u, { device });
  await stubPrint(ctx);
  return ctx.newPage();
}

async function expectBranded404(page: Page, what: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: '404', exact: true }), what).toBeVisible();
  await expect(page.getByText(NOT_FOUND_TEXT, { exact: true }), what).toBeVisible();
}

test.describe('printouts', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  let K: SeededCreate | null = null;
  test.beforeAll(async () => {
    w = await standardWorld('pr');
  });
  test.afterAll(async () => {
    await w?.cleanup();
  });

  test('a Manager prints the credit application at the signed-application step: recorded first, then printed', async ({ browser }) => {
    notRunHere(!hasR2, 'the request’s credit documents are seeded in R2');
    K = await seedCreateRequest(w, { submitter: 'SA', paymentTerms: 'CREDIT', step: 2, approvedBy: ['M1', 'SD1'] });
    const m1 = w.user('M1');
    const page = await pageAs(browser, m1, 'desktop');
    await page.goto(`/approvals/${K.id}`);
    const link = page.getByRole('note').getByRole('link', { name: 'Print credit application' });
    await expect(link).toHaveAttribute('target', '_blank');
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
    await expect(tab).toHaveURL(new RegExp(`/print/credit-application/${K.id}$`));
    const sheet = tab.getByRole('article', { name: `Credit Application: ${K.legalName}` });
    await expect(sheet).toContainText('Awaiting customer signature');
    await expect(sheet).toContainText('We/I hereby undertake to indemnify M/S: National Mineral Water Company SAOG');
    await expect(sheet.getByRole('region', { name: /^Customer: / })).toHaveCount(4);
    // Every document is in before the print starts.
    await expect(sheet.getByRole('img', { name: "Owner's ID card" })).toBeVisible();

    const before = (await auditFor({ entityId: K.id, action: 'PRINT' })).length;
    await tab.getByRole('button', { name: 'Print / Save as PDF' }).click();
    await expect.poll(() => printsOf(tab)).toEqual([true]);
    const rows = await auditFor({ entityId: K.id, action: 'PRINT' });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actorId: m1.id,
      entityType: 'CustomerEdit',
      reason: 'credit application printed',
      after: { printout: 'CREDIT_APPLICATION', cycle: 1, stepIndex: 2 },
    });
    // The browser's afterprint ends that one print's permission.
    await tab.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    expect(await tab.evaluate(() => document.documentElement.hasAttribute('data-print-ok'))).toBe(false);
  });

  test('printed, the page is the sheet alone; printed without the button it is the notice', async ({ browser }, testInfo) => {
    notRunHere(!hasR2, 'the request’s credit documents are seeded in R2');
    test.skip(!K, 'needs the seeded request');
    const page = await pageAs(browser, w.user('M1'), 'desktop');
    await page.goto(`/print/credit-application/${K!.id}`);
    const sheet = page.getByRole('article', { name: `Credit Application: ${K!.legalName}` });
    await expect(sheet).toBeVisible();
    // Ctrl+P: no data-print-ok, so the form does not print and the notice does.
    await page.emulateMedia({ media: 'print' });
    await expect(sheet).toBeHidden();
    await expect(page.getByText(BLOCKED_NOTICE, { exact: true })).toBeVisible();
    // Through the button: the sheet, and none of the app around it.
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Print / Save as PDF' }).click();
    await expect.poll(() => printsOf(page)).toEqual([true]);
    await page.emulateMedia({ media: 'print' });
    await expect(sheet).toBeVisible();
    await expect(page.getByText(BLOCKED_NOTICE, { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toBeHidden();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('credit-application-print.png'), fullPage: true });
  });

  test('the salesman gets the branded 404 on both printouts, even of his own request', async ({ browser }) => {
    const sa = w.user('SA');
    const page = await pageAs(browser, sa, 'phone');
    await page.goto(`/print/customer/${w.customer('FULL').id}`);
    await expectBranded404(page, 'customer form');
    if (K) {
      await page.goto(`/print/credit-application/${K.id}`);
      await expectBranded404(page, 'credit application');
    }
    // And no print was recorded on his behalf.
    expect(await auditFor({ actorId: sa.id, action: 'PRINT' })).toEqual([]);
  });

  test('the customer form: 2 approver boxes for a cash customer, 5 for a credit one; its print is a row on the customer', async ({ browser }) => {
    const m1 = w.user('M1');
    const page = await pageAs(browser, m1, 'desktop');
    const cash = w.customer('FULL');
    await page.goto(`/customers/${cash.id}`);
    const link = page.getByRole('link', { name: 'Print customer form' });
    await expect(link).toHaveAttribute('href', `/print/customer/${cash.id}`);
    await page.goto(`/print/customer/${cash.id}`);
    const sheet = page.getByRole('article', { name: `Customer Form: ${cash.legalName}` });
    await expect(sheet).toContainText(cash.code);
    await expect(sheet.getByRole('region', { name: /^Signature: / })).toHaveText([/^Supervisor/, /^Accountant/]);

    const credit = w.customer('CRED');
    await page.goto(`/print/customer/${credit.id}`);
    await expect(page.getByRole('article').getByRole('region', { name: /^Signature: / })).toHaveText([
      /^Supervisor/,
      /^Sales Director/,
      /^Finance Manager/,
      /^GM/,
      /^Accountant/,
    ]);
    // CRED has no photos: nothing to wait for, so the print goes straight through.
    await page.getByRole('button', { name: 'Print / Save as PDF' }).click();
    await expect.poll(() => printsOf(page)).toEqual([true]);
    const rows = await auditFor({ entityId: credit.id, action: 'PRINT' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: m1.id,
      entityType: 'Customer',
      reason: 'customer form printed',
      after: { printout: 'CUSTOMER_FORM', requestId: null, branchIds: [credit.branch.id] },
    });
  });
});
