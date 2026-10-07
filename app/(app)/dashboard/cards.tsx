/**
 * F2 — the insights dashboard's cards. Server components: they receive only the
 * aggregates lib/insights/load.ts returned and render them as HTML and inline
 * SVG. Nothing here queries, and nothing here is sent to the browser as data.
 *
 * Every card states what it counts (InsightCard `definition`), and every card
 * whose query failed shows a notice in its own place (Section.ok === false).
 */
import Link from 'next/link';
import type { Route } from 'next';
import { InsightCard } from '@/components/insights/InsightCard';
import { KpiTile } from '@/components/insights/KpiTile';
import { ColumnChart, type ColumnPoint } from '@/components/insights/ColumnChart';
import { BarList, type BarRow } from '@/components/insights/BarList';
import { SegmentBar } from '@/components/insights/SegmentBar';
import { OmanHeatMap } from '@/components/insights/OmanHeatMap';
import { SERIES } from '@/components/insights/palette';
import type { Insights } from '@/lib/insights/load';
import { bucketLabel, isPartialBucket, type InsightPeriod } from '@/lib/insights/period';
import { MAP, MIN_CUSTOMERS_TO_RANK, NEW_CUSTOMERS, ROUTE_LIST_SIZE } from '@/lib/insights/policy';
import type { InsightScope } from '@/lib/insights/scope';
import {
  REQUEST_KINDS,
  changePct,
  pct,
  sumKinds,
  type RequestKind,
  type RouteRef,
  type StateCounts,
} from '@/lib/insights/shape';
import { customersHref, type DashboardQuery } from '@/lib/insights/url';
import type { Highlight } from '@/lib/insights/highlights';

export type CardContext = {
  /** A region-scoped (or route-scoped) viewer: Manager wording and Manager rules. */
  scoped: boolean;
  scope: Exclude<InsightScope, { kind: 'none' }>;
  period: InsightPeriod;
  /** "in the last 30 days" / "from 1 Sep 2026 to 30 Sep 2026" */
  periodPhrase: string;
  /** "vs the 30 days before" */
  against: string;
  applied: DashboardQuery;
  /** The viewer may open /approvals (a Manager). */
  canOpenApprovals: boolean;
  /** The viewer may open /status (a Manager or the Steward). */
  canOpenStatus: boolean;
};

const fmt = (v: number) => v.toLocaleString('en-GB');
const LIST_CAP = 12;

function routeLabel(r: RouteRef): string {
  return r.name && r.name !== r.code ? `${r.code} · ${r.name}` : r.code;
}

/** /customers for one region, keeping the route filter in view so the count reconciles. */
function regionHref(ctx: CardContext, regionId: string): Route {
  return customersHref({ region: [regionId], route: ctx.applied.route });
}

/** /customers for one route, keeping the region filter in view. */
function routeHref(ctx: CardContext, routeId: string): Route {
  return customersHref({ region: ctx.applied.region, route: [routeId] });
}

// ── The top row ──────────────────────────────────────────────────────────────

