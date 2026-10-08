/**
 * Helpers for tests/e2e/launch/update-flow.spec.ts (the enrichment / UPDATE
 * request flow). Additive: nothing here changes the shared support files.
 *
 * Locators follow the app's own markup (read from the code, never guessed):
 *   - app/(app)/customers/[id]/edit/EnrichmentForm.tsx — LabeledField labels are
 *     associated (htmlFor), each branch is a <details> whose <h3> reads
 *     "Branch N: <branchName>", the missing list is
 *     <div><strong>Cannot submit yet — missing:</strong> A, B. Save as a draft…</div>;
 *   - components/nmwc/PhotoCaptureSlot.tsx — a slot is the <div> whose direct
 *     child is the hidden <input type="file">, labelled "Shop front",
 *     "Signboard", "CR document" or "Other";
 *   - app/(app)/today/page.tsx Stat — <div><div>{value}</div><div>{label}</div></div>.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { countFieldChanges } from '../../../../lib/gps-manual';
import { omanWhen } from '../../../../lib/submission';
import { omanDateTime } from '../../../../lib/tz';
import { db } from './env';
import type { World } from './types';

export { omanDateTime, omanWhen };

/** Escapes a value for use inside a RegExp. */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits until React has hydrated the element (its props are attached): a click
 * or a keystroke before that is lost or reset. Defaults to the enrichment form's
 * <fieldset>.
 */
export async function waitHydrated(target: Page | Locator, timeout = 60_000): Promise<void> {
  const isPage = (t: Page | Locator): t is Page => typeof (t as Page).goto === 'function';
  const loc = isPage(target) ? target.locator('fieldset').first() : target;
  await loc.waitFor({ state: 'attached', timeout });
  await expect
    .poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps$'))), {
      timeout,
      message: 'the element is hydrated by React',
    })
    .toBe(true);
}

/** The enrichment form's Submit button, in any of its states. */
export function submitButton(page: Page): Locator {
  return page.getByRole('button', { name: /^(Submit for approval ▶|Submitting…|Sent ✓)$/ });
}

/** The enrichment form's Save draft button. */
export function saveDraftButton(page: Page): Locator {
  return page.getByRole('button', { name: /^(Save draft|Saving…)$/ });
}

/** The amber "Cannot submit yet — missing:" box under the sticky bar. */
export function missingBox(page: Page): Locator {
  return page.getByText('Cannot submit yet — missing:', { exact: true }).locator('xpath=..');
}

/** Asserts the missing list exactly (or that there is none). */
export async function expectMissing(page: Page, items: string[]): Promise<void> {
  if (items.length === 0) {
    await expect(missingBox(page)).toHaveCount(0);
    return;
  }
  await expect(missingBox(page)).toHaveText(
    `Cannot submit yet — missing: ${items.join(', ')}. Save as a draft and finish the rest before submitting.`
  );
  await expect(submitButton(page)).toBeDisabled();
  await expect(submitButton(page)).toHaveAttribute('title', `Missing: ${items.join(', ')}`);
}

/**
 * One branch's section of the enrichment form, found by its branch name, and
 * its number ("Branch N") as the form numbers it — the order the page loaded
 * the branches in, which a test must not assume.
 */
export async function branchSection(page: Page, branchName: string): Promise<{ section: Locator; n: number; tag: string }> {
  const heading = page.getByRole('heading', { level: 3, name: new RegExp(`^Branch \\d+: ${esc(branchName)}$`) });
  await expect(heading).toHaveCount(1);
  const text = ((await heading.textContent()) ?? '').trim();
  const n = Number(/^Branch (\d+):/.exec(text)?.[1]);
  expect(n, `branch number in "${text}"`).toBeGreaterThan(0);
  return { section: page.locator('details').filter({ has: heading }), n, tag: `Branch ${n}` };
}

/** A photo slot by its label ('Shop front', 'Signboard', 'CR document', 'Other'). */
export function photoSlot(scope: Page | Locator, label: 'Shop front' | 'Signboard' | 'CR document' | 'Other'): Locator {
  return scope.locator('xpath=.//div[input[@type="file"]]').filter({ hasText: label }).first();
}

/** Picks a file in a slot, as the camera input would hand it over. */
export async function pickFile(slot: Locator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await slot.locator('input[type="file"]').setInputFiles(file);
}

/** The GPS button of a branch section ("Capture GPS *" first, "Recapture GPS" after). */
export function gpsButton(section: Locator): Locator {
  return section.getByRole('button', { name: /^(Capture GPS|Recapture GPS|Capturing…)/ });
}

/** The GPS chip of a branch section (data-accuracy-band: good | fair | poor | unknown | manual). */
export function gpsChip(section: Locator): Locator {
  return section.locator('[data-accuracy-band]');
}

/** A Today tile's number, by its label ('Route branches', 'Pending approval', 'Needs correction'). */
export function stat(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=preceding-sibling::div[1]');
}

/** The top bar's bell link (its name carries the counts: "Notifications (1 unread)"). */
export function bell(page: Page): Locator {
  return page.locator('header a[href="/notifications"]');
}

/**
 * Holds the next DOCUMENT load of `url` for `ms` — weak signal: the old page,
 * and the line it shows just before it leaves (the form's "It arrived"), stay
 * up a while. Read that line with watchForText (a locator waits for the
 * navigation instead). The navigation then goes on unchanged. Returns the undo.
 */
export async function slowNextDocument(page: Page, url: RegExp, ms = 2_000): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    if (route.request().resourceType() === 'document') await sleep(ms);
    await route.fallback();
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler).catch(() => undefined);
}

