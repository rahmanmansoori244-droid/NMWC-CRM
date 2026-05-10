/**
 * Captures steward (pilot.steward) screenshots for the Steward User Guide.
 * Saves to docs/guide/img/steward-*.png at desktop viewport (1280×800)
 * because stewards work primarily on a laptop, not a phone.
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://nmwc-cm.vercel.app';
const OUT = 'docs/guide/img';
const STEWARD = { username: 'pilot.steward', password: 'Steward-NMWC-2026!' };

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
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
  if (page.url().endsWith('/login')) {
    await page.waitForTimeout(70_000);
    await page.fill('input[name=username]', u.username);
    await page.fill('input[name=password]', u.password);
    await Promise.all([
      page.waitForURL((url) => !url.toString().endsWith('/login'), { timeout: 15000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
  }
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  console.log(`  → ${name}.png`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.5,
  });
  const page = await context.newPage();

  console.log('● Logging in as steward');
  await login(page, STEWARD);
  await page.waitForTimeout(800);

  console.log('\n● Steward screens (desktop viewport)');

  // Home / dashboard if available
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'steward-01-dashboard');

  // Customers — master data
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 'steward-02-customers');

  // Import
  await page.goto(`${BASE}/import`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 'steward-03-import');

  // Try to capture a batch detail (if any batch exists)
  const batchHref = await page
    .evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href^="/import/"]')).find(
        (el) => /^\/import\/[a-z0-9]+$/.test((el as HTMLAnchorElement).getAttribute('href') ?? '')
      );
      return a ? (a as HTMLAnchorElement).getAttribute('href') : null;
    })
    .catch(() => null);
  if (batchHref) {
    await page.goto(`${BASE}${batchHref}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await shot(page, 'steward-04-import-batch');
  } else {
    console.warn('  ⚠ no import batch link found — batch detail skipped');
  }

  // Export
  await page.goto(`${BASE}/export`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 'steward-05-export');

  // Duplicates
  await page.goto(`${BASE}/duplicates`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 'steward-06-duplicates');

  // Audit log
  await page.goto(`${BASE}/audit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 'steward-07-audit');

  // Routes & regions
  await page.goto(`${BASE}/routes`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'steward-08-routes');

  // Users (steward gets read-only-ish)
  await page.goto(`${BASE}/users`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'steward-09-users');

  await browser.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
