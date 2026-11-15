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
 *     <p>, beside a "Try again" button; the same sentence is also said by a
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
 * `hold`: requests wait at the route until release() — the page then shows,
 * frozen, what it has started and what still waits.
 */
export async function answerPhotos(
  page: Page,
  photos: SeededPhoto[],
  o: { delayMs?: number; hold?: boolean; fail?: { times: number } } = {}
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

  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const url = new URL(req.url());
    const m = /^\/api\/photos\/([^/]+)$/.exec(url.pathname);
    const id = m && byId.has(m[1]!) ? m[1]! : null;
    const nth = id ? (seen.get(id) ?? 0) + 1 : 0;
    if (id) seen.set(id, nth);
    if (id && nth === 1 && o.fail && failId === null && seen.size === byId.size) failId = id;
    const entry: PhotoRequest = { path: url.pathname, search: url.search, id, at: Date.now(), status: 0, nth };
    requests.push(entry);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await gate;
      await new Promise((r) => setTimeout(r, delayMs));
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

/**
 * The gaps (ms) between consecutive photo requests from the last one that
 * started before `t` on (so the first gap is the one the first failure paced).
 */
export function startGapsFrom(requests: PhotoRequest[], t: number): number[] {
  const at = requests.map((r) => r.at).sort((a, b) => a - b);
  const firstAfter = at.findIndex((x) => x >= t);
  if (firstAfter < 0) return [];
  const from = Math.max(0, firstAfter - 1);
  const gaps: number[] = [];
  for (let i = from + 1; i < at.length; i++) gaps.push(at[i]! - at[i - 1]!);
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
