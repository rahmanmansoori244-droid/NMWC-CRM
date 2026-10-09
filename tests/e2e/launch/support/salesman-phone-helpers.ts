/**
 * Helpers for tests/e2e/launch/salesman-phone.spec.ts (its author's file). The
 * page's request log and the in-place timing it once kept are shared now
 * (in-place.ts), and so are PhotoCaptureSlot's words (photo-slot-words.ts);
 * both are re-exported here. Every write here touches the world's own rows
 * only — a request the world's salesman sent through the app's own route, then
 * moved to the state a test needs; a reactivation row on a world branch;
 * buckets of world users.
 */
import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import type { DayOfWeek, PaymentTerms, Prisma, Role } from '@prisma/client';
import { resolveChain, stepDeadline } from '../../../../lib/approval-chains';
import { db } from './env';
import { newId } from './ids';
import { submitCreateViaApi, receiptEditId } from './api';
import { describeMiss, serverClock, untilShown, type RequestLog } from './in-place';
import { uniquePng } from './media';
import type { BranchSpec, FixtureCustomer, FixtureRoute, FixtureUser, World } from './types';

// The app's own words, imported where the module is plain TypeScript.
export { omanDate, omanDayTime, omanLongDate } from '../../../../lib/tz';
export { RETURNED_CLEARED_REASON } from '../../../../lib/returned-work';
export {
  OFFLINE_MESSAGE,
  PHOTO_UPLOADING_MESSAGE,
  SIGNED_OUT_MESSAGE,
  UNCONFIRMED_MESSAGE,
} from '../../../../lib/submission';
export { CR_DOCUMENT_LOCKED_MESSAGE } from '../../../../lib/permissions';

// PhotoCaptureSlot's words, defined once for every spec (photo-slot-words.ts).
export {
  ATTACH_NO_ANSWER,
  HEIC_MESSAGE,
  RATE_WAIT,
  SLOW_LINK_MESSAGE,
  UNREADABLE_PHOTO_MESSAGE,
  UPLOAD_NO_CONNECTION,
  UPLOAD_SIGNED_OUT,
} from './photo-slot-words';

/** The R2 host the browser PUTs a photo to (the presigned URL itself is never printed). */
export const R2_HOST = /^https:\/\/[^/]*\.r2\.cloudflarestorage\.com\//;

/** Waits until a page's own requests have settled, so a client form is hydrated before it is typed in. */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
}

function pageOf(root: Page | Locator): Page {
  return typeof (root as Locator).page === 'function' ? (root as Locator).page() : (root as Page);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One PhotoCaptureSlot, found by the label it prints ('Shop front', 'Signboard',
 * 'CR document', 'Other'), with or without the required star. `nth` for the two
 * 'Other' slots of a branch.
 */
export function photoSlot(root: Page | Locator, label: string, nth = 0): Locator {
  const page = pageOf(root);
  return (root as Pick<Locator, 'locator'>)
    .locator('div.isolate')
    .filter({ has: page.getByText(new RegExp(`^${escapeRe(label)}( \\*)?$`)) })
    .nth(nth);
}

/** A file as the camera input receives it. */
export type PickedFile = { name: string; mimeType: string; buffer: Buffer };

/** A fresh screenshot-like PNG with bytes unique after the browser's compression. */
export function pngFile(name = 'photo'): PickedFile {
  return { name: `${name}.png`, mimeType: 'image/png', buffer: uniquePng() };
}

/** Picks a file in a slot, as the camera would hand it over. */
export async function pickFile(slot: Locator, file: PickedFile): Promise<void> {
  await slot.locator('input[type="file"]').setInputFiles(file);
}

/** The slot's "Retake photo" control: shown once its photo is in (and attached, where the slot attaches). */
export function retakeOf(slot: Locator): Locator {
  return slot.locator('label[aria-label="Retake photo"]');
}

// The page's own calls, and the shared "in place" timing (in-place.ts): a tap's
// result must show IN_PLACE_MS after the server answered; the server gets
// SERVER_WORK_MS from the tap. Both are hard limits.
export { trackRequests, type RequestLog } from './in-place';

/** The page's stylesheets as React's commit sees them: path, precedence, and whether the sheet is loaded. */
async function stylesheetState(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .map((l) => `${new URL(l.href, location.href).pathname} precedence=${l.dataset.precedence ?? '-'}${l.sheet ? '' : ' NOT LOADED'}`)
        .join('; ')
    )
    .catch((e: unknown) => `(could not read: ${String((e as Error)?.message ?? e).slice(0, 80)})`);
}

