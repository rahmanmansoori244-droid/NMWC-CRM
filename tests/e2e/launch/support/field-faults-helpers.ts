/**
 * Helpers for tests/e2e/launch/field-faults.spec.ts only (its author's file;
 * nothing else in support/ imports it). Additive: no existing support module is
 * changed. Every write here touches the world's own rows: a salesman, route and
 * customer added to the world, his photos and requests adopted by id, buckets of
 * world users.
 *
 * Faults are made three ways, and never by printing what they carry:
 *   - page.route() aborts or holds a request in the browser (the R2 PUT's URL is
 *     presigned: it is matched by host and never read, logged or fetched from Node);
 *   - the DevTools protocol (a CDPSession, Chromium only — the tests that use it
 *     are tagged @cdp) slows the link and the CPU, freezes the tab, or makes the
 *     position unavailable;
 *   - an init script replaces navigator.geolocation where neither can produce
 *     the error (a phone that never gets a fix).
 */
import { expect, test, type CDPSession, type Locator, type Page, type Route } from '@playwright/test';
import type { BranchSpec, FixtureCustomer, FixtureRoute, FixtureUser, World } from './types';
import { db } from './env';
import { uniquePng } from './media';

// The app's own words and limits, imported where the module is plain TypeScript.
export { OFFLINE_MESSAGE, PHOTO_UPLOADING_MESSAGE, UNCONFIRMED_MESSAGE } from '../../../../lib/submission';
export { SUBMIT_TIMEOUT_MS } from '../../../../lib/submit-client';

/*
 * Copied, not imported: these live in 'use client' React components (JSX, lucide
 * icons) that the Playwright runner should not load. Each line names its source.
 */
/** components/nmwc/PhotoCaptureSlot.tsx UPLOAD_STALL_MS: how long the PUT may go without a sign of life. */
export const UPLOAD_STALL_MS = 45_000;
/** components/nmwc/PhotoCaptureSlot.tsx RETRY_DELAYS.length: tries per step before "Retry upload". */
export const PHOTO_TRIES = 3;
/**
 * PhotoCaptureSlot's UPLOAD_NO_CONNECTION (f960612, da545ac): what a slot says when a photo step got no
 * answer on all three tries — a dropped connection of any kind, the R2 PUT's ERR_TIMED_OUT included.
 * Copied, not imported: that module is a 'use client' React component.
 */
export const UPLOAD_NO_CONNECTION =
  'No connection, so the photo is not sent yet. Keep this page open: the photo is held here until it is sent. Check the signal, then tap Retry upload.';
/** components/nmwc/GpsCaptureButton.tsx: the error line for each GeolocationPositionError code. */
export const GPS_DENIED = 'Location permission denied. Tap below to enter coordinates manually.';
export const GPS_UNAVAILABLE = 'Location unavailable. Tap below to enter coordinates manually.';
export const GPS_TIMEOUT = 'Location took too long. Tap below to enter coordinates manually.';
/** components/nmwc/GpsCaptureButton.tsx: the manual panel's own heading (the same words whatever the error). */
export const GPS_MANUAL_PANEL = GPS_UNAVAILABLE;
/** components/nmwc/GpsCaptureButton.tsx applyManual's refusals. */
export const GPS_MANUAL_NUMBERS = 'Enter valid latitude and longitude numbers.';
export const GPS_MANUAL_REASON = 'Tell us why GPS did not work (5+ characters).';
/** components/nmwc/GpsCaptureButton.tsx getCurrentPosition options.timeout. */
export const GPS_TIMEOUT_MS = 15_000;

/** vercel.json functions maxDuration: the platform kills a request after this. */
export const VERCEL_MAX_DURATION_MS = 60_000;

/** The R2 host the browser PUTs a photo to (the presigned URL itself is never read or printed). */
export const R2_HOST = /^https:\/\/[^/]*\.r2\.cloudflarestorage\.com\//;
export const FORM_PATH = '/api/forms/customer-edit';
export const PRESIGN_PATH = '/api/photos/presign';
export const FINALIZE_PATH = '/api/photos/finalize';
export const ATTACH_PATH = '/api/photos/attach';

/** The enrich form's Submit, as the button reads before a submit. */
export const SUBMIT = 'Submit for approval ▶';
/** What a retry of a submit that had arrived says (lib/submission.ts alreadyReceivedMessage, SUBMITTED). */
export const ALREADY_RECEIVED = /^✓ Already received at \d{2}:\d{2} — it is waiting for approval\. Nothing more to do\.$/;
/** The enrich form's restore line (EnrichmentForm.tsx). */
export const DRAFT_RESTORED = 'Restored a local draft from your last visit.';

