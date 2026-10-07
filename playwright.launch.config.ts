/**
 * LAUNCH E2E — the full browser suite against a production build of this
 * checkout, served locally on the UAT database (tests/e2e/launch/README.md).
 *
 * The existing playwright.config.ts (login spec, go-live walk, CI) is untouched;
 * this config is used only with `-c playwright.launch.config.ts`.
 *
 *   bash:  RUN_LAUNCH_E2E=1 node scripts/qa/run-with-env.mjs playwright test -c playwright.launch.config.ts --project=phone --project=desktop
 *   then:  … --project=exclusive --workers=1
 *
 * This file runs in the runner AND again in every worker, so run-wide values
 * are set with `??=` (a plain Date.now() would give every worker its own run).
 * It imports only the pure support modules: env.ts / oman.ts read these values
 * once at import, after this file has set them.
 *
 * Secrets stay out of what the run writes: traces are OFF (a trace records every
 * call's parameters, DOM snapshots and the network log — session cookies, typed
 * passwords, the presigned R2 URL), passwords are typed with fillSecret(), and
 * the last reporter scans every launch report, test-results folder and server
 * log, deleting what holds a secret and failing the run (secret-scan-reporter.ts).
 */
import { defineConfig, devices } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { omanDateISO } from './lib/tz';
import {
  assertNotProduction,
  chromiumExecutable,
  redact,
  REPO_ROOT,
  STATE_DIR,
  withDbParams,
} from './tests/e2e/launch/support/base';
import { clockGuard } from './tests/e2e/launch/support/clock';
import { makeRunId } from './tests/e2e/launch/support/ids';
import { holdRunLock } from './tests/e2e/launch/support/runlock';

const enabled = process.env.RUN_LAUNCH_E2E === '1';
const inWorker = process.env.TEST_WORKER_INDEX !== undefined;

function stepFromArgv(argv: string[]): string {
  const a = argv.join(' ');
  const exclusive = /--project[= ]exclusive\b/.test(a);
  const main = /--project[= ](phone|desktop)\b/.test(a);
  return exclusive && main ? 'mixed' : exclusive ? 'exclusive' : 'main';
}

// ── run-wide values, shared by the runner and every worker ───────────────────
process.env.E2E_LAUNCH_CONFIG = '1';
process.env.E2E_RUN_ID ??= makeRunId();
process.env.E2E_RUNNER_PID ??= String(process.pid);
process.env.E2E_OMAN_DATE ??= omanDateISO();
process.env.E2E_STEP ??= stepFromArgv(process.argv);
// Left to the app's defaults on purpose (plan: BULK_BUDGET_MS, RATE_LIMIT_BACKEND unset).
delete process.env.BULK_BUDGET_MS;
delete process.env.RATE_LIMIT_BACKEND;

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;
/**
 * The server listens on IPv4 loopback only: it holds the UAT database URL,
 * AUTH_SECRET and production's R2 keys, and trusts x-forwarded-for — nothing
 * else on the network may reach it. Every client resolves BASE_URL's
 * "localhost" to ::1 and 127.0.0.1 and falls back between them (Chromium and
 * Playwright's own HTTP client alike); global setup proves the page, a minted
 * cookie and page.request all reach it.
 */
const BIND_HOST = '127.0.0.1';
const DEV = process.env.E2E_SERVER === 'dev';
const STEP = process.env.E2E_STEP;
const SERVER_LOG = path.join(STATE_DIR, `server-${STEP}.log`);
const MUSCAT = { latitude: 23.5881, longitude: 58.3829, accuracy: 9 };

assertNotProduction();
if (enabled && !inWorker) {
  preflight();
  // This run's heartbeat: while it is fresh, no other run sweeps our worlds (runlock.ts).
  holdRunLock(process.env.E2E_RUN_ID!);
}

/**
 * Checks that must hold BEFORE the server starts (Playwright starts the
 * webServer before globalSetup). Each failure names its fix.
 */
