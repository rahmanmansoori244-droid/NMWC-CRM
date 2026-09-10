/**
 * P2.1 (2026-05-10) — shared filter composition for the /customers list and
 * the filtered xlsx export. Both surfaces parse the same URL search params
 * and produce the same Prisma `where` so what the user sees on screen is
 * exactly what they download.
 *
 * The role-based scope is composed FIRST (in the caller's code, since it
 * needs the resolved `me` row), then this helper layers the URL filters on
 * top by intersecting with `where.branches.some` for branch-scoped fields
 * and `where` directly for customer-scoped fields.
 */
import { Prisma, Role } from '@prisma/client';
import { normalizePhone } from './phone';

/** Raw URL search params accepted on /customers. */
export type CustomerFilterParams = {
  q?: string;
  status?: string;
  region?: string;
  route?: string;
  channel?: string;
  subChannel?: string;
  supervisor?: string;
  salesman?: string;
  paymentTerms?: string;
  minScore?: string;
  maxScore?: string;
  createdAfter?: string;
  createdBefore?: string;
  editedAfter?: string;
  editedBefore?: string;
};

/** Parsed/normalized filter values used by the where-builder. */
export type ParsedCustomerFilters = {
  q: string;
  status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED' | '';
  regionIds: string[];
  routeIds: string[];
  channelIds: string[];
  subChannelIds: string[];
  supervisorId: string;
  salesmanId: string;
  paymentTerms: 'CASH' | 'CREDIT' | '';
  minScore: number | null;
  maxScore: number | null;
  createdAfter: Date | null;
  createdBefore: Date | null;
  editedAfter: Date | null;
  editedBefore: Date | null;
};

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseScore(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function parseCustomerFilters(sp: CustomerFilterParams): ParsedCustomerFilters {
  const status = (sp.status ?? '').toUpperCase();
  const paymentTerms = (sp.paymentTerms ?? '').toUpperCase();
  return {
    q: sp.q?.trim() ?? '',
    status:
      status === 'ACTIVE' || status === 'CLOSED' || status === 'SUSPENDED' ? status : '',
    regionIds: splitCsv(sp.region),
    routeIds: splitCsv(sp.route),
    channelIds: splitCsv(sp.channel),
    subChannelIds: splitCsv(sp.subChannel),
    supervisorId: sp.supervisor?.trim() ?? '',
    salesmanId: sp.salesman?.trim() ?? '',
    paymentTerms: paymentTerms === 'CASH' || paymentTerms === 'CREDIT' ? paymentTerms : '',
    minScore: parseScore(sp.minScore),
    maxScore: parseScore(sp.maxScore),
    createdAfter: parseDate(sp.createdAfter),
    createdBefore: parseDate(sp.createdBefore),
    editedAfter: parseDate(sp.editedAfter),
    editedBefore: parseDate(sp.editedBefore),
  };
}

/**
 * Branch-side filters (region/route/salesman supervisor) are merged into a
 * single `branches.some` so we never widen scope by accident — every branch
 * predicate must be satisfied on the SAME branch row.
 */
type BranchSomeWhere = NonNullable<
  NonNullable<Prisma.CustomerWhereInput['branches']>['some']
>;

/**
 * Fail-closed role → branch scope for the customers LIST and EXPORT — the
 * query-level twin of `lib/access.canSeeCustomer`, so the list, the export, and
 * per-record access can never disagree (the SR-M2 leak was the list page
 * hand-rolling its own scope and drifting out of sync after the export was
 * fixed). Returns either `{ forceEmpty: true }` (caller must return zero rows —
 * region-less Manager/Accountant, route-less Salesman) or a branch predicate to
 * pass as `branchSomeBase` (undefined = org-wide visibility).
 *
 * STEWARD/VIEWER/FINANCE_MANAGER/GM: org-wide. SALESMAN: own route. SUPERVISOR:
 * team routes. MANAGER/ACCOUNTANT: managed regions (both fail-closed when empty).
 */
export type ListBranchScope =
  | { forceEmpty: true; branchSome?: undefined }
  | { forceEmpty: false; branchSome?: BranchSomeWhere };

export function customerListBranchScope(
  role: Role,
  scope: { ownedRouteId: string | null; teamRouteIds: string[]; managedRegionIds: string[] }
): ListBranchScope {
  switch (role) {
    case Role.STEWARD:
    case Role.VIEWER:
    case Role.FINANCE_MANAGER:
    case Role.GM:
      return { forceEmpty: false }; // org-wide — no branch scope
    case Role.SALESMAN:
      if (!scope.ownedRouteId) return { forceEmpty: true };
      return { forceEmpty: false, branchSome: { routeId: scope.ownedRouteId, deletedAt: null } };
    case Role.SUPERVISOR:
      if (scope.teamRouteIds.length === 0) return { forceEmpty: true };
      return {
        forceEmpty: false,
        branchSome: { routeId: { in: scope.teamRouteIds }, deletedAt: null },
      };
    case Role.MANAGER:
    case Role.ACCOUNTANT:
      // SR-M2 (P1): fail-closed. A region-less Manager/Accountant sees NOTHING,
      // not the whole master. Aligns the list with canSeeCustomer, which already
      // scopes ACCOUNTANT by managedRegions.
      if (scope.managedRegionIds.length === 0) return { forceEmpty: true };
      return {
        forceEmpty: false,
        branchSome: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
      };
    default:
      // A newly added Role is fail-closed by default — decide its scope here.
      return { forceEmpty: true };
  }
}

/**
 * Compose the URL filters onto an existing role-scoped `where` and
 * `branchSomeBase` (the role-based branch predicate). Returns a new
 * `Prisma.CustomerWhereInput` — does not mutate the input.
 */
export function applyCustomerFilters(
  base: Prisma.CustomerWhereInput,
  branchSomeBase: BranchSomeWhere | undefined,
  filters: ParsedCustomerFilters,
  routeIdsForSupervisor: string[],
  routeIdForSalesman: string | null
): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = { ...base };
  const branchSome: BranchSomeWhere = { ...(branchSomeBase ?? {}) };
  // Always restrict to live branches; role-scope code already passes
  // `deletedAt: null`, but be defensive.
  branchSome.deletedAt = branchSome.deletedAt ?? null;

  if (filters.q) {
    // Perf (2026-05-11): phone search now uses primaryPhoneNorm so the
    // trigram GIN index on that column accelerates ILIKE. Normalize the
    // user's input via the same `normalizePhone` helper that ingestion
    // uses so "+96891234567" and "96891234567" both find the same row.
    const phoneNorm = normalizePhone(filters.q);
    where.OR = [
      { legalName: { contains: filters.q, mode: 'insensitive' } },
      { nmwcCode: { contains: filters.q, mode: 'insensitive' } },
      ...(phoneNorm ? [{ primaryPhoneNorm: { contains: phoneNorm } }] : []),
      // Go-live: the master carries the Timix branch code (`CAK0240-AK2`) and a
      // shop/branch name that often differs from the legal name — salesmen know
      // shops by those. The branch predicate is intersected with the caller's
      // role scope so a match on an out-of-scope branch can never surface a
      // customer (the SAME branch must satisfy both).
      {
        branches: {
          some: {
            ...(branchSomeBase ?? {}),
            deletedAt: null,
            OR: [
              { branchName: { contains: filters.q, mode: 'insensitive' } },
              { branchCode: { contains: filters.q, mode: 'insensitive' } },
            ],
          },
        },
      },
    ];
  }
  if (filters.status) where.status = filters.status;
  if (filters.channelIds.length) where.channelId = { in: filters.channelIds };
  if (filters.subChannelIds.length) where.subChannelId = { in: filters.subChannelIds };
  if (filters.paymentTerms) where.paymentTerms = filters.paymentTerms;
  if (filters.minScore != null || filters.maxScore != null) {
    where.completenessScore = {
      ...(filters.minScore != null ? { gte: filters.minScore } : {}),
      ...(filters.maxScore != null ? { lte: filters.maxScore } : {}),
    };
  }
  if (filters.createdAfter || filters.createdBefore) {
    where.createdAt = {
      ...(filters.createdAfter ? { gte: filters.createdAfter } : {}),
      ...(filters.createdBefore ? { lte: filters.createdBefore } : {}),
    };
  }
  if (filters.editedAfter || filters.editedBefore) {
    where.updatedAt = {
      ...(filters.editedAfter ? { gte: filters.editedAfter } : {}),
      ...(filters.editedBefore ? { lte: filters.editedBefore } : {}),
    };
  }

  // Branch-side intersections.
  if (filters.regionIds.length) {
    branchSome.regionId = mergeStringIn(branchSome.regionId, filters.regionIds);
  }

  // Route-id constraints come from THREE potential sources, all branch-side.
  // Compute the effective route-id intersection up-front so a Manager whose
  // role scope is region-based and who picks a specific salesman gets the
  // intersection narrowed to that salesman's route.
  const routeConstraints: string[][] = [];
  if (filters.routeIds.length) routeConstraints.push(filters.routeIds);
  if (filters.supervisorId && routeIdsForSupervisor.length > 0) {
    routeConstraints.push(routeIdsForSupervisor);
  } else if (filters.supervisorId) {
    // Supervisor selected but they have no reports — fail closed.
    routeConstraints.push(['__none__']);
  }
  if (filters.salesmanId && routeIdForSalesman) {
    routeConstraints.push([routeIdForSalesman]);
  } else if (filters.salesmanId) {
    // Salesman selected but has no owned route — fail closed.
    routeConstraints.push(['__none__']);
  }
  if (routeConstraints.length > 0) {
    const intersected = routeConstraints.reduce<string[]>(
      (acc, list, i) => (i === 0 ? list : acc.filter((id) => list.includes(id))),
      []
    );
    branchSome.routeId = mergeStringIn(
      branchSome.routeId,
      intersected.length > 0 ? intersected : ['__none__']
    );
  }

  // Only attach the branch predicate if any branch-side filter was set OR
  // the caller's role-scoped predicate already required it.
  if (branchSomeBase || hasAnyBranchFilter(branchSome)) {
    where.branches = { some: branchSome };
  }
  return where;
}

