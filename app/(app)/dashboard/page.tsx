import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Prisma, Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';

export const metadata = { title: 'Dashboard · NMWC' };

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // RBAC-05-013: PRD §4 says Steward sees the global dashboard. Add STEWARD.
  if (
    session.user.role !== Role.MANAGER &&
    session.user.role !== Role.VIEWER &&
    session.user.role !== Role.STEWARD
  ) {
    redirect('/home');
  }

  // QA-007 fix: scope by manager's assigned regions. VIEWER + STEWARD global.
  // RBAC-05-012: Manager with no managed regions sees a "no regions" state
  // rather than the global dashboard.
  let regionIds: string[] = [];
  let unscopedManager = false;
  if (session.user.role === Role.MANAGER) {
    const me = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { managedRegions: { select: { id: true } } },
    });
    regionIds = me?.managedRegions.map((r) => r.id) ?? [];
    if (regionIds.length === 0) unscopedManager = true;
  }
  const isScoped = regionIds.length > 0;

  if (unscopedManager) {
    return (
      <main className="p-6">
        <PageHeader title="Dashboard" subtitle="No regions assigned" />
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
          You have no managed regions. Ask a Steward to assign your regions; you
          will not see any data on the dashboard until then.
        </div>
      </main>
    );
  }

  // Customer scope = "has any non-deleted branch in a managed region"
  const customerWhere: Prisma.CustomerWhereInput = isScoped
    ? {
        deletedAt: null,
        branches: { some: { regionId: { in: regionIds }, deletedAt: null } },
      }
    : { deletedAt: null };
  const branchWhere: Prisma.BranchWhereInput = isScoped
    ? { deletedAt: null, regionId: { in: regionIds } }
    : { deletedAt: null };
  const editScope: Prisma.CustomerEditWhereInput = isScoped
    ? { customer: { branches: { some: { regionId: { in: regionIds }, deletedAt: null } } } }
    : {};

  const [
    customerCount,
    branchCount,
    activeBranches,
    closedCount,
    pendingApprovals,
    rejectedEdits,
    avgScore,
    last30Days,
  ] = await Promise.all([
    prisma.customer.count({ where: customerWhere }),
    prisma.branch.count({ where: branchWhere }),
    prisma.branch.count({ where: { ...branchWhere, status: 'ACTIVE' } }),
    prisma.customer.count({ where: { ...customerWhere, status: 'CLOSED' } }),
    prisma.customerEdit.count({ where: { state: 'SUBMITTED', ...editScope } }),
    prisma.customerEdit.count({ where: { state: 'NEEDS_CORRECTION', ...editScope } }),
    prisma.customer.aggregate({ _avg: { completenessScore: true }, where: customerWhere }),
    prisma.customerEdit.findMany({
      where: {
        state: 'APPROVED',
        reviewedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        ...editScope,
      },
      select: { reviewedAt: true },
      orderBy: { reviewedAt: 'asc' },
    }),
  ]);

  const regionStats = await prisma.region.findMany({
    where: isScoped ? { id: { in: regionIds } } : undefined,
    select: {
      id: true,
      name: true,
      code: true,
      branches: {
        select: { completenessScore: true },
        where: { deletedAt: null },
      },
    },
    orderBy: { name: 'asc' },
  });

  // Per-route leaderboard (top 10) — scoped to managed regions
  const routes = await prisma.route.findMany({
    where: isScoped
      ? { isActive: true, regionId: { in: regionIds } }
      : { isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      branches: { select: { completenessScore: true }, where: { deletedAt: null } },
      owner: { select: { fullName: true } },
    },
  });
  // UXI-018: drop empty routes from the leaderboards. Empty routes (count=0)
  // previously appeared at the top with avg=100% (or bottom with 0%) just
  // because they had no data, distorting the manager's read of "which
  // routes need attention".
  const routeStats = routes
    .map((r) => {
      const scores = r.branches.map((b) => b.completenessScore);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      return { ...r, avg, count: scores.length };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.avg - a.avg);
  const top = routeStats.slice(0, 10);
  const bottom = [...routeStats].reverse().slice(0, 5);

  // Daily activity buckets
  const dailyMap = new Map<string, number>();
  for (const e of last30Days) {
    if (!e.reviewedAt) continue;
    const d = e.reviewedAt.toISOString().slice(0, 10);
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
  }
  const dailyMax = Math.max(1, ...dailyMap.values());
  const dailyDays: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dailyDays.push({ date: d, count: dailyMap.get(d) ?? 0 });
  }

  return (
    <main>
      <PageHeader title="Dashboard" subtitle="Master data health at a glance" />

      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-6 lg:grid-cols-7">
        <Kpi label="Customers" value={customerCount.toLocaleString()} />
        <Kpi label="Branches" value={branchCount.toLocaleString()} />
        <Kpi label="Active branches" value={activeBranches.toLocaleString()} />
        <Kpi label="Closed customers" value={closedCount.toLocaleString()} tone="red" />
        <Kpi
          label="Pending approval"
          value={pendingApprovals.toLocaleString()}
          tone={pendingApprovals > 0 ? 'amber' : undefined}
        />
        <Kpi
          label="Needs correction"
          value={rejectedEdits.toLocaleString()}
          tone={rejectedEdits > 0 ? 'amber' : undefined}
        />
        <Kpi
          label="Avg completeness"
          value={`${Math.round(avgScore._avg.completenessScore ?? 0)}%`}
          tone="green"
        />
      </div>

      <div className="grid gap-4 px-4 pb-6 sm:px-6 lg:grid-cols-2">
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Daily approvals (last 30 days)
          </h2>
          <div className="flex h-32 items-end gap-0.5">
            {dailyDays.map((d) => (
              <div
                key={d.date}
                className="group relative flex-1"
                style={{ height: '100%' }}
                title={`${d.date}: ${d.count}`}
              >
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-t bg-brand-500 transition-colors group-hover:bg-brand-700"
                  style={{ height: `${(d.count / dailyMax) * 100}%`, minHeight: d.count > 0 ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Total approvals last 30 days: {last30Days.length.toLocaleString()}
          </p>
        </section>

        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Completeness by region
          </h2>
          <ul className="space-y-3">
            {regionStats.map((r) => {
              const scores = r.branches.map((b) => b.completenessScore);
              const avg = scores.length
                ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                : 0;
              return (
                <li key={r.id} className="grid grid-cols-[120px_1fr_50px] items-center gap-3">
                  <span className="text-sm font-medium text-slate-700">{r.name}</span>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${
                        avg >= 80 ? 'bg-emerald-500' : avg >= 50 ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${avg}%` }}
                    />
                  </div>
                  <span className="text-right text-xs font-semibold text-slate-700">{avg}%</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Top performing routes
          </h2>
          <RouteList routes={top} />
        </section>
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Routes needing attention
          </h2>
          <RouteList routes={bottom} />
        </section>
      </div>
    </main>
  );
}

function RouteList({
  routes,
}: {
  routes: { id: string; code: string; name: string; avg: number; count: number; owner: { fullName: string } | null }[];
}) {
  if (routes.length === 0) return <p className="text-sm text-slate-500">No routes yet.</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {routes.map((r) => (
        <li key={r.id} className="grid grid-cols-[80px_1fr_50px] items-center gap-3">
          <span className="font-mono text-xs">{r.code}</span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-slate-900">
              {r.owner?.fullName ?? 'unassigned'}
            </p>
            <p className="text-[11px] text-slate-500">{r.count} branches</p>
          </div>
          <span
            className={`text-right text-xs font-semibold ${
              r.avg >= 80
                ? 'text-emerald-700'
                : r.avg >= 50
                  ? 'text-amber-700'
                  : 'text-red-700'
            }`}
          >
            {r.avg}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'red' | 'amber' | 'green';
}) {
  const toneClass =
    tone === 'red'
      ? 'text-red-700 ring-red-200 bg-red-50'
      : tone === 'amber'
        ? 'text-amber-700 ring-amber-200 bg-amber-50'
        : tone === 'green'
          ? 'text-emerald-700 ring-emerald-200 bg-emerald-50'
          : 'text-slate-900 ring-slate-200 bg-white';
  return (
    <div className={`rounded-lg ring-1 ring-inset ${toneClass} px-3 py-2.5`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
    </div>
  );
}
