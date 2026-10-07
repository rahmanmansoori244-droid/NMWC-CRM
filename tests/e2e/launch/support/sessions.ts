/**
 * Sessions: minted cookies, real sign-in through the page and the API, and
 * browser contexts per device.
 *
 * Default: a MINTED session cookie — Auth.js's own encode() with the server's
 * secret and salt = the cookie name. It costs no login token and writes no
 * LOGIN row. global-setup proves, separately, that (1) a UI sign-in, (2) a
 * minted cookie and (3) page.request with that cookie all work against the
 * running server, and records the answers in E2E_MINT_OK / E2E_PAGE_REQUEST_OK;
 * contextAs() falls back to a real UI sign-in when minting was not proven.
 *
 * Pitfall avoided: a cookie added with `url: 'http://…'` gets secure=false from
 * Playwright, and Chromium silently refuses a non-Secure `__Host-` cookie. The
 * cookie is therefore added with domain 'localhost', path '/', secure, httpOnly
 * and no url.
 */
import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Cookie,
  type Page,
  type Route,
} from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { BASE_URL, db, SESSION_COOKIE } from './env';
import { cspListenerScript, watchPage } from './checks';
import { assertOmanDayUnchanged } from './oman';
import { HOME_BY_ROLE } from '../../../../lib/role-home';
import type { DeviceKind, FixtureUser } from './types';

export { HOME_BY_ROLE };
export const MUSCAT_GEO = { latitude: 23.5881, longitude: 58.3829, accuracy: 9 };
const SESSION_MAX_AGE_S = 8 * 60 * 60; // auth.config.ts session.maxAge

/** Context options per device. Every context: Asia/Muscat, en-GB. */
export function deviceOptions(kind: DeviceKind): BrowserContextOptions {
  const base: BrowserContextOptions = { timezoneId: 'Asia/Muscat', locale: 'en-GB', baseURL: BASE_URL };
  switch (kind) {
    case 'phone':
      return {
        ...devices['Pixel 5'],
        ...base,
        viewport: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
        geolocation: MUSCAT_GEO,
        permissions: ['geolocation'],
      };
    case 'phone360':
      return {
        ...devices['Pixel 5'],
        ...base,
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
        geolocation: MUSCAT_GEO,
        permissions: ['geolocation'],
      };
    case 'tablet':
      return { ...devices['Desktop Chrome'], ...base, viewport: { width: 768, height: 1024 }, hasTouch: true };
    case 'desktop':
      return { ...devices['Desktop Chrome'], ...base, viewport: { width: 1280, height: 800 } };
  }
}

/** The device of the running project: 'phone' for the phone project, else desktop. */
export function projectDevice(): DeviceKind {
  try {
    return test.info().project.name === 'phone' ? 'phone' : 'desktop';
  } catch {
    return 'desktop';
  }
}

/** The landing page of a role, as lib/role-home.ts sends it. */
export function homePathFor(role: FixtureUser['role']): string {
  return HOME_BY_ROLE[role] as string;
}

/** Whether global-setup proved minted cookies work on this server. */
export function mintingProven(): boolean {
  return process.env.E2E_MINT_OK === '1';
}

/**
 * A session cookie for `u`, encoded exactly as Auth.js encodes its own.
 * `lastCheck: 0` forces the server's freshness re-read on the next request
 * (revocation tests; they then wait out the 30 s per-instance cache).
 */
export async function mintSessionCookie(
  u: Pick<FixtureUser, 'id' | 'role' | 'username' | 'fullName' | 'mustChangePassword'>,
  o: { iatMs?: number; lastCheck?: number; mustChangePassword?: boolean } = {}
): Promise<Cookie> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET / NEXTAUTH_SECRET is not set (run through scripts/qa/run-with-env.mjs)');
  const now = Date.now();
  const value = await encode({
    secret,
    salt: SESSION_COOKIE,
    maxAge: SESSION_MAX_AGE_S,
    token: {
      sub: u.id,
      name: u.fullName,
      userId: u.id,
      role: u.role,
      username: u.username,
      iatMs: o.iatMs ?? now,
      lastCheck: o.lastCheck ?? now,
      mustChangePassword: o.mustChangePassword ?? u.mustChangePassword,
    },
  });
  return {
    name: SESSION_COOKIE,
    value,
    domain: 'localhost',
    path: '/',
    expires: Math.floor(now / 1000) + SESSION_MAX_AGE_S,
    httpOnly: true,
    secure: SESSION_COOKIE.startsWith('__Host-'),
    sameSite: 'Lax',
  };
}

