/**
 * Captures every screenshot used by the user-guide PDF.
 *
 * Logs in as each role on the live app, navigates to the key screens, and
 * saves PNG screenshots to docs/guide/img/. Mobile-emulating viewport
 * (390 × 844, iPhone 14 Pro size) so the guide reflects what salesmen
 * actually see on their phones.
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://nmwc-cm.vercel.app';
const OUT = 'docs/guide/img';

const SALES = { username: 'c1-12345-nmwc', password: 'C1-12345-NMWC' };
const SUP = { username: 'ahmed.alndabi', password: 'Ahmed-NMWC-2026!' };
const MGR = { username: 'pilot.manager', password: 'Manager-NMWC-2026!' };

// Known customer on c1's route for the screenshots.
const DEMO_CUSTOMER_ID = 'cmozfay5m0003tvfkupla658l';

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  // If we're already redirected away from /login (existing session), force
  // logout via cookie wipe and try again.
  if (!page.url().endsWith('/login')) {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  }
  await page.fill('input[name=username]', u.username);
  await page.fill('input[name=password]', u.password);
  await Promise.all([
    page.waitForURL((url) => !url.toString().endsWith('/login'), { timeout: 15000 }).catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
  // Sanity: confirm we're not stuck on /login (failed login leaves us there).
  if (page.url().endsWith('/login')) {
    // Could be rate-limited from prior runs. Wait a bit and try once more.
    console.warn(`  ⚠ login retry for ${u.username} after 70s wait (rate limit?)`);
    await page.waitForTimeout(70_000);
    await page.fill('input[name=username]', u.username);
    await page.fill('input[name=password]', u.password);
    await Promise.all([
      page.waitForURL((url) => !url.toString().endsWith('/login'), { timeout: 15000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
    if (page.url().endsWith('/login')) {
      throw new Error(`Login failed for ${u.username} — still on /login after retry`);
    }
  }
}

async function logout(page: Page) {
  // Click the sign-out button if present, then nuke cookies for a fully
  // clean state. Without the cookie wipe, Auth.js sometimes hands the next
  // login a stale JWT and the redirect goes to /home instead of completing
  // the new auth flow — leaving the page on the public login form which we
  // then mistakenly screenshot as if we'd captured an authed page.
  const signOut = page.getByRole('button', { name: /sign out/i }).first();
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await page.context().clearCookies();
}

async function shot(page: Page, name: string) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  → ${path}`);
}

async function shotFull(page: Page, name: string) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`  → ${path}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  // Mobile-style viewport so the guide reflects field-use reality.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  // ---- 1. LOGIN PAGE (everyone sees this) ----
  console.log('● Login page (no auth)');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '01-login');

  // ---- 2. SALESMAN ----
  console.log('\n● Salesman screens (c1-12345-nmwc)');
  await login(page, SALES);
  await page.waitForTimeout(800);

  await page.goto(`${BASE}/today`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '02-salesman-today');

  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '03-salesman-customers-list');

  // Demo customer profile + enrichment form
  await page.goto(`${BASE}/customers/${DEMO_CUSTOMER_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '04-salesman-customer-profile');
  // Scroll to show branch tile + photos
  await page.evaluate(() => window.scrollTo(0, 350));
  await page.waitForTimeout(400);
  await shot(page, '04b-salesman-customer-branch');

  await page.goto(`${BASE}/customers/${DEMO_CUSTOMER_ID}/edit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, '05-salesman-enrichment-top');
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(400);
  await shot(page, '06-salesman-enrichment-photos');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  await shot(page, '07-salesman-enrichment-bottom');

  await logout(page);

  // ---- 3. SUPERVISOR ----
  console.log('\n● Supervisor screens (ahmed.alndabi)');
  await login(page, SUP);
  await page.waitForTimeout(800);

  await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '08-supervisor-approvals-queue');

  // Try the most-recently-seeded edit. Look up its id by querying the bulk
  // queue's `<a href="/approvals/...">` links rather than guessing markup.
  const approvalHref = await page
    .evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href^="/approvals/"]')).find(
        (el) => /^\/approvals\/[a-z0-9]+$/.test((el as HTMLAnchorElement).getAttribute('href') ?? '')
      );
      return a ? (a as HTMLAnchorElement).getAttribute('href') : null;
    })
    .catch(() => null);
  if (approvalHref) {
    await page.goto(`${BASE}${approvalHref}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await shot(page, '09-supervisor-approval-diff');
  } else {
    console.warn('  ⚠ no approval link found — diff page skipped');
  }

  await logout(page);

  // ---- 4. MANAGER ----
  console.log('\n● Manager screens (pilot.manager)');
  await login(page, MGR);
  await page.waitForTimeout(800);

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, '10-manager-dashboard');

  await page.goto(`${BASE}/reactivations`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '11-manager-reactivations');

  await page.goto(`${BASE}/users`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '12-manager-users');

  await browser.close();
  console.log('\nAll screenshots saved to', OUT);
}

main().catch((err) => {
  console.error('capture failed:', err);
  process.exit(1);
});
