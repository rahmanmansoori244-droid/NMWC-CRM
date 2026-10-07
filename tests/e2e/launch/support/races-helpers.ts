/**
 * Helpers for tests/e2e/launch/races.spec.ts only (additive; no other support
 * file is changed).
 *
 *   clickTogether()   — the barrier. Every racer's control is first proved on
 *                       screen, enabled and hydrated by React; then each page
 *                       is handed ONE wall-clock instant and clicks its own
 *                       control at that instant (setTimeout, then a spin for
 *                       the last few milliseconds: timers are coarse). The
 *                       pages share this machine's clock, so the clicks land
 *                       within a few milliseconds of each other — far closer
 *                       than Playwright's own clicks, which each wait for
 *                       actionability first. The spread is measured and capped.
 *   trackPosts() / expectOverlap() — the proof that the race was real: every
 *                       racing POST had left its page before the first of them
 *                       was answered.
 *   tapRepeatedly()   — more taps on a control that may be disabled or gone,
 *                       as a thumb does while a page works (no actionability
 *                       wait: a disabled button simply takes no click).
 *   slowAnswers() / resendAlongside() — a slow reply to the phone, and the same
 *                       send arriving at the server twice at once.
 *   approvableCustomer(), seedCreateRequest(), waitHydrated().
 *
 * Every id is minted here and written to the world's registry BEFORE its row
 * is inserted, as the harness requires; every typed value carries the suffix.
 */
import { expect, type ElementHandle, type Locator, type Page, type Request } from '@playwright/test';
import type { PaymentTerms, Prisma, Role } from '@prisma/client';
import { resolveChain, stepDeadline } from '../../../../lib/approval-chains';
import { normalizeCR } from '../../../../lib/cr';
import { postJson } from './api';
import { db, safeError } from './env';
import { newId } from './ids';
import { OMAN_TODAY, omanDayAfter } from './oman';
import type { CustomerSpec, World } from './types';
import { MUSCAT } from './world';

const GPS = { lat: MUSCAT.lat, lng: MUSCAT.lng, accuracy: MUSCAT.accuracy };

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * A customer whose customer-level request (a contact-person change) passes the
 * salesman's gate and the approval re-check with no photo, whatever
 * SALESMAN_SUBMIT_GATE is: on a CREDIT customer the CR number and the CR
 * document are not the salesman's (owner decision 2), so the gate reads channel,
 * sub-channel, phone and contact only — all present — and no branch (owner
 * decision 4). The same shape as approvals-queue's, so no race needs R2.
 */
export function approvableCustomer(key: string, route: string, extra: Partial<CustomerSpec> = {}): CustomerSpec {
  return {
    key,
    paymentTerms: 'CREDIT',
    creditLimit: '500.000',
    termDays: 30,
    phone: true,
    contact: 'Khalid Al Harthy',
    crNumber: true,
    subChannel: true,
    branches: [{ key: 'S', route, gps: GPS, day: omanDayAfter(2), address: 'Way 3012, Al Ghubra North, Muscat' }],
    ...extra,
  };
}

const counters = new WeakMap<World, number>();
function next(w: World): number {
  const n = (counters.get(w) ?? 0) + 1;
  counters.set(w, n);
  return n;
}

/**
 * A new-customer request waiting at `step` of its frozen chain, as
 * services/creates.ts leaves a submitted one (drafts, chain, SLA clock); the
 * steps before it recorded as approved by `priorApprovers` (user keys, one per
 * step). No photos: finalize re-checks only the photos a request names, so a
 * request that names none is created without R2.
 */