const openContexts = new Map<string, BrowserContext[]>();

function currentTestId(): string {
  try {
    return test.info().testId;
  } catch {
    return 'outside-test';
  }
}

/** Closes every context contextAs() opened for the current test. */
export async function closeTestContexts(): Promise<void> {
  const id = currentTestId();
  const list = openContexts.get(id) ?? [];
  openContexts.delete(id);
  await Promise.all(list.map((c) => c.close().catch(() => undefined)));
}

/**
 * A browser context signed in as `u` (null = anonymous), for one device. Every
 * page it opens is watched for page errors, hydration errors and CSP refusals
 * (checks.ts). Minted cookie by default; `auth: 'ui'` signs in through the page.
 */
export async function contextAs(
  browser: Browser,
  u: FixtureUser | null,
  o: {
    device?: DeviceKind;
    geolocation?: { latitude: number; longitude: number; accuracy: number } | null;
    lastCheck?: number;
    auth?: 'mint' | 'ui';
    ip?: string;
    extra?: BrowserContextOptions;
  } = {}
): Promise<BrowserContext> {
  assertOmanDayUnchanged();
  const device = o.device ?? projectDevice();
  const opts: BrowserContextOptions = { ...deviceOptions(device), ...o.extra };
  if (o.geolocation === null) {
    delete opts.geolocation;
    opts.permissions = (opts.permissions ?? []).filter((p) => p !== 'geolocation');
  } else if (o.geolocation) {
    opts.geolocation = o.geolocation;
    opts.permissions = [...new Set([...(opts.permissions ?? []), 'geolocation'])];
  }
  const ctx = await browser.newContext(opts);
  const id = currentTestId();
  openContexts.set(id, [...(openContexts.get(id) ?? []), ctx]);
  await ctx.addInitScript(cspListenerScript);
  ctx.on('page', (p) => watchPage(p, { testId: id, locale: opts.locale }));
  if (u) {
    const mode = o.auth ?? (mintingProven() ? 'mint' : 'ui');
    if (mode === 'mint') {
      await ctx.addCookies([await mintSessionCookie(u, { lastCheck: o.lastCheck })]);
    } else {
      const page = await ctx.newPage();
      await signInViaUi(page, u.username, u.password, { ip: o.ip });
      await expect(page).not.toHaveURL(/\/login(\?|$)/);
      await page.close();
    }
  }
  return ctx;
}

/**
 * Signs in through the real login page. The x-forwarded-for of the sign-in POST
 * only is set to `ip` (a context-wide header would also reach the cross-origin
 * R2 PUT and break its CORS preflight). Waits for the hydration marker first: a
 * pre-hydration submit would be a native GET carrying the password in the URL.
 */
export async function signInViaUi(
  page: Page,
  username: string,
  password: string,
  o: { ip?: string; expectUrl?: RegExp } = {}
): Promise<void> {
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() === 'POST' && o.ip) {
      await route.continue({ headers: { ...req.headers(), 'x-forwarded-for': o.ip } });
    } else {
      await route.continue();
    }
  };
  if (o.ip) await page.route('**/login', handler);
  try {
    await page.goto('/login');
    await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    // Either the app navigates away from /login, or the form shows its refusal.
    await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 }),
      page.getByRole('alert').waitFor({ timeout: 60_000 }),
    ]);
    if (o.expectUrl) await expect(page).toHaveURL(o.expectUrl);
  } finally {
    if (o.ip) await page.unroute('**/login', handler).catch(() => undefined);
  }
}

