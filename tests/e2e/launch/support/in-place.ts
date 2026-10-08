/**
 * A result that must show IN PLACE, measured from the moment the server
 * finished — never from a reload. Shared by the back-office, create-chain,
 * approvals-queue and salesman-phone specs.
 *
 * Was an APP BUG (found by the salesman-phone run of 8 Oct), FIXED in the launch
 * candidate by 8e47bc6 (components/nmwc/TransitionWatchdog.tsx; back-off and
 * tripwire in dc134cd / a39a502): a client transition that re-renders the page in
 * place — router.refresh() after a server action (import row Correct / Release /
 * Exclude, Mark distinct, Mark loaded, Approve and create), the revalidated answer
 * of a server action (Create region / route, Disable / Enable), a decision whose
 * answer redirects to the queue, a link or button that changes only the query
 * string (Clear filters, a period button, Next →) — was often parked by the React
 * that Next 15.5 ships and never shown until a reload. The helpers used to reload
 * (or load the URL) on such a hang; now a hang FAILS the test.
 *
 * When the server finished is MEASURED (ServerDone), from the tap:
 *  - a database check, `() => Promise<boolean>`: polled from the tap; the server
 *    finished when it first reads true;
 *  - a RequestLog (trackRequests, installed BEFORE the tap): the server finished
 *    when the last of the app's own calls since the tap (navigations, refreshes,
 *    server actions — not prefetches) was answered, or at the tap when it made none;
 *  - both, when a database check is given for a page trackRequests watches: the
 *    later of the two (a decision's answer renders the queue AFTER it commits).
 * The server gets SERVER_WORK_MS from the tap; the page then gets IN_PLACE_MS.
 * Both are hard limits, so the whole wait is capped at SERVER_WORK_MS +
 * IN_PLACE_MS: a page not showing the result IN_PLACE_MS after the server
 * finished fails with NAV_HANG, and a server not done in SERVER_WORK_MS fails as
 * too slow (or refused). A late page never passes quietly; a slow one that made
 * it in time is recorded ('slow in-place result').
 */
import { test, type Page, type Request } from '@playwright/test';

export const NAV_HANG =
  'A page re-rendered in place (router.refresh after an action, a revalidated action answer, a link that changes only the query string) is not shown until a reload';

/** How long a page may take to show a result in place once the server has finished it. */
export const IN_PLACE_MS = 15_000;
/** How long a slow server (UAT's database, shared with other runs) is given, from the tap, to finish the work. */
export const SERVER_WORK_MS = 120_000;
/** How often a database check is read while the server works. */
const POLL_MS = 500;

/** What a page has asked the server for: the requests still open, and the last ones that ended. */
export type RequestLog = {
  summary(): string;
  /** The app navigations (RSC requests, not prefetches) sent at or after `since` (Date.now()), as path + query. */
  navigationsSince(since: number): string[];
  /**
   * The app's own calls sent at or after `since` — navigations, refreshes and
   * server actions, not prefetches: how many are still unanswered, and when the
   * last of the others ended (0 if none).
   */
  answeringSince(since: number): { open: number; lastEnd: number };
};

const logs = new WeakMap<Page, RequestLog>();

/**
 * Logs every request a page makes, for the message of a navigation that does
 * not land, and for when the server finished (see the header). App requests are
 * named by path and query (the _rsc cache-buster dropped) and by kind (rsc /
 * prefetch / document …); anything else is only "<external>" — the R2 PUT
 * carries a presigned URL, which is never printed. Call it BEFORE the tap it
 * measures; a second call for the same page returns the same log.
 */
