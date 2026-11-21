/**
 * Helpers for tests/e2e/launch/photo-loading.spec.ts: the photo route's HEAD
 * and its store connection, and the paced loading of a page with more than 40
 * photos (components/nmwc/photo-queue.ts, RoutePhoto.tsx, PhotoQueueStatus.tsx).
 *
 * The paced cases never ask the real photo store for a photo: the customer's
 * photo rows are seeded WITHOUT objects (seedPhotoRows, spec amendment M3) and
 * answerPhotos() answers every /api/photos/* request of the page itself, so the
 * app server and the store see none of them. What the page asks for, when, and
 * how many at once is what these helpers record.
 *
 * Words and attributes are read from the components, never guessed:
 *   - RoutePhoto: data-photo-state "waiting" (a span, role img, no <img>),
 *     "loading" / "loaded" (a new <img> per try), "failed" (a span whose text is
 *     "Not loaded");
 *   - PhotoQueueStatus: "1 photo did not load." / "{n} photos did not load." in a
 *     <p>, beside a "Try again" button; while the queue is paced and photos
 *     wait, "Showing {loaded} of {total} photos. The rest load …" in a <p>; the same sentence is also said by a
 *     visually hidden live region (a <span>), so a test reads the <p>;
 *   - PhotoCaptureSlot: REMOTE_PHOTO_FAILED_MESSAGE (photo-slot-words.ts).
 * The queue's numbers come from the module itself (it is plain TypeScript, no
 * React), so a change there is a change here.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { MAX_FAILURES, MAX_IN_FLIGHT, PACE_MS } from '../../../../components/nmwc/photo-queue';
import { PHOTO_QUEUE_FROM } from '../../../../lib/photo-pacing';
import { db } from './env';
import { seedPhotoRows } from './photos';
import type { SeededPhoto, World } from './types';

export { MAX_FAILURES, MAX_IN_FLIGHT, PACE_MS, PHOTO_QUEUE_FROM };
export { REMOTE_PHOTO_FAILED_MESSAGE } from './photo-slot-words';

/** PhotoQueueStatus's sentence for failed photos (photosNotLoadedText, copied: a .tsx client component). */
export function photosNotLoadedText(n: number): string {
  return n === 1 ? '1 photo did not load.' : `${n} photos did not load.`;
}

/** PhotoQueueStatus's paced line (photosPacedText, copied: a .tsx client component). */
export function photosPacedText(loaded: number, total: number): string {
  return `Showing ${loaded} of ${total} photos. The rest load one by one, about one a second.`;
}

/** The paced line with any loaded count, as a <p> of exactly that sentence. */
export function pacedSentence(page: Page, total: number) {
  const [head, tail] = photosPacedText(0, total).split('0 of');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator('p').filter({ hasText: new RegExp(`^${esc(head!)}\\d+ of${esc(tail!)}$`) });
}

/** RoutePhoto's failed tile text. */
export const NOT_LOADED = 'Not loaded';
/** PhotoQueueStatus's button. */
export const TRY_AGAIN = 'Try again';

/** The status line's visible sentence (a <p>; the live region is a <span>). */
export function statusSentence(page: Page, text: string) {
  return page.locator('p').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
}

/**
 * One customer with `shops` shops on `route`, each with a shop and a signboard
 * photo, and a CR document: 2 × shops + 1 photo rows, none of them uploaded.
 * Built with the world's own customer seeding, then the rows wired into the
 * live slots exactly as seedPhotos wires them.
 */
export async function seedManyPhotoCustomer(
  w: World,
  o: { key: string; shops: number; route: string; capturedBy: string; contact: string }
): Promise<{ customerId: string; photos: SeededPhoto[] }> {
  const c = await w.addCustomer({
    key: o.key,
    phone: true,
    contact: o.contact,
    branches: Array.from({ length: o.shops }, (_, i) => ({ key: `S${String(i + 1).padStart(2, '0')}`, route: o.route })),
  });
  const branches = Object.values(c.branches);
  const photos = await seedPhotoRows(w, [
    { kind: 'CR', capturedBy: o.capturedBy, customerId: c.id, wire: 'CR' },
    ...branches.flatMap((b) => [
      { kind: 'SHOP' as const, capturedBy: o.capturedBy, branchId: b.id, wire: 'SHOP' as const },
      { kind: 'SIGNBOARD' as const, capturedBy: o.capturedBy, branchId: b.id, wire: 'SIGNBOARD' as const },
    ]),
  ]);
  c.photos.push(...photos);
  return { customerId: c.id, photos };
}

export interface PhotoRequest {
  path: string;
  search: string;
  /** The id in /api/photos/<id>, or null when the path is not that shape. */
  id: string | null;
  /** When the request reached the route (ms, Date.now()). */
  at: number;
  status: number;
  /** How many requests of this id had arrived, this one included. */
  nth: number;
}