/**
 * Waits until the page's URL matches, after a tap that navigates inside the app
 * (call it right after the tap: `since` is when the tap was made). The server
 * answered when the last of the app's calls since the tap ended (`log`, from
 * trackRequests before the tap). A tap that has not landed IN_PLACE_MS after
 * that fails (NAV_HANG), and so does a server still not answering
 * SERVER_WORK_MS after the tap; the failure says what the app asked the server
 * for and which requests were still open.
 *
 * Fixed 8 Oct (components/nmwc/TransitionWatchdog.tsx): a tap that changed only
 * the query string of /today or /customers often never landed — the RSC answer
 * arrived, nothing was pending, the page stayed ("Filtering…" for good). Next
 * 15.5's own React drops a ping that fires during its render, and the
 * transition stayed parked. These helpers used to record such a hang and load
 * the URL instead; now a hang is a failure.
 */
export async function landsOn(
  page: Page,
  log: RequestLog,
  url: RegExp | ((u: URL) => boolean),
  what: string,
  o: { since?: number } = {}
): Promise<void> {
  const start = o.since ?? Date.now();
  const miss = await untilShown(start, what, serverClock(log, start), (timeout) => page.waitForURL(url, { timeout, waitUntil: 'commit' }));
  if (!miss) return;
  const at = new URL(page.url());
  const asked = log.navigationsSince(start - 1_000);
  throw new Error(
    `${what}: not landed — ${describeMiss(miss)}; still at ${at.pathname}${at.search}; ` +
      `the app asked the server for: ${asked.join(', ') || 'nothing'}\nstylesheets: ${await stylesheetState(page)}\n${log.summary()}`
  );
}

/**
 * After an action that ends in router.refresh(): what it shows, within
 * IN_PLACE_MS of the server finishing — the later of `done` first reading true
 * (polled from the tap) and the last of the page's calls being answered (`log`).
 * The refresh is the same client transition as a tap; the failure says whether
 * the server did the work, which separates a page that was never refreshed
 * from a refused action.
 */
export async function shownAfterRefresh(log: RequestLog, shown: Locator, what: string, done: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  const miss = await untilShown(start, what, serverClock(done, start, log), (timeout) => expect(shown).toBeVisible({ timeout }));
  if (!miss) return;
  throw new Error(`${what}: not shown — ${describeMiss(miss)}\n${log.summary()}`);
}

/**
 * Records every text a page shows on its buttons and live regions, as it shows
 * them — through a binding, so it outlives a document load the form starts
 * itself (Playwright waits for such a load before it reads a locator, and the
 * page that said "Sent ✓" is gone by then).
 */
export async function watchTexts(page: Page): Promise<{ saw(text: string): boolean; all(): string[] }> {
  const seen = new Set<string>();
  const fn = `__e2eSaw${Math.random().toString(36).slice(2, 10)}`;
  await page.exposeFunction(fn, (texts: string[]) => {
    for (const t of texts) seen.add(t);
  });
  await page.evaluate((name) => {
    const report = () => {
      const texts = [...document.querySelectorAll('button, [role="status"], [role="alert"]')]
        .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0);
      (window as unknown as Record<string, (t: string[]) => void>)[name]?.(texts);
    };
    report();
    new MutationObserver(report).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, fn);
  return { saw: (t) => seen.has(t), all: () => [...seen] };
}

