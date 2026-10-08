/**
 * Helpers for tests/e2e/launch/iphone.spec.ts only (the `iphone` project:
 * Playwright WebKit with the iPhone 15 profile). A NEW file on purpose: no
 * shared support module changes, and nothing here runs at import time.
 *
 * Why a context helper of its own: contextAs() picks its device from the
 * project name (sessions.ts projectDevice), and for any project but `phone` that
 * is the 1280 px desktop. iphoneContext() asks contextAs() for that base and
 * lays the iPhone 15 profile over it (viewport 393×659, touch, mobile meta
 * viewport, Safari user agent), with the GPS at Muscat — so every page still
 * gets the harness's watchers, cookie minting and per-test closing.
 *
 * What this Windows WebKit build does (probed without a server, 2026-10-08):
 * canvas.toBlob('image/jpeg') encodes JPEG; a label tap on the hidden camera
 * input opens the file chooser; geolocation honours the emulated accuracy;
 * Intl formats en-GB September as "Sept"; OffscreenCanvas is missing (so
 * media.ts jpegInBrowser cannot run here — cameraJpeg below uses a <canvas>);
 * <input type="date"> falls back to a text box (no date picker to test); an
 * Arabic-Indic digit typed into <input type="number"> leaves value ''.
 *
 * And (run 2026-10-08, production build on http://localhost): this WebKit
 * STORES a Secure cookie that arrives over plain http (addCookies or the
 * server's Set-Cookie) but never SENDS it there, so the production build's
 * Secure __Host- session never reaches the server. When the probe sees that,
 * every iPhone context reaches the app through installCookieBridge() below
 * (requests sent from Node with the context's own cookie store, answers handed
 * back to WebKit with route.fulfill).
 */