export function KpiRow({ data, ctx }: { data: Insights; ctx: CardContext }) {
  const s = data.state.ok ? data.state.data.total : null;
  const c = data.created.ok ? data.created.data : null;
  const u = data.updated.ok ? data.updated.data : null;
  const st = data.statusChanges.ok ? data.statusChanges.data : null;
  const pipe = data.pipeline.ok ? data.pipeline.data : null;
  const pending = pipe ? (ctx.scoped ? sumKinds(pipe.waitingFirstStep) : sumKinds(pipe.waitingAnyStep)) : 0;
  // Reactivations wait at the Manager's own step and are decided on /reactivations,
  // not /approvals, so the Supervisor-step count leaves them out; a Manager is
  // shown them beside it, so the tile never hides work that waits for him.
  const reactivations = pipe ? pipe.waitingAnyStep.reactivation : 0;
  const gps = s ? pct(s.openWithGps, s.open) : null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      <KpiTile
        label="New customers"
        failed={!c}
        value={fmt(c?.total ?? 0)}
        delta={c ? { pct: changePct(c.total, c.prevTotal), against: ctx.against } : undefined}
        sub={c ? `${fmt(c.cash)} cash · ${fmt(c.credit)} credit` : undefined}
      />
      <KpiTile
        label="Customers updated"
        failed={!u}
        value={fmt(u?.customers ?? 0)}
        delta={u ? { pct: changePct(u.customers, u.prevCustomers), against: ctx.against } : undefined}
        sub={u ? `${fmt(u.byRequest)} by salesmen's requests · ${fmt(u.directOnly)} by direct write only` : undefined}
      />
      <KpiTile
        label="Pending approval"
        failed={!pipe}
        value={fmt(pending)}
        sub={
          ctx.scoped
            ? 'Waiting now in your approval queue, new-customer requests included'
            : 'Waiting now at any step, every kind of request'
        }
        href={ctx.canOpenApprovals ? '/approvals' : undefined}
        hrefLabel={ctx.canOpenApprovals ? 'Open the approval queue' : undefined}
        extra={
          ctx.canOpenApprovals ? (
            <>
              Not counted above:{' '}
              <Link href="/reactivations" className="font-medium text-brand-700 hover:underline">
                {fmt(reactivations)} reactivation{reactivations === 1 ? '' : 's'} waiting for your decision
              </Link>
            </>
          ) : undefined
        }
      />
      <KpiTile
        label="Branches closed"
        failed={!st}
        value={fmt(st?.closed ?? 0)}
        delta={st ? { pct: changePct(st.closed, st.prevClosed), against: ctx.against, goodWhenUp: false } : undefined}
        sub={st ? `${fmt(st.reactivated)} reactivated · ${fmt(st.closeWaiting + st.reactWaiting)} waiting` : undefined}
      />
      <KpiTile
        label="GPS on open branches"
        failed={!s}
        value={gps === null ? '—' : `${gps}%`}
        sub={s ? `${fmt(s.openWithGps)} of ${fmt(s.open)}` : undefined}
      />
      <KpiTile
        label="Avg completeness"
        failed={!s}
        value={s?.completenessPct === null || s?.completenessPct === undefined ? '—' : `${s.completenessPct}%`}
        sub="Open branches, out of the branch maximum"
      />
      <KpiTile
        label="Customers in view"
        failed={!s}
        value={fmt(s?.customers ?? 0)}
        sub={s ? `${fmt(s.branches)} branches · ${fmt(s.open)} open` : undefined}
        href={customersHref({ region: ctx.applied.region, route: ctx.applied.route })}
        hrefLabel="Open the customer list"
      />
    </div>
  );
}

// ── What stands out ──────────────────────────────────────────────────────────

export function HighlightsCard({ items, coverage }: { items: Highlight[]; coverage: 'all' | 'some' | 'none' }) {
  return (
    <InsightCard
      title="What stands out"
      wide
      failed={coverage === 'none'}
      definition="Read from the figures on this page, for exactly what is in view. Nothing here compares you with another region or person."
    >
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">
          {coverage === 'all'
            ? 'Nothing to report for this view yet.'
            : 'Nothing to report from the figures that loaded; some could not be loaded just now.'}
        </p>
      ) : (
        <>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            {items.map((h) => (
              <li key={h.key}>{h.text}</li>
            ))}
          </ul>
          {coverage === 'some' && (
            <p className="mt-2 text-xs text-slate-500">Some figures could not be loaded just now, so this reading leaves them out.</p>
          )}
        </>
      )}
    </InsightCard>
  );
}

// ── New customers ────────────────────────────────────────────────────────────

