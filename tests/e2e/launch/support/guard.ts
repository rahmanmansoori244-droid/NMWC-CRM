/**
 * The gate every launch spec opens with, and the per-test hooks.
 *
 * The old playwright.config.ts (testDir tests/e2e) also collects these spec
 * files, so a launch spec must do nothing at module level and must skip unless
 * it runs under playwright.launch.config.ts with RUN_LAUNCH_E2E=1.
 */
import { test } from '@playwright/test';
import { assertNotProduction, launchEnabled } from './env';
import { expectCleanConsole } from './checks';
import { closeTestContexts } from './sessions';

/**
 * Call first inside every launch test.describe(): skips the describe unless
 * RUN_LAUNCH_E2E=1 under the launch config, and refuses a production database.
 */
export function requireLaunchEnv(): void {
  test.skip(
    !launchEnabled(),
    'launch e2e: run with RUN_LAUNCH_E2E=1 and -c playwright.launch.config.ts (see tests/e2e/launch/README.md)'
  );
  if (launchEnabled()) assertNotProduction();
}

/**
 * After each test: fail on page errors / hydration / CSP refusals (an OPEN known
 * bug's allow-listed error excepted — none is open on the launch build), then
 * close every context contextAs() opened.
 */
export function installLaunchHooks(): void {
  test.afterEach(async () => {
    try {
      expectCleanConsole();
    } finally {
      await closeTestContexts();
    }
  });
}
