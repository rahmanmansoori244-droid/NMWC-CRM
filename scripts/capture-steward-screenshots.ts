/**
 * Captures the Data Steward's screenshots for the Steward User Guide.
 * Saves to docs/guide/img/steward-*.png at desktop viewport (1280×800)
 * because stewards work primarily on a laptop, not a phone.
 *
 * It refuses to start without `--expect-host ep-sweet-haze` (owner decisions
 * 2026-10-11): BASE is production.
 *
 * The account comes from the environment, never from this file (owner item 20,
 * 2026-10-11; scripts/lib/guide-accounts.ts). Set GUIDE_STEWARD_USERNAME and
 * GUIDE_STEWARD_PASSWORD in the shell for the one run, then:
 *   npm run guide:capture:steward -- --expect-host ep-sweet-haze
 * A missing variable stops it before Chromium starts.
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LIVE_SITE, liveSiteNamed } from './lib/assert-not-production';
import { guideAccountsFromEnv, type GuideAccount } from './lib/guide-accounts';

// Owner decisions 2026-10-11: BASE is the live site, which is production, so nothing
// starts — no browser, no sign-in, no file written — unless the command line names
// production: `npx tsx scripts/capture-steward-screenshots.ts --expect-host ep-sweet-haze`
// (or `npm run guide:capture:steward -- --expect-host ep-sweet-haze`).
if (!liveSiteNamed('scripts/capture-steward-screenshots.ts')) process.exit(2);

const BASE = LIVE_SITE;
const OUT = 'docs/guide/img';

// Owner item 20 (2026-10-11): no credential is written here. The operator sets
// GUIDE_STEWARD_USERNAME and GUIDE_STEWARD_PASSWORD in the shell for this run only
// (scripts/lib/guide-accounts.ts), read only after the refusal above.
const ACCOUNTS = guideAccountsFromEnv('scripts/capture-steward-screenshots.ts', ['steward']);
if (!ACCOUNTS) process.exit(2);
const { steward: STEWARD } = ACCOUNTS;

async function login(page: Page, u: GuideAccount) {
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
