import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import Link from 'next/link';
import { StatusBadge } from '@/components/nmwc/StatusBadge';

export const metadata = { title: 'Work items · NMWC' };

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
    href: string;
    state?: string;
    when?: Date | null;
  }> = [];

  if (role === Role.SALESMAN) {
    const rejected = await prisma.customerEdit.findMany({
      where: { submittedById: userId, state: 'NEEDS_CORRECTION' },
      include: { customer: { select: { id: true, legalName: true, nmwcCode: true } } },
      orderBy: { reviewedAt: 'desc' },
      take: 50,
    });
    const pending = await prisma.customerEdit.findMany({
      where: { submittedById: userId, state: 'SUBMITTED' },
      include: { customer: { select: { id: true, legalName: true, nmwcCode: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 50,
    });
    items = [
      ...rejected.map((e) => ({
        id: e.id,
        category: 'Rejected',
        title: e.customer?.legalName ?? '—',
        subtitle: e.decisionReason ?? 'Needs correction',
        href: `/customers/${e.customerId}`,
        state: e.state,
        when: e.reviewedAt,
      })),
      ...pending.map((e) => ({
        id: e.id,
        category: 'Awaiting approval',
        title: e.customer?.legalName ?? '—',
        subtitle: 'Submitted to your supervisor',
        href: `/customers/${e.customerId}`,
        state: e.state,
        when: e.submittedAt,
      })),
    ];
  } else if (role === Role.SUPERVISOR) {
    const queue = await prisma.customerEdit.findMany({
      where: { state: 'SUBMITTED', submittedBy: { supervisorId: userId } },
      include: {
        customer: { select: { id: true, legalName: true, nmwcCode: true } },
        submittedBy: { select: { fullName: true } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 100,
    });
    items = queue.map((e) => ({
      id: e.id,
      category: 'Pending approval',
      title: e.customer?.legalName ?? '—',
      subtitle: `From ${e.submittedBy.fullName}`,
      href: `/approvals/${e.id}`,
      state: e.state,
      when: e.submittedAt,
    }));
  } else if (role === Role.MANAGER) {
    const stale = await prisma.customerEdit.findMany({
      where: {
        state: 'SUBMITTED',
        submittedAt: { lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      },
      include: { customer: { select: { id: true, legalName: true } } },
      take: 50,
    });
    items = stale.map((e) => ({
      id: e.id,
      category: 'Stale approval (>3 days)',
      title: e.customer?.legalName ?? '—',
      href: `/approvals/${e.id}`,
      state: e.state,
      when: e.submittedAt,
    }));
  } else if (role === Role.STEWARD) {
    const failed = await prisma.importBatch.findMany({
      where: { OR: [{ status: 'FAILED' }, { quarantinedRows: { gt: 0 } }] },
      orderBy: { uploadedAt: 'desc' },
      take: 30,
    });
    items = failed.map((b) => ({
      id: b.id,
      category: 'Import to review',
      title: b.filename,
      subtitle: `${b.quarantinedRows} quarantined / ${b.totalRows} total`,
      href: `/import/${b.id}`,
      when: b.uploadedAt,
    }));
  }

  return (
    <main>
      <PageHeader title="Work items" subtitle="Things that need your attention" />
      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <EmptyState title="All clear ✨" description="Nothing is waiting on you right now." />
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
                      {it.subtitle && (
                        <p className="text-xs text-slate-600">{it.subtitle}</p>
                      )}
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