export function NewCustomersCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  const c = data.created.ok ? data.created.data : null;
  const imported = NEW_CUSTOMERS.showImported && data.state.ok ? data.state.data.total.imported : null;
  const points: ColumnPoint[] = (c?.series ?? []).map((p) => ({
    key: p.bucket,
    label: bucketLabel(p.bucket, ctx.period.grain),
    values: [p.cash, p.credit, p.other],
    partial: isPartialBucket(p.bucket, ctx.period),
  }));
  const byArea = c ? (c.regions.length > 1 ? 'region' : 'route') : 'region';
  const rows: BarRow[] = c
    ? byArea === 'region'
      ? c.regions.slice(0, LIST_CAP).map((r) => ({ key: r.region.id, label: r.region.name, value: r.n }))
      : c.routes.slice(0, LIST_CAP).map((r) => ({ key: r.route.id, label: routeLabel(r.route), value: r.n }))
    : [];
  const more = c ? (byArea === 'region' ? c.regions.length : c.routes.length) - rows.length : 0;
  return (
    <InsightCard
      title="New customers over time"
      failed={!c}
      definition={
        <>
          Field-created customers: new-customer requests given their final approval {ctx.periodPhrase}, dated by that
          decision (Oman days{ctx.period.grain === 'week' ? '; weeks start on Monday' : ''}). Counted as requests
          finalized, on the route each was raised on, in that route&apos;s current region. Imports are not counted here.
        </>
      }
      footer={
        imported === null ? undefined : (
          <>
            Loaded by import {ctx.periodPhrase}, shown apart and not counted above:{' '}
            <span className="font-semibold tabular-nums text-slate-700">{fmt(imported)}</span> customer
            {imported === 1 ? '' : 's'}.
          </>
        )
      }
    >
      <ColumnChart
        unit="new customers"
        emptyText={`No new customer was finalized ${ctx.periodPhrase}.`}
        series={[
          { key: 'cash', label: 'Cash', color: SERIES[0] },
          { key: 'credit', label: 'Credit', color: SERIES[1] },
          { key: 'other', label: 'Terms not recorded', color: SERIES[2] },
        ].filter((_s, i) => i < 2 || (c?.unrecorded ?? 0) > 0)}
        points={(c?.unrecorded ?? 0) > 0 ? points : points.map((p) => ({ ...p, values: p.values.slice(0, 2) }))}
      />
      {rows.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            By {byArea === 'region' ? 'current region' : 'route'}
          </h3>
          <BarList rows={rows} emptyText="" more={more} />
        </div>
      )}
    </InsightCard>
  );
}

// ── Customers updated ────────────────────────────────────────────────────────

const FAMILY_LABELS: Array<[keyof import('@/lib/insights/shape').FieldFamilies, string]> = [
  ['gps', 'GPS location'],
  ['phone', 'Phone numbers'],
  ['address', 'Address'],
  ['visitDay', 'Visit day'],
  ['equipment', 'Coolers, stands, bottles'],
  ['channel', 'Channel'],
  ['contact', 'Contact person'],
];

export function UpdatedCustomersCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  const u = data.updated.ok ? data.updated.data : null;
  const points: ColumnPoint[] = (u?.series ?? []).map((p) => ({
    key: p.bucket,
    label: bucketLabel(p.bucket, ctx.period.grain),
    values: [p.byRequest, p.directOnly],
    partial: isPartialBucket(p.bucket, ctx.period),
  }));
  const families: BarRow[] = u
    ? FAMILY_LABELS.map(([k, label]) => ({ key: k, label, value: u.families[k] }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];
  return (
    <InsightCard
      title="Customers updated over time"
      failed={!u}
      definition={
        <>
          Customers with an approved change {ctx.periodPhrase}: a salesman&apos;s update request once approved, or a
          Manager&apos;s or Steward&apos;s direct write, dated by the decision. Closures, reactivations, photos and
          imports are not updates here. A customer changed in two {ctx.period.grain}s counts in both bars, and once in
          the total.
        </>
      }
      footer={u ? <>{fmt(u.changes)} approved changes in all, on {fmt(u.customers)} customers.</> : undefined}
    >
      <ColumnChart
        unit="customers updated"
        legendTotals={false}
        emptyText={`No customer change was approved ${ctx.periodPhrase}.`}
        series={[
          { key: 'request', label: "Salesmen's requests", color: SERIES[0] },
          { key: 'direct', label: 'Direct writes only', color: SERIES[1] },
        ]}
        points={points}
      />
      {families.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">What changed (customers)</h3>
          <BarList rows={families} emptyText="" color={SERIES[2]} />
        </div>
      )}
    </InsightCard>
  );
}

// ── Activity by region (or by route when one region is in view) ─────────────

function activityDefinition(ctx: CardContext, area: string) {
  return (
    <>
      Per {area} as it stands today: customers with a live branch there (the number opens the same list in Customers),
      new customers {ctx.periodPhrase} (by the route each was raised on), and customers updated and the share of the{' '}
      {area}&apos;s customers that is. A customer with branches in two places counts in both.
    </>
  );
}

