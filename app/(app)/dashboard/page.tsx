import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { loadScope } from '@/lib/access';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { getAllActiveRegions, getAllActiveRoutes, type RegionLite, type RouteLite } from '@/lib/reference-data';
import { omanWhen } from '@/lib/submission';
import { omanDateISO } from '@/lib/tz';
import { HISTORY_BASELINE_DAY, isDashboardRole, PERIOD_PRESETS } from '@/lib/insights/policy';
import { dayLabel, parsePeriod, type InsightPeriod } from '@/lib/insights/period';
import {
  parseInsightFilters,
  resolveInsightScope,
  roleScopeIsOrgWide,
  singleRegionInView,
  type InsightScope,
  type RoleScope,
} from '@/lib/insights/scope';
import { loadInsights } from '@/lib/insights/load';
import { highlights } from '@/lib/insights/highlights';
import type { DashboardQuery } from '@/lib/insights/url';
import { STATUS_ROLES } from '@/lib/service-levels';
import { InsightFilters, type RouteOption } from './InsightFilters';
import {
  ActivityByAreaCard,
  ClosuresCard,
  CompletenessCard,
  GapsCard,
  HighlightsCard,
  KpiRow,
  MapCard,
  NewCustomersCard,
  PipelineCard,
  RouteActivityCard,
  UpdatedCustomersCard,
  type CardContext,
} from './cards';

export const metadata = { title: 'Dashboard · NMWC' };
// Region-scoped per viewer: rendered per request, never cached. A shared cache
// entry would serve one Manager another's figures (lib/insights/load.ts).
export const dynamic = 'force-dynamic';

type Search = {
  period?: string | string[];
  from?: string | string[];
  to?: string | string[];
  region?: string | string[];
  route?: string | string[];
};

/**
 * F2 (2026-10-05): the insights dashboard — the landing page of every Manager and
 * Viewer, and the Steward's from the menu.
 *
 * Who sees what: DASHBOARD_ROLES (lib/insights/policy.ts). A Manager sees his
 * managed regions only — no national total, no company average — and a Manager
 * with no regions sees the "no regions" notice and nothing else; the Viewer and
 * the Steward see the whole organisation. URL filters narrow that and never widen
 * it (lib/insights/scope.ts). Every figure is an aggregate computed on the server
 * (lib/insights/load.ts); the only client component is the filter bar, which gets
 * option lists already cut to the viewer's scope.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const role = session.user.role;
  if (!isDashboardRole(role)) redirect('/home');

  const sp = await searchParams;
  // The clock is read once; every window and label below derives from it.
  const now = new Date();
  const period = parsePeriod(sp, now);
  const filters = parseInsightFilters(sp);

  // Org-wide roles need no scope read; anyone else's scope comes from the database.
  let roleScope: RoleScope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };
  if (!roleScopeIsOrgWide(role)) {
    try {
      roleScope = await loadScope(session.user.id);
    } catch {
      return (
        <main>
          <PageHeader title="Dashboard" subtitle="Your regions could not be read" />
          <div className="m-4 rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200 sm:m-6">
            The dashboard could not read which regions you manage just now, so it shows nothing rather than the wrong
            figures. Reload the page to try again.
          </div>
        </main>
      );
    }
  }

  const scope = resolveInsightScope(role, roleScope, filters);
  if (scope.kind === 'none') {
    // RBAC-05-012: a Manager with no managed regions sees nothing, not the company.
    return (
      <main className="p-6">
        <PageHeader title="Dashboard" subtitle="No regions assigned" />
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
          You have no managed regions. Ask a Steward to assign your regions; you will not see any data on the dashboard
          until then.
        </div>
      </main>
    );
  }

  const [insights, options] = await Promise.all([loadInsights(scope, period), filterOptions(scope)]);

  const scoped = scope.kind !== 'company';
  const applied: DashboardQuery = {
    period: period.key,
    from: period.key === 'custom' ? period.fromDay : undefined,
    to: period.key === 'custom' ? period.toDay : undefined,
    region: filters.regionIds,
    route: filters.routeIds,
  };
  const ctx: CardContext = {
    scoped,
    scope,
    period,
    periodPhrase: periodPhrase(period),
    against: againstPhrase(period),
    applied,
    canOpenApprovals: role === 'MANAGER',
    canOpenStatus: STATUS_ROLES.includes(role),
  };
  const items = highlights(insights, ctx.periodPhrase);
  const baselineNote = historyNote(period);
  const viewName = describeView(scope, options.regions);

  return (
    <main>
      <PageHeader
        title="Dashboard"
        subtitle={`${viewName} · ${dayLabel(period.fromDay)} – ${dayLabel(period.toDay)}, Oman days`}
        actions={
          <p className="text-xs text-slate-500">
            Figures as of <span className="font-medium tabular-nums">{omanWhen(now, now)}</span> Oman time
          </p>
        }
      />
      <InsightFilters
        key={`${period.key}|${period.fromDay}|${period.toDay}|${filters.regionIds.join(',')}|${filters.routeIds.join(',')}`}
        applied={{ ...applied, fromDay: period.fromDay, toDay: period.toDay }}
        regions={options.regions.map((r) => ({ value: r.id, label: r.name }))}
        routes={options.routes}
        today={omanDateISO(now)}
        showRegion={!(scope.roleRegionIds && scope.roleRegionIds.length === 1)}
      />
      {(period.note || baselineNote || filters.rejected || options.failed) && (
        <div className="mx-4 mt-4 space-y-1 rounded-md bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200 sm:mx-6">
          {period.note && <p>{period.note}</p>}
          {baselineNote && <p>{baselineNote}</p>}
          {filters.rejected && <p>A filter in the address was too long to read, so it matches nothing. Clear the filters.</p>}
          {options.failed && <p>The region and route lists could not be loaded just now; the figures below are unaffected.</p>}
        </div>
      )}

      <div className="space-y-4 p-4 sm:p-6">
        <KpiRow data={insights} ctx={ctx} />
        <div className="grid gap-4 lg:grid-cols-2">
          <HighlightsCard items={items} />
          <NewCustomersCard data={insights} ctx={ctx} />
          <UpdatedCustomersCard data={insights} ctx={ctx} />
          <ActivityByAreaCard data={insights} ctx={ctx} />
          <RouteActivityCard data={insights} ctx={ctx} />
          <MapCard data={insights} zoom={singleRegionInView(scope) !== null} />
          <GapsCard data={insights} ctx={ctx} />
          <CompletenessCard data={insights} ctx={ctx} />
          <ClosuresCard data={insights} ctx={ctx} />
          <PipelineCard data={insights} ctx={ctx} />
        </div>
        <p className="text-[11px] text-slate-500">
          Attribution is by each branch&apos;s current route and region: a route handed over or moved takes its history
          with it. Dates and buckets are Oman calendar days.
        </p>
      </div>
    </main>
  );
}

/** The caveat for a window, or its comparison window, reaching back before go-live. */
function historyNote(p: InsightPeriod): string | null {
  const day = dayLabel(HISTORY_BASELINE_DAY);
  if (p.fromDay < HISTORY_BASELINE_DAY) {
    return `This period starts before go-live (${day}). Activity before then is the pilot and test runs, and some of it was deleted since, so read those weeks with care.`;
  }
  if (p.prevFromDay < HISTORY_BASELINE_DAY) {
    return `The comparison with the period before reaches back before go-live (${day}), when activity was the pilot and test runs, so read the up and down arrows with care.`;
  }
  return null;
}

