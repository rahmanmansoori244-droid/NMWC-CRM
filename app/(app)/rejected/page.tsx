import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import Link from 'next/link';

export const metadata = { title: 'Needs correction · NMWC' };

export default async function RejectedPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SALESMAN) redirect('/work');

  const items = await prisma.customerEdit.findMany({
    where: { submittedById: session.user.id, state: 'NEEDS_CORRECTION' },
    include: {
      customer: { select: { id: true, legalName: true, nmwcCode: true } },
      // Phase 1 creation flow: CREATE rejections carry their name in the draft
      // and are revised on the create form, not the customer profile.
      customerDraft: { select: { legalName: true } },
      reviewedBy: { select: { fullName: true } },
    },
    orderBy: { reviewedAt: 'desc' },
  });

  return (
    <main>
      <PageHeader
        title="Needs correction"
        subtitle={`${items.length} submission(s) sent back by your supervisor`}
      />
      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <EmptyState title="No rejections" description="Keep it up 👍" />
        ) : (
          <ul className="grid gap-3">
            {items.map((e) => (
              <li key={e.id}>
                <Link
                  href={
                    e.process === 'CREATE'
                      ? `/customers/new?edit=${e.id}`
                      : `/customers/${e.customerId}`
                  }
                  className="block rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:shadow-md"
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
                    Rejected by {e.reviewedBy?.fullName} ·{' '}
                    {e.reviewedAt?.toLocaleDateString('en-GB')}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