export interface AnsweredPhotos {
  readonly requests: PhotoRequest[];
  /** The most requests the route held at one time. */
  maxInFlight(): number;
  /** The id chosen to fail: the last photo of the page to be asked for (null until then). */
  failId(): string | null;
  /** When the first 502 was sent (null before). */
  firstFailureAt(): number | null;
  /** Lets held requests go on (with `hold`). */
  release(): void;
  /** From now on the chosen id is answered 200. */
  stopFailing(): void;
  /** Answers 200 per id. */
  okCount(id: string): number;
}

/**
 * Answers EVERY request of `page` whose path starts with /api/photos/ itself:
 * a photo of `photos` gets its own seeded bytes with a 200 after `delayMs`
 * (so requests overlap and can be counted); anything else gets 404 and is
 * recorded, so a test can fail on it.
 *
 * `fail`: the LAST photo of the page to be asked for (the request that makes
 * the distinct count reach photos.length) is the one that fails, with a 502
 * as the photo route sends it, on its first `times` requests (Infinity: on
 * every request). The last one is chosen because the queue paces every start
 * after the first failure: a photo failing early would make all the photos
 * after it load one by one (about 1.1 s each), a photo failing last costs only
 * its own retries.
 *
 * `fail.at` chooses another one instead: the photo that is the at-th distinct
 * one to be asked for (1-based). With `fail.alone`, its first 502 is sent only
 * once every request that came before it has been answered, plus SETTLE_MS,
 * and the requests that come after it wait until SETTLE_MS after that 502: so
 * every photo the burst started has started before the failure reaches the
 * page, and every start after it is one the queue made after the failure.
 *
 * `hold`: requests wait at the route until release() — the page then shows,
 * frozen, what it has started and what still waits.
 */
export async function answerPhotos(
  page: Page,
  photos: SeededPhoto[],
  o: { delayMs?: number; hold?: boolean; fail?: { times: number; at?: number; alone?: boolean } } = {}
): Promise<AnsweredPhotos> {
  const delayMs = o.delayMs ?? 150;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const requests: PhotoRequest[] = [];
  const seen = new Map<string, number>();
  const ok = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let failId: string | null = null;
  let firstFailureAt: number | null = null;
  let failing = Boolean(o.fail);
  let open!: () => void;
  const gate = o.hold ? new Promise<void>((r) => (open = r)) : Promise.resolve();
  if (!o.hold) open = () => undefined;
  const failAt = o.fail?.at ?? byId.size;
  // fail.alone: the requests after the failing one wait for `afterFailure`.
  let failEntry: PhotoRequest | null = null;
  let afterFailureOpen!: () => void;
  const afterFailure = new Promise<void>((r) => (afterFailureOpen = r));

  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const url = new URL(req.url());
    const m = /^\/api\/photos\/([^/]+)$/.exec(url.pathname);
    const id = m && byId.has(m[1]!) ? m[1]! : null;
    const nth = id ? (seen.get(id) ?? 0) + 1 : 0;
    if (id) seen.set(id, nth);
    if (id && nth === 1 && o.fail && failId === null && seen.size === failAt) failId = id;
    const entry: PhotoRequest = { path: url.pathname, search: url.search, id, at: Date.now(), status: 0, nth };
    const before = [...requests];
    requests.push(entry);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const isFirstFailure = Boolean(o.fail?.alone) && id !== null && id === failId && nth === 1;
    if (isFirstFailure) failEntry = entry;
    const waitsForFailure = Boolean(o.fail?.alone) && failEntry !== null && entry !== failEntry && firstFailureAt === null;
    try {
      await gate;
      if (isFirstFailure) {
        // Every earlier request answered, and the page given time to start what it starts on them.
        const until = Date.now() + 30_000;
        while (before.some((b) => b.status === 0) && Date.now() < until) await sleep(20);
        await sleep(SETTLE_MS);
      } else if (waitsForFailure) {
        await afterFailure;
      }
      await sleep(delayMs);
      if (!id || url.search !== '') {
        entry.status = 404;
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"NOT_FOUND"}' });
      } else if (failing && id === failId && nth <= o.fail!.times) {
        entry.status = 502;
        firstFailureAt ??= Date.now();
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: '{"error":"R2_FETCH_FAILED"}',
        });
        if (isFirstFailure) void sleep(SETTLE_MS).then(afterFailureOpen);
      } else {
        entry.status = 200;
        ok.set(id, (ok.get(id) ?? 0) + 1);
        await route.fulfill({
          status: 200,
          contentType: 'image/jpeg',
          headers: { 'cache-control': 'private, max-age=3600, immutable', etag: `"p-${id}"` },
          body: byId.get(id)!.bytes,
        });
      }
    } catch {
      // The page closed while the request waited: nothing to answer.
    } finally {
      inFlight--;
    }
  };
  await page.route((u) => u.pathname.startsWith('/api/photos/'), handler);

  return {
    requests,
    maxInFlight: () => maxInFlight,
    failId: () => failId,
    firstFailureAt: () => firstFailureAt,
    release: () => open(),
    stopFailing: () => {
      failing = false;
    },
    okCount: (id) => ok.get(id) ?? 0,
  };
}