export async function seedCreateRequest(
  w: World,
  o: { submitter: string; step: Role; priorApprovers: string[]; paymentTerms?: PaymentTerms }
): Promise<{ id: string; legalName: string; crNumberNorm: string }> {
  const terms: PaymentTerms = o.paymentTerms ?? 'CASH';
  const chain = resolveChain('CREATE', terms);
  const stepIndex = chain.findIndex((s) => s.role === o.step);
  if (stepIndex < 0) throw new Error(`seedCreateRequest: a ${terms} request has no ${o.step} step`);
  const n = next(w);
  const legalName = w.name(`Race shop ${n}`);
  const submitter = w.user(o.submitter);
  if (!submitter.routeId) throw new Error(`seedCreateRequest: ${o.submitter} owns no route`);
  const route = await db.route.findUniqueOrThrow({ where: { id: submitter.routeId }, select: { id: true, regionId: true } });
  const ch = await db.channel.findFirst({
    where: { key: 'GENERAL_TRADE' },
    select: { id: true, subChannels: { where: { isActive: true }, select: { id: true }, orderBy: { key: 'asc' }, take: 1 } },
  });
  if (!ch || ch.subChannels.length === 0) throw new Error('GENERAL_TRADE with an active sub-channel is not on this database');
  const [phone] = await w.allocPhones(1);
  const cr = `CRR${w.SFX}${String(n).padStart(2, '0')}`;
  const crNumberNorm = normalizeCR(cr)!;
  const now = new Date();
  const step = chain[stepIndex]!;
  const id = newId();
  w.registry.add('editIds', id);
  try {
    await db.customerEdit.create({
      data: {
        id,
        target: 'CUSTOMER',
        process: 'CREATE',
        customerId: null,
        state: 'SUBMITTED',
        submittedById: submitter.id,
        submittedAt: now,
        fieldChanges: [] as unknown as Prisma.InputJsonValue,
        attachmentChanges: [] as unknown as Prisma.InputJsonValue,
        paymentTermsAtSubmit: terms,
        approvalChain: chain as unknown as Prisma.InputJsonValue,
        currentStepIndex: stepIndex,
        pendingRole: step.role,
        cycle: 1,
        requestedCreditLimit: terms === 'CREDIT' ? '1500.000' : null,
        requestedPaymentTermDays: terms === 'CREDIT' ? 30 : null,
        stageEnteredAt: now,
        slaDueAt: stepDeadline(now, step.slaHours),
        escalationLevel: 0,
      },
    });
    await db.editCustomerDraft.create({
      data: {
        editId: id,
        legalName,
        paymentTerms: terms,
        crNumber: cr,
        crNumberNorm,
        channelId: ch.id,
        subChannelId: ch.subChannels[0]!.id,
        primaryPhone: phone!,
        primaryPhoneNorm: phone!,
        contactPerson: 'Saif Al Hinai',
      },
    });
    await db.editBranchDraft.create({
      data: {
        id: newId(),
        editId: id,
        branchName: `${legalName} B1`,
        regionId: route.regionId,
        routeId: route.id,
        address: 'Way 3012, Al Ghubra North, Muscat',
        gpsLat: GPS.lat,
        gpsLng: GPS.lng,
        gpsAccuracy: GPS.accuracy,
        gpsCapturedAt: now,
        dayOfVisit: OMAN_TODAY,
        extraPhotoAttachmentIds: [] as unknown as Prisma.InputJsonValue,
      },
    });
    for (let i = 0; i < stepIndex; i++) {
      const by = o.priorApprovers[i];
      if (!by) throw new Error(`seedCreateRequest: no approver given for step ${i} (${chain[i]!.role})`);
      await db.editApproval.create({
        data: { editId: id, cycle: 1, stepIndex: i, role: chain[i]!.role, decision: 'APPROVED', actorId: w.user(by).id, at: now },
      });
    }
  } catch (err) {
    throw safeError(err, 'seedCreateRequest insert failed');
  }
  return { id, legalName, crNumberNorm };
}

// ── the page is ready ────────────────────────────────────────────────────────

/**
 * Waits until React has hydrated the element (its props are attached): a click
 * before that is lost. A Locator for one element.
 */
export async function waitHydrated(target: Locator, timeout = 60_000): Promise<void> {
  await target.waitFor({ state: 'attached', timeout });
  await expect
    .poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps$'))), {
      timeout,
      message: 'the element is hydrated by React',
    })
    .toBe(true);
}