/** The Playwright abort codes the field meets most (net::ERR_TIMED_OUT, ERR_CONNECTION_RESET, ERR_INTERNET_DISCONNECTED). */
export const FIELD_ABORTS = ['timedout', 'connectionreset', 'internetdisconnected'] as const;
export type FieldAbort = (typeof FIELD_ABORTS)[number];

// ── annotations ──────────────────────────────────────────────────────────────

/** Adds a line to the test's report (timings, which way a race went, the words shown). */
export function note(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits `ms`, or less if the page closes first (a failed test must not keep a handler alive). */
export function sleepWhileOpen(page: Page, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      page.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    page.once('close', done);
  });
}

// ── the enrich form ──────────────────────────────────────────────────────────

/** Waits until a page's own requests have settled, so a client form is hydrated before it is typed in. */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
}

/** The enrich form of a customer, hydrated. Returns its Submit button. */
export async function openEnrich(page: Page, customerId: string): Promise<Locator> {
  await page.goto(`/customers/${customerId}/edit`);
  await settled(page);
  const submit = page.getByRole('button', { name: SUBMIT, exact: true });
  await expect(submit).toBeVisible();
  return submit;
}

export const contactBox = (page: Page) => page.getByLabel('Contact person *', { exact: true });
export const notesBox = (page: Page) => page.getByLabel('Notes', { exact: true });
export const tryAgain = (page: Page) => page.getByRole('button', { name: 'Try again', exact: true });

/** The phone copy of the enrich form (EnrichmentForm.tsx draftKey), or '' when there is none. */
export function phoneCopy(page: Page, userId: string, customerId: string): Promise<string> {
  return page.evaluate((k) => window.localStorage.getItem(k) ?? '', `nmwc:draft:${userId}:${customerId}`);
}

export const editsOf = (customerId: string) => db.customerEdit.count({ where: { customerId } });

/**
 * Where a Try again ended: 'sent' (a first arrival — the form left for the
 * customer page) or 'already received' (an earlier try had landed — it stays).
 */
export async function sentOrAlreadyReceived(page: Page, customerId: string): Promise<'sent' | 'already received'> {
  const state = async (): Promise<'sent' | 'already received' | 'waiting'> => {
    try {
      if (new URL(page.url()).pathname === `/customers/${customerId}`) return 'sent';
      if ((await page.getByText(ALREADY_RECEIVED).count()) > 0) return 'already received';
    } catch {
      /* mid-navigation: ask again */
    }
    return 'waiting';
  };
  await expect.poll(state, { timeout: 45_000, message: 'Try again ends in a first arrival or "Already received"' }).not.toBe('waiting');
  return (await state()) as 'sent' | 'already received';
}

/**
 * Records every "it is saved" line the page ever shows from now on — the Sent ✓
 * button, a green "Submitted" / "Already received" / "Saved" — even one that
 * flashes for a moment. The no-answer notices quote “Already received” in curly
 * quotes, without the tick, so they do not count.
 */
export async function watchSavedClaims(page: Page): Promise<() => Promise<string[]>> {
  const CLAIM = /Sent ✓|✓ Submitted for approval|✓ Already received|✓ Saved|✓ Draft saved/;
  await page.evaluate((source) => {
    const re = new RegExp(source);
    const w = window as unknown as { __nmwcClaims?: string[] };
    w.__nmwcClaims = [];
    const check = () => {
      const m = re.exec(document.body?.textContent ?? '');
      if (m && !w.__nmwcClaims!.includes(m[0])) w.__nmwcClaims!.push(m[0]);
    };
    check();
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, CLAIM.source);
  return () => page.evaluate(() => [...((window as unknown as { __nmwcClaims?: string[] }).__nmwcClaims ?? [])]);
}

// ── photo slots ──────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One PhotoCaptureSlot, found by the label it prints ('Shop front', 'Signboard',
 * 'CR document', 'Other'), with or without the required star. `nth` for the two
 * 'Other' slots of a branch.
 */
export function photoSlot(page: Page, label: string, nth = 0): Locator {
  return page
    .locator('div.isolate')
    .filter({ has: page.getByText(new RegExp(`^${escapeRe(label)}( \\*)?$`)) })
    .nth(nth);
}

