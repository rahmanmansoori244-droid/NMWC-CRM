/**
 * Helpers for tests/e2e/launch/platform.spec.ts only (the platform checks: Oman
 * times, hydration, CSP, layout, accessibility, slow-phone metrics, health and
 * cron). Kept out of the shared support index on purpose: other spec authors
 * work on support/ in parallel, so nothing here changes an existing file.
 *
 * Every write goes to a row the world registers BEFORE the insert (ids minted
 * with newId), so world.cleanup() and the crash sweep find it:
 *   - bulk UPDATE requests  → registry editIds
 *   - import batches        → registry importBatchIds (rows go with the batch)
 *   - Temix batches         → registry temixBatchIds
 *   - notifications         → registry notificationIds
 *   - audit rows            → about a world row (cleanup deletes by entityId)
 * Nothing here prints an env value: the CRON/HEALTH secrets are only compared,
 * and the smoke script's output is redacted before it is returned.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import type { AuditAction, ImportBatchStatus, NotificationKind, Prisma } from '@prisma/client';
import { resolveChain, stepDeadline } from '../../../../lib/approval-chains';
import { submitGateRecord } from '../../../../lib/edit-scope';
import { BASE_URL, db, redact, REPO_ROOT } from './env';
import { newId } from './ids';
import type { World } from './types';

// ── Oman and UTC clock text, computed independently of lib/tz ─────────────────

const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type ClockText = {
  /** "07/10/2026" */
  date: string;
  /** "07/10/2026, 14:05:33" */
  dateTime: string;
  /** "07 Oct, 14:05" (the notification list) */
  dayTime: string;
  /** "Wednesday, 7 October 2026" (the Today header) */
  longDate: string;
  /** "14:05" */
  hhmm: string;
};

/**
 * How an instant reads on a clock in `timeZone`, from Intl's numeric parts (the
 * zone database), with fixed English names. The app builds its text by
 * arithmetic (lib/tz.ts); this is the independent oracle the tests compare it
 * with. 'UTC' gives what a page formatted on the server's own clock would print.
 */
export function clockText(at: Date, timeZone: 'Asia/Muscat' | 'UTC'): ClockText {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(get('year'));
  const mo = Number(get('month'));
  const d = Number(get('day'));
  const two = (n: number) => String(n).padStart(2, '0');
  const hh = two(Number(get('hour')) % 24);
  const mi = two(Number(get('minute')));
  const ss = two(Number(get('second')));
  const date = `${two(d)}/${two(mo)}/${y}`;
  const weekday = WEEKDAY_LONG[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]!;
  return {
    date,
    dateTime: `${date}, ${hh}:${mi}:${ss}`,
    dayTime: `${two(d)} ${MON_SHORT[mo - 1]}, ${hh}:${mi}`,
    longDate: `${weekday}, ${d} ${MON_LONG[mo - 1]} ${y}`,
    hhmm: `${hh}:${mi}`,
  };
}

export const omanText = (at: Date): ClockText => clockText(at, 'Asia/Muscat');
export const utcText = (at: Date): ClockText => clockText(at, 'UTC');

/**
 * The most recent instant at hh:mm UTC that is at least `atLeastAgoMs` in the
 * past. 21:30Z is 01:30 the NEXT day in Oman, so a page printing the server's
 * UTC clock shows both the wrong time and the wrong date for it.
 */
export function lastUtcInstant(hour: number, minute: number, atLeastAgoMs = 120_000): Date {
  const now = new Date();
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0);
  while (t > now.getTime() - atLeastAgoMs) t -= 86_400_000;
  return new Date(t);
}

/** Minutes between two "HH:MM" clock readings, the short way round midnight. */
export function minutesApart(a: string, b: string): number {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const d = Math.abs(m(a) - m(b));
  return Math.min(d, 1440 - d);
}

// ── page watchers ─────────────────────────────────────────────────────────────