export function trackRequests(page: Page): RequestLog {
  const known = logs.get(page);
  if (known) return known;
  const t0 = Date.now();
  const open = new Map<Request, number>();
  const headersAt = new Map<Request, number>();
  const ended: string[] = [];
  const navigations: Array<{ at: number; url: string }> = [];
  const appCalls = new Map<Request, { sent: number; ended: number }>();
  const isLocal = (r: Request) => {
    try {
      const u = new URL(r.url());
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };
  const name = (r: Request): string => {
    let u: URL;
    try {
      u = new URL(r.url());
    } catch {
      return `${r.method()} <unparsable>`;
    }
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return `${r.method()} <external> [${r.resourceType()}]`;
    u.searchParams.delete('_rsc');
    const h = r.headers();
    const kind = h['next-router-prefetch'] ? 'prefetch' : h['rsc'] ? 'rsc' : h['next-action'] ? 'action' : r.resourceType();
    return `${r.method()} ${u.pathname}${u.search} [${kind}]`;
  };
  const end = (r: Request, how: string) => {
    const s = open.get(r);
    open.delete(r);
    const call = appCalls.get(r);
    if (call) call.ended = Date.now();
    if (s === undefined) return;
    ended.push(`${name(r)} ${how} in ${Date.now() - s} ms (sent at +${s - t0} ms)`);
    if (ended.length > 40) ended.shift();
  };
  page.on('request', (r) => {
    open.set(r, Date.now());
    const h = r.headers();
    if (isLocal(r) && ((h['rsc'] && !h['next-router-prefetch']) || h['next-action'])) appCalls.set(r, { sent: Date.now(), ended: 0 });
    if (h['rsc'] && !h['next-router-prefetch']) {
      try {
        const u = new URL(r.url());
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
          u.searchParams.delete('_rsc');
          navigations.push({ at: Date.now(), url: `${u.pathname}${u.search}` });
        }
      } catch {
        /* not an app URL */
      }
    }
  });
  page.on('response', (res) => headersAt.set(res.request(), Date.now()));
  page.on('requestfinished', (r) => end(r, 'finished'));
  page.on('requestfailed', (r) => end(r, `failed (${r.failure()?.errorText ?? '?'})`));
  const log: RequestLog = {
    summary() {
      const now = Date.now();
      const pending = [...open.entries()].map(([r, s]) => {
        const h = headersAt.get(r);
        return `  ${name(r)} open for ${now - s} ms (sent at +${s - t0} ms, ${h === undefined ? 'no answer yet' : `answer began after ${h - s} ms`})`;
      });
      return [
        `still open (${pending.length}):`,
        ...pending,
        `last ended (${Math.min(ended.length, 15)}):`,
        ...ended.slice(-15).map((l) => `  ${l}`),
      ].join('\n');
    },
    navigationsSince(since) {
      return navigations.filter((n) => n.at >= since).map((n) => n.url);
    },
    answeringSince(since) {
      let openCalls = 0;
      let lastEnd = 0;
      for (const c of appCalls.values()) {
        if (c.sent < since) continue;
        if (c.ended === 0) openCalls += 1;
        else lastEnd = Math.max(lastEnd, c.ended);
      }
      return { open: openCalls, lastEnd };
    },
  };
  logs.set(page, log);
  return log;
}

/** The RequestLog trackRequests keeps for `page`, if it was called for it. */
export function requestsOf(page: Page): RequestLog | undefined {
  return logs.get(page);
}

/** How the test knows the server finished: a database check, the page's own calls, or both (see the header). */
export type ServerDone = (() => Promise<boolean>) | RequestLog;

/** When the server finished, as far as the test can tell: null while it is still working. */
export type ServerClock = { by: string; doneAt(): number | null; stop(): void };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function requestClock(log: RequestLog, start: number): ServerClock {
  return {
    by: "the app's calls since the tap",
    doneAt() {
      // The tap's own call is sent a moment before the helper starts counting.
      const { open, lastEnd } = log.answeringSince(start - 1_000);
      return open > 0 ? null : Math.max(start, lastEnd);
    },
    stop() {},
  };
}

function databaseClock(check: () => Promise<boolean>, start: number): ServerClock {
  let at: number | null = null;
  let stopped = false;
  void (async () => {
    while (!stopped && Date.now() < start + SERVER_WORK_MS) {
      const yes = await check().catch(() => false);
      if (yes) {
        at = Date.now();
        return;
      }
      await sleep(POLL_MS);
    }
  })();
  return {
    by: 'the database',
    doneAt: () => at,
    stop() {
      stopped = true;
    },
  };
}

/**
 * The clock for `server`. A database check is joined by the page's own calls:
 * `also` is that page (when trackRequests watches it) or its RequestLog.
 */
export function serverClock(server: ServerDone, start: number, also?: Page | RequestLog): ServerClock {
  if (typeof server !== 'function') return requestClock(server, start);
  const db = databaseClock(server, start);
  const log = also === undefined ? undefined : 'answeringSince' in also ? also : logs.get(also);
  if (!log) return db;
  const net = requestClock(log, start);
  return {
    by: `${db.by} and ${net.by}`,
    doneAt() {
      const a = db.doneAt();
      const b = net.doneAt();
      return a === null || b === null ? null : Math.max(a, b);
    },
    stop() {
      db.stop();
    },
  };
}

