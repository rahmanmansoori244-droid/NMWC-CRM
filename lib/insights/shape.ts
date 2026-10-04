/**
 * F2 — the dashboard's aggregate rows, as the cards read them.
 *
 * lib/insights/load.ts runs the SQL; this file only reshapes what came back, so
 * it is pure and unit-tested on synthetic rows (tests/unit/insights-load.test.ts).
 * Every row already holds counts only: no customer, branch, person or point.
 *
 * Several statements use GROUPING SETS and return one row per set; `g` is
 * Postgres GROUPING(...) over the listed columns, a bitmask with the FIRST column
 * as the highest bit and a bit set when that column is rolled up. The masks each
 * statement uses are named below, next to the set they stand for.
 */
import { BRANCH_MAX_SCORE, completenessPct } from '../completeness';
import type { InsightPeriod } from './period';

export type Section<T> = { ok: true; data: T } | { ok: false };

export type RegionRef = { id: string; name: string; code: string };
export type RouteRef = {
  id: string;
  code: string;
  name: string;
  /** The route's CURRENT region. */
  regionId: string | null;
  regionName: string | null;
  /** An active salesman owns the route. Without one, no field activity can happen on it. */
  hasOwner: boolean;
};

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

// ── 1. Current state: branches and customers in view ─────────────────────────

export type StateRow = {
  regionId: string | null;
  routeId: string | null;
  /** GROUPING("regionId", "routeId"): 1 = per region, 2 = per route, 3 = total. */
  g: number;
  branches: number;
  customers: number;
  open: number;
  closed: number;
  closedInPeriod: number;
  openWithGps: number;
  openNoDay: number;
  openNoShop: number;
  openNoSign: number;
  openNoEquipment: number;
  customersNoCr: number;
  imported: number;
  avgScore: number | null;
  regionName: string | null;
  regionCode: string | null;
  routeCode: string | null;
  routeName: string | null;
  routeRegionId: string | null;
  routeRegionName: string | null;
  routeHasOwner: boolean | null;
};

export type StateCounts = {
  /** Live branches of live customers, any status. */
  branches: number;
  /** Live customers with a live branch in view — what /customers lists for the same filters. */
  customers: number;
  /** Open (ACTIVE) branches: the base of every data-quality share. */
  open: number;
  closed: number;
  /** Closed now, and the status last changed inside the window (a field closure or an import). */
  closedInPeriod: number;
  openWithGps: number;
  openNoDay: number;
  openNoShop: number;
  openNoSign: number;
  openNoEquipment: number;
  /** Customers in view without a CR photo (a customer-level document). */
  customersNoCr: number;
  /** Customers first created by an import inside the window. */
  imported: number;
  /** Mean branch completeness of the open branches, as a percentage of the branch maximum. */
  completenessPct: number | null;
};

export type StateData = {
  total: StateCounts;
  regions: Array<StateCounts & { region: RegionRef }>;
  routes: Array<StateCounts & { route: RouteRef }>;
};

function counts(r: StateRow): StateCounts {
  return {
    branches: n(r.branches),
    customers: n(r.customers),
    open: n(r.open),
    closed: n(r.closed),
    closedInPeriod: n(r.closedInPeriod),
    openWithGps: n(r.openWithGps),
    openNoDay: n(r.openNoDay),
    openNoShop: n(r.openNoShop),
    openNoSign: n(r.openNoSign),
    openNoEquipment: n(r.openNoEquipment),
    customersNoCr: n(r.customersNoCr),
    imported: n(r.imported),
    // Branch scores run 0-60 (lib/completeness.ts): never show one as a percent raw.
    completenessPct: r.avgScore === null || r.avgScore === undefined ? null : completenessPct(n(r.avgScore), BRANCH_MAX_SCORE),
  };
}

export const EMPTY_STATE: StateCounts = {
  branches: 0,
  customers: 0,
  open: 0,
  closed: 0,
  closedInPeriod: 0,
  openWithGps: 0,
  openNoDay: 0,
  openNoShop: 0,
  openNoSign: 0,
  openNoEquipment: 0,
  customersNoCr: 0,
  imported: 0,
  completenessPct: null,
};

function regionRef(id: string, name: string | null, code: string | null): RegionRef {
  return { id, name: name ?? code ?? 'Unknown region', code: code ?? '' };
}

function routeRef(r: {
  routeId: string | null;
  routeCode: string | null;
  routeName: string | null;
  routeRegionId?: string | null;
  routeRegionName?: string | null;
  routeHasOwner?: boolean | null;
}): RouteRef {
  return {
    id: r.routeId!,
    code: r.routeCode ?? '',
    name: r.routeName ?? r.routeCode ?? 'Unknown route',
    regionId: r.routeRegionId ?? null,
    regionName: r.routeRegionName ?? null,
    hasOwner: r.routeHasOwner === true,
  };
}

