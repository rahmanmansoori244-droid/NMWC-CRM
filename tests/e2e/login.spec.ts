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