/** Why a result did not show in place. */
export type InPlaceMiss = {
  /** 'hang': the server finished and the page did not show it; 'server': the server did not finish in time. */
  why: 'hang' | 'server';
  /** When the server finished, in ms after the tap (null: not yet). */
  serverMs: number | null;
  by: string;
  /** The last failure of the page check. */
  last: unknown;
};

/**
 * Checks the page (`shown(timeout)`, in short slices) until it shows the result:
 * null when it did; the miss otherwise. `start` is the tap. The clock is stopped
 * before it returns.
 */
export async function untilShown(
  start: number,
  what: string,
  clock: ServerClock,
  shown: (timeout: number) => Promise<unknown>
): Promise<InPlaceMiss | null> {
  const workCap = start + SERVER_WORK_MS;
  let last: unknown = null;
  try {
    for (;;) {
      const now = Date.now();
      const done = clock.doneAt();
      const deadline = done === null ? workCap : Math.min(done, workCap) + IN_PLACE_MS;
      if (now >= deadline) {
        const serverMs = done === null ? null : done - start;
        return { why: done === null || done > workCap ? 'server' : 'hang', serverMs, by: clock.by, last };
      }
      const tried = Date.now();
      const ok = await shown(Math.max(250, Math.min(deadline - now, 1_000))).then(
        () => true,
        (e: unknown) => {
          last = e;
          return false;
        }
      );
      if (ok) {
        const took = Date.now() - start;
        if (took > 5_000) {
          const server = done === null ? 'the server was still working' : `the server finished after ${done - start} ms`;
          test.info().annotations.push({ type: 'slow in-place result', description: `${what}: shown ${took} ms after the tap (${server})` });
        }
        return null;
      }
      // A check that fails at once (not a waiting assertion) must not spin.
      if (Date.now() - tried < 200) await sleep(200);
    }
  } finally {
    clock.stop();
  }
}

/** The sentence a failure starts with. */
export function describeMiss(m: InPlaceMiss): string {
  if (m.why === 'hang') {
    const when = m.serverMs === 0 ? 'nothing was left for the server to do at the tap' : `the server finished ${m.serverMs} ms after the tap`;
    return `${when} (by ${m.by}), and the page did not show it ${IN_PLACE_MS / 1000} s later (${NAV_HANG})`;
  }
  return m.serverMs === null
    ? `the server had not finished ${SERVER_WORK_MS / 1000} s after the tap (by ${m.by}): the action was refused, or the server is slower than the suite allows`
    : `the server finished only ${m.serverMs} ms after the tap (by ${m.by}), past the ${SERVER_WORK_MS / 1000} s the suite allows, and the page had not shown it by the cap (${(SERVER_WORK_MS + IN_PLACE_MS) / 1000} s after the tap)`;
}

/**
 * An action's result that must show on the page, in place: `check(timeout)` is
 * the assertion. Call it right after the tap. The page must show the result
 * within IN_PLACE_MS of the server finishing (`serverDid`, see the header); the
 * server gets SERVER_WORK_MS. A page that never shows what the server did fails
 * with NAV_HANG — there is no reload.
 */
export async function shownInPlace(
  page: Page,
  what: string,
  check: (timeout: number) => Promise<unknown>,
  serverDid: ServerDone
): Promise<void> {
  const start = Date.now();
  const miss = await untilShown(start, what, serverClock(serverDid, start, page), check);
  if (!miss) return;
  const at = new URL(page.url());
  const log = typeof serverDid === 'function' ? logs.get(page) : serverDid;
  throw new Error(
    `${what}: not shown in place at ${at.pathname}${at.search} — ${describeMiss(miss)}` +
      `\n${String((miss.last as Error)?.message ?? miss.last).slice(0, 600)}` +
      (log ? `\n${log.summary()}` : '')
  );
}

/**
 * A tap that must land on `url` in the app, within IN_PLACE_MS of the server
 * finishing (as shownInPlace). A tap that never lands (NAV_HANG) fails — the URL
 * is not loaded for it.
 */
export async function landsInPlace(page: Page, url: RegExp, what: string, serverDid: ServerDone): Promise<void> {
  await shownInPlace(page, what, (timeout) => page.waitForURL(url, { timeout, waitUntil: 'commit' }), serverDid);
}