/** Why a phone page may be laid out wider than the screen: the viewport numbers and the widest elements. */
export async function layoutDiagnosis(page: Page): Promise<string> {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    const de = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.right > de.clientWidth + 0.5 || r.left < -0.5)
      .slice(0, 8)
      .map(({ e, r }) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    // Unbreakable text (nowrap / truncate) is what usually sets a list's minimum width.
    const nowrap = [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((e) => e.children.length === 0 && getComputedStyle(e).whiteSpace === 'nowrap' && e.scrollWidth > 150)
      .sort((a, b) => b.scrollWidth - a.scrollWidth)
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)} needs ${e.scrollWidth} px ("${(e.textContent ?? '').slice(0, 40)}")`);
    return (
      `innerWidth ${window.innerWidth}, innerHeight ${window.innerHeight}, clientWidth ${de.clientWidth}, ` +
      `scrollWidth ${de.scrollWidth}, visualViewport ${vv ? `${vv.width}x${vv.height} @${vv.scale}` : 'none'}; ` +
      `outside the screen: ${wide.join(' | ') || 'none'}; widest unbreakable text: ${nowrap.join(' | ') || 'none'}`
    );
  });
}

/** Counts the page's requests to one of the app's paths (POST only, unless said). */
export function countRequests(page: Page, path: string, method = 'POST'): { readonly count: number } {
  const box = { count: 0 };
  page.on('request', (r) => {
    if (r.method() !== method) return;
    try {
      if (new URL(r.url()).pathname === path) box.count += 1;
    } catch {
      /* not a URL we count */
    }
  });
  return box;
}

/** Delays the page's POSTs to a path, so the "Submitting…" state can be read. The request still goes. */
export async function delayPosts(page: Page, path: string, ms: number): Promise<void> {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, ms));
      await route.continue();
    }
  );
}

/** Delays the document load of a page, so what a form says just before it leaves can be read. */
export async function delayDocument(page: Page, path: string, ms: number): Promise<void> {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().resourceType() === 'document') await new Promise((r) => setTimeout(r, ms));
      await route.continue();
    }
  );
}

/**
 * The first POST to `path` is read by the server (route.fetch), and its answer is
 * then lost on the way back (route.abort) — "it arrived, the phone never heard".
 * Later POSTs pass. Returns what the first one carried. `beforeSend` runs with
 * its body before the server has seen it (an error there is kept in `error`,
 * since a route handler cannot fail the test itself).
 */
export async function loseFirstReply(
  page: Page,
  path: string,
  beforeSend?: (body: Record<string, unknown> | null) => Promise<void>
): Promise<{ body: Record<string, unknown> | null; status: number | null; error: string | null }> {
  const seen: { body: Record<string, unknown> | null; status: number | null; error: string | null } = {
    body: null,
    status: null,
    error: null,
  };
  let first = true;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== 'POST' || !first) {
        await route.continue();
        return;
      }
      first = false;
      seen.body = (route.request().postDataJSON() as Record<string, unknown> | null) ?? null;
      if (beforeSend) await beforeSend(seen.body).catch((e: unknown) => void (seen.error = String((e as Error)?.message ?? e)));
      const res = await route.fetch();
      seen.status = res.status();
      await route.abort('failed');
    }
  );
  return seen;
}

/**
 * Throttles the page through the DevTools protocol, as a weak phone link and a
 * slow phone CPU would. Speeds in kilobits per second.
 */
export async function throttle(
  page: Page,
  o: { upKbps: number; downKbps: number; latencyMs: number; cpu?: number }
): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: o.latencyMs,
    uploadThroughput: (o.upKbps * 1000) / 8,
    downloadThroughput: (o.downKbps * 1000) / 8,
  });
  if (o.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpu });
  return cdp;
}

export async function unthrottle(cdp: CDPSession): Promise<void> {
  await cdp
    .send('Network.emulateNetworkConditions', { offline: false, latency: 0, uploadThroughput: -1, downloadThroughput: -1 })
    .catch(() => undefined);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
  await cdp.detach().catch(() => undefined);
}

/**
 * A camera-like JPEG encoded by the browser itself: gradients, shapes and
 * sensor noise, unique every call. Unlike pure noise (media.ts jpegInBrowser),
 * its size after the app's own compression is that of a real photo.
 */
export async function cameraJpeg(page: Page, width: number, height: number, quality = 0.97): Promise<Buffer> {
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

/** A channel that has active sub-channels (the new-customer form needs both). */
export async function channelWithSubs(): Promise<{ id: string; label: string }> {
  return db.channel.findFirstOrThrow({
    where: { isActive: true, subChannels: { some: { isActive: true } } },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, label: true },
  });
}

/** The GENERAL_TRADE channel every fixture customer carries. */
export async function generalTrade(): Promise<{ id: string; label: string }> {
  return db.channel.findFirstOrThrow({ where: { key: 'GENERAL_TRADE' }, select: { id: true, label: true } });
}

/**
 * A salesman of his own, on a route of his own, with one customer of his own:
 * the send-safety tests each need one (one open request per customer, 60 sends
 * an hour per salesman).
 */
export async function addFieldSalesman(
  world: World,
  key: string,
  o: { region?: string; supervisor?: string; branch?: Partial<Omit<BranchSpec, 'key' | 'route'>>; paymentTerms?: PaymentTerms } = {}
): Promise<{ user: FixtureUser; route: FixtureRoute; customer: FixtureCustomer }> {
  const route = await world.addRoute({ key: `RT${key}`, region: o.region ?? 'R1' });
  const user = await world.addUser({ key, role: 'SALESMAN', route: route.key, supervisor: o.supervisor ?? 'M1' });
  const customer = await world.addCustomer({
    key: `CU${key}`,
    phone: true,
    contact: 'Majid Al Shukaili',
    paymentTerms: o.paymentTerms ?? 'CASH',
    branches: [{ key: 'S', route: route.key, ...o.branch }],
  });
  return { user, route, customer };
}

/**
 * Registers what the world's salesmen made through the browser since `since`:
 * photos (an upload that never got attached is otherwise foreign to cleanup)
 * and requests (a new-customer request is found by its drafted name too, but a
 * crash between here and there would leave it). Salesmen only: the approvers
 * of a world are shared audiences, the salesmen are not.
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

/**
 * The draft-save buckets ('edit-draft:<user>', launch fix) of the world's
 * users. The shared cleanup knows the other buckets of a fixture user, not this
 * newer one; fixture keys only.
 */
export async function dropDraftBuckets(world: World): Promise<void> {
  const keys = world.users().map((u) => `edit-draft:${u.id}`);
  if (keys.length) await db.rateLimit.deleteMany({ where: { key: { in: keys } } });
}

/**
 * A new-customer request of `submitter`, sent through the app's own route as a
 * DRAFT (services/creates.ts writes the draft rows), then — for a state a
 * salesman cannot reach alone — moved on the world's own row the way the
 * approval chain leaves it. `page` is signed in as the submitter.
 */
export async function seedCreateRequest(
  page: Page,
  world: World,
  o: {
    legalName: string;
    paymentTerms?: PaymentTerms;
    state: 'DRAFT' | 'SUBMITTED' | 'NEEDS_CORRECTION';
    /** SUBMITTED: the step it waits at. */
    pendingRole?: Role;
    /** NEEDS_CORRECTION: the user key of who sent it back, and why. */
    reviewer?: string;
    reason?: string;
  }
): Promise<string> {
  const paymentTerms: PaymentTerms = o.paymentTerms ?? 'CASH';
  const out = await submitCreateViaApi(
    page,
    { isDraft: true, customer: { legalName: o.legalName, paymentTerms }, branches: [{ branchName: 'Main' }] },
    { world }
  );
  const id = receiptEditId(out);
  if (!out.ok || !id) throw new Error(`seedCreateRequest: the draft was refused (${out.status} ${out.code ?? ''} ${out.message ?? ''})`);
  if (o.state === 'DRAFT') return id;
  const chain = resolveChain('CREATE', paymentTerms);
  const now = new Date();
  if (o.state === 'SUBMITTED') {
    const role = o.pendingRole ?? 'SUPERVISOR';
    const stepIndex = Math.max(0, chain.findIndex((s) => s.role === role));
    await db.customerEdit.update({
      where: { id },
      data: {
        state: 'SUBMITTED',
        submittedAt: now,
        approvalChain: chain as unknown as Prisma.InputJsonValue,
        paymentTermsAtSubmit: paymentTerms,
        currentStepIndex: stepIndex,
        pendingRole: role,
        stageEnteredAt: now,
        // Far ahead: no SLA sweep may escalate a fixture into real audiences.
        slaDueAt: stepDeadline(now, 24 * 30),
      },
    });
    return id;
  }
  if (!o.reviewer) throw new Error('seedCreateRequest: NEEDS_CORRECTION needs a reviewer');
  await db.customerEdit.update({
    where: { id },
    data: {
      state: 'NEEDS_CORRECTION',
      submittedAt: new Date(now.getTime() - 3_600_000),
      approvalChain: chain as unknown as Prisma.InputJsonValue,
      paymentTermsAtSubmit: paymentTerms,
      pendingRole: null,
      slaDueAt: null,
      reviewedById: world.user(o.reviewer).id,
      reviewedAt: now,
      decisionReason: o.reason ?? world.name('Sent back'),
    },
  });
  return id;
}

/**
 * A pending reactivation request on a world branch, as services/reactivations.ts
 * writes one (pendingRole MANAGER), without its evidence photo: the Work and
 * Needs-correction lists read only the row.
 */
export async function seedReactivationRow(world: World, o: { branch: string; submitter: string; reason?: string }): Promise<string> {
  const b = world.branch(o.branch);
  const id = newId();
  world.adopt.edit(id);
  const now = new Date();
  await db.customerEdit.create({
    data: {
      id,
      target: 'BRANCH',
      branchId: b.id,
      customerId: b.customerId,
      state: 'SUBMITTED',
      submittedById: world.user(o.submitter).id,
      submittedAt: now,
      isReactivation: true,
      decisionReason: o.reason ?? world.name('Shop has reopened'),
      pendingRole: 'MANAGER',
      stageEnteredAt: now,
      slaDueAt: stepDeadline(now, 24 * 30),
      fieldChanges: [{ field: `branch.${b.id}.status`, before: 'CLOSED', after: 'ACTIVE' }] as unknown as Prisma.InputJsonValue,
      attachmentChanges: [] as unknown as Prisma.InputJsonValue,
    },
  });
  return id;
}

/** The salesman's bottom tab bar (components/nmwc/Sidebar.tsx MobileTabBar). */
export function tabBar(page: Page): Locator {
  return page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Me', exact: true }) });
}

/** The value printed above a Today stat's label ("Route branches", "Pending approval", "Needs correction"). */
export function todayStat(page: Page, label: string): Locator {
  return page.locator('main').getByText(label, { exact: true }).locator('xpath=preceding-sibling::div[1]');
}

/**
 * Fills the new-customer form completely, as a salesman at the shop does: CASH,
 * identity, a channel with its sub-channel, contact, the branch's address, a
 * GPS fix from the phone, its visit day, and the three photos (CR document,
 * shop front, signboard) through the camera input. Waits until Submit is enabled.
 * `photos`: the files to pick (a picture picked again, production walk
 * 2026-10-09); a fresh PNG for each slot otherwise.
 */
export async function fillCreateForm(
  page: Page,
  o: {
    legalName: string;
    crNumber: string;
    phone: string;
    contact: string;
    channelLabel: string;
    day: DayOfWeek;
    address: string;
    photos?: { cr: PickedFile; shop: PickedFile; sign: PickedFile };
  }
): Promise<void> {
  await page.goto('/customers/new');
  await settled(page);
  await page.getByLabel('Legal name *', { exact: true }).fill(o.legalName);
  await page.getByLabel('CR number *', { exact: true }).fill(o.crNumber);
  await page.getByLabel('Channel *', { exact: true }).selectOption({ label: o.channelLabel });
  const sub = page.getByLabel('Sub-channel *', { exact: true });
  await expect(sub).toBeEnabled();
  await sub.selectOption({ index: 1 });
  await page.getByLabel('Primary phone *', { exact: true }).fill(o.phone);
  await page.getByLabel('Contact person *', { exact: true }).fill(o.contact);
  await page.getByLabel('Address *', { exact: true }).fill(o.address);
  await page.getByRole('button', { name: /^Capture GPS/ }).click();
  await expect(page.getByText('23.588100, 58.382900')).toBeVisible();
  await page.getByLabel('Day of visit *', { exact: true }).selectOption(o.day);
  for (const [label, name] of [
    ['CR document', 'cr'],
    ['Shop front', 'shop'],
    ['Signboard', 'sign'],
  ] as const) {
    const slot = photoSlot(page, label);
    await pickFile(slot, o.photos?.[name] ?? pngFile(name));
    await expect(retakeOf(slot), `${label} photo is in`).toBeVisible({ timeout: 120_000 });
  }
  await expect(page.getByRole('button', { name: 'Submit for approval ▶' })).toBeEnabled({ timeout: 30_000 });
}