// ── the barrier ──────────────────────────────────────────────────────────────

export type Racer = {
  /** Who presses it, for the messages. */
  name: string;
  /** The control: a button, or a form's submit button. */
  target: Locator;
  /** Clicks at the instant, in ONE task (2 = a double tap faster than any re-render). Default 1. */
  taps?: number;
};

/**
 * In the page: waits for the shared instant, then clicks. A function on its own
 * (Playwright sends its source to the page): nothing from outside it is used.
 */
function clickAt(el: Element, a: { at: number; taps: number }): Promise<number> {
  return new Promise<number>((resolve) => {
    const fire = () => {
      while (Date.now() < a.at) {
        // The last few milliseconds: timers are too coarse to land on the instant.
      }
      const firedAt = Date.now();
      for (let i = 0; i < a.taps; i++) (el as HTMLElement).click();
      resolve(firedAt);
    };
    const wait = a.at - Date.now() - 30;
    if (wait > 0) setTimeout(fire, wait);
    else fire();
  });
}

/**
 * Presses every racer's control at the same instant. First the barrier: each is
 * visible, enabled and hydrated; only then is the instant fixed, `leadMs` ahead
 * (time for every page to receive its order). Returns each racer's firing time
 * relative to the instant, and fails when they fired further apart than
 * `maxSpreadMs` — the race would not have been one.
 */
export async function clickTogether(
  racers: Racer[],
  o: { leadMs?: number; maxSpreadMs?: number } = {}
): Promise<Record<string, number>> {
  for (const r of racers) {
    await expect(r.target, `${r.name}: the control is on screen`).toBeVisible();
    await expect(r.target, `${r.name}: the control is enabled`).toBeEnabled();
    await waitHydrated(r.target);
  }
  const at = Date.now() + (o.leadMs ?? 1_500);
  const fired = await Promise.all(racers.map((r) => r.target.evaluate(clickAt, { at, taps: r.taps ?? 1 })));
  const spread = Math.max(...fired) - Math.min(...fired);
  const late = fired.map((t, i) => `${racers[i]!.name} +${t - at} ms`).join(', ');
  expect(spread, `the racers clicked ${spread} ms apart (${late}): the barrier did not hold`).toBeLessThanOrEqual(o.maxSpreadMs ?? 250);
  return Object.fromEntries(racers.map((r, i) => [r.name, fired[i]! - at]));
}

/** In the page: `taps` clicks, `gapMs` apart. A disabled or detached button takes none. */
function tapsInPage(el: Element, a: { taps: number; gapMs: number }): Promise<number> {
  return new Promise<number>((resolve) => {
    let n = 0;
    const tap = () => {
      (el as HTMLElement).click();
      n += 1;
      if (n >= a.taps) resolve(n);
      else setTimeout(tap, a.gapMs);
    };
    tap();
  });
}

/**
 * More taps on a control while the page works — on the very element found
 * before, whatever its label says now ("Submitting…", "Working…"), and with no
 * actionability wait: a thumb does not wait for a button to be enabled.
 */
export async function tapRepeatedly(handle: ElementHandle<Element>, o: { taps: number; gapMs: number }): Promise<void> {
  await handle.evaluate(tapsInPage, o);
}

// ── the proof that the race was real ─────────────────────────────────────────

export type PostLog = { name: string; calls: Array<{ sent: number; done: number | null }> };

/**
 * Records the page's POSTs to `path` (a server action posts to the page's own
 * path; a field form to /api/forms/<form>): when each left, when each was
 * answered (finished or failed), in this process's clock.
 */
export function trackPosts(page: Page, name: string, path: string): PostLog {
  const log: PostLog = { name, calls: [] };
  const open = new Map<Request, PostLog['calls'][number]>();
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    try {
      if (new URL(r.url()).pathname !== path) return;
    } catch {
      return;
    }
    const call = { sent: Date.now(), done: null as number | null };
    log.calls.push(call);
    open.set(r, call);
  });
  const end = (r: Request) => {
    const call = open.get(r);
    if (call && call.done === null) call.done = Date.now();
    open.delete(r);
  };
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return log;
}

