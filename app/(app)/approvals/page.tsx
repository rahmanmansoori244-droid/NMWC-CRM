import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { loadScope } from '@/lib/access';
import { BulkApprovalQueue, type ApprovalQueueItem } from './BulkApprovalQueue';

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

  // B-11 (Senior-audit 2026-05-10): pre-shape items for the bulk-approval client
  // component and let it own the multi-select + bulk action UI. The per-row
  // link still goes to /approvals/[id] for nuanced reviews.
  const queueItems: ApprovalQueueItem[] = items.map((e) => {
    const changesCount = Array.isArray(e.fieldChanges) ? e.fieldChanges.length : 0;
    const ageHours = e.submittedAt
      ? Math.round((Date.now() - new Date(e.submittedAt).getTime()) / (60 * 60 * 1000))
      : 0;
    return {
      id: e.id,
      ageHours,
      changesCount,
      customer: e.customer
        ? {
            legalName: e.customer.legalName,
            nmwcCode: e.customer.nmwcCode,
            completenessScore: e.customer.completenessScore,
          }
        : null,
      submittedByFullName: e.submittedBy.fullName,
    };
  });

  return (
    <main>
      <PageHeader
        title="Approval queue"
        subtitle={`${items.length} pending`}
      />

      <div className="pt-4 sm:pt-6">
        {items.length === 0 ? (
          <div className="px-4 sm:px-6">
            <EmptyState
              title="Nothing pending"
              description="When salesmen submit edits, they appear here for your review."
            />
          </div>
        ) : (
          <BulkApprovalQueue items={queueItems} />
        )}
      </div>
    </main>
  );
}
