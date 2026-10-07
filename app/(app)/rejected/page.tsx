import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import Link from 'next/link';
import { inIdOrder, openReturnedIds } from '@/lib/returned-work';
import { ClearReturned } from './ClearReturned';

export const metadata = { title: 'Needs correction · NMWC' };

export default async function RejectedPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SALESMAN) redirect('/work');

  // Launch fix: only what still waits on him — a sent-back update he has sent
  // again is answered (lib/returned-work.ts), and stayed here for good.
  const ids = await openReturnedIds(prisma, session.user.id);
  const rows =
    ids.length === 0
      ? []
      : await prisma.customerEdit.findMany({
          where: { id: { in: ids } },
          include: {
            customer: { select: { id: true, legalName: true, nmwcCode: true } },
            // Phase 1 creation flow: CREATE rejections carry their name in the draft
            // and are revised on the create form, not the customer profile.
            customerDraft: { select: { legalName: true } },
            reviewedBy: { select: { fullName: true } },
          },
        });
  const items = inIdOrder(ids, rows);

  return (
    <main>
      <PageHeader
        title="Needs correction"
        // Not "your supervisor": a Manager decides a reactivation, and stands in
        // for the Supervisor on the first step. Each card names who sent it back.
        subtitle={`${items.length} submission(s) sent back to you`}
      />
      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <EmptyState title="Nothing to correct" description="Nothing you sent is waiting on you." />
        ) : (
          <ul className="grid gap-3">
            {items.map((e) => (
              <li key={e.id} className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200 hover:shadow-md">
                <Link
                  // A sent-back update opens on the edit form, with the reason and
                  // what he sent filled in; a close or reactivation on the profile.
                  href={
                    e.process === 'CREATE'
                      ? `/customers/new?edit=${e.id}`
                      : e.target === 'CUSTOMER' && !e.isReactivation
                        ? `/customers/${e.customerId}/edit?returned=${e.id}`
                        : `/customers/${e.customerId}`
                  }
                  className="block p-4"
                >
                  <h3 className="text-sm font-semibold text-slate-900">
                    {e.customer?.legalName ?? e.customerDraft?.legalName ?? '—'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {e.process === 'CREATE' ? 'New customer request' : e.customer?.nmwcCode}
                  </p>
                  <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-200">
                    {e.decisionReason ?? 'Needs correction'}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Sent back by {e.reviewedBy?.fullName} ·{' '}
                    {e.reviewedAt?.toLocaleDateString('en-GB')}
                  </p>
                </Link>
                {/* Launch fix: one he will not send again can be cleared here — even
                    a customer no longer on his route, whose page he cannot open. A
                    new-customer request is withdrawn from its own page instead. */}
                {e.process !== 'CREATE' && (
                  <div className="px-4 pb-3">
                    <ClearReturned editId={e.id} then="/rejected" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