function preflight(): void {
  const fail = (why: string) => {
    throw new Error(`[launch preflight] ${why}`);
  };
  if (!process.env.DATABASE_URL || !process.env.DIRECT_URL) {
    fail('DATABASE_URL / DIRECT_URL are not set — run through `node scripts/qa/run-with-env.mjs playwright test …`');
  }
  // next start / next dev load these files over .env; run-with-env reads .env only.
  const shadowing = ['.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local'];
  const found = shadowing.filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  if (found.length) fail(`${found.join(', ')} exist in this checkout — the server would read them instead of the UAT .env. Remove them.`);

  const budget = Number(process.env.E2E_RUN_BUDGET_MIN ?? 120);
  const why = clockGuard(new Date(), budget);
  if (why) fail(`refusing to start: ${why}.`);

  if (!DEV) {
    const buildId = path.join(REPO_ROOT, '.next', 'BUILD_ID');
    if (!fs.existsSync(buildId)) {
      fail('no production build — run: NEXT_PUBLIC_SENTRY_DSN= node scripts/qa/run-with-env.mjs next build --no-lint (never `npm run build`: it migrates UAT)');
    }
    const builtAt = fs.statSync(buildId).mtimeMs;
    const newer = newestSource(builtAt);
    if (newer) fail(`the build is older than ${newer} — rebuild (same command as above) so the suite tests this code`);
    // NEXT_PUBLIC_SENTRY_DSN is inlined at BUILD time (client and server bundles):
    // a build made with a DSN would report the suite's deliberate errors to Sentry.
    const inlined = fileWithSentryDsn(path.join(REPO_ROOT, '.next'));
    if (inlined) {
      fail(`the build has a Sentry DSN inlined (${inlined}) — rebuild with NEXT_PUBLIC_SENTRY_DSN empty (same command as above)`);
    }
  }

  // UAT's schema equals this checkout's migrations (read-only: migrate STATUS).
  const status = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'status'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${status.stdout ?? ''}${status.stderr ?? ''}`;
  if (status.status !== 0 || !/Database schema is up to date/.test(out)) {
    const lines = redact(out)
      .split(/\r?\n/)
      .filter((l) => /migration|applied|drift|error/i.test(l) && !/Datasource/.test(l))
      .slice(0, 12);
    fail(`prisma migrate status: UAT does not match this checkout's migrations:\n  ${lines.join('\n  ')}`);
  }

  // The server runs TZ=UTC like Vercel; prove this Node honours TZ on this OS.
  const tz = spawnSync(process.execPath, ['-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  });
  if (!/^(UTC|Etc\/UTC)$/.test(tz.stdout ?? '')) fail(`Node ignored TZ=UTC here (got "${tz.stdout}") — the server would hide UTC defects`);

  // Reference lists (filters, dropdowns) are unstable_cache entries kept on disk
  // across runs; start every run without them.
  fs.rmSync(path.join(REPO_ROOT, '.next', 'cache', 'fetch-cache'), { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/** The first app source file changed after `since`, or null. */
function newestSource(since: number): string | null {
  const roots = ['app', 'components', 'lib', 'services', 'prisma/schema.prisma', 'middleware.ts', 'auth.config.ts', 'next.config.ts', 'instrumentation.ts', 'instrumentation-client.ts', 'package-lock.json'];
  const stack = roots.map((r) => path.join(REPO_ROOT, r)).filter((p) => fs.existsSync(p));
  while (stack.length) {
    const p = stack.pop()!;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
    } else if (st.mtimeMs > since + 1000) {
      return path.relative(REPO_ROOT, p);
    }
  }
  return null;
}

/** The first built .js file (static or server) carrying a Sentry DSN, or null. */
function fileWithSentryDsn(nextDir: string): string | null {
  const DSN = /https?:\/\/[0-9a-f]{32}@[a-z0-9.-]*ingest[a-z0-9.-]*\.sentry\.io\/\d+/i;
  const stack = ['static', 'server'].map((d) => path.join(nextDir, d)).filter((p) => fs.existsSync(p));
  while (stack.length) {
    const p = stack.pop()!;
    if (fs.statSync(p).isDirectory()) {
      for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
    } else if (p.endsWith('.js') && DSN.test(fs.readFileSync(p, 'utf8'))) {
      return path.relative(REPO_ROOT, p);
    }
  }
  return null;
}

/** The server's own pool: sized, with a longer wait, so bulk approvals do not P2024. */
function serverDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) return url;
  return withDbParams(url, {
    connection_limit: process.env.E2E_SERVER_DB_CONNECTIONS ?? '10',
    pool_timeout: '30',
    connect_timeout: '30',
  });
}

const executablePath = chromiumExecutable();
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: './tests/e2e/launch',
  testMatch: /.*\.spec\.ts$/,
  // Per step, so step 2 (exclusive) does not erase step 1's traces and report.
  outputDir: `test-results/launch-${STEP}`,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: Number(process.env.E2E_WORKERS ?? 4),
  timeout: 180_000,
  globalTimeout: 3 * 60 * 60 * 1000,
  expect: { timeout: 20_000 },
  // The secret scan runs last: reporters end in this order, so the HTML report is on disk by then.
  reporter: [
    ['list'],
    ['html', { outputFolder: `playwright-report/launch-${STEP}`, open: 'never' }],
    ['./tests/e2e/launch/support/secret-scan-reporter.ts'],
  ],
  globalSetup: './tests/e2e/launch/support/global-setup.ts',
  globalTeardown: './tests/e2e/launch/support/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    timezoneId: 'Asia/Muscat',
    locale: 'en-GB',
    // OFF, on purpose: every context carries a session cookie and some type a
    // password; a trace would keep both (see the header). Failures keep a
    // screenshot and Playwright's error context.
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  projects: [
    {
      name: 'phone',
      grep: /@phone/,
      grepInvert: /@exclusive/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
        geolocation: MUSCAT,
        permissions: ['geolocation'],
      },
    },
    { name: 'desktop', grep: /@desktop/, grepInvert: /@exclusive/, use: desktop },
    { name: 'exclusive', grep: /@exclusive/, use: desktop },
  ],
  webServer: enabled
    ? {
        // The production server CI uses (E2E_SERVER=dev for authoring). Output goes
        // to .e2e-launch/server-<step>.log, never to the console: a server error
        // can quote a connection string.
        command: `node node_modules/next/dist/bin/next ${DEV ? 'dev' : 'start'} -p ${PORT} -H ${BIND_HOST} > "${SERVER_LOG}" 2>&1`,
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
          TZ: 'UTC',
          AUTH_URL: BASE_URL,
          NEXTAUTH_URL: BASE_URL,
          AUTH_TRUST_HOST: 'true',
          NOTIFY_EMAIL_ENABLED: '',
          EMAIL_REDIRECT_TO: '',
          ALERT_WEBHOOK_URL: '',
          NEXT_PUBLIC_SENTRY_DSN: '',
          MAINTENANCE_MODE: '',
          INSIGHTS_DASHBOARD_DISABLED: '',
          DEMO_ACCOUNTS_DISABLED: 'true',
          NEXT_TELEMETRY_DISABLED: '1',
          DATABASE_URL: serverDatabaseUrl(),
        },
      }
    : undefined,
});
