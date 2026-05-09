import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { isFieldLocked } from '@/lib/permissions';
import { loadScope, filterBranchesByScope } from '@/lib/access';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { PaymentTermsPill } from '@/components/nmwc/PaymentTermsPill';
import { StatusBadge } from '@/components/nmwc/StatusBadge';
import { EnrichmentForm } from './EnrichmentForm';

export const metadata = { title: 'Enrich · NMWC' };
// UXI-005: never serve a stale cached form. Without this, hitting Back after
// a successful submit would render the populated form with `canSubmit=true`
// from the pre-submit server snapshot, encouraging an accidental re-submit.
export const dynamic = 'force-dynamic';

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
    select: {
      id: true,
      nmwcCode: true,
      legalName: true,
      paymentTerms: true,
      crNumber: true,
      crPhotoId: true,
      channelId: true,
      subChannelId: true,
      primaryPhone: true,
      altPhone: true,
      contactPerson: true,
      contactRole: true,
      status: true,
      notes: true,
      // UXI-003 — surfaced to the form to detect stale localStorage drafts.
      updatedAt: true,
      branches: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          branchName: true,
          address: true,
          areaDescription: true,
          gpsLat: true,
          gpsLng: true,
          gpsAccuracy: true,
          gpsCapturedAt: true,
          dayOfVisit: true,
          openingHours: true,
          deliveryWindow: true,
          coolersCount: true,
          standsCount: true,
          emptyBottlesCount: true,
          status: true,
          shopPhotoId: true,
          signboardPhotoId: true,
          // RBAC-05-022: needed by filterBranchesByScope.
          routeId: true,
          regionId: true,
          deletedAt: true,
          region: { select: { name: true } },
          route: { select: { code: true } },
        },
      },
    },
  });
  if (!customer) notFound();

  // RBAC-05-005: SUPERVISOR may not edit (they approve). VIEWER read-only.
  // Previously the page rendered the form for SUPERVISOR and the server
  // action then refused on submit, losing all the typed fields. Redirect at
  // the page level so they never see the form.
  if (
    session.user.role === Role.SUPERVISOR ||
    session.user.role === Role.VIEWER
  ) {
    redirect(`/customers/${customer.id}`);
  }
  // Salesman scope check
  if (session.user.role === Role.SALESMAN) {
    const me = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { ownedRouteId: true },
    });
    const onMyRoute = customer.branches.some((b) => b.routeId === me.ownedRouteId);
    if (!onMyRoute) redirect(`/customers/${customer.id}`);
  }

  // RBAC-05-022: filter the branches array to the caller's scope BEFORE
  // shipping to the form. A Salesman editing a multi-branch customer
  // previously got every branch's IDs / addresses / photos in their initial
  // state — same leak class as RBAC-05-001 on the read page.
  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  const scope = await loadScope(session.user.id);
  customer.branches = filterBranchesByScope(sessionUser, customer.branches, scope);

  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
    include: { subChannels: { where: { isActive: true }, orderBy: { label: 'asc' } } },
  });

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
        sessionUserId={session.user.id}
      />
    </main>
  );
}
