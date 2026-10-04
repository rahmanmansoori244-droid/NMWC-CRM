'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MultiSelectFilter, type MultiSelectOption } from '@/components/nmwc/MultiSelectFilter';
import { dashboardHref, type DashboardQuery } from '@/lib/insights/url';
import { EARLIEST_DAY, PERIOD_PRESETS, type PresetKey } from '@/lib/insights/policy';

export type RouteOption = MultiSelectOption & { regionId: string };

/**
 * F2 — the dashboard's filter bar. Everything lives in the URL, and every change
 * is ONE navigation and ONE server render (each round trip from Oman costs
 * 0.2–0.4 s): a period preset applies on its own click; regions, routes and
 * custom dates apply together on "Apply".
 *
 * The option lists arrive already cut to the viewer's scope by the server. The
 * server intersects whatever the URL says with that scope again, so a hand-made
 * URL can only narrow the view, never widen it (lib/insights/scope.ts).
 *
 * The page renders this with a `key` of the applied query, so a navigation
 * (Back, a preset, a drill-down) remounts it with the applied values instead of
 * keeping stale picks.
 */
export function InsightFilters({
  applied,
  regions,
  routes,
  today,
  showRegion,
}: {
  applied: DashboardQuery & { fromDay: string; toDay: string };
  regions: MultiSelectOption[];
  routes: RouteOption[];
  /** Oman date today: the latest day a custom period may end. */
  today: string;
  /** A Manager with one region has nothing to choose there. */
  showRegion: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [region, setRegion] = useState<string[]>(applied.region);
  const [route, setRoute] = useState<string[]>(applied.route);
  const [customOpen, setCustomOpen] = useState(applied.period === 'custom');
  const [from, setFrom] = useState(applied.fromDay);
  const [to, setTo] = useState(applied.toDay);

  // Routes narrow to the regions picked, the way /customers narrows them.
  const routeOptions = region.length ? routes.filter((r) => region.includes(r.regionId)) : routes;

  function go(q: DashboardQuery) {
    startTransition(() => router.push(dashboardHref(q)));
  }

  const dirty =
    region.join(',') !== applied.region.join(',') ||
    route.join(',') !== applied.route.join(',') ||
    (customOpen && (applied.period !== 'custom' || from !== applied.fromDay || to !== applied.toDay));

  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (customOpen) go({ period: 'custom', from, to, region, route });
    else go({ period: applied.period, from: applied.from, to: applied.to, region, route });
  }

  const presetKeys = Object.keys(PERIOD_PRESETS) as PresetKey[];

  return (
    <form
      onSubmit={apply}
      aria-label="Dashboard filters"
      className="space-y-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-600">Period</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Period">
          {presetKeys.map((k) => {
            const on = applied.period === k && !customOpen;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setCustomOpen(false);
                  go({ period: k, region, route });
                }}
                className={`h-9 rounded-md px-3 text-sm font-medium ring-1 ring-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
                }`}
              >
                {PERIOD_PRESETS[k].label}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={customOpen}
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
            className={`h-9 rounded-md px-3 text-sm font-medium ring-1 ring-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              customOpen ? 'bg-brand-50 text-brand-800 ring-brand-500' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
            }`}
          >
            Custom
          </button>
        </div>
        {customOpen && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1 text-xs text-slate-600">
              From
              <input
                type="date"
                value={from}
                min={EARLIEST_DAY}
                max={today}
                onChange={(e) => setFrom(e.currentTarget.value)}
                className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900"
                required
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              To
              <input
                type="date"
                value={to}
                min={EARLIEST_DAY}
                max={today}
                onChange={(e) => setTo(e.currentTarget.value)}
                className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900"
                required
              />
            </label>
            <span className="text-[11px] text-slate-500">Oman days, both included; up to 366 days.</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {showRegion && (
          <MultiSelectFilter
            label="Region"
            value={region}
            options={regions}
            allLabel="All in view"
            onChange={(next) => {
              setRegion(next);
              // Keep only routes still offered under the new regions.
              if (next.length) setRoute((cur) => cur.filter((id) => routes.some((r) => r.value === id && next.includes(r.regionId))));
            }}
          />
        )}
        <MultiSelectFilter label="Route" value={route} options={routeOptions} allLabel="All in view" onChange={setRoute} />
        <button
          type="submit"
          disabled={pending || !dirty}
          className="h-10 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
        >
          Apply
        </button>
        {(applied.region.length > 0 || applied.route.length > 0) && (
          <Link
            href={dashboardHref({ period: applied.period, from: applied.from, to: applied.to, region: [], route: [] })}
            className="text-sm font-medium text-slate-600 hover:underline"
          >
            Clear filters
          </Link>
        )}
        <span aria-live="polite" className="text-xs text-slate-500">
          {pending ? 'Updating…' : dirty ? 'Not applied yet — press Apply.' : ''}
        </span>
      </div>
    </form>
  );
}