export function ActivityByAreaCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  if (!data.state.ok || !data.created.ok || !data.updated.ok) {
    return <InsightCard title="Activity by area" failed definition={activityDefinition(ctx, 'region or route')} />;
  }
  const state = data.state.data;
  const created = data.created.data;
  const updated = data.updated.data;
  const byRegion = state.regions.length > 1;
  const items = byRegion
    ? state.regions.map((r) => ({
        key: r.region.id,
        label: r.region.name,
        href: regionHref(ctx, r.region.id),
        customers: r.customers,
        created: created.regions.find((x) => x.region.id === r.region.id)?.n ?? 0,
        updated: updated.regions.find((x) => x.region.id === r.region.id)?.customers ?? 0,
      }))
    : state.routes.map((r) => ({
        key: r.route.id,
        label: routeLabel(r.route),
        href: routeHref(ctx, r.route.id),
        customers: r.customers,
        created: created.routes.find((x) => x.route.id === r.route.id)?.n ?? 0,
        updated: updated.routes.find((x) => x.route.id === r.route.id)?.customers ?? 0,
      }));
  items.sort((a, b) => b.customers - a.customers || a.label.localeCompare(b.label));
  const shown = items.slice(0, LIST_CAP);
  return (
    <InsightCard
      title={byRegion ? 'Activity by region' : 'Activity by route'}
      definition={activityDefinition(ctx, byRegion ? 'region' : 'route')}
    >
      {shown.length === 0 ? (
        <p className="text-sm text-slate-500">No customers in view.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-xs">
          {shown.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
              <span className="truncate font-medium text-slate-800">{r.label}</span>
              <Link
                href={r.href}
                className="text-right tabular-nums font-medium text-brand-700 hover:underline"
                aria-label={`${fmt(r.customers)} customers in ${r.label}: open the list`}
              >
                {fmt(r.customers)} cust.
              </Link>
              <span className="col-span-2 tabular-nums text-slate-600 sm:col-span-1 sm:text-right">{fmt(r.created)} new</span>
              <span className="col-span-2 tabular-nums text-slate-600 sm:col-span-1 sm:text-right">
                {fmt(r.updated)} updated ({pct(r.updated, r.customers) ?? 0}%)
              </span>
            </li>
          ))}
        </ul>
      )}
      {items.length > shown.length && (
        <p className="mt-2 text-[11px] text-slate-500">and {fmt(items.length - shown.length)} more</p>
      )}
    </InsightCard>
  );
}

// ── Routes: most and least active ────────────────────────────────────────────

function routeActivityDefinition(ctx: CardContext) {
  return (
    <>
      The share of each route&apos;s customers that a salesman&apos;s approved request updated on that route{' '}
      {ctx.periodPhrase}: a request counts on the route of the branch it changed (by the route that branch is on today),
      or, when it changed no branch, on its salesman&apos;s own route — never on every route a customer has a branch on.
      Only routes with at least {MIN_CUSTOMERS_TO_RANK} customers are ranked, so one update on a tiny route does not top
      the list. Route-level: each route is shown by its code, which is its salesman&apos;s username.
    </>
  );
}

