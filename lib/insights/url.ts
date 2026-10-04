/**
 * F2 — the dashboard's query string and its drill-down links. Pure, shared by the
 * page (server) and the filter bar (client), so both build the same URL.
 *
 * The URL carries ids and dates only — never a name or a phone number (Vercel
 * keeps request paths and query strings for 30 days: DATA-RETENTION gap 7).
 */
import { DEFAULT_PRESET } from './policy';
import type { PeriodKey } from './period';

export type DashboardQuery = {
  period: PeriodKey;
  /** Only for period 'custom': Oman days, inclusive. */
  from?: string;
  to?: string;
  region: string[];
  route: string[];
};

/** Key order is fixed, and the default period is left out, so one view has one URL. */
export function dashboardQueryString(q: DashboardQuery): string {
  const sp = new URLSearchParams();
  if (q.period === 'custom') {
    sp.set('period', 'custom');
    if (q.from) sp.set('from', q.from);
    if (q.to) sp.set('to', q.to);
  } else if (q.period !== DEFAULT_PRESET) {
    sp.set('period', q.period);
  }
  if (q.region.length) sp.set('region', q.region.join(','));
  if (q.route.length) sp.set('route', q.route.join(','));
  return sp.toString();
}

export function dashboardHref(q: DashboardQuery): '/dashboard' | `/dashboard?${string}` {
  const qs = dashboardQueryString(q);
  return qs ? `/dashboard?${qs}` : '/dashboard';
}

/**
 * The /customers list for a slice of the view. /customers applies the viewer's
 * role scope itself and matches region and route on the SAME branch row
 * (lib/customer-filters.ts), so the list it opens holds exactly the customers a
 * branch-level count here counted — the "customers" figures reconcile with it.
 * Event figures (new, updated, closed) are not filters /customers has: their
 * links open the slice, not the events.
 */
export function customersHref(slice: { region?: string[]; route?: string[] }): '/customers' | `/customers?${string}` {
  const sp = new URLSearchParams();
  if (slice.region?.length) sp.set('region', slice.region.join(','));
  if (slice.route?.length) sp.set('route', slice.route.join(','));
  const qs = sp.toString();
  return qs ? `/customers?${qs}` : '/customers';
}