const byName = <T extends { region: RegionRef }>(a: T, b: T) => a.region.name.localeCompare(b.region.name);
const byCode = <T extends { route: RouteRef }>(a: T, b: T) => a.route.code.localeCompare(b.route.code);

export function shapeState(rows: StateRow[]): StateData {
  const total = rows.find((r) => n(r.g) === 3);
  return {
    total: total ? counts(total) : EMPTY_STATE,
    regions: rows
      .filter((r) => n(r.g) === 1 && r.regionId)
      .map((r) => ({ ...counts(r), region: regionRef(r.regionId!, r.regionName, r.regionCode) }))
      .sort(byName),
    routes: rows
      .filter((r) => n(r.g) === 2 && r.routeId)
      .map((r) => ({ ...counts(r), route: routeRef(r) }))
      .sort(byCode),
  };
}

// ── 2. New customers: CREATE requests approved in the window ─────────────────

export type CreatedRow = {
  bucket: string | null;
  regionId: string | null;
  routeId: string | null;
  terms: string | null;
  /** GROUPING("bucket", "regionId", "routeId", "terms"): 6 = bucket×terms, 11 = region, 13 = route, 14 = terms, 15 = total. */
  g: number;
  n: number;
  prev: number;
  regionName: string | null;
  regionCode: string | null;
  routeCode: string | null;
  routeName: string | null;
};

export type CreatedData = {
  total: number;
  /** The same count over the comparison window (as long as this window has run: period.ts prevTo). */
  prevTotal: number;
  cash: number;
  credit: number;
  /** Requests with no payment terms recorded at submit (older rows). */
  unrecorded: number;
  series: Array<{ bucket: string; cash: number; credit: number; other: number }>;
  regions: Array<{ region: RegionRef; n: number }>;
  routes: Array<{ route: RouteRef; n: number }>;
};

export function shapeCreated(rows: CreatedRow[], period: Pick<InsightPeriod, 'buckets'>): CreatedData {
  const total = rows.find((r) => n(r.g) === 15);
  const terms = (t: string) => rows.filter((r) => n(r.g) === 14 && r.terms === t).reduce((s, r) => s + n(r.n), 0);
  const unrecorded = rows.filter((r) => n(r.g) === 14 && r.terms === null).reduce((s, r) => s + n(r.n), 0);
  const series = new Map(period.buckets.map((b) => [b, { bucket: b, cash: 0, credit: 0, other: 0 }]));
  for (const r of rows) {
    if (n(r.g) !== 6 || !r.bucket) continue;
    const slot = series.get(r.bucket);
    if (!slot) continue; // outside the gap-filled range: never invented, never dropped silently into another bar
    if (r.terms === 'CASH') slot.cash += n(r.n);
    else if (r.terms === 'CREDIT') slot.credit += n(r.n);
    else slot.other += n(r.n);
  }
  return {
    total: total ? n(total.n) : 0,
    prevTotal: total ? n(total.prev) : 0,
    cash: terms('CASH'),
    credit: terms('CREDIT'),
    unrecorded,
    series: [...series.values()],
    regions: rows
      .filter((r) => n(r.g) === 11 && r.regionId && n(r.n) > 0)
      .map((r) => ({ region: regionRef(r.regionId!, r.regionName, r.regionCode), n: n(r.n) }))
      .sort((a, b) => b.n - a.n || a.region.name.localeCompare(b.region.name)),
    routes: rows
      .filter((r) => n(r.g) === 13 && r.routeId && n(r.n) > 0)
      .map((r) => ({ route: routeRef(r), n: n(r.n) }))
      .sort((a, b) => b.n - a.n || a.route.code.localeCompare(b.route.code)),
  };
}

// ── 3. Customers updated: approved UPDATE requests and direct writes ─────────

export type UpdatedRow = {
  bucket: string | null;
  regionId: string | null;
  routeId: string | null;
  /** GROUPING("bucket", "regionId", "routeId"): 3 = bucket, 5 = region, 6 = route, 7 = total. */
  g: number;
  customers: number;
  byRequest: number;
  /** Customers a salesman's approved request changed ON this route (load.ts updatedSql "onRoute"); read per route only. */
  byRequestOnRoute: number;
  byDirect: number;
  changes: number;
  prev: number;
  gps: number;
  phone: number;
  address: number;
  visitDay: number;
  channel: number;
  equipment: number;
  contact: number;
  regionName: string | null;
  regionCode: string | null;
  routeCode: string | null;
  routeName: string | null;
};

