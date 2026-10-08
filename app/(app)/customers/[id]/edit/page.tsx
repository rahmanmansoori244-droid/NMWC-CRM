import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { isFieldLocked } from '@/lib/permissions';
import { loadScope, filterBranchesByScope, canEditCustomer } from '@/lib/access';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { PaymentTermsPill } from '@/components/nmwc/PaymentTermsPill';
import { StatusBadge } from '@/components/nmwc/StatusBadge';
import { EnrichmentForm } from './EnrichmentForm';
import { salesmanSubmitGate } from '@/lib/submit-gate';
import { ownPendingBanner, pendingReplacesDraft, requestKindOf } from '@/lib/submission-replay';
import { omanWhen } from '@/lib/submission';
import { openReturnedIds } from '@/lib/returned-work';
import { returnedPrefill } from './returned';
import { ClearReturned } from '../../../rejected/ClearReturned';
import { ROUTE_INACTIVE_MESSAGE } from '@/lib/errors';

export const metadata = { title: 'Enrich · NMWC' };
// UXI-005: never serve a stale cached form. Without this, hitting Back after
// a successful submit would render the populated form with `canSubmit=true`
// from the pre-submit server snapshot, encouraging an accidental re-submit.
export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `returned`: fill the form with that sent-back update (Work and Needs correction link so). */
  searchParams?: Promise<{ returned?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const { id } = await params;
  const asked = (await searchParams)?.returned;

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
          // F21: whether the counts were confirmed at the shop ("Counted").
          equipmentConfirmed: true,
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
  // the page level so they never see the form. The same for every role that
  // can neither submit an edit (services/edits.ts), attach a photo nor — owner
  // decision 2026-09-27 — remove one: only SALESMAN, STEWARD and MANAGER edit.
  if (
    session.user.role !== Role.SALESMAN &&
    session.user.role !== Role.STEWARD &&
    session.user.role !== Role.MANAGER
  ) {
    redirect(`/customers/${customer.id}`);
  }
  // Salesman scope check
  let routeOff = false;
  if (session.user.role === Role.SALESMAN) {
    const me = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { ownedRouteId: true, ownedRoute: { select: { isActive: true } } },
    });
    const onMyRoute = customer.branches.some((b) => b.routeId === me.ownedRouteId);
    if (!onMyRoute) redirect(`/customers/${customer.id}`);
    // Launch review: his route switched off refuses the submit
    // (services/edits.ts); say so before he fills the form. A draft still saves.
    routeOff = me.ownedRoute?.isActive === false;
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
  // SEC-H1: a MANAGER may only open the edit form for a customer in a region
  // they manage (fail-closed when they manage none). Without this an
  // out-of-region Manager could reach the form and submit a direct-write edit
  // to a customer outside their authority. Evaluated on the FULL branch set,
  // before filterBranchesByScope narrows it on the next line.
  if (
    session.user.role === Role.MANAGER &&
    !canEditCustomer(sessionUser, customer, scope)
  ) {
    redirect(`/customers/${customer.id}`);
  }
  customer.branches = filterBranchesByScope(sessionUser, customer.branches, scope);

  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
    include: { subChannels: { where: { isActive: true }, orderBy: { label: 'asc' } } },
  });

  // 2026-05-11: legalName lock is now independent of CR lock.
  //   - lockName  = always true for SALESMAN (any payment terms)
  //   - lockCr    = SALESMAN + CREDIT only
  const lockName = isFieldLocked('legalName', sessionUser, customer);
  const lockCr = isFieldLocked('crNumber', sessionUser, customer);

  // Existing pending edit?
  const pending = await prisma.customerEdit.findFirst({
    where: { customerId: customer.id, state: 'SUBMITTED' },
    select: {
      id: true,
      submittedAt: true,
      submittedById: true,
      target: true,
      isReactivation: true,
      submittedBy: { select: { fullName: true } },
    },
  });
  // Item 22: after a lost reply, reloading this page is how a salesman finds out
  // whether his submit landed. His own pending edit says so in those words.
  const pendingIsMine = pending?.submittedById === session.user.id;

  // Launch fix: his update of this customer that was sent back and that he has
  // neither sent again nor cleared (lib/returned-work.ts). The page always says
  // why. The form opens with what he sent filled in (./returned.ts) only when he
  // asks for it — the rows on Work and Needs correction link with ?returned=, and
  // the banner offers it. Filled in on every visit, a value he was told NOT to
  // send went back with the next unrelated edit he made.
  const [returnedId] = await openReturnedIds(prisma, session.user.id, {
    customerId: customer.id,
    updatesOnly: true,
    take: 1,
  });
  const returnedEdit = returnedId
    ? await prisma.customerEdit.findUnique({
        where: { id: returnedId },
        select: {
          fieldChanges: true,
          decisionReason: true,
          reviewedAt: true,
          reviewedBy: { select: { fullName: true } },
        },
      })
    : null;
  const fillIn = !!returnedEdit && asked === returnedId;
  const returned =
    returnedEdit && fillIn ? returnedPrefill(customer, returnedEdit.fieldChanges, { lockName, lockCr }) : null;

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

      {routeOff && (
        <div className="mx-4 mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 sm:mx-6">
          {ROUTE_INACTIVE_MESSAGE} You can save a draft, but you cannot submit it until the route is
          active again.
        </div>
      )}

      {returnedId && returnedEdit && (
        <div className="mx-4 mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 [overflow-wrap:anywhere] sm:mx-6">
          <p>
            <strong className="font-semibold">
              Sent back to you
              {returnedEdit.reviewedBy ? ` by ${returnedEdit.reviewedBy.fullName}` : ''}
              {returnedEdit.reviewedAt ? `, ${omanWhen(returnedEdit.reviewedAt)}` : ''}:
            </strong>{' '}
            {returnedEdit.decisionReason ?? 'Needs correction.'}
          </p>
          {returned ? (
            <>
              <p className="mt-1">
                What you sent is filled in below. Change what was asked, then submit again.
              </p>
              {returned.notFilled.length > 0 && (
                <p className="mt-1">
                  Not filled in, because it changed after you sent it: {returned.notFilled.join(', ')}.
                </p>
              )}
              <Link
                href={`/customers/${customer.id}/edit`}
                className="mt-1 inline-flex min-h-11 items-center font-medium underline underline-offset-2"
              >
                Start from the customer as it is
              </Link>
            </>
          ) : (
            <>
              <p className="mt-1">The form below shows the customer as it is now.</p>
              <Link
                href={`/customers/${customer.id}/edit?returned=${returnedId}`}
                className="mt-1 inline-flex min-h-11 items-center font-medium underline underline-offset-2"
              >
                Fill in what I sent
              </Link>
            </>
          )}
          <div className="mt-2">
            <ClearReturned editId={returnedId} then={`/customers/${customer.id}/edit`} />
          </div>
        </div>
      )}

      {pending && (
        <div className="mx-4 mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 sm:mx-6">
          {pendingIsMine ? (
            // Names what is waiting: his pending close is not "your changes".
            ownPendingBanner(pending)
          ) : (
            <>
              A submission is already pending review (by {pending.submittedBy.fullName}). You can
              save drafts but cannot submit until the supervisor decides.
            </>
          )}
        </div>
      )}

      <EnrichmentForm
        // A new form when he switches between what he sent and the customer as it is.
        key={returned ? `returned:${returnedId}` : 'live'}
        customer={customer}
        channels={channels}
        lockName={lockName}
        lockCr={lockCr}
        userRole={session.user.role}
        canSubmit={!pending && !routeOff}
        submitHeldTitle={routeOff ? ROUTE_INACTIVE_MESSAGE : undefined}
        // A reactivation replaces the draft too, when it turns the customer
        // ACTIVE (item 22 review) — the rule lives in the helper.
        pendingReplacesDraft={pendingReplacesDraft(pending ? requestKindOf(pending) : null, customer.status)}
        sessionUserId={session.user.id}
        gate={salesmanSubmitGate()}
        returned={returned && returnedId ? { id: returnedId, prefill: returned.state } : undefined}
      />
    </main>
  );
}
