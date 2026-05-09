import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { CompletenessRing } from '@/components/nmwc/CompletenessRing';
import { loadScope } from '@/lib/access';

export const metadata = { title: 'Approvals · NMWC' };

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SUPERVISOR && session.user.role !== Role.MANAGER) {
    redirect('/home');
  }

  // RBAC-05-003 (Critical): Manager queue must be region-scoped. Previously
  // any Manager saw the global queue and could approve cross-region. Now we
  // intersect with their `managedRegionIds`; a Manager with no managed
  // regions sees an empty queue (fail-closed).
  let where: Prisma.CustomerEditWhereInput;
  if (session.user.role === Role.SUPERVISOR) {
    where = {
      state: 'SUBMITTED',
      submittedBy: { supervisorId: session.user.id },
    };
  } else {
    const scope = await loadScope(session.user.id);
    if (scope.managedRegionIds.length === 0) {
      where = { state: 'SUBMITTED', id: '__none__' };
    } else {
      where = {
        state: 'SUBMITTED',
        customer: {
          branches: {
            some: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
          },
        },
      };
    }
  }

  const items = await prisma.customerEdit.findMany({
    where,
    include: {
      submittedBy: { select: { fullName: true, username: true } },
      customer: {
        select: {
          id: true,
          legalName: true,
          nmwcCode: true,
          completenessScore: true,
          paymentTerms: true,
        },
      },
    },
    orderBy: { submittedAt: 'asc' },
  });

  return (
    <main>
      <PageHeader
        title="Approval queue"
        subtitle={`${items.length} pending`}
      />

      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <EmptyState
            title="Nothing pending"
            description="When salesmen submit edits, they appear here for your review."
          />
        ) : (
          <ul className="grid gap-3">
            {items.map((e) => {
              const changes = Array.isArray(e.fieldChanges) ? e.fieldChanges.length : 0;
              const ageHours =
                e.submittedAt
                  ? Math.round((Date.now() - new Date(e.submittedAt).getTime()) / (60 * 60 * 1000))
                  : 0;
              return (
                <li key={e.id}>
                  <Link
                    href={`/approvals/${e.id}`}
                    className="flex items-start gap-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:shadow-md"
                  >
                    <CompletenessRing
                      value={e.customer?.completenessScore ?? 0}
                      size={44}
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold text-slate-900">
                        {e.customer?.legalName}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {e.customer?.nmwcCode} · {changes} change{changes === 1 ? '' : 's'}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        Submitted by {e.submittedBy.fullName}
                      </p>
                    </div>
                    <div className="text-right text-xs">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 font-medium ${
                          ageHours > 72
                            ? 'bg-red-50 text-red-700'
                            : ageHours > 24
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {ageHours < 1 ? 'just now' : ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