export function RouteActivityCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  if (!data.state.ok || !data.created.ok || !data.updated.ok) {
    return <InsightCard title="Routes: most and least active" failed definition={routeActivityDefinition(ctx)} />;
  }
  const created = new Map(data.created.data.routes.map((r) => [r.route.id, r.n]));
  const updated = new Map(data.updated.data.routes.map((r) => [r.route.id, r.byRequestOnRoute]));
  const routes = data.state.data.routes
    .filter((r) => r.customers > 0)
    .map((r) => ({
      route: r.route,
      customers: r.customers,
      created: created.get(r.route.id) ?? 0,
      updated: updated.get(r.route.id) ?? 0,
    }))
    .map((r) => ({ ...r, rate: r.updated / r.customers }));
  const ranked = routes.filter((r) => r.customers >= MIN_CUSTOMERS_TO_RANK);
  // "Most active" holds only routes with some activity: five routes at 0% would be
  // ranked by a tie-breaker, as if by performance.
  const top = ranked
    .filter((r) => r.rate > 0)
    .sort((a, b) => b.rate - a.rate || b.updated - a.updated)
    .slice(0, ROUTE_LIST_SIZE);
  const bottom = [...ranked]
    .sort((a, b) => a.rate - b.rate || b.customers - a.customers)
    .filter((r) => !top.includes(r))
    .slice(0, ROUTE_LIST_SIZE);
  const idle = routes.filter((r) => r.created === 0 && r.updated === 0);
  const unowned = idle.filter((r) => !r.route.hasOwner);
  const row = (r: (typeof ranked)[number]): BarRow => ({
    key: r.route.id,
    label: routeLabel(r.route),
    note: `${fmt(r.updated)} of ${fmt(r.customers)} customers updated · ${fmt(r.created)} new${r.route.hasOwner ? '' : ' · no salesman'}`,
    value: Math.round(r.rate * 100),
    display: `${Math.round(r.rate * 100)}%`,
    href: routeHref(ctx, r.route.id),
    hrefLabel: `Route ${r.route.code}: open its customers`,
  });
  return (
    <InsightCard
      title="Routes: most and least active"
      definition={routeActivityDefinition(ctx)}
      footer={
        idle.length > 0 ? (
          <>
            {fmt(idle.length)} route{idle.length === 1 ? '' : 's'} with customers had no approved new-customer or update
            request {ctx.periodPhrase}
            {unowned.length > 0 ? (
              <>
                ; {fmt(unowned.length)} ha{unowned.length === 1 ? 's' : 've'} no salesman assigned (
                {unowned
                  .slice(0, 8)
                  .map((r) => r.route.code)
                  .join(', ')}
                {unowned.length > 8 ? '…' : ''}), so no field request can come from them
              </>
            ) : null}
            .
          </>
        ) : undefined
      }
    >
      {ranked.length === 0 ? (
        <p className="text-sm text-slate-500">No route in view has {MIN_CUSTOMERS_TO_RANK} or more customers.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Most active</h3>
            {top.length === 0 ? (
              <p className="text-sm text-slate-500">
                No route in view had an approved update request {ctx.periodPhrase}.
              </p>
            ) : (
              <BarList rows={top.map(row)} max={100} emptyText="" />
            )}
          </div>
          {bottom.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Least active</h3>
              <BarList rows={bottom.map(row)} max={100} color={SERIES[1]} emptyText="" />
            </div>
          )}
        </div>
      )}
    </InsightCard>
  );
}

// ── Completeness ─────────────────────────────────────────────────────────────

const COMPLETENESS_DEFINITION = (
  <>
    The average completeness score of open branches, out of the branch maximum (60) and shown as a percentage. A score is
    as fresh as the last change or rescore of its branch, and an &quot;address pending&quot; placeholder still counts as
    an address, so these read high.
  </>
);

export function CompletenessCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  if (!data.state.ok) return <InsightCard title="Completeness" failed definition={COMPLETENESS_DEFINITION} />;
  const s = data.state.data;
  const routes = s.routes.filter((r) => r.open > 0 && r.completenessPct !== null);
  const top = [...routes].sort((a, b) => b.completenessPct! - a.completenessPct! || b.open - a.open).slice(0, ROUTE_LIST_SIZE);
  const bottom = [...routes]
    .sort((a, b) => a.completenessPct! - b.completenessPct! || b.open - a.open)
    .filter((r) => !top.includes(r))
    .slice(0, ROUTE_LIST_SIZE);
  const row = (r: (typeof routes)[number]): BarRow => ({
    key: r.route.id,
    label: routeLabel(r.route),
    note: `${fmt(r.open)} open branch${r.open === 1 ? '' : 'es'}`,
    value: r.completenessPct!,
    display: `${r.completenessPct}%`,
    href: routeHref(ctx, r.route.id),
    hrefLabel: `Route ${r.route.code}: open its customers`,
  });
  const regions = s.regions.filter((r) => r.open > 0 && r.completenessPct !== null);
  return (
    <InsightCard
      title="Completeness"
      definition={COMPLETENESS_DEFINITION}
    >
      <div className="space-y-4">
        {regions.length > 1 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By region</h3>
            <BarList
              max={100}
              emptyText=""
              rows={regions.map((r) => ({
                key: r.region.id,
                label: r.region.name,
                value: r.completenessPct!,
                display: `${r.completenessPct}%`,
              }))}
            />
          </div>
        )}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Highest routes</h3>
          <BarList rows={top.map(row)} max={100} color={SERIES[2]} emptyText="No open branches in view." />
        </div>
        {bottom.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Routes needing attention</h3>
            <BarList rows={bottom.map(row)} max={100} color={SERIES[1]} emptyText="" />
          </div>
        )}
      </div>
    </InsightCard>
  );
}

