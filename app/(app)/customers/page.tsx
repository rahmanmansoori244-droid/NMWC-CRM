import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CustomerCard } from '@/components/nmwc/CustomerCard';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { Prisma, Role } from '@prisma/client';
import { CustomerFiltersClient } from './CustomerFiltersClient';
import {
  applyCustomerFilters,
  customerListBranchScope,
  parseCustomerFilters,
  type CustomerFilterParams,
} from '@/lib/customer-filters';
import { listSavedViewsForCurrentUser } from '@/services/saved-views';
import { customerCountFast } from '@/lib/customer-count';
import {
  getAllActiveChannels,
  getAllActiveRegions,
  getAllActiveRoutes,
  getAllActiveSubChannels,
  getAllHierarchyUsers,
} from '@/lib/reference-data';

export const metadata = { title: 'Customers · NMWC' };

const PAGE_SIZE = 50;

type Search = CustomerFilterParams & { page?: string };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const sp = await searchParams;
  const filters = parseCustomerFilters(sp);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  // Determine scope. perf audit #13: the scope read and the (conditional)
  // supervisor/salesman filter lookups are independent — issue them in ONE
  // parallel wave instead of three sequential round trips.
  const [me, supervisorReports, salesmanUser] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: {
        id: true,
        role: true,
        ownedRouteId: true,
        reports: { where: { ownedRouteId: { not: null } }, select: { ownedRouteId: true } },
        managedRegions: { select: { id: true } },
      },
    }),
    filters.supervisorId
      ? prisma.user.findMany({
          where: { supervisorId: filters.supervisorId, ownedRouteId: { not: null } },
          select: { ownedRouteId: true },
        })
      : Promise.resolve([] as { ownedRouteId: string | null }[]),
    filters.salesmanId
      ? prisma.user.findUnique({
          where: { id: filters.salesmanId },
          select: { ownedRouteId: true },
        })
      : Promise.resolve(null),
  ]);

  const baseWhere: Prisma.CustomerWhereInput = { deletedAt: null };
  type BranchSomeWhere = NonNullable<
    NonNullable<Prisma.CustomerWhereInput['branches']>['some']
  >;
  let branchSomeBase: BranchSomeWhere | undefined;
  // Scope-aware "primary branch" predicate (shown in CustomerCard subtitle).
  const branchInclude: Prisma.Customer$branchesArgs = {
    take: 1,
    orderBy: { createdAt: 'asc' },
  };

  // SR-M2 (P1): fail-closed role scope from the single shared helper (the query
  // twin of lib/access.canSeeCustomer). Previously this was hand-rolled here and
  // drifted: a region-less Manager fell through UNSCOPED and read the entire
  // nationwide master (the list-page twin of the already-fixed export leak).
  const listScope = customerListBranchScope(me.role, {
    ownedRouteId: me.ownedRouteId,
    teamRouteIds: me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id),
    managedRegionIds: me.managedRegions.map((r) => r.id),
  });
  if (listScope.forceEmpty) {
    baseWhere.id = '__none__';
    branchInclude.where = { id: '__none__' };
  } else if (listScope.branchSome) {
    branchSomeBase = listScope.branchSome;
    branchInclude.where = listScope.branchSome;
  } else {
    // org-wide (STEWARD / VIEWER / FINANCE_MANAGER / GM)
    branchInclude.where = { deletedAt: null };
  }

  // Resolve supervisor / salesman filter to route ids (fetched in the parallel
  // wave above).
  const routeIdsForSupervisor: string[] = supervisorReports
    .map((r) => r.ownedRouteId)
    .filter((id): id is string => !!id);
  const routeIdForSalesman: string | null = salesmanUser?.ownedRouteId ?? null;

  const where = applyCustomerFilters(
    baseWhere,
    branchSomeBase,
    filters,
    routeIdsForSupervisor,
    routeIdForSalesman
  );

  // Filter-bar reference data. Pulled per-page; small lookup tables.
  // Visibility per spec:
  //   SALESMAN  : hide all four (region/route/supervisor/salesman)
  //   SUPERVISOR: show region + salesman; hide route + supervisor
  //   MANAGER   : show all four
  //   STEWARD   : show all four
  //   VIEWER    : show all four (read-only role; same filters as a steward)
  const showRegion = me.role !== Role.SALESMAN;
  const showRoute = me.role === Role.MANAGER || me.role === Role.STEWARD || me.role === Role.VIEWER;
  const showSupervisor =
    me.role === Role.MANAGER || me.role === Role.STEWARD || me.role === Role.VIEWER;
  const showSalesman = me.role !== Role.SALESMAN;
  const canExport = me.role !== Role.SALESMAN;

  // Constrain the route list to the caller's scope so a supervisor doesn't
  // see Dhofar routes in their dropdown.
  let routeWhere: Prisma.RouteWhereInput = { isActive: true };
  if (me.role === Role.SUPERVISOR) {
    const routeIds = me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id);
    routeWhere = { isActive: true, id: { in: routeIds.length > 0 ? routeIds : ['__none__'] } };
  } else if (me.role === Role.MANAGER) {
    const regionIds = me.managedRegions.map((r) => r.id);
    routeWhere = {
      isActive: true,
      regionId: { in: regionIds.length > 0 ? regionIds : ['__none__'] },
    };
  }

  let regionWhere: Prisma.RegionWhereInput = { isActive: true };
  if (me.role === Role.MANAGER) {
    const regionIds = me.managedRegions.map((r) => r.id);
    regionWhere = {
      isActive: true,
      id: { in: regionIds.length > 0 ? regionIds : ['__none__'] },
    };
  } else if (me.role === Role.SUPERVISOR) {
    // A supervisor can see the region list filtered to those their routes
    // belong to. Cheap derived predicate.
    const routeIds = me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id);
    if (routeIds.length === 0) {
      regionWhere = { isActive: true, id: '__none__' };
    } else {
      regionWhere = {
        isActive: true,
        routes: { some: { id: { in: routeIds } } },
      };
    }
  }

  // F1 (2026-05-11): the six reference-data lookups (regions, routes,
  // channels, sub-channels, supervisors, salesmen) are now served from
  // `lib/reference-data.ts` with a 5-minute unstable_cache + per-request
  // React cache. Scope filtering (e.g. a Supervisor only sees their own
  // salesmen) is applied in memory after the cached read — the lists are
  // tiny (<100 rows).
  const [
    total,
    customers,
    allRegions,
    allRoutes,
    allChannels,
    allSubChannels,
    allHierarchyUsers,
    savedViews,
  ] = await Promise.all([
    customerCountFast(where),
    // perf audit #40: select exactly what CustomerCard renders — the old
    // `include` dragged every Customer column (incl. the notes @db.Text) for
    // all 50 rows across the wire per render.
    prisma.customer.findMany({
      where,
      orderBy: { legalName: 'asc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        nmwcCode: true,
        legalName: true,
        paymentTerms: true,
        status: true,
        completenessScore: true,
        branches: { ...branchInclude, select: { branchName: true, address: true } },
      },
    }),
    getAllActiveRegions(),
    getAllActiveRoutes(),
    getAllActiveChannels(),
    getAllActiveSubChannels(),
    getAllHierarchyUsers(),
    listSavedViewsForCurrentUser().catch(() => []),
  ]);

  // In-memory scope filtering on the cached reference data.
  // Compute scope route IDs once and reuse.
  const scopeRouteIds = new Set(
    me.role === Role.SUPERVISOR
      ? me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id)
      : me.role === Role.MANAGER
        ? allRoutes
            .filter((r) => me.managedRegions.some((mr) => mr.id === r.regionId))
            .map((r) => r.id)
        : allRoutes.map((r) => r.id)
  );
  const scopeRegionIds = new Set(
    me.role === Role.MANAGER
      ? me.managedRegions.map((mr) => mr.id)
      : me.role === Role.SUPERVISOR
        ? allRoutes.filter((r) => scopeRouteIds.has(r.id)).map((r) => r.regionId)
        : allRegions.map((r) => r.id)
  );
  const regions = showRegion ? allRegions.filter((r) => scopeRegionIds.has(r.id)) : [];
  const routes = showRoute ? allRoutes.filter((r) => scopeRouteIds.has(r.id)) : [];
  const channels = allChannels;
  const subChannels = allSubChannels;
  const supervisors = showSupervisor
    ? allHierarchyUsers
        .filter((u) => u.role === Role.SUPERVISOR)
        .map((u) => ({ id: u.id, fullName: u.fullName, username: u.username }))
    : [];
  const salesmen = showSalesman
    ? allHierarchyUsers
        .filter((u) => {
          if (u.role !== Role.SALESMAN) return false;
          if (me.role === Role.SUPERVISOR) return u.supervisorId === me.id;
          return true;
        })
        .map((u) => ({ id: u.id, fullName: u.fullName, username: u.username }))
    : [];
  void regionWhere;
  void routeWhere;

  const lastPage = Math.max(1, Math.ceil(total.total / PAGE_SIZE));

  // Preserve current filter URL params for pagination links.
  const baseSp = new URLSearchParams();
  if (filters.q) baseSp.set('q', filters.q);
  if (filters.status) baseSp.set('status', filters.status);
  if (filters.regionIds.length) baseSp.set('region', filters.regionIds.join(','));
  if (filters.routeIds.length) baseSp.set('route', filters.routeIds.join(','));
  if (filters.channelIds.length) baseSp.set('channel', filters.channelIds.join(','));
  if (filters.subChannelIds.length) baseSp.set('subChannel', filters.subChannelIds.join(','));
  if (filters.supervisorId) baseSp.set('supervisor', filters.supervisorId);
  if (filters.salesmanId) baseSp.set('salesman', filters.salesmanId);
  if (filters.paymentTerms) baseSp.set('paymentTerms', filters.paymentTerms);
  if (filters.minScore != null) baseSp.set('minScore', String(filters.minScore));
  if (filters.maxScore != null) baseSp.set('maxScore', String(filters.maxScore));
  // Keep date inputs as-is (yyyy-mm-dd) — the parsed Date is reconstructible.
  if (sp.createdAfter) baseSp.set('createdAfter', sp.createdAfter);
  if (sp.createdBefore) baseSp.set('createdBefore', sp.createdBefore);
  if (sp.editedAfter) baseSp.set('editedAfter', sp.editedAfter);
  if (sp.editedBefore) baseSp.set('editedBefore', sp.editedBefore);

  function pageHref(p: number): string {
    const sp = new URLSearchParams(baseSp);
    sp.set('page', String(p));
    return `?${sp.toString()}`;
  }

  return (
    <main>
      <PageHeader
        title="Customers"
        subtitle={`${total.isApprox ? '~' : ''}${total.total.toLocaleString()} total`}
      />
      <CustomerFiltersClient
        initial={{
          q: filters.q,
          status: filters.status,
          region: filters.regionIds,
          route: filters.routeIds,
          channel: filters.channelIds,
          subChannel: filters.subChannelIds,
          supervisor: filters.supervisorId,
          salesman: filters.salesmanId,
          paymentTerms: filters.paymentTerms,
          minScore: filters.minScore != null ? String(filters.minScore) : '',
          maxScore: filters.maxScore != null ? String(filters.maxScore) : '',
          createdAfter: sp.createdAfter ?? '',
          createdBefore: sp.createdBefore ?? '',
          editedAfter: sp.editedAfter ?? '',
          editedBefore: sp.editedBefore ?? '',
        }}
        flags={{ showRegion, showRoute, showSupervisor, showSalesman, canExport }}
        regions={regions}
        routes={routes}
        channels={channels}
        subChannels={subChannels}
        supervisors={supervisors}
        salesmen={salesmen}
        savedViews={savedViews.map((v) => ({
          id: v.id,
          name: v.name,
          urlParams: v.urlParams,
        }))}
      />

      <section className="px-4 py-4 sm:px-6">
        {customers.length === 0 ? (
          <EmptyState
            title="No customers match"
            description="Try clearing filters or searching for a different term."
          />
        ) : (
          <div className="grid gap-3">
            {customers.map((c) => (
              <CustomerCard
                key={c.id}
                customer={c}
                primaryBranch={c.branches[0]}
                href={`/customers/${c.id}`}
              />
            ))}
          </div>
        )}

        {lastPage > 1 && (
          <nav className="mt-6 flex items-center justify-between text-sm">
            {/* perf audit #7/#16: <Link>, not <a> — a raw anchor forced a full
                document reload (HTML + CSS + JS re-parse + layout re-render)
                per page flip; client navigation only fetches the RSC delta. */}
            <Link
              href={pageHref(Math.max(1, page - 1))}
              className={`rounded-md px-3 py-1.5 ${page === 1 ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              ← Previous
            </Link>
            <span className="text-slate-600">
              Page {page} of {lastPage}
            </span>
            <Link
              href={pageHref(Math.min(lastPage, page + 1))}
              className={`rounded-md px-3 py-1.5 ${page === lastPage ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              Next →
            </Link>
          </nav>
        )}
      </section>
    </main>
  );
}