function hasAnyBranchFilter(b: BranchSomeWhere): boolean {
  // `deletedAt: null` is the only key we set defensively. If anything else is
  // present, the filter is meaningful.
  for (const k of Object.keys(b)) {
    if (k !== 'deletedAt') return true;
  }
  return false;
}

function mergeStringIn(
  existing: BranchSomeWhere['regionId'] | BranchSomeWhere['routeId'],
  next: string[]
): { in: string[] } {
  if (!existing) return { in: next };
  if (typeof existing === 'string') {
    return { in: next.includes(existing) ? [existing] : ['__none__'] };
  }
  // Existing { in: [...] } — intersect. An EXISTING empty `{ in: [] }` is a
  // fail-CLOSED scope (Prisma matches nothing); the intersection with any filter
  // must STAY empty. Returning `{ in: next }` here was a set-theory bug
  // (∅ ∩ next computed as next) that let a URL filter widen a zero-scope
  // predicate back to the filter's rows — an out-of-scope PII leak on the
  // filtered export for an empty-team Supervisor (SR-EXP-01).
  const prevList = Array.isArray((existing as { in?: string[] }).in)
    ? ((existing as { in: string[] }).in)
    : [];
  if (prevList.length === 0) return { in: ['__none__'] };
  const intersected = prevList.filter((id) => next.includes(id));
  return { in: intersected.length > 0 ? intersected : ['__none__'] };
}