/**
 * Signs in through Auth.js's own endpoint (/api/auth/callback/credentials), as a
 * script would. Use a FRESH request context: `request.newContext()`.
 */
export async function apiSignIn(
  request: APIRequestContext,
  username: string,
  password: string,
  o: { ip?: string } = {}
): Promise<{ status: number; signedIn: boolean; error: string | null }> {
  const headers: Record<string, string> = o.ip ? { 'x-forwarded-for': o.ip } : {};
  const csrf = await request.get(`${BASE_URL}/api/auth/csrf`, { headers });
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const res = await request.post(`${BASE_URL}/api/auth/callback/credentials`, {
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    form: { username, password, csrfToken, callbackUrl: `${BASE_URL}/home` },
    maxRedirects: 0,
  });
  const location = res.headers()['location'] ?? '';
  const setCookie = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value)
    .join('\n');
  const signedIn = setCookie.includes(`${SESSION_COOKIE}=`) && !/error=/.test(location);
  const error = /error=([^&]+)/.exec(location)?.[1] ?? null;
  return { status: res.status(), signedIn, error: error ? decodeURIComponent(error) : null };
}

/**
 * A GET as the page's signed-in user. Uses page.request when global-setup proved
 * it carries the session cookie (E2E_PAGE_REQUEST_OK), else fetch() inside the
 * page (which must already be on BASE_URL).
 */
export async function fetchAs(page: Page, url: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  if (process.env.E2E_PAGE_REQUEST_OK === '1') {
    const res = await page.request.get(url);
    return { status: res.status(), headers: res.headers(), body: await res.body() };
  }
  if (!page.url().startsWith(BASE_URL)) await page.goto('/home');
  const out = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'same-origin' });
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    return { status: r.status, headers, b64: btoa(bin) };
  }, url);
  return { status: out.status, headers: out.headers, body: Buffer.from(out.b64, 'base64') };
}

/**
 * Changes the password through /profile/change-password (the forced-change
 * page too) and records the new one on the fixture. The session is revoked by
 * the change: the user is sent back to /login.
 */
export async function changePasswordViaUi(page: Page, u: FixtureUser, next: string): Promise<void> {
  if (!/\/profile\/change-password/.test(page.url())) await page.goto('/profile/change-password');
  await page.locator('input[name="currentPassword"]').fill(u.password);
  await page.locator('input[name="newPassword"]').fill(next);
  await page.locator('input[name="confirmNewPassword"]').fill(next);
  await page.getByRole('button', { name: /change password/i }).click();
  await expect(page.getByText(/password changed/i)).toBeVisible();
  u.password = next;
  u.mustChangePassword = false;
}

/**
 * Resets login and form buckets so a test starts with full tokens. Fixture
 * keys only: login:user:<fixture username>, login:ip:<world address>,
 * edit:/photo:<fixture user id>.
 */
export async function resetLimits(o: { users?: FixtureUser[]; ips?: string[] }): Promise<void> {
  const keys = [
    ...(o.users ?? []).flatMap((u) => [`login:user:${u.username}`, `edit:${u.id}`, `photo:${u.id}`]),
    ...(o.ips ?? []).map((ip) => {
      if (!/^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(ip)) throw new Error(`resetLimits: ${ip} is not a test address`);
      return `login:ip:${ip}`;
    }),
  ];
  if (keys.length) await db.rateLimit.deleteMany({ where: { key: { in: keys } } });
}

/** Pre-empties a bucket (tokens 0, refilled now), so the NEXT attempt is refused. */
export async function drainLimit(key: string): Promise<void> {
  if (!/^(login:user:e2e\.|login:user:e2|login:ip:198\.(18|19)\.|edit:c|photo:c)/.test(key)) {
    throw new Error(`drainLimit: ${key} is not a fixture bucket`);
  }
  await db.rateLimit.upsert({
    where: { key },
    create: { key, tokens: 0, lastRefill: new Date() },
    update: { tokens: 0, lastRefill: new Date() },
  });
}