/**
 * Every log's first POST had left before the first of them was answered: the
 * server had them all in hand at once.
 */
export async function expectOverlap(logs: PostLog[]): Promise<void> {
  await expect
    .poll(() => logs.filter((l) => !(l.calls.length > 0 && l.calls[0]!.done !== null)).map((l) => l.name), {
      timeout: 90_000,
      message: 'every racing POST left its page and was answered',
    })
    .toEqual([]);
  const firsts = logs.map((l) => ({ name: l.name, sent: l.calls[0]!.sent, done: l.calls[0]!.done! }));
  const t0 = Math.min(...firsts.map((f) => f.sent));
  const lastSent = Math.max(...firsts.map((f) => f.sent));
  const firstDone = Math.min(...firsts.map((f) => f.done));
  const story = firsts.map((f) => `${f.name}: sent +${f.sent - t0} ms, answered +${f.done - t0} ms`).join('; ');
  expect(lastSent, `the racing POSTs were in flight together (${story})`).toBeLessThan(firstDone);
}

// ── slow and doubled sends ───────────────────────────────────────────────────

/**
 * The page's POSTs to `path` reach the server at once (route.fetch), and the
 * answer is handed back to the page only `ms` later: a slow reply on a weak
 * signal. The server's work is not delayed.
 */
export async function slowAnswers(page: Page, path: string, ms: number): Promise<void> {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const res = await route.fetch();
      await sleep(ms);
      await route.fulfill({ response: res });
    }
  );
}

export type DoubledSend = {
  /** The JSON the page sent (its submission id included). */
  body: Record<string, unknown> | null;
  /** The server's answer to the page's own POST, and to the copy sent beside it. */
  page: Record<string, unknown> | null;
  copy: Record<string, unknown> | null;
  copyStatus: number | null;
  error: string | null;
  done: boolean;
};

/**
 * The page's FIRST POST to `path` is sent to the server together with an exact
 * copy of it (same body, same submission id, the same session) — the retry of a
 * phone that gave up waiting, landing while the first is still being written.
 * The page's own answer is then held `holdMs` (a slow reply) before it is handed
 * back. Later POSTs pass untouched. A route handler cannot fail the test: what
 * went wrong is kept in `error`.
 */
export async function resendAlongside(page: Page, path: string, holdMs: number): Promise<DoubledSend> {
  const out: DoubledSend = { body: null, page: null, copy: null, copyStatus: null, error: null, done: false };
  let first = true;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== 'POST' || !first) return route.continue();
      first = false;
      try {
        out.body = (route.request().postDataJSON() as Record<string, unknown> | null) ?? null;
        const [res, copy] = await Promise.all([route.fetch(), postJson(page, path, out.body)]);
        out.page = ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? null;
        out.copyStatus = copy.status();
        out.copy = ((await copy.json().catch(() => null)) as Record<string, unknown> | null) ?? null;
        await sleep(holdMs);
        await route.fulfill({ response: res });
      } catch (err) {
        out.error = String((err as Error)?.message ?? err).slice(0, 300);
        // Never continue(): the server may already have it, and continue() would send it again.
        await route.abort('failed').catch(() => undefined);
      } finally {
        out.done = true;
      }
    }
  );
  return out;
}

// ── read-backs ───────────────────────────────────────────────────────────────

/** The live customer fields a contact change touches, and its optimistic-lock version. */
export async function customerNow(id: string): Promise<{ contactPerson: string | null; version: number }> {
  return db.customer.findUniqueOrThrow({ where: { id }, select: { contactPerson: true, version: true } });
}

/** The value a request carries for one field (its stored fieldChanges). */
export function changedTo(fieldChanges: unknown, field: string): unknown {
  const list = Array.isArray(fieldChanges) ? (fieldChanges as Array<{ field?: unknown; after?: unknown }>) : [];
  return list.find((c) => c.field === field)?.after;
}
