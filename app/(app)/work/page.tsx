import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { OPEN_PROBLEM_ROW, WORK_BATCH_ROWS } from '@/lib/import-rows-view';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import Link from 'next/link';
import { StatusBadge } from '@/components/nmwc/StatusBadge';

export const metadata = { title: 'Work items · NMWC' };

/** Where a work item can lead: any static page, or one of these dynamic pages. */
type WorkHref = Route<`/approvals/${string}` | `/customers/${string}` | `/import/${string}`>;

export default async function WorkPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const role = session.user.role;
  const userId = session.user.id;

  // Per-role queries
  let items: Array<{
    id: string;
    category: string;
    title: string;
    subtitle?: string;
    href: WorkHref;
    state?: string;
    when?: Date | null;
  }> = [];

  if (role === Role.SALESMAN) {
    // Phase 1 creation flow: a CREATE request (customerId null) is revised on
    // the create form, not the customer profile — route its rows there.
    const editHref = (e: { id: string; process: string; customerId: string | null }): WorkHref =>
      e.process === 'CREATE' ? `/customers/new?edit=${e.id}` : `/customers/${e.customerId}`;
    const editTitle = (e: {
      customer: { legalName: string } | null;
      customerDraft: { legalName: string } | null;
    }) => e.customer?.legalName ?? e.customerDraft?.legalName ?? '—';
    const include = {
      customer: { select: { id: true, legalName: true, nmwcCode: true } },
      customerDraft: { select: { legalName: true } },
    } as const;
    // perf audit #11/#39: three independent reads — one parallel wave, not
    // three sequential round trips.
    const [rejected, pending, createDrafts] = await Promise.all([
      prisma.customerEdit.findMany({
        where: { submittedById: userId, state: 'NEEDS_CORRECTION' },
        include,
        orderBy: { reviewedAt: 'desc' },
        take: 50,
      }),
      prisma.customerEdit.findMany({
        where: { submittedById: userId, state: 'SUBMITTED' },
        include,
        orderBy: { submittedAt: 'desc' },
        take: 50,
      }),
      prisma.customerEdit.findMany({
        where: { submittedById: userId, state: 'DRAFT', process: 'CREATE' },
        include,
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
    ]);
    items = [
      ...rejected.map((e) => ({
        id: e.id,
        category: e.process === 'CREATE' ? 'New customer — needs correction' : 'Rejected',
        title: editTitle(e),
        subtitle: e.decisionReason ?? 'Needs correction',
        href: editHref(e),
        state: e.state,
        when: e.reviewedAt,
      })),
      ...pending.map((e) => ({
        id: e.id,
        category: e.process === 'CREATE' ? 'New customer — in approval' : 'Awaiting approval',
        title: editTitle(e),
        subtitle:
          e.process === 'CREATE'
            ? `In review — current step: ${e.pendingRole?.replace('_', ' ') ?? '…'}`
            : 'Submitted to your supervisor',
        href: editHref(e),
        state: e.state,
        when: e.submittedAt,
      })),
      ...createDrafts.map((e) => ({
        id: e.id,
        category: 'New customer — draft',
        title: editTitle(e),
        subtitle: 'Unfinished create request — tap to continue',
        href: editHref(e),
        state: e.state,
        when: e.updatedAt,
      })),
    ];
  } else if (role === Role.SUPERVISOR) {
    // Step-aware: only requests whose CURRENT step is the Supervisor's.
    // pendingRole NULL = pre-Phase-1 deploy-gap row (single-step Supervisor
    // edit by construction) — treat as SUPERVISOR, same as /approvals.
    const queue = await prisma.customerEdit.findMany({
      where: {
        state: 'SUBMITTED',
        OR: [{ pendingRole: Role.SUPERVISOR }, { pendingRole: null }],
        submittedBy: { supervisorId: userId },
      },
      include: {
        customer: { select: { id: true, legalName: true, nmwcCode: true } },
        customerDraft: { select: { legalName: true } },
        submittedBy: { select: { fullName: true } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 100,
    });
    items = queue.map((e) => ({
      id: e.id,
      category: e.process === 'CREATE' ? 'New customer to review' : 'Pending approval',
      title: e.customer?.legalName ?? e.customerDraft?.legalName ?? '—',
      subtitle: `From ${e.submittedBy.fullName}`,
      href: `/approvals/${e.id}`,
      state: e.state,
      when: e.submittedAt,
    }));
  } else if (role === Role.ACCOUNTANT || role === Role.FINANCE_MANAGER || role === Role.GM) {
    // Phase 1 approver queues. Accountant is region-scoped (fail-closed, same
    // managedRegions mechanism as Manager) and matches CREATE requests via
    // draft-branch regions; FM/GM are org-wide.
    const { loadScope } = await import('@/lib/access');
    let where: import('@prisma/client').Prisma.CustomerEditWhereInput;
    if (role === Role.ACCOUNTANT) {
      const scope = await loadScope(userId);
      where =
        scope.managedRegionIds.length === 0
          ? { state: 'SUBMITTED', id: '__none__' }
          : {
              state: 'SUBMITTED',
              pendingRole: Role.ACCOUNTANT,
              OR: [
                {
                  customer: {
                    branches: {
                      some: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
                    },
                  },
                },
                { branchDrafts: { some: { route: { regionId: { in: scope.managedRegionIds } } } } }, // final-hunt #7/#15: current route region
              ],
            };
    } else {
      where = { state: 'SUBMITTED', pendingRole: role };
    }
    const queue = await prisma.customerEdit.findMany({
      where,
      include: {
        customer: { select: { id: true, legalName: true } },
        customerDraft: { select: { legalName: true, paymentTerms: true } },
        submittedBy: { select: { fullName: true } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 100,
    });
    items = queue.map((e) => ({
      id: e.id,
      category:
        e.process === 'CREATE'
          ? `New ${e.customerDraft?.paymentTerms ?? ''} customer to review`.replace('  ', ' ')
          : 'Pending approval',
      title: e.customer?.legalName ?? e.customerDraft?.legalName ?? '—',
      subtitle: `From ${e.submittedBy.fullName}`,
      href: `/approvals/${e.id}`,
      state: e.state,
      when: e.submittedAt,
    }));
  } else if (role === Role.MANAGER) {
    // RBAC-05-010: Manager work queue must be region-scoped. Without this,
    // the inbox shows stale approvals from every region globally.
    const { loadScope } = await import('@/lib/access');
    const scope = await loadScope(userId);
    const stale =
      scope.managedRegionIds.length === 0
        ? []
        : await prisma.customerEdit.findMany({
            where: {
              state: 'SUBMITTED',
              submittedAt: { lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
              OR: [
                {
                  customer: {
                    branches: {
                      some: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
                    },
                  },
                },
                // Phase 1: stale CREATE requests match via draft-branch regions.
                { branchDrafts: { some: { route: { regionId: { in: scope.managedRegionIds } } } } }, // final-hunt #7/#15: current route region
              ],
            },
            include: {
              customer: { select: { id: true, legalName: true } },
              customerDraft: { select: { legalName: true } },
            },
            take: 50,
          });
    items = stale.map((e) => ({
      id: e.id,
      category: 'Stale approval (>3 days)',
      title: e.customer?.legalName ?? e.customerDraft?.legalName ?? '—',
      href: `/approvals/${e.id}`,
      state: e.state,
      when: e.submittedAt,
    }));
  } else if (role === Role.STEWARD) {
    // RK-3: promote is sliced, so a load can now be left half-finished (tab closed,
    // timeout, network drop) — it sits in PROMOTING with no live lease. That needs
    // the Steward's attention just as much as a FAILED batch, and without this it
    // would be invisible here: promote no longer writes FAILED at all.
    //
    // Item 20: a batch is listed while it has a held-back or rejected row that is
    // neither fixed nor accepted as excluded, and while rows fixed in the app are
    // waiting to be promoted. It used to be listed while its UPLOAD-TIME
    // quarantine count was above zero — for ever, since nothing could lower it —
    // and never for rejections alone, so a batch that lost 1,833 customers at
    // promote was not on this page at all.
    const failed = await prisma.importBatch.findMany({
      where: {
        OR: [
          { status: 'FAILED' },
          { status: 'PROMOTING', promoteLeaseUntil: null },
          { status: 'PROMOTING', promoteLeaseUntil: { lt: new Date() } },
          ...WORK_BATCH_ROWS,
        ],
      },
      orderBy: { uploadedAt: 'desc' },
      take: 30,
      include: { _count: { select: { rows: { where: OPEN_PROBLEM_ROW } } } },
    });
    items = failed.map((b) => ({
      id: b.id,
      category:
        b.status === 'PROMOTING'
          ? 'Import to resume'
          : b._count.rows > 0
            ? 'Import to review'
            : 'Import to promote',
      title: b.filename,
      subtitle:
        b.status === 'PROMOTING'
          ? `Promote interrupted — ${b.promotedRows} of ${b.totalRows} rows loaded`
          : b._count.rows > 0
            ? `${b._count.rows.toLocaleString('en-US')} row${b._count.rows === 1 ? '' : 's'} held back or rejected, not yet fixed or excluded`
            : 'Rows fixed in the app are waiting to be promoted',
      href: `/import/${b.id}`,
      when: b.uploadedAt,
    }));
  }

  return (
    <main>
      <PageHeader title="Work items" subtitle="Things that need your attention" />
      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <EmptyState title="All clear" description="Nothing is waiting on you right now." />
        ) : (
          <ul className="grid gap-3">
            {items.map((it) => (
              <li key={it.id}>
                <Link
                  href={it.href}
                  className="block rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-brand-700">
                        {it.category}
                      </p>
                      <h3 className="truncate text-sm font-semibold text-slate-900">{it.title}</h3>
                      {it.subtitle && <p className="text-xs text-slate-600">{it.subtitle}</p>}
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      {it.state && <StatusBadge status={it.state} className="mb-1" />}
                      {it.when && <div>{it.when.toLocaleDateString('en-GB')}</div>}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
