import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CustomerCard } from '@/components/nmwc/CustomerCard';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { Prisma, Role } from '@prisma/client';

export const metadata = { title: 'Customers · NMWC' };

const PAGE_SIZE = 50;

type Search = { q?: string; status?: string; page?: string };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const sp = await searchParams;
  const q = sp.q?.trim() ?? '';
  const statusFilter = sp.status ?? '';
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

  const where: Prisma.CustomerWhereInput = { deletedAt: null };
  if (me.role === Role.SALESMAN) {
    if (!me.ownedRouteId) where.id = '__none__';
    else where.branches = { some: { routeId: me.ownedRouteId, deletedAt: null } };
  } else if (me.role === Role.SUPERVISOR) {
    const routeIds = me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id);
    where.branches = { some: { routeId: { in: routeIds }, deletedAt: null } };
  } else if (me.role === Role.MANAGER) {
    const regionIds = me.managedRegions.map((r) => r.id);
    if (regionIds.length > 0) {
      where.branches = { some: { regionId: { in: regionIds }, deletedAt: null } };
    }
  }
  // STEWARD and VIEWER: no extra scope filter (see all)

  if (q) {
    where.OR = [
      { legalName: { contains: q, mode: 'insensitive' } },
      { nmwcCode: { contains: q, mode: 'insensitive' } },
      { primaryPhone: { contains: q } },
    ];
  }
  if (statusFilter && ['ACTIVE', 'CLOSED', 'SUSPENDED'].includes(statusFilter)) {
    where.status = statusFilter as 'ACTIVE' | 'CLOSED' | 'SUSPENDED';
  }

  // RBAC-05-002: scope-aware primary branch. Previously the eager-load took
  // `branches: { take: 1, orderBy: { createdAt: 'asc' } }` which picked the
  // OLDEST branch regardless of the caller's scope. For a multi-branch
  // customer (Lulu, Carrefour) the salesman's list could show a Dhofar
  // address as the subtitle for a Muscat customer.
  const branchInclude: Prisma.Customer$branchesArgs = {
    take: 1,
    orderBy: { createdAt: 'asc' },
  };
  if (me.role === Role.SALESMAN && me.ownedRouteId) {
    branchInclude.where = { routeId: me.ownedRouteId, deletedAt: null };
  } else if (me.role === Role.SUPERVISOR) {
    const routeIds = me.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id);
    branchInclude.where = { routeId: { in: routeIds }, deletedAt: null };
  } else if (me.role === Role.MANAGER) {
    const regionIds = me.managedRegions.map((r) => r.id);
    branchInclude.where = regionIds.length > 0
      ? { regionId: { in: regionIds }, deletedAt: null }
      : { id: '__none__' };
  } else {
    branchInclude.where = { deletedAt: null };
  }

  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { legalName: 'asc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { branches: branchInclude },
    }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <PageHeader title="Customers" subtitle={`${total.toLocaleString()} total`} />
      <form className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name, code, phone…"
          className="w-full max-w-md rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
        />
        <select
          name="status"
          defaultValue={statusFilter}
          className="rounded-md border border-slate-300 px-2 py-2.5 text-base"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="CLOSED">Closed</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-brand-700"
        >
          Filter
        </button>
      </form>

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
              href={`?q=${encodeURIComponent(q)}&status=${statusFilter}&page=${Math.max(1, page - 1)}`}
              className={`rounded-md px-3 py-1.5 ${page === 1 ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              ← Previous
            </a>
            <span className="text-slate-600">
              Page {page} of {lastPage}
            </span>
            <a
              href={`?q=${encodeURIComponent(q)}&status=${statusFilter}&page=${Math.min(lastPage, page + 1)}`}
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
