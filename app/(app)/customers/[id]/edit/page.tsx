import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { isFieldLocked } from '@/lib/permissions';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { PaymentTermsPill } from '@/components/nmwc/PaymentTermsPill';
import { StatusBadge } from '@/components/nmwc/StatusBadge';
import { EnrichmentForm } from './EnrichmentForm';

export const metadata = { title: 'Enrich · NMWC' };

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const { id } = await params;

  const customer = await prisma.customer.findFirst({
    where: { id, deletedAt: null },
    include: {
      branches: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { region: true, route: true },
      },
    },
  });
  if (!customer) notFound();

  // Salesman scope check
  if (session.user.role === Role.SALESMAN) {
    const me = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { ownedRouteId: true },
    });
    const onMyRoute = customer.branches.some((b) => b.routeId === me.ownedRouteId);
    if (!onMyRoute) redirect(`/customers/${customer.id}`);
  } else if (session.user.role === Role.VIEWER) {
    redirect(`/customers/${customer.id}`);
  }

  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
    include: { subChannels: { where: { isActive: true }, orderBy: { label: 'asc' } } },
  });

  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  const lockNameAndCr = isFieldLocked('legalName', sessionUser, customer);

  // Existing pending edit?
  const pending = await prisma.customerEdit.findFirst({
    where: { customerId: customer.id, state: 'SUBMITTED' },
    select: { id: true, submittedAt: true, submittedBy: { select: { fullName: true } } },
  });

  return (
    <main className="pb-24">
      <PageHeader
        title={customer.legalName}
        subtitle={`${customer.nmwcCode} · Enrich missing data`}
        actions={
          <div className="flex items-center gap-2">
            <PaymentTermsPill terms={customer.paymentTerms} />
            <StatusBadge status={customer.status} />
          </div>
        }
      />

      {pending && (
        <div className="mx-4 mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 sm:mx-6">
          A submission is already pending review (by {pending.submittedBy.fullName}). You can save
          drafts but cannot submit until the supervisor decides.
        </div>
      )}

      <EnrichmentForm
        customer={customer}
        channels={channels}
        lockNameAndCr={lockNameAndCr}
        userRole={session.user.role}
        canSubmit={!pending}
      />
    </main>
  );
}
