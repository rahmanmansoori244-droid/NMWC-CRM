/**
 * F2 — the insights dashboard (/dashboard): every choice the record lists as the
 * OWNER'S to make, in one place.
 *
 * None of these was answered when the dashboard was built (2026-10-05). Each is
 * the default recommended in the F2 design, implemented so the dashboard works.
 * docs/handover/04-PENDING-WORK.md section A6 ("Insights dashboard (F2): built on
 * defaults the owner has not confirmed") lists them as OPEN questions for the
 * owner. Nothing else in the dashboard restates them.
 *
 * Two kinds of entry, and the difference matters when the owner answers:
 *   - SWITCHES, which the code reads: DASHBOARD_ROLES, NEW_CUSTOMERS.showImported,
 *     UPDATED_CUSTOMERS.includeDirectWrites, MANAGER_PENDING_STEP_ROLES, MAP and
 *     the time and ranking constants. Changing one changes the page (plus the
 *     tests that pin it).
 *   - RECORDS of a default the code implements in its structure:
 *     NEW_CUSTOMERS.counts, ATTRIBUTION, ROUTE_LEVEL_ONLY,
 *     MANAGER_SEES_COMPANY_FIGURES. Each has ONE supported value;
 *     tests/unit/insights-policy.test.ts fails if it is edited alone, because
 *     a different answer means changing the code each one names, not this line.
 *
 * Pure: no database, no session, no 'use server'. Safe to import from tests and
 * from the client filter bar.
 */
import type { Role } from '@prisma/client';

// ── Who may open the dashboard ───────────────────────────────────────────────

/**
 * Owner decision (default): MANAGER at his managed regions, VIEWER and STEWARD at
 * the whole organisation — who could open the page before F2. The menu
 * (components/nmwc/Sidebar.tsx NAV_BY_ROLE) must offer /dashboard to exactly
 * these roles; tests/unit/dashboard-page.test.tsx pins it. Admitting ACCOUNTANT,
 * FINANCE_MANAGER or GM later is this list, the menu and possibly lib/role-home.ts
 * together: the scope already comes from customerListBranchScope, which covers
 * every role (lib/insights/scope.ts).
 */
export const DASHBOARD_ROLES: readonly Role[] = ['MANAGER', 'VIEWER', 'STEWARD'];

export function isDashboardRole(role: string): role is Role {
  return (DASHBOARD_ROLES as readonly string[]).includes(role);
}

// ── What the figures count ───────────────────────────────────────────────────

/**
 * Owner decision (default): a "new customer" is a FIELD-CREATED one — a
 * new-customer (CREATE) request APPROVED in the window, dated by its final
 * decision (reviewedAt), counted as REQUESTS FINALIZED. A duplicate merge later
 * moves the request onto the surviving customer; it still counts once, where it
 * was raised. Customer.createdAt is never used: the go-live load and every import
 * stamp it too.
 *
 * `showImported`: customers first created by a Steward's import in the window
 * (Customer.importBatchId set, by createdAt) are shown beside it as a separate,
 * labelled figure, never added to it. Seeded pilot customers have neither marker
 * and appear in neither figure.
 */
export const NEW_CUSTOMERS = {
  /** RECORD, not a switch: lib/insights/load.ts createdSql counts finalized CREATE requests and nothing else. */
  counts: 'requests-finalized',
  /** Switch: read by load.ts stateSql and the New customers card. */
  showImported: true,
} as const;

/**
 * Owner decision (default): "customers updated" = customers with an APPROVED
 * UPDATE request on the customer (target CUSTOMER) decided in the window —
 * never Customer.updatedAt, which imports, photo wiring and rescoring move too.
 * Reactivations and close-shop requests are not updates: they have their own card
 * (closures read the branch: Customer.status closes only with its last open
 * branch, owner decision 7, lib/customer-status.ts).
 * A Manager's or Steward's direct write (an APPROVED row its author reviewed) is
 * shown as its own series beside the salesmen's approved requests.
 */
export const UPDATED_CUSTOMERS = {
  includeDirectWrites: true,
} as const;

/**
 * Owner decision (default): activity is attributed to the CURRENT route and
 * region — an update to the customer's live branches' route and region today, a
 * new customer to the route its request was raised on and that route's region
 * today (the same test /approvals/[id] applies). A route handed over or moved
 * takes its history with it; snapshotting the route at decision time would be a
 * schema change. Every card that attributes says "current". Ranking routes (the
 * work of each route's salesman) counts a request only on the route of the branch
 * it changed, or on its salesman's own route when it changed no branch — still
 * by the current route (load.ts updatedSql "onRoute").
 *
 * RECORD, not a switch: the joins in lib/insights/load.ts and lib/insights/sql.ts
 * read the current Branch.routeId / Route.regionId; another answer is a schema
 * change and new joins there.
 */
export const ATTRIBUTION = 'current-route-and-region' as const;