function periodPhrase(p: InsightPeriod): string {
  if (p.key !== 'custom') return `in the last ${PERIOD_PRESETS[p.key].label}`;
  return p.fromDay === p.toDay ? `on ${dayLabel(p.fromDay)}` : `from ${dayLabel(p.fromDay)} to ${dayLabel(p.toDay)}`;
}

function againstPhrase(p: InsightPeriod): string {
  return `vs the ${p.days === 1 ? 'day' : `${p.days.toLocaleString('en-GB')} days`} before`;
}

function describeView(scope: Exclude<InsightScope, { kind: 'none' }>, regions: RegionLite[]): string {
  const names = (ids: string[] | null) =>
    (ids ?? [])
      .map((id) => regions.find((r) => r.id === id)?.name)
      .filter((n): n is string => !!n);
  if (scope.kind === 'company') {
    if (!scope.filtered) return 'Whole organisation';
    const picked = names(scope.regionIds);
    return picked.length ? `Filtered: ${picked.join(', ')}` : 'Filtered view';
  }
  const own = names(scope.roleRegionIds);
  const label = own.length ? `Your regions: ${own.join(', ')}` : 'Your regions';
  return scope.filtered ? `${label} (filtered)` : label;
}

/**
 * The region and route choices, cut to the viewer's ROLE scope (not to the URL
 * filters, so a pick can be undone). The lists are the cached, unscoped
 * reference lists (lib/reference-data.ts), filtered here per viewer — the one
 * safe way to cache scoped data. A route moved out of a Manager's regions whose
 * branches stayed behind (F14) is not offered, though its branches still count.
 */
async function filterOptions(
  scope: Exclude<InsightScope, { kind: 'none' }>
): Promise<{ regions: RegionLite[]; routes: RouteOption[]; failed: boolean }> {
  try {
    const [regions, routes] = await Promise.all([getAllActiveRegions(), getAllActiveRoutes()]);
    const regionOk = (id: string) => !scope.roleRegionIds || scope.roleRegionIds.includes(id);
    const routeOk = (r: RouteLite) => regionOk(r.regionId) && (!scope.roleRouteIds || scope.roleRouteIds.includes(r.id));
    return {
      regions: regions.filter((r) => regionOk(r.id)),
      routes: routes
        .filter(routeOk)
        .map((r) => ({ value: r.id, label: r.name && r.name !== r.code ? `${r.code} · ${r.name}` : r.code, regionId: r.regionId })),
      failed: false,
    };
  } catch {
    return { regions: [], routes: [], failed: true };
  }
}