/** A file as the camera input receives it. */
export type PickedFile = { name: string; mimeType: string; buffer: Buffer };

/** A fresh screenshot-like PNG with bytes unique after the browser's compression (finalize dedupes on hash). */
export function pngFile(name = 'photo'): PickedFile {
  return { name: `${name}.png`, mimeType: 'image/png', buffer: uniquePng() };
}

/** Picks a file in a slot, as the camera would hand it over. */
export async function pickFile(slot: Locator, file: PickedFile): Promise<void> {
  await slot.locator('input[type="file"]').setInputFiles(file);
}

/** The slot's "Retake photo" control: shown once its photo is in and attached. */
export const retakeOf = (slot: Locator) => slot.locator('label[aria-label="Retake photo"]');
/** The slot's "Retry upload" button: shown after the last try of a step failed. */
export const retryOf = (slot: Locator) => slot.getByRole('button', { name: 'Retry upload', exact: true });
/** The capture / retake control: hidden while the slot is busy (no second pick mid-upload). */
export const pickControlOf = (slot: Locator) => slot.locator('label[aria-label]');

/** The words the failed slot shows above its Retry upload button. */
export async function slotMessage(slot: Locator): Promise<string> {
  return ((await retryOf(slot).locator('xpath=preceding-sibling::span[1]').textContent()) ?? '').trim();
}

/**
 * Where a slot stands: 'attached' (its photo is in), 'retry' (Retry upload is
 * offered), else 'busy: "<what it says>"' while it compresses or uploads, or
 * 'idle: "<what it says>"'.
 */