import { randomBytes } from 'node:crypto';
import {
  devices,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { BASE_URL, db } from './env';
import { clearSecretFields, contextAs, fillSecret, mintSessionCookie, mintingProven, MUSCAT_GEO } from './sessions';
import type { FixtureUser, World } from './types';

// The app's own words and formats, where the module is plain TypeScript.
export { gpsAccuracyAdvice } from '../../../../lib/gps-accuracy';
export { omanLongDate } from '../../../../lib/tz';
export { UNCONFIRMED_MESSAGE } from '../../../../lib/submission';

/** The iPhone the `iphone` project emulates (present in Playwright 1.63). */
export const IPHONE = devices['iPhone 15'];

/**
 * Whether this worker's iPhone contexts reach the app through the cookie
 * bridge. Set by probeWebKitSession() only: on when WebKit's own cookie
 * store will not carry the session and the bridge does.
 */
let cookieBridge = false;

/**
 * A browser context on the iPhone, signed in as `u` (null = signed out),
 * through contextAs(): minted cookie by default, every page watched, closed
 * after the test. GPS at Muscat (±9 m) with the permission granted, unless
 * `geolocation: null`. With the cookie bridge on (see probeWebKitSession), the
 * bridge is installed BEFORE the session is minted or signed in.
 */
export async function iphoneContext(
  browser: Browser,
  u: FixtureUser | null,
  o: {
    geolocation?: { latitude: number; longitude: number; accuracy: number } | null;
    auth?: 'mint' | 'ui';
    ip?: string;
    extra?: BrowserContextOptions;
  } = {}
): Promise<BrowserContext> {
  const base = {
    device: 'desktop' as const,
    geolocation: o.geolocation === undefined ? MUSCAT_GEO : o.geolocation,
    ip: o.ip,
    extra: { ...IPHONE, ...o.extra },
  };
  if (!cookieBridge) return contextAs(browser, u, { ...base, auth: o.auth });
  const ctx = await contextAs(browser, null, base);
  await installCookieBridge(ctx, o.extra?.extraHTTPHeaders);
  if (u) {
    if ((o.auth ?? (mintingProven() ? 'mint' : 'ui')) === 'mint') {
      await ctx.addCookies([await mintSessionCookie(u)]);
    } else {
      const page = await ctx.newPage();
      await signInOnIphone(page, u.username, u.password, { ip: o.ip });
      await expect(page).not.toHaveURL(/\/login(\?|$)/);
      await page.close();
    }
  }
  return ctx;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/**
 * Request headers the bridge never forwards: the cookie (read from the context's
 * store instead), conditionals (a 304 cannot be handed back), and what the
 * HTTP client sets itself.
 */
const BRIDGE_DROP_REQUEST = new Set([
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'expect',
  'accept-encoding',
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'range',
]);
/** Response headers the bridge never hands WebKit: the body is already decoded and whole, and Set-Cookie is already in the store. */
const BRIDGE_DROP_RESPONSE = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** What the bridge did, as paths and statuses only (no query, no header, no other origin's address): for a failing test's report. */
const bridgeLines: string[] = [];
function trace(line: string): void {
  if (bridgeLines.length < 600) bridgeLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
}
/** The bridge's trace since the last call, emptied. */
export function takeBridgeTrace(): string[] {
  return bridgeLines.splice(0, bridgeLines.length);
}

type SetCookie = { name: string; value: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None'; gone: boolean };

/** One Set-Cookie line, read as a browser would for a host-only cookie of localhost. */
function parseSetCookie(line: string): SetCookie | null {
  const [pair, ...attrs] = line.split(';');
  const eq = pair!.indexOf('=');
  if (eq <= 0) return null;
  const c: SetCookie = {
    name: pair!.slice(0, eq).trim(),
    value: pair!.slice(eq + 1).trim(),
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
    gone: false,
  };
  let maxAge: number | null = null;
  let expiresAt: number | null = null;
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'path' && v.startsWith('/')) c.path = v;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'secure') c.secure = true;
    else if (k === 'samesite') c.sameSite = /^strict$/i.test(v) ? 'Strict' : /^none$/i.test(v) ? 'None' : 'Lax';
    else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (k === 'expires' && !Number.isNaN(Date.parse(v))) expiresAt = Date.parse(v);
  }
  const now = Date.now();
  if (maxAge !== null) {
    c.gone = maxAge <= 0;
    c.expires = Math.floor(now / 1000) + maxAge;
  } else if (expiresAt !== null) {
    c.gone = expiresAt <= now;
    c.expires = Math.floor(expiresAt / 1000);
  }
  return c;
}

/** Applies a response's Set-Cookie lines to the context's store (deletions included). */
async function storeCookies(ctx: BrowserContext, lines: string[]): Promise<void> {
  for (const line of lines) {
    const c = parseSetCookie(line);
    if (!c) continue;
    if (c.gone) {
      await ctx.clearCookies({ name: c.name });
    } else {
      await ctx.addCookies([
        { name: c.name, value: c.value, domain: 'localhost', path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite },
      ]);
    }
  }
}

/**
 * Sends one browser request from Node (fetch), with the context's cookies for
 * the app, and stores what the app sets. `follow`: follow redirects (a
 * fetch/XHR) or stop at the first answer (a page load). Never goes through a
 * Playwright API call, so no report step or call log holds a header.
 */
async function sendFromNode(
  ctx: BrowserContext,
  req: ReturnType<Route['request']>,
  o: { follow: boolean; extraHeaders?: Record<string, string> }
): Promise<{ status: number; headers: Array<[string, string]>; body: Buffer; location: string | null }> {
  const appOrigin = new URL(BASE_URL).origin;
  const sent: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(o.extraHeaders ?? {}), ...req.headers() })) {
    if (!BRIDGE_DROP_REQUEST.has(k.toLowerCase())) sent[k.toLowerCase()] = v;
  }
  let url = req.url();
  let method = req.method();
  let body: Buffer | null = req.postDataBuffer();
  for (let hop = 0; hop <= 20; hop++) {
    const target = new URL(url);
    const own = target.origin === appOrigin;
    const headers: Record<string, string> = own ? { ...sent } : { 'user-agent': sent['user-agent'] ?? '', accept: '*/*' };
    if (own) {
      const jar = await ctx.cookies(url);
      if (jar.length) headers['cookie'] = jar.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' || !body ? undefined : new Uint8Array(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    if (own) await storeCookies(ctx, res.headers.getSetCookie());
    const location = res.headers.get('location');
    trace(`${hop ? '  ↳ ' : ''}${method} ${own ? target.pathname : '(another origin)'} → ${res.status}${location ? ` → ${new URL(location, url).origin === appOrigin ? new URL(location, url).pathname : '(another origin)'}` : ''}`);
    if (!o.follow || !REDIRECT_STATUS.has(res.status) || !location) {
      const headersOut: Array<[string, string]> = [];
      res.headers.forEach((v, k) => {
        if (!BRIDGE_DROP_RESPONSE.has(k.toLowerCase())) headersOut.push([k, v]);
      });
      return { status: res.status, headers: headersOut, body: Buffer.from(await res.arrayBuffer()), location };
    }
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      if (method !== 'HEAD') method = 'GET';
      body = null;
      delete sent['content-type'];
    }
    url = new URL(location, url).toString();
  }
  throw new Error('the bridge followed more than 20 redirects');
}