// ── Closures and reactivations ───────────────────────────────────────────────

export function ClosuresCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  const st = data.statusChanges.ok ? data.statusChanges.data : null;
  const now = data.state.ok ? data.state.data.total : null;
  const points: ColumnPoint[] = (st?.series ?? []).map((p) => ({
    key: p.bucket,
    label: bucketLabel(p.bucket, ctx.period.grain),
    values: [p.closed, p.reactivated],
    partial: isPartialBucket(p.bucket, ctx.period),
  }));
  return (
    <InsightCard
      title="Closures and reactivations"
      failed={!st}
      definition={
        <>
          Close-shop and reactivation requests decided {ctx.periodPhrase}, on the branch&apos;s own region and route. A
          customer closes only when its last open branch does, so this reads branches, not customers.
        </>
      }
      footer={
        now ? (
          <>
            Closed right now: <span className="font-semibold tabular-nums text-slate-700">{fmt(now.closed)}</span> branch
            {now.closed === 1 ? '' : 'es'} in view, {fmt(now.closedInPeriod)} of them last changed status {ctx.periodPhrase}{' '}
            (a field closure or an import).
          </>
        ) : undefined
      }
    >
      {st && (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Figure term="Closed" value={st.closed} />
            <Figure term="Reactivated" value={st.reactivated} />
            <Figure term="Close refused" value={st.closeRefused} />
            <Figure term="Kept closed" value={st.keptClosed} />
            <Figure term="Close requests waiting" value={st.closeWaiting} />
            <Figure term="Reactivations waiting" value={st.reactWaiting} />
          </dl>
          <ColumnChart
            unit="branches"
            emptyText={`No closure or reactivation was decided ${ctx.periodPhrase}.`}
            series={[
              { key: 'closed', label: 'Closed', color: SERIES[1] },
              { key: 'reactivated', label: 'Reactivated', color: SERIES[0] },
            ]}
            points={points}
          />
          {ctx.canOpenApprovals && st.reactWaiting > 0 && (
            <p className="mt-2 text-xs">
              <Link href="/reactivations" className="font-medium text-brand-700 hover:underline">
                Open the reactivation requests
              </Link>
            </p>
          )}
        </>
      )}
    </InsightCard>
  );
}

function Figure({ term, value }: { term: string; value: number }) {
  return (
    <div>
      <dt className="text-slate-500">{term}</dt>
      <dd className="text-lg font-semibold tabular-nums text-slate-900">{fmt(value)}</dd>
    </div>
  );
}

// ── Requests by state ────────────────────────────────────────────────────────

const KIND_LABEL: Record<RequestKind, string> = {
  create: 'New-customer requests',
  update: 'Update requests',
  close: 'Close-shop requests',
  reactivation: 'Reactivation requests',
};