export async function slotState(slot: Locator): Promise<string> {
  if ((await retakeOf(slot).count()) > 0) return 'attached';
  if ((await retryOf(slot).count()) > 0) return 'retry';
  const text = ((await slot.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  const busy = /Compressing…|Uploading…|Too many photos — trying again/.test(text);
  return `${busy ? 'busy' : 'idle'}: "${text.slice(0, 80)}"`;
}

/**
 * Notes, once per page, that R2 refused the browser's photo PUT for this
 * origin (the bucket's CORS allows the suite's default http://localhost:3000
 * only): on another E2E_PORT every browser upload fails as "No connection".
 * The console line quotes the presigned URL: it is matched, never kept.
 */
export function noteR2CorsRefusal(page: Page): void {
  let said = false;
  page.on('console', (msg) => {
    if (said || msg.type() !== 'error') return;
    const text = msg.text();
    if (!/blocked by CORS policy/i.test(text) || !/\.r2\.cloudflarestorage\.com/.test(text)) return;
    said = true;
    try {
      note('R2 CORS', `R2 refused the browser's photo PUT from ${new URL(page.url()).origin} — browser uploads need E2E_PORT=3000`);
    } catch {
      /* the test has ended */
    }
  });
}

/** The slot's upload progress, or null when it is not uploading. */
export async function uploadPct(slot: Locator): Promise<number | null> {
  const text = (await slot.textContent().catch(() => '')) ?? '';
  const m = /Uploading… (\d+)%/.exec(text);
  return m ? Number(m[1]) : null;
}

// ── requests ─────────────────────────────────────────────────────────────────

export type UrlMatch = (url: URL) => boolean;
export const pathIs = (path: string): UrlMatch => (u) => u.pathname === path;
export const isR2: UrlMatch = (u) => R2_HOST.test(u.href);

/** Counts the page's requests that match (POST unless said) — read `.count` when needed. */
export function countRequests(page: Page, match: UrlMatch, method = 'POST'): { readonly count: number } {
  const box = { count: 0 };
  page.on('request', (r) => {
    if (r.method() !== method) return;
    try {
      if (match(new URL(r.url()))) box.count += 1;
    } catch {
      /* not a URL we count */
    }
  });
  return box;
}

/**
 * Fails the page's matching requests in the browser with a network error code,
 * as a weak link does: every one, or only the first `times`. Others go on
 * untouched (a CORS preflight to R2 included). `stop()` removes the fault — call
 * it only once nothing is waiting in the handler (it never holds a request).
 */
export async function failRequests(
  page: Page,
  o: { match: UrlMatch; method: string; code: FieldAbort | 'failed'; times?: number }
): Promise<{ readonly aborted: number; stop(): Promise<void> }> {
  const state = { aborted: 0 };
  const handler = async (route: Route) => {
    if (route.request().method() !== o.method || (o.times !== undefined && state.aborted >= o.times)) {
      await route.fallback();
      return;
    }
    state.aborted += 1;
    await route.abort(o.code);
  };
  await page.route(o.match, handler);
  return {
    get aborted() {
      return state.aborted;
    },
    stop: () => page.unroute(o.match, handler),
  };
}

export type HeldPost = {
  /** The JSON body of the held POST (its submissionId). */
  body: Record<string, unknown> | null;
  /** The server's status, when the server read it first ('answerLate'). */
  serverStatus: number | null;
  /** Resolves when the hold is over and the request was let go, aborted or answered. */
  released: Promise<void>;
  releasedAt: number | null;
  /** What the let-go said (a closed page, an abandoned request) — the handler never throws. */
  error: string | null;
};

/** Hop-by-hop and pseudo headers Node's fetch must set itself (or refuses). */
const NOT_FORWARDED = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer']);

/**
 * Sends the page's request to the server from Node, with the page's own headers
 * (its session cookie, its Origin), and returns only what the page needs back.
 * Not route.fetch(): Playwright's request client writes every request header —
 * the session cookie included — into its call log, and a failed or cut-off
 * call puts that log into the HTML report (the secret scan then deletes it and
 * fails the run). Node's fetch is not a reported step, and its errors carry no
 * headers.
 */
async function serverAnswers(req: ReturnType<Route['request']>): Promise<{ status: number; contentType: string; body: Buffer }> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(await req.allHeaders())) {
    if (!k.startsWith(':') && !NOT_FORWARDED.has(k.toLowerCase())) headers[k] = v;
  }
  const res = await fetch(req.url(), {
    method: req.method(),
    headers,
    // The field forms post JSON text.
    body: req.postData() ?? undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
}

/**
 * Holds the FIRST POST to `path` for `holdMs`, then:
 *   'continue'   — lets it go on to the server (if the page still wants it);
 *   'abort'      — fails it with `abortCode`, so it never reaches the server;
 *   'answerLate' — the server reads and answers it AT ONCE (from Node, see
 *                  serverAnswers), and the answer is held instead: it reaches
 *                  the page only after the hold (status, content type and body;
 *                  no Set-Cookie).
 * Later POSTs pass untouched. Nothing is un-routed while the request is held
 * (README: un-routing a paused request makes Chromium send it on).
 */
export async function holdFirstPost(
  page: Page,
  path: string,
  o: { holdMs: number; then: 'continue' | 'abort' | 'answerLate'; abortCode?: FieldAbort }
): Promise<HeldPost> {
  let release!: () => void;
  const held: HeldPost = {
    body: null,
    serverStatus: null,
    released: new Promise<void>((r) => (release = r)),
    releasedAt: null,
    error: null,
  };
  let first = true;
  await page.route(pathIs(path), async (route) => {
    const req = route.request();
    if (req.method() !== 'POST' || !first) {
      await route.fallback().catch(() => undefined);
      return;
    }
    first = false;
    try {
      held.body = (req.postDataJSON() as Record<string, unknown> | null) ?? null;
      if (o.then === 'answerLate') {
        const res = await serverAnswers(req);
        held.serverStatus = res.status;
        await sleepWhileOpen(page, o.holdMs);
        await route.fulfill({ status: res.status, contentType: res.contentType, body: res.body });
      } else {
        await sleepWhileOpen(page, o.holdMs);
        if (o.then === 'abort') await route.abort(o.abortCode ?? 'timedout');
        else await route.continue();
      }
    } catch (e) {
      held.error = String((e as Error)?.message ?? e).slice(0, 200);
    } finally {
      held.releasedAt = Date.now();
      release();
    }
  });
  return held;
}

// ── the world ────────────────────────────────────────────────────────────────

/**
 * A salesman of his own, on a route of his own, with one customer of his own
 * (one open request per customer, 60 sends and 120 photos an hour per
 * salesman): every fault test gets one.
 */
export async function addFieldSalesman(
  world: World,
  key: string,
  o: { region?: string; supervisor?: string; branch?: Partial<Omit<BranchSpec, 'key' | 'route'>> } = {}
): Promise<{ user: FixtureUser; route: FixtureRoute; customer: FixtureCustomer }> {
  const route = await world.addRoute({ key: `RT${key}`, region: o.region ?? 'R1' });
  const user = await world.addUser({ key, role: 'SALESMAN', route: route.key, supervisor: o.supervisor ?? 'M1' });
  const customer = await world.addCustomer({
    key: `CU${key}`,
    phone: true,
    contact: 'Majid Al Shukaili',
    paymentTerms: 'CASH',
    branches: [{ key: 'S', route: route.key, ...o.branch }],
  });
  return { user, route, customer };
}

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

/** The draft-save buckets ('edit-draft:<user>') of the world's users; fixture keys only. */
export async function dropDraftBuckets(world: World): Promise<void> {
  const keys = world.users().map((u) => `edit-draft:${u.id}`);
  if (keys.length) await db.rateLimit.deleteMany({ where: { key: { in: keys } } });
}

/** The live photos a user captured, oldest first. */
export function photosBy(userId: string) {
  return db.attachment.findMany({
    where: { capturedById: userId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, r2Key: true, bytes: true, mimeType: true, branchId: true, branchExtraId: true },
  });
}

/** The <UTC yyyy/mm/dd> folder of an R2 key. */
export const ymdOf = (key: string) => key.split('/').slice(0, 3).join('/');

// ── the DevTools protocol (Chromium only: tag the test @cdp) ─────────────────

export type NetworkProfile = { latencyMs: number; downBytesPerSec: number; upBytesPerSec: number };

/**
 * Chrome DevTools' "Slow 4G" preset (front_end/core/sdk/NetworkManager.ts):
 * 1.6 Mbps down and 750 kbps up at 90 %, 150 ms RTT × 3.75.
 */
export const SLOW_4G: NetworkProfile = { latencyMs: 562.5, downBytesPerSec: (1_600_000 / 8) * 0.9, upBytesPerSec: (750_000 / 8) * 0.9 };

/** A low-end Android on a weak link: the CPU 6× slower, two cores, Slow 4G. */
export const SLOW_PHONE = { cpuRate: 6, cores: 2, network: SLOW_4G } as const;

export async function cdpFor(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Every request of the page goes through this link (the R2 PUT too: it leaves from the browser). */
export async function emulateNetwork(cdp: CDPSession, n: NetworkProfile): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: n.latencyMs,
    downloadThroughput: n.downBytesPerSec,
    uploadThroughput: n.upBytesPerSec,
  });
}

