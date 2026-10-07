/**
 * Launch e2e: pure helpers with no env snapshot. playwright.launch.config.ts
 * imports only this file (and ids.ts, clock.ts): env.ts and oman.ts read the
 * run-wide variables once at import, and the config sets those variables first.
 *
 * Never print an env value. redact() exists for error messages that might carry
 * one (a Prisma P1001 names the database host).
 */
import fs from 'node:fs';
import path from 'node:path';

/** The production Neon endpoint. Any URL containing it aborts the run. */
export const PROD_MARKER = 'ep-sweet-haze';

/** The repository root (this file is tests/e2e/launch/support/base.ts). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Crash registry and server logs. OUTSIDE every Playwright outputDir on purpose:
 * Playwright deletes a project's outputDir at the start of each run, and the old
 * config's outputDir is the whole of test-results/.
 */
export const STATE_DIR = path.join(REPO_ROOT, '.e2e-launch');
export const REGISTRY_DIR = path.join(STATE_DIR, 'registry');

/** Throws when any database URL points at production, or the checkout is the production clone. */
export function assertNotProduction(): void {
  for (const k of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if ((process.env[k] ?? '').includes(PROD_MARKER)) {
      throw new Error(`ABORT: ${k} points at the PRODUCTION database. The launch suite runs on UAT only.`);
    }
  }
  // The Desktop clone's .env is production's (see the handover notes).
  const root = REPO_ROOT.replace(/\\/g, '/').toLowerCase();
  if (root.includes('onedrive/desktop/nmwc-crm')) {
    throw new Error('ABORT: this checkout is the Desktop clone, whose .env is PRODUCTION.');
  }
}

/** The env values that must never reach a log, a report or an error message. */
const SECRET_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CRON_SECRET',
  'HEALTH_BEARER',
  'SEED_ADMIN_PASSWORD',
  'NMWC_APP_URL',
];

/** Remove env values, database URLs and hosts from a message before it is shown. */
export function redact(message: string): string {
  let out = message;
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 6) out = out.split(v).join(`<${k}>`);
    if (v && /^postgres(ql)?:\/\//.test(v)) {
      try {
        const u = new URL(v);
        if (u.hostname) out = out.split(u.hostname).join('<db-host>');
        if (u.password) out = out.split(u.password).join('<db-password>');
        if (u.username) out = out.split(`${u.username}:`).join('<db-user>:');
      } catch {
        /* not a URL */
      }
    }
  }
  return out
    .replace(/postgres(ql)?:\/\/\S+/g, '<db-url>')
    .replace(/[a-z0-9-]+(\.[a-z0-9-]+)*\.neon\.tech(:\d+)?/gi, '<db-host>')
    .replace(/[a-f0-9]{32}\.r2\.cloudflarestorage\.com/gi, '<r2-endpoint>');
}

/** An Error whose message has been through redact(), keeping the Prisma code if any. */
export function safeError(err: unknown, context?: string): Error {
  const e = err as { message?: string; code?: string };
  const msg = redact(String(e?.message ?? err));
  const code = e?.code ? ` [${e.code}]` : '';
  return new Error(`${context ? `${context}: ` : ''}${msg}${code}`);
}

/** The URL with query parameters set, for connection limits. Never logged. */
export function withDbParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Chromium for the launch suite. The bundled revision of the pinned
 * @playwright/test may be missing on this PC, and the full chrome.exe of the
 * older install is not runnable here, so: E2E_CHROMIUM when set, else the newest
 * installed headless shell, else Playwright's default.
 */
export function chromiumExecutable(): string | undefined {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'ms-playwright')
      : undefined);
  if (!base || !fs.existsSync(base)) return undefined;
  const shells = fs
    .readdirSync(base)
    .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of shells) {
    const exe =
      process.platform === 'win32'
        ? path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
        : path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