/** With fail.alone: how long the route lets the page settle before and after the failure. */
export const SETTLE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A photo's start or failure as the page saw it (browser clock, ms). */
export interface PageEvent {
  id: string;
  t: number;
}

/**
 * Records, in the page itself, when each try of a photo starts (RoutePhoto
 * mounts a new <img> per try: the moment it is added to the document) and
 * when an <img> of a photo fails (its error event, in the capture phase, so
 * before the component hears it). Times taken in the page do not depend on
 * how soon Playwright delivers a route event to the test. Call before goto.
 */
export async function recordPhotoEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __e2ePhotoStarts: Array<{ id: string; t: number }>; __e2ePhotoErrors: Array<{ id: string; t: number }> };
    w.__e2ePhotoStarts = [];
    w.__e2ePhotoErrors = [];
    const idOf = (el: Element) => {
      const m = /^\/api\/photos\/([^/?]+)/.exec(el.getAttribute('src') ?? '');
      return m ? m[1]! : null;
    };
    const seenImg = new WeakSet<Element>();
    const note = (el: Element) => {
      if (el.tagName !== 'IMG' || seenImg.has(el)) return;
      const id = idOf(el);
      if (!id) return;
      seenImg.add(el);
      w.__e2ePhotoStarts.push({ id, t: Date.now() });
    };
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          note(n);
          for (const img of n.querySelectorAll('img')) note(img);
        }
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener(
      'error',
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLImageElement)) return;
        const id = idOf(el);
        if (id) w.__e2ePhotoErrors.push({ id, t: Date.now() });
      },
      true
    );
  });
}

/** What recordPhotoEvents saw so far. */
export async function photoEvents(page: Page): Promise<{ starts: PageEvent[]; errors: PageEvent[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __e2ePhotoStarts?: PageEvent[]; __e2ePhotoErrors?: PageEvent[] };
    return { starts: [...(w.__e2ePhotoStarts ?? [])], errors: [...(w.__e2ePhotoErrors ?? [])] };
  });
}

/**
 * The gaps (ms) between consecutive starts, from the last start at or before
 * `t` on (so the first gap is the one the failure at `t` paced).
 */
export function gapsAfter(starts: PageEvent[], t: number): number[] {
  const at = starts.map((s) => s.t).sort((a, b) => a - b);
  const from = at.reduce((last, x, i) => (x <= t ? i : last), -1);
  const gaps: number[] = [];
  for (let i = Math.max(0, from) + 1; i < at.length; i++) gaps.push(at[i]! - at[i - 1]!);
  return gaps;
}

/** Every [data-photo-state] on the page, in document order. */
export async function photoStates(page: Page): Promise<string[]> {
  return page.locator('[data-photo-state]').evaluateAll((els) => els.map((e) => e.getAttribute('data-photo-state') ?? ''));
}

/** Waits until the page has exactly `n` photo tiles and every one is in `state`. */
export async function expectAllPhotos(page: Page, n: number, state: string, timeout = 60_000): Promise<void> {
  await expect
    .poll(async () => {
      const s = await photoStates(page);
      return s.length === n && s.every((x) => x === state) ? 'all' : `${s.length} tiles: ${JSON.stringify(count(s))}`;
    }, { timeout, message: `${n} photos ${state}` })
    .toBe('all');
}

function count(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/** The loaded <img> of every id, with its decoded width (0 = not a picture). */
export async function loadedImages(page: Page): Promise<Array<{ src: string; state: string | null; width: number }>> {
  return page
    .locator('img[src^="/api/photos/"]')
    .evaluateAll((els) =>
      (els as HTMLImageElement[]).map((i) => ({ src: i.getAttribute('src') ?? '', state: i.getAttribute('data-photo-state'), width: i.naturalWidth }))
    );
}

/** Where a photo row is wired now (its live slot), read from the database. */
export async function liveSlotOf(attachmentId: string): Promise<{ crOf: string | null; shopOf: string | null; signboardOf: string | null; deletedAt: Date | null }> {
  const a = await db.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
    select: {
      deletedAt: true,
      customerCrPhoto: { select: { id: true } },
      branchShopPhoto: { select: { id: true } },
      branchSignboardPhoto: { select: { id: true } },
    },
  });
  return {
    crOf: a.customerCrPhoto?.id ?? null,
    shopOf: a.branchShopPhoto?.id ?? null,
    signboardOf: a.branchSignboardPhoto?.id ?? null,
    deletedAt: a.deletedAt,
  };
}
