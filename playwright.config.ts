import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'html',
  // The go-live browser walk drives a `next dev` server (first-hit compiles
  // take tens of seconds per route) against a remote DB.
  timeout: 300_000,
  // A cold `next dev` route (first hit after start, machine under load) can take
  // well over a minute to compile before the router can even redirect.
  expect: { timeout: 120_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    // E2E_CHROMIUM: reuse an already-installed Chromium build (this machine has
    // a newer ms-playwright revision than the pinned @playwright/test expects).
    launchOptions: process.env.E2E_CHROMIUM
      ? { executablePath: process.env.E2E_CHROMIUM }
      : undefined,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run dev', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 120_000 },
});