export function PipelineCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  const p = data.pipeline.ok ? data.pipeline.data : null;
  return (
    <InsightCard
      title="Requests by state"
      failed={!p}
      definition={
        <>
          Requests submitted {ctx.periodPhrase}, by the state each is in now
          {ctx.scoped ? ' — only requests you can open from your regions' : ''}. A sent-back update stays
          &quot;sent back&quot; for good (the salesman sends a new one); a refused close-shop or reactivation request
          is final; a sent-back new-customer request is revised and resubmitted, which re-dates it. Direct writes
          never queue and are not here. No timings: Service status has those.
        </>
      }
      footer={
        p ? (
          <>
            Waiting now, whenever submitted: {fmt(sumKinds(p.waitingAnyStep))} at any step
            {/* Owner decision 3: a Manager's Supervisor-step count is his queue
                (lib/insights/load.ts), not every request he can open. */}
            {ctx.scoped ? `, ${fmt(sumKinds(p.waitingFirstStep))} of them in your approval queue` : ''}.
            {ctx.canOpenStatus && (
              <>
                {' '}
                <Link href="/status" className="font-medium text-brand-700 hover:underline">
                  Service status
                </Link>{' '}
                shows how long they take.
              </>
            )}
          </>
        ) : undefined
      }
    >
      {p && (
        <div className="space-y-4">
          {REQUEST_KINDS.map((k) => {
            const s = p.submitted[k];
            return (
              <SegmentBar
                key={k}
                label={KIND_LABEL[k]}
                emptyText={`None submitted ${ctx.periodPhrase}.`}
                segments={[
                  { key: 'waiting', label: 'Waiting', value: s.SUBMITTED, color: SERIES[0] },
                  { key: 'back', label: 'Sent back', value: s.NEEDS_CORRECTION, color: SERIES[1] },
                  { key: 'approved', label: 'Approved', value: s.APPROVED, color: SERIES[2] },
                  {
                    key: 'rejected',
                    // A refused close and a "Keep closed" end REJECTED (2026-10-07).
                    label: k === 'close' || k === 'reactivation' ? 'Refused' : 'Closed by a merge',
                    value: s.REJECTED,
                    color: SERIES[3],
                  },
                ]}
              />
            );
          })}
        </div>
      )}
    </InsightCard>
  );
}

// ── The map ──────────────────────────────────────────────────────────────────

export function MapCard({ data, zoom }: { data: Insights; zoom: boolean }) {
  const h = data.heat.ok ? data.heat.data : null;
  const coverage = h ? pct(h.openWithGps, h.openBranches) : null;
  const outside = h ? Math.max(0, h.openWithGps - h.located) : 0;
  const state = data.state.ok ? data.state.data : null;
  const areaRows: BarRow[] = state
    ? state.regions.length > 1
      ? state.regions
          .filter((r) => r.open > 0)
          .map((r) => ({
            key: r.region.id,
            label: r.region.name,
            note: `${fmt(r.openWithGps)} of ${fmt(r.open)} open branches`,
            value: pct(r.openWithGps, r.open) ?? 0,
            display: `${pct(r.openWithGps, r.open) ?? 0}%`,
          }))
      : state.routes
          .filter((r) => r.open > 0)
          .map((r) => ({
            key: r.route.id,
            label: routeLabel(r.route),
            note: `${fmt(r.openWithGps)} of ${fmt(r.open)} open branches`,
            value: pct(r.openWithGps, r.open) ?? 0,
            display: `${pct(r.openWithGps, r.open) ?? 0}%`,
          }))
          .sort((a, b) => a.value - b.value)
    : [];
  return (
    <InsightCard
      title="Where the located branches are"
      wide
      failed={!h}
      definition={
        <>
          Open branches in view that have a GPS location, counted in squares on an approximate outline of Oman — never a
          branch&apos;s own point, and never a phone&apos;s location. GPS exists only where a salesman captured it on an
          update or a new customer; imports carry none. So the map shows where that has happened, not where every customer
          is: read it beside the coverage.
        </>
      }
    >
      {h && (
        <div className="grid gap-6 md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          {h.cells.length > 0 ? (
            <OmanHeatMap cells={h.cells} cellDeg={h.cellDeg} zoom={zoom} />
          ) : (
            <p className="text-sm text-slate-500">No open branch in view has a GPS location on the map yet.</p>
          )}
          <div className="min-w-0 space-y-4">
            <div>
              <div className="text-3xl font-bold tabular-nums text-slate-900">{coverage === null ? '—' : `${coverage}%`}</div>
              <p className="text-xs text-slate-600">
                of open branches in view have GPS ({fmt(h.openWithGps)} of {fmt(h.openBranches)}).
              </p>
              {outside > 0 && (
                <p className="mt-1 text-xs text-amber-800">
                  {fmt(outside)} with GPS outside the map area ({MAP.bounds.latMin}–{MAP.bounds.latMax}°N,{' '}
                  {MAP.bounds.lngMin}–{MAP.bounds.lngMax}°E) — likely mistyped points — are not drawn.
                </p>
              )}
              {h.totalCells > h.cells.length && (
                <p className="mt-1 text-xs text-slate-500">
                  Showing the {fmt(h.cells.length)} densest of {fmt(h.totalCells)} squares.
                </p>
              )}
            </div>
            {areaRows.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  GPS coverage by {state && state.regions.length > 1 ? 'region' : 'route, lowest first'}
                </h3>
                <BarList rows={areaRows.slice(0, LIST_CAP)} max={100} emptyText="" more={areaRows.length - Math.min(areaRows.length, LIST_CAP)} />
              </div>
            )}
          </div>
        </div>
      )}
    </InsightCard>
  );
}