let sawSeq = 0;

/**
 * Watches the CURRENT document for `text` and reports when it first appears —
 * even when the page then leaves by a document load (the form's "It arrived"
 * line, said just before location.replace). A locator cannot read it there:
 * once the navigation starts, Playwright waits for it to finish before it
 * queries, and the next page no longer has the line. The observer reports
 * through an exposed binding, so the answer survives the navigation.
 * Returns a getter: the time it was seen, or null.
 */
export async function watchForText(page: Page, text: string): Promise<() => number | null> {
  const name = `__e2eSawText${++sawSeq}`;
  let at: number | null = null;
  await page.exposeBinding(name, () => {
    at ??= Date.now();
  });
  await page.evaluate(
    ({ name, text }) => {
      const report = (window as unknown as Record<string, () => void>)[name]!;
      let done = false;
      const check = () => {
        if (!done && (document.body?.textContent ?? '').includes(text)) {
          done = true;
          report();
        }
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
      check();
    },
    { name, text }
  );
  return () => at;
}

/**
 * Rewrites the body of the NEXT enrichment submit the page sends (POST
 * /api/forms/customer-edit) before it leaves the browser — a body the form's
 * own gate would never build, sent by the real page, so the answer is shown by
 * the real form. Same origin, JSON only; nothing secret is in it.
 */
export async function rewriteNextEditSubmit(
  page: Page,
  mutate: (body: { customer: Record<string, unknown>; customerBase: Record<string, unknown>; branches: Array<Record<string, unknown>> }) => void
): Promise<() => Promise<void>> {
  const url = '**/api/forms/customer-edit';
  let done = false;
  const handler = async (route: Route) => {
    if (done || route.request().method() !== 'POST') return route.fallback();
    done = true;
    const body = JSON.parse(route.request().postData() ?? '{}') as Parameters<typeof mutate>[0];
    mutate(body);
    await route.fallback({ postData: JSON.stringify(body) });
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler).catch(() => undefined);
}

/** Holds the next request to `url` (e.g. the photo presign) for `ms`, then lets it go. */
export async function holdNextRequest(page: Page, url: string, ms: number): Promise<() => Promise<void>> {
  let done = false;
  const handler = async (route: Route) => {
    if (!done) {
      done = true;
      await sleep(ms);
    }
    await route.fallback();
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler).catch(() => undefined);
}

/** "<name> submitted N change(s)" — the customer page's Recent activity line for an update (app/(app)/customers/[id]/activity.ts). */
export function activityLine(fullName: string, fieldChanges: unknown): string {
  return `${fullName} submitted ${countFieldChanges(fieldChanges)} change(s)`;
}

/** The id of a channel by key (reference data; read only). */
export async function channelId(key = 'GENERAL_TRADE'): Promise<string> {
  return (await db.channel.findFirstOrThrow({ where: { key }, select: { id: true } })).id;
}

/** The requests on one customer, newest first. */
export async function editsOn(customerId: string, state?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'NEEDS_CORRECTION' | 'REJECTED') {
  return db.customerEdit.findMany({
    where: { customerId, ...(state ? { state } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

/** Waits for (and returns) the one SUBMITTED request on a customer. */
export async function submittedEditOn(customerId: string) {
  await expect.poll(async () => (await editsOn(customerId, 'SUBMITTED')).length, { timeout: 30_000 }).toBe(1);
  return (await editsOn(customerId, 'SUBMITTED'))[0]!;
}

/** Polls a branch's photo slot until it holds a photo other than `not`; returns the attachment id. */
export async function waitForBranchPhoto(branchId: string, slot: 'shop' | 'signboard', not: string | null = null, timeout = 120_000): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(
      async () => {
        const b = await db.branch.findUniqueOrThrow({ where: { id: branchId }, select: { shopPhotoId: true, signboardPhotoId: true } });
        id = slot === 'shop' ? b.shopPhotoId : b.signboardPhotoId;
        return id !== null && id !== not;
      },
      { timeout, message: `the ${slot} photo is attached (presign → R2 PUT → finalize → attach)` }
    )
    .toBe(true);
  return id!;
}

/** Polls the customer's CR slot until it holds a photo; returns the attachment id. */
export async function waitForCrPhoto(customerId: string, timeout = 120_000): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(
      async () => {
        id = (await db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { crPhotoId: true } })).crPhotoId;
        return id !== null;
      },
      { timeout, message: 'the CR photo is attached' }
    )
    .toBe(true);
  return id!;
}

/**
 * Registers every photo the world's users took since `since` — the browser
 * uploads (presign → finalize) and the evidence photos of a refused close —
 * so cleanup removes them and their R2 objects. A photo never attached to a
 * world row is otherwise foreign to cleanup and keeps the world dirty.
 */
export async function adoptPhotosTaken(world: World, since: Date): Promise<number> {
  const rows = await db.attachment.findMany({
    where: { capturedById: { in: world.users().map((u) => u.id) }, createdAt: { gte: since } },
    select: { id: true },
  });
  for (const r of rows) world.adopt.attachment(r.id);
  return rows.length;
}

/**
 * The world's cleanup, after adopting its users' photos and removing their
 * draft-save buckets ('edit-draft:<id>', a bucket cleanup does not know yet —
 * services/edits.ts gives Save draft its own since the launch fixes).
 */
export async function cleanupUpdateWorld(world: World | undefined, since: Date): Promise<void> {
  if (!world) return;
  await adoptPhotosTaken(world, since);
  await db.rateLimit.deleteMany({ where: { key: { in: world.users().map((u) => `edit-draft:${u.id}`) } } });
  await world.cleanup();
}