export type FieldFamilies = {
  gps: number;
  phone: number;
  address: number;
  visitDay: number;
  channel: number;
  equipment: number;
  contact: number;
};

export type UpdatedData = {
  /** Distinct customers with at least one approved change in the window. */
  customers: number;
  /** Of those, customers with an approved salesman request. */
  byRequest: number;
  /** Of those, customers changed only by a Manager's or Steward's direct write. */
  directOnly: number;
  /** Approved changes (requests and direct writes), not customers. */
  changes: number;
  /** The same count over the comparison window (as long as this window has run: period.ts prevTo). */
  prevCustomers: number;
  families: FieldFamilies;
  series: Array<{ bucket: string; byRequest: number; directOnly: number }>;
  regions: Array<{ region: RegionRef; customers: number; byRequest: number }>;
  /**
   * customers / byRequest: the customer counts on every route it has a branch on
   * in view. byRequestOnRoute: only where a salesman's request did the work — the
   * branch it changed, or the submitter's own route for a change to no branch.
   * Ranking routes, which stand for their salesmen, reads byRequestOnRoute.
   */
  routes: Array<{ route: RouteRef; customers: number; byRequest: number; byRequestOnRoute: number }>;
};

export function shapeUpdated(rows: UpdatedRow[], period: Pick<InsightPeriod, 'buckets'>): UpdatedData {
  const total = rows.find((r) => n(r.g) === 7);
  const series = new Map(period.buckets.map((b) => [b, { bucket: b, byRequest: 0, directOnly: 0 }]));
  for (const r of rows) {
    if (n(r.g) !== 3 || !r.bucket) continue;
    const slot = series.get(r.bucket);
    if (!slot) continue;
    slot.byRequest += n(r.byRequest);
    slot.directOnly += Math.max(0, n(r.customers) - n(r.byRequest));
  }
  const customers = total ? n(total.customers) : 0;
  const byRequest = total ? n(total.byRequest) : 0;
  return {
    customers,
    byRequest,
    directOnly: Math.max(0, customers - byRequest),
    changes: total ? n(total.changes) : 0,
    prevCustomers: total ? n(total.prev) : 0,
    families: {
      gps: total ? n(total.gps) : 0,
      phone: total ? n(total.phone) : 0,
      address: total ? n(total.address) : 0,
      visitDay: total ? n(total.visitDay) : 0,
      channel: total ? n(total.channel) : 0,
      equipment: total ? n(total.equipment) : 0,
      contact: total ? n(total.contact) : 0,
    },
    series: [...series.values()],
    regions: rows
      .filter((r) => n(r.g) === 5 && r.regionId && n(r.customers) > 0)
      .map((r) => ({
        region: regionRef(r.regionId!, r.regionName, r.regionCode),
        customers: n(r.customers),
        byRequest: n(r.byRequest),
      }))
      .sort((a, b) => b.customers - a.customers || a.region.name.localeCompare(b.region.name)),
    routes: rows
      .filter((r) => n(r.g) === 6 && r.routeId && n(r.customers) > 0)
      .map((r) => ({
        route: routeRef(r),
        customers: n(r.customers),
        byRequest: n(r.byRequest),
        byRequestOnRoute: n(r.byRequestOnRoute),
      }))
      .sort(byCode),
  };
}

// ── 4. Closures and reactivations, on the branch's own region ───────────────

export type StatusRow = {
  bucket: string | null;
  regionId: string | null;
  /** GROUPING("bucket", "regionId"): 1 = bucket, 2 = region, 3 = total. */
  g: number;
  closed: number;
  reactivated: number;
  closeRefused: number;
  keptClosed: number;
  prevClosed: number;
  prevReactivated: number;
  closeWaiting: number;
  reactWaiting: number;
  regionName: string | null;
  regionCode: string | null;
};

export type StatusChangeCounts = {
  closed: number;
  reactivated: number;
  closeRefused: number;
  keptClosed: number;
  prevClosed: number;
  prevReactivated: number;
  closeWaiting: number;
  reactWaiting: number;
};

export type StatusChangeData = StatusChangeCounts & {
  series: Array<{ bucket: string; closed: number; reactivated: number }>;
  regions: Array<StatusChangeCounts & { region: RegionRef }>;
};

function statusCounts(r: StatusRow | undefined): StatusChangeCounts {
  return {
    closed: n(r?.closed),
    reactivated: n(r?.reactivated),
    closeRefused: n(r?.closeRefused),
    keptClosed: n(r?.keptClosed),
    prevClosed: n(r?.prevClosed),
    prevReactivated: n(r?.prevReactivated),
    closeWaiting: n(r?.closeWaiting),
    reactWaiting: n(r?.reactWaiting),
  };
}