/**
 * The cookie bridge — a TEST-ENVIRONMENT workaround, not app behaviour. This
 * Windows WebKit stores the production build's Secure __Host- session cookie
 * but never sends it over plain http://localhost (production is https, where
 * it does). Every request to the app (but /_next/static, which needs no
 * cookie) is therefore sent from Node (sendFromNode: the context's own cookie
 * store, read and written through ctx.cookies/addCookies) and its answer
 * handed back to WebKit:
 *   - a page load the server redirects (WebKit cannot be fulfilled with a 3xx)
 *     gets a one-line page that location.replace()s to the target, so the
 *     address bar ends where a browser would;
 *   - a fetch/XHR follows its redirects in Node (the page sees the final
 *     answer, not `redirected`);
 *   - a server action's redirect (303, no Location, x-action-redirect) is
 *     handed over as 200: Next.js reads x-action-redirect, not the status.
 * Not route.fetch: Playwright keeps the call log of a failed API call — every
 * request and response header, the session cookie and a presigned R2 address
 * among them — in the report, which the secret scan then refuses.
 * What WebKit itself still does: rendering, layout, touch, the keyboard, its
 * file chooser, canvas, geolocation, Intl, localStorage and the R2 PUT (not
 * bridged: another origin). What it no longer does: send its own cookie.
 */
