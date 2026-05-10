import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CustomerCard } from '@/components/nmwc/CustomerCard';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { Role } from '@prisma/client';
import { omanDayOfWeek } from '@/lib/tz';

export const metadata = { title: 'Today · NMWC' };

export default async function TodayPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SALESMAN) redirect('/home');

  // Find owned route
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { id: true, fullName: true, ownedRouteId: true },
  });
  if (!me.ownedRouteId) {
    return (
      <main className="p-6">
        <PageHeader title={`Welcome, ${me.fullName}`} subtitle="No route assigned yet." />
        <div className="p-6">
          <EmptyState
            title="No route assigned"
            description="Ask a Manager to assign you to a route. You'll see your customers here once that's done."
          />
        </div>
      </main>
    );
  }

  // PROD-004: compute Oman-local day-of-week. Vercel runs in UTC; without this
  // the server returned yesterday's customer list between Oman 00:00 and 04:00.
  const today = omanDayOfWeek();

  const branches = await prisma.branch.findMany({
    where: {
      routeId: me.ownedRouteId,
      deletedAt: null,
      dayOfVisit: today,
    },
    take: 200,
    include: {
      customer: {
        select: {
          id: true,
          nmwcCode: true,
          legalName: true,
          paymentTerms: true,
          status: true,
          completenessScore: true,
        },
      },
    },
    orderBy: { branchName: 'asc' },
  });

  // Stats
  const [total, pending, rejected] = await Promise.all([
    prisma.branch.count({ where: { routeId: me.ownedRouteId, deletedAt: null } }),
    prisma.customerEdit.count({ where: { submittedById: me.id, state: 'SUBMITTED' } }),
    prisma.customerEdit.count({ where: { submittedById: me.id, state: 'NEEDS_CORRECTION' } }),
  ]);

  return (
    <main>
      <PageHeader
        title={`Good day, ${me.fullName?.split(' ')[0] ?? 'there'}`}
        subtitle={new Date().toLocaleDateString('en-GB', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
      />

      <div className="grid grid-cols-3 gap-2 px-4 pt-4 sm:gap-3 sm:px-6">
        <Stat label="Route customers" value={total} />
        <Stat label="Pending approval" value={pending} tone={pending > 0 ? 'amber' : undefined} />
        <Stat label="Needs correction" value={rejected} tone={rejected > 0 ? 'red' : undefined} />
      </div>

      <section className="px-4 py-4 sm:px-6">
        <h2 className="mb-3 text-base font-semibold text-slate-700">
          Today&apos;s visits ({branches.length})
        </h2>
        {branches.length === 0 ? (
          <EmptyState
            title="No customers scheduled today"
            description={`No branches on your route are flagged for ${today}. View the full customer list to plan visits.`}
          />
        ) : (
          <div className="grid gap-3">
            {branches.map((b) => (
              <CustomerCard
                key={b.id}
                customer={b.customer}
                primaryBranch={{ branchName: b.branchName, address: b.address }}
                href={`/customers/${b.customer.id}`}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'red' | 'amber';
}) {
  const toneClass =
    tone === 'red'
      ? 'text-red-700 ring-red-200 bg-red-50'
      : tone === 'amber'
        ? 'text-amber-700 ring-amber-200 bg-amber-50'
        : 'text-slate-900 ring-slate-200 bg-white';
  return (
    <div className={`rounded-lg ring-1 ring-inset ${toneClass} px-3 py-2.5 text-center`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs font-medium text-slate-600">{label}</div>
    </div>
  );
}