export function shapeStatusChanges(rows: StatusRow[], period: Pick<InsightPeriod, 'buckets'>): StatusChangeData {
  const series = new Map(period.buckets.map((b) => [b, { bucket: b, closed: 0, reactivated: 0 }]));
  for (const r of rows) {
    if (n(r.g) !== 1 || !r.bucket) continue;
    const slot = series.get(r.bucket);
    if (!slot) continue;
    slot.closed += n(r.closed);
    slot.reactivated += n(r.reactivated);
  }
  return {
    ...statusCounts(rows.find((r) => n(r.g) === 3)),
    series: [...series.values()],
    regions: rows
      .filter((r) => n(r.g) === 2 && r.regionId)
      .map((r) => ({ ...statusCounts(r), region: regionRef(r.regionId!, r.regionName, r.regionCode) }))
      .sort(byName),
  };
}

// ── 5. Requests: the pipeline by state, and what waits now ──────────────────

export const REQUEST_KINDS = ['create', 'update', 'close', 'reactivation'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATES = ['SUBMITTED', 'NEEDS_CORRECTION', 'APPROVED', 'REJECTED'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export type RequestRow = {
  kind: string;
  state: string;
  submitted: number;
  waiting: number;
  waitingFirstStep: number;
};

export type PipelineData = {
  /** Requests submitted inside the window, by kind and by the state they are in now. */
  submitted: Record<RequestKind, Record<RequestState, number>>;
  /** Waiting for a decision now, at any step. */
  waitingAnyStep: Record<RequestKind, number>;
  /** Waiting now at the steps a Manager's figures count (policy MANAGER_PENDING_STEP_ROLES). */
  waitingFirstStep: Record<RequestKind, number>;
};

function zeroKinds(): Record<RequestKind, number> {
  return { create: 0, update: 0, close: 0, reactivation: 0 };
}

export function shapePipeline(rows: RequestRow[]): PipelineData {
  const submitted = Object.fromEntries(
    REQUEST_KINDS.map((k) => [k, { SUBMITTED: 0, NEEDS_CORRECTION: 0, APPROVED: 0, REJECTED: 0 }])
  ) as PipelineData['submitted'];
  const waitingAnyStep = zeroKinds();
  const waitingFirstStep = zeroKinds();
  for (const r of rows) {
    if (!(REQUEST_KINDS as readonly string[]).includes(r.kind)) continue;
    const kind = r.kind as RequestKind;
    if ((REQUEST_STATES as readonly string[]).includes(r.state)) {
      submitted[kind][r.state as RequestState] += n(r.submitted);
    }
    waitingAnyStep[kind] += n(r.waiting);
    waitingFirstStep[kind] += n(r.waitingFirstStep);
  }
  return { submitted, waitingAnyStep, waitingFirstStep };
}

export function sumKinds(rec: Record<RequestKind, number>): number {
  return REQUEST_KINDS.reduce((s, k) => s + rec[k], 0);
}

// ── 6. The map: GPS cells of open branches ──────────────────────────────────

export type HeatRow = { kind: string; cy: number | null; cx: number | null; n: number; m: number };

export type HeatData = {
  /** Cell edge in degrees. */
  cellDeg: number;
  /** South-west corner of each drawn cell, in degrees, and its open branches. */
  cells: Array<{ lat: number; lng: number; n: number }>;
  /** Cells with at least one branch, drawn or not. */
  totalCells: number;
  /** Open branches whose GPS falls inside the map box. */
  located: number;
  /** Open branches in view. */
  openBranches: number;
  /** Open branches with any GPS (inside the box or not). */
  openWithGps: number;
};

export function shapeHeat(rows: HeatRow[], cellDeg: number): HeatData {
  const perDeg = Math.round(1 / cellDeg);
  const total = rows.find((r) => r.kind === 'total');
  const cellsRow = rows.find((r) => r.kind === 'cells');
  return {
    cellDeg,
    cells: rows
      .filter((r) => r.kind === 'cell' && r.cy !== null && r.cx !== null)
      .map((r) => ({ lat: n(r.cy) / perDeg, lng: n(r.cx) / perDeg, n: n(r.n) })),
    totalCells: n(cellsRow?.n),
    located: n(cellsRow?.m),
    openBranches: n(total?.n),
    openWithGps: n(total?.m),
  };
}

// ── Shared ───────────────────────────────────────────────────────────────────

/** Whole-number percentage, or null when there is nothing to divide by. */
export function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 100);
}

/** Change against the previous window, as a signed whole percentage (null when there was nothing before). */
export function changePct(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}
