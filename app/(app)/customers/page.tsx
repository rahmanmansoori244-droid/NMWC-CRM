import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CustomerCard } from '@/components/nmwc/CustomerCard';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { Prisma, Role } from '@prisma/client';
import { CustomerFiltersClient } from './CustomerFiltersClient';
import {
  applyCustomerFilters,
  parseCustomerFilters,
  type CustomerFilterParams,
} from '@/lib/customer-filters';
import { listSavedViewsForCurrentUser } from '@/services/saved-views';
import { customerCountFast } from '@/lib/customer-count';

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

  // Determine scope
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: {
      id: true,
      role: true,
      ownedRouteId: true,
      reports: { where: { ownedRouteId: { not: null } }, select: { ownedRouteId: true } },
      managedRegions: { select: { id: true } },
    },
  });

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

  if (me.role === Role.SALESMAN) {
    if (!me.ownedRouteId) {
      baseWhere.id = '__none__';
    } else {
      branchSomeBase = { routeId: me.ownedRouteId, deletedAt: null };
    }
    branchInclude.where = me.ownedRouteId
      ? { routeId: me.ownedRouteId, deletedAt: null }
      : { id: '__none__' };
  } else if (me.role === Role.SUPERVISOR) {
    const routeIds = me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id);
    branchSomeBase = { routeId: { in: routeIds }, deletedAt: null };
    branchInclude.where = { routeId: { in: routeIds }, deletedAt: null };
  } else if (me.role === Role.MANAGER) {
    const regionIds = me.managedRegions.map((r) => r.id);
    if (regionIds.length > 0) {
      branchSomeBase = { regionId: { in: regionIds }, deletedAt: null };
      branchInclude.where = { regionId: { in: regionIds }, deletedAt: null };
    } else {
      branchInclude.where = { id: '__none__' };
    }
  } else {
    branchInclude.where = { deletedAt: null };
  }
  // STEWARD and VIEWER: no extra scope filter (see all)

  // Resolve supervisor / salesman filter to route ids if set.
  let routeIdsForSupervisor: string[] = [];
  let routeIdForSalesman: string | null = null;
  if (filters.supervisorId) {
    const reports = await prisma.user.findMany({
      where: { supervisorId: filters.supervisorId, ownedRouteId: { not: null } },
      select: { ownedRouteId: true },
    });
    routeIdsForSupervisor = reports
      .map((r) => r.ownedRouteId)
      .filter((id): id is string => !!id);
  }
  if (filters.salesmanId) {
    const u = await prisma.user.findUnique({
      where: { id: filters.salesmanId },
      select: { ownedRouteId: true },
    });
    routeIdForSalesman = u?.ownedRouteId ?? null;
  }

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

  const [
    total,
    customers,
    regions,
    routes,
    channels,
    subChannels,
    supervisors,
    salesmen,
    savedViews,
  ] = await Promise.all([
    customerCountFast(where),
    prisma.customer.findMany({
      where,
      orderBy: { legalName: 'asc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { branches: branchInclude },
    }),
    showRegion
      ? prisma.region.findMany({
          where: regionWhere,
          orderBy: { name: 'asc' },
          select: { id: true, name: true, code: true },
        })
      : Promise.resolve([]),
    showRoute
      ? prisma.route.findMany({
          where: routeWhere,
          orderBy: { code: 'asc' },
          select: { id: true, code: true, name: true, regionId: true },
        })
      : Promise.resolve([]),
    prisma.channel.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, label: true },
    }),
    prisma.subChannel.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
      select: { id: true, label: true, channelId: true },
    }),
    showSupervisor
      ? prisma.user.findMany({
          where: { role: Role.SUPERVISOR, isActive: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true, username: true },
        })
      : Promise.resolve([]),
    showSalesman
      ? prisma.user.findMany({
          where:
            me.role === Role.SUPERVISOR
              ? { role: Role.SALESMAN, isActive: true, supervisorId: me.id }
              : { role: Role.SALESMAN, isActive: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true, username: true },
        })
      : Promise.resolve([]),
    listSavedViewsForCurrentUser().catch(() => []),
  ]);

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
            <a
              href={pageHref(Math.max(1, page - 1))}
              className={`rounded-md px-3 py-1.5 ${page === 1 ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              ← Previous
            </a>
            <span className="text-slate-600">
              Page {page} of {lastPage}
            </span>
            <a
              href={pageHref(Math.min(lastPage, page + 1))}
              className={`rounded-md px-3 py-1.5 ${page === lastPage ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              Next →
            </a>
          </nav>
        )}
      </section>
    </main>
  );
}