const HYDRATION = /Hydration failed|did not match|Minified React error #(418|423|425)|hydration mismatch|server rendered (HTML|text) didn't match/i;
const CSP = /\[csp-violation\]|Refused to (load|execute|connect|apply|frame|evaluate|create|send)/i;

/** Query strings out (a blocked presigned URL would carry a live signature). */
function scrubUrl(text: string): string {
  return redact(text.replace(/\?[^\s'"`)]*/g, '?…')).slice(0, 300);
}

export type ProblemWatch = { hydration(): string[]; csp(): string[]; pageErrors(): string[] };

/**
 * This spec's own watcher for one page, independent of the harness allow-list
 * (checks.ts still allow-lists /notifications #418 and the /import locale
 * mismatch while their KNOWN_BUGS entries say open — both were fixed in wave 1,
 * so here any hydration error fails).
 */
export function watchProblems(page: Page): ProblemWatch {
  const hydration: string[] = [];
  const csp: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (HYDRATION.test(text)) hydration.push(`${scrubUrl(page.url())}: ${scrubUrl(text)}`);
    if (CSP.test(text)) csp.push(`${scrubUrl(page.url())}: ${scrubUrl(text)}`);
  });
  page.on('pageerror', (err) => {
    const text = String(err?.message ?? err);
    pageErrors.push(`${scrubUrl(page.url())}: ${scrubUrl(text)}`);
    if (HYDRATION.test(text)) hydration.push(`${scrubUrl(page.url())}: ${scrubUrl(text)}`);
  });
  return { hydration: () => [...hydration], csp: () => [...csp], pageErrors: () => [...pageErrors] };
}

/** Horizontal overflow of the document in px (0 when the page fits). */
export async function sideOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/**
 * What makes a page scroll sideways: the innermost elements whose right edge is
 * past the viewport and that no scrolling or clipping ancestor contains. Tag,
 * first classes and a short text, so a failure names the component.
 */
export async function overflowCulprits(page: Page, max = 3): Promise<string[]> {
  return page.evaluate((max) => {
    const vw = document.documentElement.clientWidth;
    const contained = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const s = window.getComputedStyle(p);
        if (s.overflowX !== 'visible') return true;
      }
      return false;
    };
    const over = Array.from(document.body.querySelectorAll('*')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > vw + 0.5 && !contained(el);
    });
    const innermost = over.filter((el) => !over.some((o) => o !== el && el.contains(o)));
    const describe = (el: Element) => {
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 6).join('.');
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const r = el.getBoundingClientRect();
      return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> right ${Math.round(r.right * 10) / 10} of ${vw} "${text}"`;
    };
    if (innermost.length) return innermost.slice(0, max).map(describe);
    // Nothing's box is past the edge (a margin or a flex/grid item's overflow): find it by
    // clipping. Walk down to the deepest element whose `overflow-x: clip` removes the
    // sideways scroll, then name its children that reach past its own box.
    const fits = () => document.documentElement.scrollWidth <= window.innerWidth + 1;
    if (fits()) return [];
    const clipFixes = (el: HTMLElement) => {
      const prev = el.style.overflowX;
      el.style.overflowX = 'clip';
      const ok = fits();
      el.style.overflowX = prev;
      return ok;
    };
    const trail: string[] = [];
    let node: Element = document.body;
    for (;;) {
      const next = Array.from(node.children).find((c) => c instanceof HTMLElement && clipFixes(c));
      if (!next) break;
      trail.push(describe(next));
      node = next;
    }
    const box = node.getBoundingClientRect();
    const sticking = Array.from(node.querySelectorAll('*'))
      .filter((c) => {
        const r = c.getBoundingClientRect();
        const s = window.getComputedStyle(c);
        return r.width > 0 && r.right + (parseFloat(s.marginRight) || 0) > box.right + 0.5;
      })
      .slice(0, max)
      .map((c) => `${describe(c)} margin-right ${window.getComputedStyle(c).marginRight}`);
    return [`clip fixes it at: ${trail.slice(-2).join(' > ') || '(no element)'}`, ...sticking];
  }, max);
}

/** Waits for the network to settle after a hard load; a page that never idles is not a failure here. */
export async function settle(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForLoadState('load', { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
}

/** The error boundary, the root error page or a 404 — a page that did not really render. */
export async function brokenPageHeading(page: Page): Promise<string | null> {
  for (const name of ['This page could not load.', 'Something went wrong.', '404']) {
    if (await page.getByRole('heading', { level: 1, name, exact: true }).isVisible().catch(() => false)) return name;
  }
  return null;
}

// ── accessibility ─────────────────────────────────────────────────────────────

/**
 * Every rendered form control that has no name a getByLabel lookup could use:
 * no associated <label> (for= or wrapping), no aria-label, no aria-labelledby.
 * A placeholder is not a label. Hidden and type=hidden controls are skipped.
 */
export async function unlabelledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const controls = Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'));
    for (const el of controls) {
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
      const style = window.getComputedStyle(el);
      if (el.getClientRects().length === 0 || style.visibility === 'hidden') continue;
      const labels = (el as HTMLInputElement).labels;
      const hasLabel = !!labels && Array.from(labels).some((l) => (l.textContent ?? '').trim() !== '' || !!l.getAttribute('aria-label'));
      const aria = (el.getAttribute('aria-label') ?? '').trim() !== '';
      const by = (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .some((id) => (document.getElementById(id)?.textContent ?? '').trim() !== '');
      if (!hasLabel && !aria && !by) {
        const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '';
        const type = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
        out.push(`${el.tagName.toLowerCase()}[${type}]${name ? ` name=${name}` : ''}`);
      }
    }
    return out;
  });
}

/** Every rendered <img> without an alt attribute (alt="" is a deliberate decorative image). */
export async function imagesWithoutAlt(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img'))
      .filter((img) => img.getClientRects().length > 0 && !img.hasAttribute('alt'))
      .map((img) => (img.getAttribute('src') ?? '').slice(0, 80))
  );
}

/** Whether React has hydrated this element (it carries React's internal fiber key). */
export async function isHydrated(l: Locator): Promise<boolean> {
  return l
    .first()
    .evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')))
    .catch(() => false);
}

export async function waitForHydrated(l: Locator, timeout = 60_000): Promise<void> {
  await l.first().waitFor({ state: 'attached', timeout });
  await expect.poll(() => isHydrated(l), { timeout, message: 'the element is hydrated by React' }).toBe(true);
}

// ── slow links, CPU and transferred JS (Chromium DevTools protocol) ───────────

export type Throttle = { latencyMs: number; downKbps: number; upKbps: number; cpu: number };
/** STREAM-LOADING-SKELETONS: 400 ms RTT, 400 kbps, CPU 4x. */
export const SLOW_LINK: Throttle = { latencyMs: 400, downKbps: 400, upKbps: 400, cpu: 4 };
/** PERF-SLOW-PHONE: Lighthouse's Slow 4G (150 ms, 1.6 Mbps down, 750 kbps up), CPU 4x. */
export const SLOW_4G: Throttle = { latencyMs: 150, downKbps: 1600, upKbps: 750, cpu: 4 };

export async function throttle(page: Page, t: Throttle): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: t.latencyMs,
    downloadThroughput: Math.round((t.downKbps * 1000) / 8),
    uploadThroughput: Math.round((t.upKbps * 1000) / 8),
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: t.cpu });
  return cdp;
}

/** Sums the bytes on the wire of every Script response the session sees. */
export function scriptMeter(cdp: CDPSession): { bytes(): number; count(): number } {
  const scripts = new Set<string>();
  let bytes = 0;
  let count = 0;
  cdp.on('Network.responseReceived', (e) => {
    if (e.type === 'Script') scripts.add(e.requestId);
  });
  cdp.on('Network.loadingFinished', (e) => {
    if (!scripts.has(e.requestId)) return;
    bytes += e.encodedDataLength;
    count += 1;
  });
  return { bytes: () => bytes, count: () => count };
}

/**
 * Markers that must never be in a browser chunk: the Prisma query engine (the
 * native or WASM library) and exceljs. The Prisma BROWSER SHIM (what a client
 * component's `import { Role } from '@prisma/client'` pulls in) is reported
 * separately: it holds no engine.
 */
export const ENGINE_MARKERS: Array<{ what: string; re: RegExp }> = [
  { what: 'Prisma query engine', re: /libquery_engine|query_engine_bg|PRISMA_QUERY_ENGINE_LIBRARY|prisma-engines/ },
  { what: 'exceljs', re: /\bExcelJS\b|xl\/sharedStrings\.xml|xl\/worksheets\/sheet/ },
];
export const PRISMA_BROWSER_SHIM = /is unable to run in this browser environment/;

/**
 * Collects the body of every app script chunk the page loads (/_next/static/…),
 * so a test can search them for server-only code.
 */
export function collectChunks(page: Page): Map<string, string> {
  const chunks = new Map<string, string>();
  page.on('response', async (res) => {
    try {
      const url = new URL(res.url());
      if (url.origin !== BASE_URL || !url.pathname.startsWith('/_next/static/') || !url.pathname.endsWith('.js')) return;
      if (chunks.has(url.pathname)) return;
      chunks.set(url.pathname, await res.text());
    } catch {
      /* a response the page abandoned */
    }
  });
  return chunks;
}

// ── heading log, for the loading skeletons ────────────────────────────────────

export type HeadingEntry = { t: number; h1: string; sub: string; path: string };

/**
 * Records every change of the page's first <main> h1, its subtitle and the path,
 * with performance.now(), from now on (survives client navigations, not a
 * document load). The skeletons are loading.tsx's PageHeader: "Loading your
 * day…" or a title with the subtitle "Loading…".
 */
export async function recordHeadings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __nmwcHeadings?: Array<{ t: number; h1: string; sub: string; path: string }> };
    w.__nmwcHeadings = [];
    let last = '';
    const snap = () => {
      const h1 = document.querySelector('main h1');
      const sub = h1?.parentElement?.querySelector('p')?.textContent?.trim() ?? '';
      const entry = { t: performance.now(), h1: h1?.textContent?.trim() ?? '', sub, path: location.pathname };
      const key = `${entry.h1}|${entry.sub}|${entry.path}`;
      if (key === last) return;
      last = key;
      w.__nmwcHeadings!.push(entry);
    };
    snap();
    new MutationObserver(snap).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  });
}

export async function headingLog(page: Page): Promise<HeadingEntry[]> {
  return page.evaluate(
    () => (window as unknown as { __nmwcHeadings?: Array<{ t: number; h1: string; sub: string; path: string }> }).__nmwcHeadings ?? []
  );
}

export async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

// ── seeds ─────────────────────────────────────────────────────────────────────

/**
 * Many SUBMITTED update requests at the Supervisor step in one insert, one per
 * customer (the partial unique index allows one open request per customer):
 * each changes the customer's contact person, frozen chain and gate as
 * services/edits.ts writes them. Their SLA deadline is in the future, so no
 * SLA sweep (a real scheduler on UAT) ever escalates them. Returns the ids,
 * oldest first.
 */
export async function seedPendingUpdates(
  w: World,
  o: { customers: string[]; submitter: string }
): Promise<string[]> {
  const submitter = w.user(o.submitter);
  const now = Date.now();
  const chain = resolveChain('UPDATE', 'CASH');
  const first = chain[0]!;
  const rows: Prisma.CustomerEditCreateManyInput[] = o.customers.map((key, i) => {
    const c = w.customer(key);
    const stageEnteredAt = new Date(now - (o.customers.length - i) * 60_000);
    return {
      id: newId(),
      target: 'CUSTOMER',
      customerId: c.id,
      state: 'SUBMITTED',
      submittedById: submitter.id,
      submittedAt: stageEnteredAt,
      fieldChanges: [{ field: 'customer.contactPerson', before: null, after: w.name(`Contact ${key}`) }] as unknown as Prisma.InputJsonValue,
      attachmentChanges: [] as unknown as Prisma.InputJsonValue,
      process: 'UPDATE',
      approvalChain: chain as unknown as Prisma.InputJsonValue,
      paymentTermsAtSubmit: c.paymentTerms,
      currentStepIndex: 0,
      cycle: 1,
      pendingRole: first.role,
      stageEnteredAt,
      // Never overdue: a deadline from now, ordered like the submissions.
      slaDueAt: new Date(stepDeadline(new Date(now), first.slaHours).getTime() + i * 60_000),
      escalationLevel: 0,
      submitGate: submitGateRecord([c.branch.id]) as unknown as Prisma.InputJsonValue,
    };
  });
  w.registry.add('editIds', ...rows.map((r) => r.id!));
  for (let i = 0; i < rows.length; i += 250) {
    await db.customerEdit.createMany({ data: rows.slice(i, i + 250) });
  }
  return rows.map((r) => r.id!);
}

/**
 * An import batch with `rows` CLEAN customer rows (raw cells only), as the
 * Steward's /import/<batch> page reads them. A READY batch is promotable: its
 * button reads "Promote 1,200 clean rows". Never promote it from a test.
 */
export async function seedImportBatch(
  w: World,
  o: { uploader: string; rows: number; status: ImportBatchStatus; uploadedAt?: Date; filename?: string }
): Promise<{ id: string; filename: string }> {
  const id = newId();
  const filename = o.filename ?? `${w.name('platform-batch')}.xlsx`;
  if (!w.carriesSuffix(filename)) throw new Error('seedImportBatch: the filename must carry the world suffix');
  w.registry.add('importBatchIds', id);
  await db.importBatch.create({
    data: {
      id,
      filename,
      kind: 'CUSTOMER',
      uploadedById: w.user(o.uploader).id,
      uploadedAt: o.uploadedAt ?? new Date(),
      status: o.status,
      totalRows: o.rows,
      cleanRows: o.status === 'READY' ? o.rows : 0,
      promotedRows: o.status === 'PROMOTED' ? o.rows : 0,
    },
  });
  const all: Prisma.ImportRowCreateManyInput[] = Array.from({ length: o.rows }, (_, i) => ({
    id: newId(),
    batchId: id,
    rowNumber: i + 2,
    raw: {
      cust_code: `000E2E${w.SFX}-B${String(i + 1).padStart(4, '0')}`,
      cust_name: w.name(`Batch customer ${i + 1}`),
      branch_code: `000E2E${w.SFX}-B${String(i + 1).padStart(4, '0')}-01`,
    } as Prisma.InputJsonValue,
    state: o.status === 'READY' ? 'CLEAN' : 'PROMOTED',
  }));
  for (let i = 0; i < all.length; i += 500) {
    await db.importRow.createMany({ data: all.slice(i, i + 500) });
  }
  return { id, filename };
}

/** A Temix upload batch row (no file in R2), as /temix lists it. */
export async function seedTemixBatch(
  w: World,
  o: { createdBy: string; createdAt: Date; markedLoadedAt: Date | null }
): Promise<string> {
  const id = newId();
  w.registry.add('temixBatchIds', id);
  await db.temixSyncBatch.create({
    data: {
      id,
      createdById: w.user(o.createdBy).id,
      createdAt: o.createdAt,
      rowCount: 0,
      customerIds: [],
      status: 'DONE',
      markedLoadedAt: o.markedLoadedAt,
    },
  });
  return id;
}

/** One audit row about a WORLD row (cleanup deletes audit rows by the world's entity ids). */
export async function seedAuditRow(
  w: World,
  o: { actor: string; customer: string; at: Date; reason: string; action?: AuditAction }
): Promise<string> {
  const id = newId();
  await db.auditLog.create({
    data: {
      id,
      actorId: w.user(o.actor).id,
      action: o.action ?? 'UPDATE',
      entityType: 'Customer',
      entityId: w.customer(o.customer).id,
      reason: o.reason,
      at: o.at,
    },
  });
  return id;
}

/** Sets a fixture user's last sign-in time (what /profile, /users and /team print). */
export async function setLastLogin(w: World, userKey: string, at: Date): Promise<void> {
  await db.user.update({ where: { id: w.user(userKey).id }, data: { lastLoginAt: at } });
}

/**
 * Notifications the e-mail outbox has NOT dealt with (emailedAt null,
 * emailAttempts 0), for "e-mail is off" checks. Fixture users have no e-mail
 * address, so even a real drain could never send one.
 */
export async function seedOutboxNotifications(
  w: World,
  users: string[],
  kind: NotificationKind = 'EDIT_SUBMITTED'
): Promise<string[]> {
  const rows = users.map((u) => ({
    id: newId(),
    userId: w.user(u).id,
    kind,
    title: w.name('Outbox check'),
    body: w.name('Outbox check body'),
  }));
  w.registry.add('notificationIds', ...rows.map((r) => r.id));
  await db.notification.createMany({ data: rows });
  return rows.map((r) => r.id);
}

// ── cron bookkeeping (read-only) ──────────────────────────────────────────────

export const CRON_KEYS = ['photo-gc', 'retention-sweep', 'keep-warm', 'sla-escalate', 'email-drain'] as const;

export async function cronRunsByKey(): Promise<Record<string, number>> {
  const rows = await db.cronHeartbeat.findMany({ where: { key: { in: [...CRON_KEYS] } }, select: { key: true, runs: true } });
  return Object.fromEntries(CRON_KEYS.map((k) => [k, rows.find((r) => r.key === k)?.runs ?? 0]));
}

export async function cronRunsSince(since: Date): Promise<Array<{ key: string; source: string | null }>> {
  return db.cronRun.findMany({
    where: { key: { in: [...CRON_KEYS] }, at: { gte: since } },
    select: { key: true, source: true },
  });
}

// ── the operator smoke script ─────────────────────────────────────────────────

/** Every check scripts/ops/smoke.ts runs without HEALTH_BEARER, by name. */
export const SMOKE_CHECKS = [
  'health (anonymous)',
  'health rejects a wrong bearer',
  'login page renders',
  'exactly one CSP header',
  'CSP carries every required directive',
  'CSP script-src carries a nonce and strict-dynamic',
  'the page is actually stamped with that nonce',
  'security headers',
  'root redirects to /login',
  'a protected page redirects when signed out',
  'cron routes refuse an unauthenticated call',
  'ops and data routes refuse an unauthenticated call',
  'served from the intended region',
  'auth provider points at THIS host',
] as const;
/** Only a Vercel deployment can pass these (x-vercel-id names the region). */
export const SMOKE_VERCEL_ONLY: readonly string[] = ['served from the intended region'];

/**
 * `npm run smoke -- <this server>` (scripts/ops/smoke.ts through tsx), without
 * the monitor bearer. Returns each named check's PASS/FAIL; the output is
 * redacted before it is kept.
 */
export function runSmoke(): { status: number | null; results: Record<string, 'PASS' | 'FAIL' | 'missing'>; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HEALTH_BEARER;
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/ops/smoke.ts', BASE_URL], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const output = redact(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  const lines = output.split(/\r?\n/);
  const results: Record<string, 'PASS' | 'FAIL' | 'missing'> = {};
  for (const name of SMOKE_CHECKS) {
    const line = lines.find((l) => l.startsWith(`PASS  ${name}`) || l.startsWith(`FAIL  ${name}`));
    results[name] = line ? (line.startsWith('PASS') ? 'PASS' : 'FAIL') : 'missing';
  }
  return { status: r.status, results, output };
}
