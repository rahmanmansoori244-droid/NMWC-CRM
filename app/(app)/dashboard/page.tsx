import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';

export const metadata = { title: 'Dashboard · NMWC' };

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.MANAGER && session.user.role !== Role.VIEWER)
    redirect('/home');

  const [
    customerCount,
    branchCount,
    activeBranches,
    closedCount,
    pendingApprovals,
    rejectedEdits,
    avgScore,
  ] = await Promise.all([
    prisma.customer.count({ where: { deletedAt: null } }),
    prisma.branch.count({ where: { deletedAt: null } }),
    prisma.branch.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
    prisma.customer.count({ where: { deletedAt: null, status: 'CLOSED' } }),
    prisma.customerEdit.count({ where: { state: 'SUBMITTED' } }),
    prisma.customerEdit.count({ where: { state: 'NEEDS_CORRECTION' } }),
    prisma.customer.aggregate({ _avg: { completenessScore: true }, where: { deletedAt: null } }),
  ]);

  // Per-region completeness
  const regionStats = await prisma.region.findMany({
    select: {
      id: true,
      name: true,
      code: true,
      branches: { select: { completenessScore: true }, where: { deletedAt: null } },
    },
    orderBy: { name: 'asc' },
  });

  return (
    <main>
      <PageHeader
        title="Dashboard"
        subtitle="Master data health at a glance"
      />

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

      <section className="px-4 pb-6 sm:px-6">
        <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
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
            {regionStats.length === 0 && (
              <p className="text-sm text-slate-500">No regions yet.</p>
            )}
          </ul>
        </div>
      </section>
    </main>
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