/** Back to the machine's own link and CPU, then detached. Never throws. */
export async function restoreDevice(cdp: CDPSession): Promise<void> {
  await cdp
    .send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    .catch(() => undefined);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
  await cdp.detach().catch(() => undefined);
}

/**
 * Makes the page a slow phone: CPU throttled, fewer cores (navigator.hardwareConcurrency,
 * read by scripts as they load — set this before the navigation), and a slow link.
 * `cores` says whether this Chromium took the core override.
 */
export async function slowPhone(
  page: Page,
  o: { cpuRate: number; cores: number; network: NetworkProfile } = SLOW_PHONE
): Promise<{ cdp: CDPSession; cores: boolean }> {
  const cdp = await cdpFor(page);
  await emulateNetwork(cdp, o.network);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpuRate });
  let cores = true;
  try {
    await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: o.cores });
  } catch {
    cores = false;
  }
  return { cdp, cores };
}

/**
 * Throttles the uplink so that `bytes` take about `seconds` to go up (floor
 * 1 KB/s), downloads at 64 KB/s, 300 ms latency. Returns the bytes per second.
 */
export async function crawlUplink(cdp: CDPSession, bytes: number, seconds: number): Promise<number> {
  const up = Math.max(1024, Math.round(bytes / seconds));
  await emulateNetwork(cdp, { latencyMs: 300, downBytesPerSec: 64 * 1024, upBytesPerSec: up });
  return up;
}

/**
 * Freezes the tab for `ms`, as Android does to a tab behind the camera app
 * (Page.setWebLifecycleState frozen, which also hides it), then makes it active
 * again. `beats` counts a 250 ms page timer during the freeze — about 0 when the
 * freeze took (an unfrozen hidden tab still ticks about once a second).
 */
export async function freezeFor(page: Page, cdp: CDPSession, ms: number): Promise<{ beats: number; visibility: string }> {
  const beatsNow = () =>
    page.evaluate(() => {
      const w = window as unknown as { __nmwcBeats?: number; __nmwcBeat?: number };
      if (w.__nmwcBeat === undefined) {
        w.__nmwcBeats = 0;
        w.__nmwcBeat = window.setInterval(() => (w.__nmwcBeats = (w.__nmwcBeats ?? 0) + 1), 250);
      }
      return w.__nmwcBeats ?? 0;
    });
  const before = await beatsNow();
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await sleepWhileOpen(page, ms);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  const after = await beatsNow();
  const visibility = await page.evaluate(() => document.visibilityState);
  return { beats: after - before, visibility };
}

