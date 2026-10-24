/**
 * LAUNCH E2E — the customer's History page (docs/HISTORY.md §11), as the Data
 * Steward reads it: after a change made in the app on a fixture customer, the
 * page shows it with the right actor, cause and dates, the routes that served
 * the customer with the salesman of each stretch, and how it was created; a
 * personal value the change set is nowhere on the page. Steward only: a Manager
 * is sent home, and his customer page has no History link.
 *
 * One world, desktop project. Written for the launch suite and listed with
 * `--list`; it needs the UAT database and a production build to run:
 *
 *   RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts customer-history --project=desktop
 */
import { expect, test, type Page } from '@playwright/test';
import {
  RUN_ID,
  contextAs,
  db,
  homePathFor,
  installLaunchHooks,
  receiptEditId,
  requireLaunchEnv,
  standardWorld,
  submitEnrichViaApi,
  type World,
} from './support';
import { omanDate, omanDateTime } from '../../../lib/tz';

const pathOf = (page: Page) => new URL(page.url()).pathname;

test.describe('customer history', { tag: ['@desktop'] }, () => {
  requireLaunchEnv();
  installLaunchHooks();
  test.describe.configure({ mode: 'serial' });

  let w: World;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    w = await standardWorld('hist', {
      customers: [{ key: 'HIST', phone: true, contact: 'Initial Contact', branches: [{ key: 'S', route: 'A', day: 'SUN' }] }],
    });
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await w?.cleanup();
  });

  test("the Steward's change is on the History page: who, when, what, why — and no personal value", async ({ browser }) => {
    test.setTimeout(240_000);
    const stw = w.user('STW');
    const sa = w.user('SA');
    const c = w.customer('HIST');
    const shop = c.branch;
    const contact = w.name('History contact');

    const page = await (await contextAs(browser, stw, { device: 'desktop' })).newPage();
    await page.goto('/import');
    const sent = await submitEnrichViaApi(
      page,
      { customerId: c.id, customer: { contactPerson: contact }, branches: [{ branchId: shop.id, dayOfVisit: 'TUE' }] },
      { world: w }
    );
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, data: { state: 'APPROVED' } });
    const editId = receiptEditId(sent)!;
    expect(editId).toBeTruthy();

    // What the database recorded for that change, and the shop's first row.
    const [customerRow] = await db.customerHistory.findMany({ where: { customerId: c.id, source: `edit:${editId}` } });
    const [shopRow] = await db.branchHistory.findMany({ where: { branchId: shop.id, source: `edit:${editId}` } });
    expect(customerRow?.changedFields).toEqual(['contactPerson']);
    expect(shopRow?.changedFields).toEqual(['dayOfVisit']);
    const shopFirst = await db.branchHistory.findFirstOrThrow({
      where: { branchId: shop.id },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    });
    const birth = await db.customerHistory.findFirstOrThrow({
      where: { customerId: c.id },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    });

    await page.goto(`/customers/${c.id}`);
    await page.getByRole('link', { name: 'History', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}/history$`));
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();

    // The newest change: the Steward's direct write, customer and shop in one entry.
    const first = page.getByRole('list', { name: 'Changes' }).getByRole('listitem').first();
    await expect(first).toContainText(`${stw.fullName} (Data Steward)`);
    await expect(first).toContainText(omanDateTime(customerRow!.validFrom));
    await expect(first).not.toContainText('recorded');
    await expect(first).toContainText('Contact person: changed');
    await expect(first).toContainText('Day of visit: Sunday → Tuesday');
    // A direct write has no CustomerEdit audit row: its ledger row is the customer's UPDATE.
    await expect(first.getByRole('link', { name: /Direct change by/ })).toHaveAttribute(
      'href',
      `/audit?entityType=Customer&q=${encodeURIComponent(c.id)}`
    );
    // The value the change set is not on the page: the history records the name only.
    await expect(page.getByRole('main')).not.toContainText(contact);

    const routes = page.getByRole('region', { name: 'Routes that served this customer' });
    const list = routes.getByRole('list', { name: `Routes of shop ${shop.code}` });
    await expect(list).toContainText(w.route('A').code);
    await expect(list).toContainText(sa.fullName);
    await expect(list).toContainText(`${omanDate(shopFirst.validFrom)} – now`);

    const created = page.getByRole('region', { name: 'Created' });
    await expect(created).toContainText(`e2e:${RUN_ID}`);
    await expect(created).toContainText(omanDateTime(birth.validFrom));

    await expect(page.getByRole('region', { name: 'Terms over time' })).toContainText('Cash');
  });

  test("one shop's view lists that shop only", async ({ browser }) => {
    const c = w.customer('HIST');
    const shop = c.branch;
    const page = await (await contextAs(browser, w.user('STW'), { device: 'desktop' })).newPage();
    await page.goto(`/customers/${c.id}`);
    await page.getByRole('link', { name: `Shop history: ${shop.code}` }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${c.id}/history\\?shop=${shop.id}$`));
    const routes = page.getByRole('region', { name: 'Routes that served this shop' });
    await expect(routes.getByRole('list', { name: /^Routes of shop / })).toHaveCount(1);
    await expect(routes.getByRole('list', { name: `Routes of shop ${shop.code}` })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Terms over time' })).toHaveCount(0);
    for (const item of await page.getByRole('list', { name: 'Changes' }).getByRole('listitem').all()) {
      await expect(item).not.toContainText('Customer —');
    }
    const picker = page.getByRole('navigation', { name: 'Shops' });
    await expect(picker.getByRole('link', { name: new RegExp(shop.code) })).toHaveAttribute('aria-current', 'page');
    await expect(picker.getByRole('link', { name: 'All shops' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('a Manager is sent home from it, and his customer page has no History link', async ({ browser }) => {
    const m1 = w.user('M1');
    const c = w.customer('HIST');
    const page = await (await contextAs(browser, m1, { device: 'desktop' })).newPage();
    await page.goto(`/customers/${c.id}/history`);
    await expect.poll(() => pathOf(page), { message: 'M1 ends on his home page', timeout: 30_000 }).toBe(homePathFor(m1.role));
    await page.goto(`/customers/${c.id}`);
    await expect(page.getByRole('heading', { level: 1, name: c.legalName })).toBeVisible();
    await expect(page.getByRole('link', { name: 'History', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Shop history/ })).toHaveCount(0);
  });
});
