import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { ReactivationDecisionForm } from './ReactivationDecisionForm';

export const metadata = { title: 'Reactivations · NMWC' };

export default async function ReactivationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.MANAGER) redirect('/home');

  const items = await prisma.customerEdit.findMany({
    where: { isReactivation: true, state: 'SUBMITTED' },
    include: {
      submittedBy: { select: { fullName: true } },
      customer: { select: { id: true, legalName: true, nmwcCode: true } },
      branch: {
        select: {
          id: true,
          branchName: true,
          shopPhotoId: true,
          signboardPhotoId: true,
          route: { select: { code: true } },
        },
      },
    },
    orderBy: { submittedAt: 'asc' },
  });

  return (
    <main>
      <PageHeader
        title="Reactivation queue"
        subtitle={`${items.length} closed shops requesting reactivation`}
      />
      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <EmptyState
            title="No reactivation requests"
            description="When salesmen find a previously closed shop has reopened, they submit a request here for your review."
          />
        ) : (
          <ul className="grid gap-3">
            {items.map((e) => (
              <li
                key={e.id}
                className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
              >
                <header className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {e.customer?.legalName} —{' '}
                    <span className="text-slate-700">{e.branch?.branchName}</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    {e.customer?.nmwcCode} · route {e.branch?.route.code} · submitted by{' '}
                    {e.submittedBy.fullName}
                  </p>
                </header>
                <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-center">
                  <div>
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
                      <strong>Reason:</strong> {e.decisionReason ?? '—'}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {e.branch?.shopPhotoId && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/photos/${e.branch.shopPhotoId}`}
                          alt="Shop evidence"
                          className="h-24 w-full rounded-md object-cover"
                        />
                      )}
                      {e.branch?.signboardPhotoId && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/photos/${e.branch.signboardPhotoId}`}
                          alt="Signboard"
                          className="h-24 w-full rounded-md object-cover"
                        />
                      )}
                    </div>
                  </div>
                  <ReactivationDecisionForm editId={e.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
