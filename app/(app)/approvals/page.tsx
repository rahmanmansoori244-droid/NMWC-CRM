import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { loadScope } from '@/lib/access';
import { formatSlaStatus } from '@/lib/working-hours';
import { countFieldChanges, hasManualGps } from '@/lib/gps-manual';
import { BulkApprovalQueue, type ApprovalQueueItem } from './BulkApprovalQueue';

export const metadata = { title: 'Approvals · NMWC' };

const APPROVER_ROLES: Role[] = [
  Role.SUPERVISOR,
  Role.MANAGER,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
  Role.GM,
];

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!APPROVER_ROLES.includes(session.user.role)) {
    redirect('/home');
  }

  // Phase 1: the queue is STEP-AWARE — each role sees only the edits whose
  // CURRENT chain step is theirs (`pendingRole`), scoped exactly like
  // canActOnStep so a row in the queue is always actionable:
  //   SUPERVISOR       — pendingRole SUPERVISOR + their own team's submitters
  //   MANAGER          — pendingRole SUPERVISOR + region overlap (RBAC-05-003
  //                      fallback approver; fail-closed on empty regions)
  //   ACCOUNTANT       — pendingRole ACCOUNTANT + region overlap (fail-closed)
  //   FINANCE_MANAGER  — pendingRole FINANCE_MANAGER (org-wide)
  //   GM               — pendingRole GM (org-wide)
  // Region overlap matches live customer branches (UPDATE) OR draft branches
  // (CREATE — customerId is null until finalize).
  // Deploy-gap healing: a row submitted by pre-Phase-1 code AFTER the
  // migration backfill ran has pendingRole NULL. Only such gap rows can be
  // SUBMITTED with a null pendingRole (drafts are filtered out by state), and
  // they are all single-step Supervisor edits — so the Supervisor-step queues
  // (Supervisor + Manager-fallback) treat NULL as SUPERVISOR.
  const supervisorStepOr: Prisma.CustomerEditWhereInput[] = [
    { pendingRole: Role.SUPERVISOR },
    { pendingRole: null },
  ];
  const role = session.user.role;
  let where: Prisma.CustomerEditWhereInput;
  if (role === Role.SUPERVISOR) {
    where = {
      state: 'SUBMITTED',
      OR: supervisorStepOr,
      submittedBy: { supervisorId: session.user.id },
    };
  } else if (role === Role.FINANCE_MANAGER || role === Role.GM) {
    where = { state: 'SUBMITTED', pendingRole: role };
  } else {
    // MANAGER (fallback on the Supervisor step) and ACCOUNTANT — region-scoped.
    const scope = await loadScope(session.user.id);
    if (scope.managedRegionIds.length === 0) {
      // RBAC-05-003 / RBAC-05-012: fail-closed empty queue.
      where = { state: 'SUBMITTED', id: '__none__' };
    } else {
      const regionOr: Prisma.CustomerEditWhereInput[] = [
        {
          customer: {
            branches: {
              some: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
            },
          },
        },
        {
          // final-hunt #7/#15: scope on the draft's CURRENT route region (not the
          // frozen EditBranchDraft.regionId snapshot) so visibility == the approve
          // gate's authorization even when a route is re-regioned mid-chain.
          branchDrafts: {
            some: { route: { regionId: { in: scope.managedRegionIds } } },
          },
        },
      ];
      where = {
        state: 'SUBMITTED',
        AND: [
          role === Role.MANAGER ? { OR: supervisorStepOr } : { pendingRole: Role.ACCOUNTANT },
          { OR: regionOr },
        ],
      };
    }
  }

  // perf audit #14/#38: SELECT exactly what the queue renders — the old
  // `include` dragged every CustomerEdit column (attachmentChanges +
  // approvalChain JSON, decisionReason Text …) for every row, and the query
  // was unbounded. fieldChanges stays (the card shows a change count).
  const items = await prisma.customerEdit.findMany({
    where,
    select: {
      id: true,
      process: true,
      fieldChanges: true,
      submittedAt: true,
      slaDueAt: true,
      escalationLevel: true,
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
      // CREATE requests: display fields come from the draft.
      customerDraft: { select: { legalName: true, paymentTerms: true } },
    },
    // Most-overdue first (index [state, slaDueAt] backs it); legacy rows
    // without a deadline sort last.
    orderBy: [{ slaDueAt: 'asc' }, { submittedAt: 'asc' }],
    take: 200,
  });

  // B-11 (Senior-audit 2026-05-10): pre-shape items for the bulk-approval client
  // component and let it own the multi-select + bulk action UI. The per-row
  // link still goes to /approvals/[id] for nuanced reviews.
  const queueItems: ApprovalQueueItem[] = items.map((e) => {
    // Real field changes only: a new-customer request carries item 41 markers
    // in fieldChanges, which are notes about a point, not changes.
    const changesCount = countFieldChanges(e.fieldChanges);
    const ageHours = e.submittedAt
      ? Math.round((Date.now() - new Date(e.submittedAt).getTime()) / (60 * 60 * 1000))
      : 0;
    const isCreate = e.process === 'CREATE';
    // Working-hours SLA pill, computed server-side (client clocks drift).
    const sla = e.slaDueAt ? formatSlaStatus(e.slaDueAt) : null;
    return {
      sla,
      escalationLevel: e.escalationLevel,
      id: e.id,
      ageHours,
      changesCount,
      manualGps: hasManualGps(e.fieldChanges),
      isCreate,
      paymentTerms: isCreate ? (e.customerDraft?.paymentTerms ?? null) : null,
      customer: e.customer
        ? {
            legalName: e.customer.legalName,
            nmwcCode: e.customer.nmwcCode,
            completenessScore: e.customer.completenessScore,
          }
        : isCreate && e.customerDraft
          ? {
              legalName: e.customerDraft.legalName,
              nmwcCode: 'NEW',
              completenessScore: 0,
            }
          : null,
      submittedByFullName: e.submittedBy.fullName,
    };
  });

  return (
    <main>
      <PageHeader title="Approval queue" subtitle={`${items.length} pending`} />

      <div className="pt-4 sm:pt-6">
        {items.length === 0 ? (
          <div className="px-4 sm:px-6">
            <EmptyState
              title="Nothing pending"
              description="When a request reaches your step of the approval chain, it appears here."
            />
          </div>
        ) : (
          <BulkApprovalQueue items={queueItems} />
        )}
      </div>
    </main>
  );
}