export async function installCookieBridge(ctx: BrowserContext, extraHeaders?: Record<string, string>): Promise<void> {
  const origin = new URL(BASE_URL).origin;
  await ctx.route(
    // http(s) only. A blob: URL the page made (blob:http://localhost:3000/<uuid>) has the app's
    // origin too, and WebKit routes it: sent from Node it failed, was aborted, and the photo slot's
    // <img> of the picked file fired onerror ("This phone could not read this photo", run 2026-10-08).
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin && !url.pathname.startsWith('/_next/static/'),
    async (route) => {
      const req = route.request();
      try {
        const nav = req.isNavigationRequest();
        const res = await sendFromNode(ctx, req, { follow: !nav, extraHeaders });
        if (nav && REDIRECT_STATUS.has(res.status) && res.location) {
          const to = new URL(res.location, req.url()).toString();
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><meta charset="utf-8"><title>Redirecting</title><script>location.replace(${JSON.stringify(to)})</script>`,
          });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of res.headers) headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
        await route.fulfill({ status: res.status >= 300 && res.status < 400 ? 200 : res.status, headers, body: res.body });
      } catch (err) {
        // The page or context closed mid-request, or the server dropped it: the page sees a network failure.
        trace(`${req.method()} ${new URL(req.url()).pathname} ✗ ${String((err as Error)?.name ?? 'error')}: ${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 120)}`);
        await route.abort('failed').catch(() => undefined);
      }
    }
  );
}

/**
 * The real login page, as signInViaUi() (sessions.ts) does it, but the sign-in
 * POST's x-forwarded-for is set with route.fallback(), so the POST still goes
 * through the cookie bridge (signInViaUi's route.continue() would send it past
 * the bridge, and WebKit would take the session cookie natively).
 */
export async function signInOnIphone(page: Page, username: string, password: string, o: { ip?: string; expectUrl?: RegExp } = {}): Promise<void> {
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() === 'POST' && o.ip) await route.fallback({ headers: { ...req.headers(), 'x-forwarded-for': o.ip } });
    else await route.fallback();
  };
  if (o.ip) await page.route('**/login', handler);
  try {
    await page.goto('/login');
    await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    await page.getByLabel('Username').fill(username);
    await fillSecret(page.getByLabel('Password'), password);
    await page.getByRole('button', { name: /sign in/i }).click();
    try {
      await Promise.race([
        page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 }),
        page.getByRole('alert').waitFor({ timeout: 60_000 }),
      ]);
    } finally {
      await clearSecretFields(page);
    }
    if (o.expectUrl) await expect(page).toHaveURL(o.expectUrl);
  } finally {
    if (o.ip) await page.unroute('**/login', handler).catch(() => undefined);
  }
}

/** Whether the iPhone contexts of this worker go through installCookieBridge(). */
export function cookieBridgeOn(): boolean {
  return cookieBridge;
}

/** Where a signed-in iPhone lands on /today: the path once the app (not a redirect page) is on screen. */
async function landedOnToday(browser: Browser, u: FixtureUser): Promise<{ ok: boolean; landed: string }> {
  let ctx: BrowserContext | null = null;
  try {
    ctx = await iphoneContext(browser, u);
    const page = await ctx.newPage();
    await page.goto('/today');
    // The bridge's redirect page carries no route announcer; the app's pages do.
    await page.locator('next-route-announcer').waitFor({ state: 'attached', timeout: 60_000 }).catch(() => undefined);
    const landed = new URL(page.url()).pathname;
    return { ok: landed === '/today', landed };
  } catch (err) {
    return { ok: false, landed: `error: ${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 160)}` };
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

/**
 * Whether WebKit keeps a signed-in session on this server. The production
 * build sets a Secure `__Host-` cookie, and the suite serves it over plain
 * http://localhost: Chromium treats localhost as a secure origin for cookies;
 * the first probe says whether this WebKit build does (`raw`). When it does
 * not, the second probe tries the cookie bridge and, when that carries the
 * session, turns it on for every iPhone context of this worker. Never throws.
 */
export async function probeWebKitSession(
  browser: Browser,
  u: FixtureUser
): Promise<{ ok: boolean; landed: string; bridged: boolean; rawLanded: string }> {
  cookieBridge = false;
  const raw = await landedOnToday(browser, u);
  if (raw.ok) return { ok: true, landed: raw.landed, bridged: false, rawLanded: raw.landed };
  cookieBridge = true;
  const bridged = await landedOnToday(browser, u);
  if (!bridged.ok) cookieBridge = false;
  return { ok: bridged.ok, landed: bridged.landed, bridged: bridged.ok, rawLanded: raw.landed };
}

/** Why the iPhone tests cannot run when both probes fail. */
export function webkitSessionNote(landed: string): string {
  return (
    `WebKit did not keep the signed-in session, not even through the cookie bridge (/today landed on ${landed}). ` +
    'This Windows WebKit build does not send the Secure __Host- session cookie over plain http://localhost ' +
    '(production is https). Run the iphone project against a dev server (E2E_SERVER=dev, plain cookie) or an https origin.'
  );
}

/** Why WebKit's own cookie handling is not tested on this machine (the probe needed the bridge). */
export function webkitBridgeNote(rawLanded: string): string {
  return (
    `This Windows WebKit build stores the production build's Secure __Host- session cookie but never sends it over ` +
    `plain http://localhost (/today landed on ${rawLanded}) — a gap of this test machine, not of the app (production is https). ` +
    'The other iPhone tests reach the app through the cookie bridge (iphone-helpers.ts installCookieBridge): ' +
    'WebKit’s own Secure-cookie handling is NOT tested here; run on an https origin to test it.'
  );
}

/** Best-effort wait until the client app is interactive (no network for a moment, the route announcer mounted). */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.locator('next-route-announcer').waitFor({ state: 'attached', timeout: 30_000 }).catch(() => undefined);
}

/** The salesman's bottom tab bar (components/nmwc/Sidebar.tsx MobileTabBar): the only navigation with "Me". */
export function tabBar(page: Page): Locator {
  return page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Me', exact: true }) });
}

/** Whether `el` is on screen and its whole box stands above the tab bar. */
export async function standsAboveTabBar(page: Page, el: Locator): Promise<boolean> {
  const [box, bar] = await Promise.all([el.boundingBox(), tabBar(page).boundingBox()]);
  return !!box && !!bar && box.y >= 0 && box.y + box.height <= bar.y + 0.5;
}

/** Scrolls the window to the middle or the end of the page. */
export async function scrollPage(page: Page, where: 'middle' | 'end'): Promise<void> {
  await page.evaluate((w) => {
    const h = document.documentElement.scrollHeight;
    window.scrollTo(0, w === 'end' ? h : h / 2);
  }, where);
}

