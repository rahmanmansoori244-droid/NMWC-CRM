import { test, expect } from '@playwright/test';

test('login page loads with NMWC branding', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'NMWC' })).toBeVisible();
  await expect(page.getByText('Customer Master')).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
});

test('health endpoint returns ok', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  // DO-02/UAT-03: this asserted body.service === 'nmwc-cm', a field the anonymous
  // probe has never returned. The test passed only because Playwright was never
  // run in CI. The anonymous response is deliberately minimal — status and
  // nothing else — so that is what it checks (B-12; app/api/health/route.ts).
  expect(Object.keys(body)).toEqual(['status']);
});

test('root redirects to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('the document response carries one CSP, with the SEC-14b directives', async ({ request }) => {
  // The unit test pins what buildCsp() produces. This pins what actually reaches
  // a browser, which is the part no unit test can see: exactly ONE
  // Content-Security-Policy header (middleware sets one and next.config's
  // headers() supplies a fallback, and two would be intersected), and the nonce
  // still present in script-src.
  //
  // Not run in CI — Playwright needs a server. Run it during the browser walk.
  const res = await request.get('/login');
  expect(res.status()).toBe(200);

  const all = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'content-security-policy');
  expect(all).toHaveLength(1);

  const csp = all[0]!.value;
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("object-src 'none'");
  // Not anchored: `next dev` appends 'unsafe-eval' to this directive.
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
});