// ── Data-quality gaps ────────────────────────────────────────────────────────

function gapChips(s: StateCounts): string {
  const share = (v: number) => `${pct(v, s.open) ?? 0}%`;
  return [
    `No GPS ${share(s.open - s.openWithGps)}`,
    `No visit day ${share(s.openNoDay)}`,
    `No shop photo ${share(s.openNoShop)}`,
    `No signboard ${share(s.openNoSign)}`,
  ].join(' · ');
}

export function GapsCard({ data, ctx }: { data: Insights; ctx: CardContext }) {
  if (!data.state.ok) {
    return (
      <InsightCard
        title="Data-quality gaps"
        wide
        failed
        definition="What open branches in view are missing — GPS, visit day, shop and signboard photos, confirmed equipment — and customers without a CR photo."
      />
    );
  }
  const s = data.state.data;
  const t = s.total;
  const summary: BarRow[] =
    t.open > 0
      ? [
          { key: 'gps', label: 'No GPS location', value: t.open - t.openWithGps },
          { key: 'day', label: 'No visit day', value: t.openNoDay },
          { key: 'shop', label: 'No shop photo', value: t.openNoShop },
          { key: 'sign', label: 'No signboard photo', value: t.openNoSign },
          { key: 'equipment', label: 'Equipment not confirmed', value: t.openNoEquipment },
        ].map((r) => ({
          ...r,
          display: `${pct(r.value, t.open) ?? 0}% (${fmt(r.value)})`,
          value: pct(r.value, t.open) ?? 0,
        }))
      : [];
  const byRegion = s.regions.length > 1;
  const areas = (byRegion
    ? s.regions.map((r) => ({ key: r.region.id, label: r.region.name, counts: r as StateCounts, href: regionHref(ctx, r.region.id) }))
    : s.routes.map((r) => ({ key: r.route.id, label: routeLabel(r.route), counts: r as StateCounts, href: routeHref(ctx, r.route.id) }))
  )
    .filter((a) => a.counts.open > 0)
    .sort((a, b) => b.counts.open - a.counts.open);
  const shown = areas.slice(0, LIST_CAP);
  return (
    <InsightCard
      title="Data-quality gaps"
      wide
      definition={
        <>
          What open branches in view are missing, as a share of them. The CR photo belongs to the customer: {fmt(t.customersNoCr)}{' '}
          of {fmt(t.customers)} customers in view ({pct(t.customersNoCr, t.customers) ?? 0}%) have none. Each{' '}
          {byRegion ? 'region' : 'route'} opens its customers.
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <BarList rows={summary} max={100} color={SERIES[1]} emptyText="No open branches in view." />
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By {byRegion ? 'region' : 'route'}</h3>
          {shown.length === 0 ? (
            <p className="text-sm text-slate-500">No open branches in view.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {shown.map((a) => (
                <li key={a.key} className="py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link href={a.href} className="truncate font-medium text-brand-700 hover:underline">
                      {a.label}
                    </Link>
                    <span className="shrink-0 tabular-nums text-slate-500">{fmt(a.counts.open)} open</span>
                  </div>
                  <p className="mt-0.5 text-slate-600">{gapChips(a.counts)}</p>
                </li>
              ))}
            </ul>
          )}
          {areas.length > shown.length && <p className="mt-2 text-[11px] text-slate-500">and {fmt(areas.length - shown.length)} more</p>}
        </div>
      </div>
    </InsightCard>
  );
}