/** The "Cannot submit yet — missing: …" box of a field form, or '' when there is none. */
export async function missingText(page: Page): Promise<string> {
  const box = page.getByText('Cannot submit yet — missing:', { exact: true }).locator('xpath=..');
  return (await box.count()) ? (await box.innerText()).replace(/\s+/g, ' ').trim() : '';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One PhotoCaptureSlot, by the label it prints ('Shop front', 'Signboard', 'CR document', 'Other'). */
export function photoSlot(page: Page, label: string, nth = 0): Locator {
  return page
    .locator('div.isolate')
    .filter({ has: page.getByText(new RegExp(`^${escapeRe(label)}( \\*)?$`)) })
    .nth(nth);
}

/** The slot's camera control, empty ("Capture photo") or filled ("Retake photo"). */
export const captureOf = (slot: Locator) => slot.locator('label[aria-label="Capture photo"]');
export const retakeOf = (slot: Locator) => slot.locator('label[aria-label="Retake photo"]');

/** The R2 host the phone PUTs a photo to. The presigned URL itself is never printed. */
export const R2_HOST = /^https:\/\/[^/]*\.r2\.cloudflarestorage\.com\//;

/**
 * A photo as an iPhone camera hands it over: a 4032×3024 JPEG, encoded by
 * WebKit itself (a <canvas>: this build has no OffscreenCanvas) — gradients,
 * shapes and sensor-like noise, so its size is a real photo's (~4.7 MB, about
 * 600 KB after the app's compression). Unique bytes every call.
 */
export async function cameraJpeg(page: Page, width = 4032, height = 3024, quality = 0.92): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h, q]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${Math.floor(Math.random() * 360)}, 55%, 60%)`);
      g.addColorStop(1, `hsl(${Math.floor(Math.random() * 360)}, 45%, 30%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 600; i++) {
        ctx.fillStyle = `hsla(${Math.floor(Math.random() * 360)}, 50%, ${30 + Math.floor(Math.random() * 40)}%, 0.55)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, (Math.random() * w) / 10, (Math.random() * h) / 10);
      }
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      const rnd = new Uint8Array(65_536);
      for (let p = 0; p < d.length / 4; p++) {
        if (p % 65_536 === 0) crypto.getRandomValues(rnd);
        const n = (rnd[p % 65_536]! - 128) >> 3;
        const i = p * 4;
        d[i] = d[i]! + n;
        d[i + 1] = d[i + 1]! + n;
        d[i + 2] = d[i + 2]! + n;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob gave nothing'))), 'image/jpeg', q)
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    [width, height, quality] as const
  );
  return Buffer.from(b64, 'base64');
}

/** A JPEG's pixel size, read from its SOF marker; null when it is not a JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * The first POST to `path` reaches the server (route.fetch) and its answer is
 * then lost on the way back (route.abort) — "it arrived, the phone never
 * heard". Later POSTs pass untouched — through route.fallback(), so they still
 * reach the context's cookie bridge when it is on (route.continue() would send
 * them past it, without the session). Returns what the server answered.
 */
export async function loseFirstReply(page: Page, path: string): Promise<{ status: number | null; error: string | null }> {
  const seen: { status: number | null; error: string | null } = { status: null, error: null };
  let first = true;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== 'POST' || !first) {
        await route.fallback();
        return;
      }
      first = false;
      try {
        // From Node with the context's cookies (sendFromNode), not route.fetch(): a failed route.fetch keeps
        // every header — the session cookie — in the report's call log.
        seen.status = (await sendFromNode(page.context(), route.request(), { follow: true })).status;
      } catch (err) {
        seen.error = String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 200);
      }
      await route.abort('failed');
    }
  );
  return seen;
}

/**
 * The editable fields under `root` whose text is under 16 px. iOS Safari zooms
 * the page into such a field when it is tapped, and leaves the salesman to
 * pinch back out. Checkboxes, radios, file inputs, buttons and fields that are
 * disabled, read-only or not rendered are not counted.
 */
export async function fieldsUnder16px(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const out: string[] = [];
    const sel =
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';
    for (const c of Array.from(el.querySelectorAll<HTMLInputElement>(sel))) {
      if (c.disabled || c.readOnly || c.getClientRects().length === 0) continue;
      const style = getComputedStyle(c);
      if (style.visibility === 'hidden') continue;
      const px = parseFloat(style.fontSize);
      if (px < 16) out.push(`${c.getAttribute('aria-label') ?? c.getAttribute('name') ?? c.id ?? c.tagName}: ${px}px`);
    }
    return out;
  });
}

/** Collects React hydration errors and page errors of one page, for a test that asserts on them itself. */
export function collectHydrationErrors(page: Page): () => string[] {
  const seen: string[] = [];
  const HYDRATION = /#418|#423|#425|Hydration|did not match/i;
  page.on('console', (m) => {
    if (m.type() === 'error' && HYDRATION.test(m.text())) seen.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => {
    if (HYDRATION.test(String(e?.message ?? e))) seen.push(String(e?.message ?? e).slice(0, 300));
  });
  return () => [...seen];
}

/** The form copies this browser holds, by key (lib/device-drafts.ts prefixes). */
export async function deviceCopies(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && (k.startsWith('nmwc:draft:') || k.startsWith('nmwc:create:'))) out[k] = window.localStorage.getItem(k) ?? '';
    }
    return out;
  });
}

/**
 * components/nmwc/SignOutButton.tsx signOutDraftsQuestion, copied: that module
 * is a 'use client' component importing a server action, which the Playwright
 * runner should not load.
 */
export function signOutDraftsQuestion(n: number): string {
  const [what, it] = n === 1 ? ['1 unsent form is', 'it'] : [`${n} unsent forms are`, 'them'];
  return `${what} saved on this device. Signing out deletes ${it}, so the next person to use this device cannot read ${it}. Sign out?`;
}

/** ASCII digits as Arabic-Indic ones (U+0660–U+0669), as an Arabic keyboard types them; nothing else changes. */
export function arabicDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

/** A run password of the shape the secret scan looks for (E2e-<16>-9a). Never logged, never typed with fill(). */
export function freshPassword(): string {
  return `E2e-${randomBytes(12).toString('base64url')}-9a`;
}

// ── Oman time, computed here (UTC+4, no DST) — not with the app's own helpers ──

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');
const omanClock = (at: Date) => new Date(at.getTime() + 4 * 3_600_000);

/** "14:05": the Oman wall clock of an instant. */
export function omanHm(at: Date): string {
  const o = omanClock(at);
  return `${two(o.getUTCHours())}:${two(o.getUTCMinutes())}`;
}

/** "08 Oct, 01:30": the notification list's stamp, on the Oman clock. */
export function omanStamp(at: Date): string {
  const o = omanClock(at);
  return `${two(o.getUTCDate())} ${MONTH_SHORT[o.getUTCMonth()]}, ${omanHm(at)}`;
}

/** The same stamp on the UTC clock — what a server-side (TZ=UTC) slip would print. */
export function utcStamp(at: Date): string {
  return `${two(at.getUTCDate())} ${MONTH_SHORT[at.getUTCMonth()]}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
}

