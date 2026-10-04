/**
 * F2 — how the insights dashboard is switched off, and how long it may take.
 *
 * /dashboard is the landing page of every Manager and Viewer (lib/role-home.ts),
 * and where a Manager lands after signing in from a link. A broken or slow
 * dashboard therefore degrades every such sign-in, so it has two levers that are
 * not a revert:
 *
 *   - the kill switch: INSIGHTS_DASHBOARD_DISABLED=true (Vercel, then REDEPLOY —
 *     environment variables are read at instance start, as MAINTENANCE_MODE's
 *     are; docs/OPERATIONS.md §6.8) makes /dashboard render a short notice with
 *     links to the pages the viewer works from, and run no dashboard query at all;
 *   - the time limits: every statement runs with its own Postgres
 *     statement_timeout, and the page waits for the whole wave at most
 *     WAVE_DEADLINE_MS. A statement still running then fails its own cards like
 *     any other failure ("could not be loaded just now"); the rest of the page
 *     renders. Both are well inside the function's 60 s limit (vercel.json).
 *
 * Engineering limits, not owner decisions (those are lib/insights/policy.ts).
 * Pure apart from reading the one environment variable: no database, no session.
 */

/** Postgres cancels one dashboard statement after this long (SET LOCAL statement_timeout). */
export const STATEMENT_TIMEOUT_MS = 10_000;

/** The page waits this long for the six statements together, and for its filter lists. */
export const WAVE_DEADLINE_MS = 20_000;

/** The kill switch. Only the exact value "true" switches the dashboard off, as DEMO_ACCOUNTS_DISABLED reads. */
export function insightsDashboardDisabled(): boolean {
  return process.env.INSIGHTS_DASHBOARD_DISABLED === 'true';
}

/** What a statement that ran out of time rejects with: a class and a code, never a message worth logging. */
export class InsightsDeadlineError extends Error {
  readonly code = 'DEADLINE';
  constructor(ms: number) {
    super(`did not finish within ${ms} ms`);
    this.name = 'InsightsDeadlineError';
  }
}

/**
 * `work`, or a rejection with InsightsDeadlineError once `ms` have passed —
 * whichever comes first. The timer is cleared as soon as either settles, so a
 * finished wave leaves nothing pending. The work itself is not cancelled here:
 * the database side has its own statement_timeout for that.
 */
export function withinDeadline<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InsightsDeadlineError(ms)), ms);
  });
  return Promise.race([Promise.resolve(work), deadline]).finally(() => clearTimeout(timer));
}