// ── geolocation ──────────────────────────────────────────────────────────────

/**
 * Init script: a phone that never gets a fix. getCurrentPosition answers only
 * when the caller's own `timeout` runs out — with a TIMEOUT error, as the
 * browser would — and never when there is none. Every call's options are kept
 * in window.__nmwcGeoCalls. Playwright cannot produce a TIMEOUT any other way.
 */
export function neverFixGeolocation(): void {
  type Call = { timeout: number | null; enableHighAccuracy: boolean; maximumAge: number | null };
  const w = window as unknown as { __nmwcGeoCalls?: Call[] };
  w.__nmwcGeoCalls = [];
  const proto = Object.getPrototypeOf(navigator.geolocation) as object;
  Object.defineProperty(proto, 'getCurrentPosition', {
    configurable: true,
    writable: true,
    value(_ok: unknown, fail?: ((e: unknown) => void) | null, options?: PositionOptions) {
      const t = options?.timeout;
      w.__nmwcGeoCalls!.push({
        timeout: typeof t === 'number' ? t : null,
        enableHighAccuracy: options?.enableHighAccuracy === true,
        maximumAge: typeof options?.maximumAge === 'number' ? options.maximumAge : null,
      });
      if (typeof t !== 'number' || !Number.isFinite(t)) return;
      setTimeout(
        () => fail?.({ code: 3, message: 'Timeout expired', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }),
        t
      );
    },
  });
}

/** The options the app passed to each getCurrentPosition (neverFixGeolocation only). */
export function geoCalls(page: Page): Promise<Array<{ timeout: number | null; enableHighAccuracy: boolean; maximumAge: number | null }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __nmwcGeoCalls?: Array<{ timeout: number | null; enableHighAccuracy: boolean; maximumAge: number | null }> })
        .__nmwcGeoCalls ?? []
  );
}

// ── media ────────────────────────────────────────────────────────────────────

/**
 * A camera-like JPEG encoded by the browser itself: gradients, shapes and
 * sensor noise, unique every call (its size after the app's compression is that
 * of a real photo). Make it BEFORE throttling the CPU.
 */
export async function cameraJpeg(page: Page, width: number, height: number, quality = 0.95): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h, q]) => {
      const canvas = new OffscreenCanvas(w, h);
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
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    [width, height, quality] as const
  );
  return Buffer.from(b64, 'base64');
}

/**
 * The size the app's own compression gives this JPEG (PhotoCaptureSlot
 * compressImage: long side ≤ 1920 px, JPEG quality 0.85), measured in the page —
 * so a throttle can be set for the photo that will really go up.
 */
export async function compressedSizeInBrowser(page: Page, jpeg: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).size;
  }, jpeg.toString('base64'));
}

/** A JPEG's pixel size, read from its SOF marker. */
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

// ── timings ──────────────────────────────────────────────────────────────────

export type PageTimings = { ttfbMs: number; domContentLoadedMs: number; loadMs: number; lcpMs: number | null; transferKB: number };

/** The page's own navigation timings (from its navigation start), its LCP and what it downloaded. */
export async function pageTimings(page: Page): Promise<PageTimings> {
  return page.evaluate(async () => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const lcp = await new Promise<number | null>((resolve) => {
      let last: number | null = null;
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) last = e.startTime;
        });
        po.observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => {
          po.disconnect();
          resolve(last);
        }, 300);
      } catch {
        resolve(null);
      }
    });
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const bytes = resources.reduce((n, r) => n + (r.transferSize || 0), nav?.transferSize ?? 0);
    return {
      ttfbMs: nav ? Math.round(nav.responseStart) : -1,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : -1,
      loadMs: nav ? Math.round(nav.loadEventEnd) : -1,
      lcpMs: lcp === null ? null : Math.round(lcp),
      transferKB: Math.round(bytes / 1024),
    };
  });
}

export const fmtTimings = (t: PageTimings) =>
  `TTFB ${t.ttfbMs} ms · DCL ${t.domContentLoadedMs} ms · load ${t.loadMs} ms · LCP ${t.lcpMs ?? 'n/a'} ms · ${t.transferKB} KB`;