/** Yesterday at hh:mm UTC — with hh ≥ 20 that is already today in Oman, a day the UTC clock does not show. */
export function yesterdayUtcAt(hh: number, mm: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, hh, mm));
}

// ── what the browser made, registered with the world ──

/**
 * Registers what the world's salesmen made through the browser since `since`:
 * photos (an upload never attached is otherwise foreign to cleanup) and
 * requests. Salesmen only: the approvers of a world are shared audiences.
 */
export async function adoptSalesmanWork(world: World, since: Date): Promise<void> {
  const ids = world.users().filter((u) => u.role === 'SALESMAN').map((u) => u.id);
  if (ids.length === 0) return;
  const [atts, edits] = await Promise.all([
    db.attachment.findMany({ where: { capturedById: { in: ids }, createdAt: { gte: since } }, select: { id: true, r2Key: true } }),
    db.customerEdit.findMany({ where: { submittedById: { in: ids }, createdAt: { gte: since } }, select: { id: true } }),
  ]);
  for (const a of atts) {
    world.adopt.attachment(a.id);
    world.registry.add('r2Keys', a.r2Key);
    world.registry.add('ymds', a.r2Key.split('/').slice(0, 3).join('/'));
  }
  for (const e of edits) world.adopt.edit(e.id);
}

/** The draft-save buckets ('edit-draft:<user>') of the world's users, which the shared cleanup does not know. */
export async function dropDraftBuckets(world: World): Promise<void> {
  const keys = world.users().map((u) => `edit-draft:${u.id}`);
  if (keys.length) await db.rateLimit.deleteMany({ where: { key: { in: keys } } });
}

/** The pixel size of an <img> once it has decoded (0 until then). */
export async function naturalWidth(img: Locator): Promise<number> {
  return img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0));
}

/** Polls until `check` holds; for a value that only a later render or an autosave sets. */
export async function eventually(check: () => Promise<boolean>, message: string, timeout = 15_000): Promise<void> {
  await expect.poll(check, { message, timeout }).toBe(true);
}