/**
 * Owner decision (default): route-level figures only. No per-salesman league
 * table and no route owner's name on this page (Route.code is a salesman's
 * username, so route-level activity is already employee-monitoring data —
 * docs/compliance/RECORDS-OF-PROCESSING.md A4). The one owner fact shown is
 * whether a route has an active salesman at all, because a route without one
 * shows no field activity by construction. Route-level is not anonymous: each
 * route is shown by its code, which is its salesman's username.
 *
 * RECORD, not a switch: no statement in lib/insights/load.ts groups by person;
 * per-salesman figures would be new statements and a new card.
 */
export const ROUTE_LEVEL_ONLY = true as const;

/**
 * Owner decision (default): a region Manager never sees a national total or a
 * company average. Every figure is aggregated over what the viewer can open
 * (lib/insights/scope.ts reuses the access gates as the query predicates), and
 * comparisons are with the viewer's own previous period, never with the company.
 *
 * RECORD, not a switch: lib/insights/scope.ts builds every statement's predicate
 * from the viewer's scope; a company benchmark would be a second, unscoped wave
 * and a privacy review (the /status history: lib/service-levels.ts).
 */
export const MANAGER_SEES_COMPANY_FIGURES = false as const;

/**
 * Owner decision (default): a Manager's "Pending approval" counts what his
 * /approvals queue holds and what /status counts for him — requests waiting at
 * the Supervisor step in his regions. Against the dashboard before F2, which
 * counted every waiting request on a customer with a branch in his regions at
 * any step, two things changed: NEW-CUSTOMER REQUESTS at the Supervisor step are
 * now included (it left them out), and REACTIVATIONS — waiting at the Manager's
 * own step, decided on /reactivations, not /approvals — are no longer in this
 * number; the tile shows them on a line of their own, and the Closures card
 * counts them as "Reactivations waiting". So the number can rise or fall.
 *
 * Switch, read by lib/insights/load.ts requestsSql. It must equal
 * lib/service-levels.ts MANAGER_VIEW_ROLES — the steps /status counts for a
 * Manager — and tests/unit/insights-policy.test.ts fails when the two differ
 * (this module stays importable by the client filter bar, so it does not import
 * that one). The Steward and the Viewer count every step.
 */
export const MANAGER_PENDING_STEP_ROLES: readonly string[] = ['SUPERVISOR'];

// ── The map ──────────────────────────────────────────────────────────────────

/**
 * Owner decision (default): a self-drawn, approximate outline of Oman with
 * server-binned heat cells. No tiles, no third party, no CSP change, never an
 * exact pin, never an employee's device GPS (Attachment.capturedLat/Lng). Only
 * live, open branches' own GPS is binned, on the branch's own region and route.
 */
export const MAP = {
  /** Cell size in degrees when more than one region is in view (about 5.5 km). */
  cellDegCountry: 0.05,
  /** Cell size when exactly one region is in view (about 1.1 km). */
  cellDegRegion: 0.01,
  /** The densest cells drawn at most; the rest are counted, not drawn. */
  maxCells: 2000,
  /** The box the app already validates GPS against (lib/validation/edit.ts). */
  bounds: { latMin: 16, latMax: 27, lngMin: 51, lngMax: 61 },
} as const;

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Owner decision (default): Oman calendar days (UTC+4, no daylight saving —
 * lib/tz.ts) for every bucket and every date shown. A week starts on MONDAY,
 * because that is where Postgres date_trunc('week') starts it (ISO 8601); the
 * gap-fill in lib/insights/period.ts reproduces it exactly. The business week is
 * Sunday–Thursday (D1), so a week bar is labelled by its Monday.
 */
export const OMAN_OFFSET_HOURS = 4;

/** Period presets offered in the filter bar, in days ending today (Oman). */
export const PERIOD_PRESETS = {
  '7d': { days: 7, label: '7 days' },
  '30d': { days: 30, label: '30 days' },
  '90d': { days: 90, label: '90 days' },
  '12m': { days: 365, label: '12 months' },
} as const;
export type PresetKey = keyof typeof PERIOD_PRESETS;
export const DEFAULT_PRESET: PresetKey = '30d';
/** A custom window is clamped to this many days. */
export const MAX_WINDOW_DAYS = 366;
/** The earliest day a custom window may start. */
export const EARLIEST_DAY = '2020-01-01';
/**
 * Go-live (docs/handover/07-PROJECT-HISTORY.md). Activity recorded before it is the
 * May pilot and test runs, and one-off clean-up scripts deleted some of it, so a
 * window — or the comparison window — reaching back before this day carries a
 * caveat on the page. Not a filter: the figures are shown as they are.
 */
export const HISTORY_BASELINE_DAY = '2026-09-10';
/** Day bars up to this many days, week bars up to WEEK_MAX_DAYS, months beyond. */
export const DAY_MAX_DAYS = 31;
export const WEEK_MAX_DAYS = 120;

// ── Ranking ──────────────────────────────────────────────────────────────────

/** Routes shown at each end of a ranked list. */
export const ROUTE_LIST_SIZE = 5;
/**
 * A route enters the activity ranking only with at least this many customers:
 * below it, one update reads as a large share and ranks the route by chance.
 */
export const MIN_CUSTOMERS_TO_RANK = 10;
