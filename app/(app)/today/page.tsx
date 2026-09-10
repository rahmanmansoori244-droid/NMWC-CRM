import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CustomerCard } from '@/components/nmwc/CustomerCard';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { Role } from '@prisma/client';
import { omanDayOfWeek } from '@/lib/tz';

export const metadata = { title: 'Today · NMWC' };

// P3.3: cache the rendered output for 30s. /today is a salesman's daily
// route view — the visit list comes from `dayOfVisit` which only changes
// when a salesman or supervisor edits a branch. 30s of staleness is fine
// (and the salesman would refresh anyway when they open the app at the
// next stop). We don't cache /approvals, /audit, /reactivations because
// those need live data.
export const revalidate = 30;

export default async function TodayPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SALESMAN) redirect('/home');

  // Find owned route. perf audit #15: the personal edit counts key off the
  // session id directly — fetch them in the SAME wave as `me` instead of a
  // third sequential round trip after the branch list.
  const [me, pending, rejected] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { id: true, fullName: true, ownedRouteId: true },
    }),
    prisma.customerEdit.count({ where: { submittedById: session.user.id, state: 'SUBMITTED' } }),
    prisma.customerEdit.count({
      where: { submittedById: session.user.id, state: 'NEEDS_CORRECTION' },
    }),
  ]);
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

  const [branches, total] = await Promise.all([
    prisma.branch.findMany({
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
    }),
    prisma.branch.count({ where: { routeId: me.ownedRouteId, deletedAt: null } }),
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
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-700">
            Today&apos;s visits ({branches.length})
          </h2>
          {/* Go-live: only ~1 in 3 branches carries a journey-plan day, so the
              scheduled list is NOT the salesman's whole route. Keep the full,
              searchable list one tap away from the landing page. */}
          <Link
            href="/customers"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
          >
            <Search className="h-3.5 w-3.5" />
            All my customers ({total})
          </Link>
        </div>
        {branches.length === 0 ? (
          <EmptyState
            title="No customers scheduled today"
            description={`No branches on your route are flagged for ${today}. Open your full customer list to find any customer on your route.`}
            action={
              <Link
                href="/customers"
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-brand-700"
              >
                <Search className="h-4 w-4" />
                All my customers ({total})
              </Link>
            }
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
