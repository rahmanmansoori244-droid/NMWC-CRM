import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { manualGpsReasonForPoint } from '@/lib/gps-manual';
import { CreateCustomerForm, type CreateFormInitial } from './CreateCustomerForm';
import { WithdrawRequest } from './WithdrawRequest';
import { SignedFormUpload } from './SignedFormUpload';
import { isSignedFormStep, parseChain, stepName } from '@/lib/approval-chains';
import { decisionBoundWhere, decisionTokenFor } from '@/lib/decision-token';
import { CREDIT_DOCUMENT_KINDS, SIGNED_FORM_KIND, type CreditDocumentKind } from '@/lib/credit-documents';
import { minutesRemaining } from '@/lib/working-hours';
import { omanDateTime } from '@/lib/tz';
import { DECISION_TRAIL, currentReason, type SendBack } from '@/lib/request-reasons';
import { EarlierSendBacks, SendBackWho } from '@/components/nmwc/SendBackTrail';

export const metadata = { title: 'New customer · NMWC' };
// UXI-005 posture: never serve a stale cached form (same as the edit page).
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Owner-confirmed: only a Salesman initiates a create request (the
  // Steward's lane is the import; Manager/Steward direct-write is UPDATE-only).
  if (session.user.role !== Role.SALESMAN) redirect('/customers');

  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: {
      id: true,
      ownedRoute: {
        select: { id: true, code: true, isActive: true, region: { select: { name: true } } },
      },
    },
  });

  const { edit: editParam } = await searchParams;

  // Resume an existing request (draft / needs-correction / submitted status view).
  let initial: CreateFormInitial | null = null;
  // Security review: the route(s) a draft or sent-back request was started on,
  // when he has since moved off them. services/creates.ts refuses to save or
  // send it again; the page says why, shows it read-only, and keeps Withdraw.
  let startedOn: string | null = null;
  // Owner decisions 2026-10-11: his request waiting at the signed-application step.
  let signedForm: {
    editId: string;
    decisionToken: string;
    keptPageIds: string[];
    dueText: string | null;
    overdue: boolean;
    sentBackReason: string | null;
  } | null = null;
  // Finding 18: why the request is back with him, read from its decisions
  // (EditApproval) — the latest send-back of the round with who, at which step
  // and when, and the ones before it. He cannot open the approver's page, so
  // this page is where he reads an Accountant's reason a Manager relayed.
  let sentBack: { latest: SendBack; earlier: SendBack[] } | null = null;
  // At the signed-application step: what was said before the Finance Manager's send-back.
  let relayedBefore: SendBack[] = [];
  if (editParam) {
    const edit = await prisma.customerEdit.findUnique({
      where: { id: editParam },
      include: {
        customerDraft: true,
        branchDrafts: { orderBy: { id: 'asc' }, include: { route: { select: { code: true } } } },
        // The one trail every reason on this page is read from (lib/request-reasons.ts).
        steps: DECISION_TRAIL,
        // A request sent back before decisions were recorded names its reviewer here only.
        reviewedBy: { select: { fullName: true } },
      },
    });
    // Ownership: a create request is private to its submitter.
    if (!edit || edit.process !== 'CREATE' || edit.submittedById !== session.user.id) {
      notFound();
    }
    if (edit.state === 'APPROVED' && edit.customerId) {
      redirect(`/customers/${edit.customerId}`);
    }
    const chain = parseChain(edit.approvalChain);
    const atSignedForm = edit.state === 'SUBMITTED' && isSignedFormStep(chain[edit.currentStepIndex]);
    // Nothing is current on a request moving forward or approved; a withdrawn
    // one says so on the form. Never from decisionReason alone on a row that has
    // decisions: an earlier round or step may have left it.
    const reason = currentReason(edit, edit.steps);
    if (reason?.kind === 'SENT_BACK') sentBack = { latest: reason.latest, earlier: reason.earlier };
    // At the signed-application step too (owner decisions 2026-10-11): the
    // signed form is refused from a route he has left, as a resubmit is.
    if (me.ownedRoute && (edit.state === 'DRAFT' || edit.state === 'NEEDS_CORRECTION' || atSignedForm)) {
      const myRouteId = me.ownedRoute.id;
      const elsewhere = new Set(
        edit.branchDrafts.filter((b) => b.routeId !== myRouteId).map((b) => b.route.code)
      );
      if (elsewhere.size > 0) startedOn = [...elsewhere].join(', ');
    }
    // The documents on file, by kind: the guarantees, and (owner decisions
    // 2026-10-11) each credit document's pages — oldest first, as they were taken.
    const docs = await prisma.attachment.findMany({
      where: { editId: edit.id, kind: { in: ['GUARANTEE', ...CREDIT_DOCUMENT_KINDS] }, deletedAt: null },
      select: { id: true, kind: true },
      orderBy: { createdAt: 'asc' },
    });
    const docsOf = (kind: string) => docs.filter((a) => a.kind === kind).map((a) => a.id);
    if (atSignedForm) {
      // The documents his confirm is bound to, read by the server's own rule
      // (lib/decision-token.ts), and the pages an earlier upload left on file.
      const bound = await prisma.attachment.findMany({
        where: decisionBoundWhere(edit.id),
        select: { id: true, kind: true },
        orderBy: { createdAt: 'asc' },
      });
      // The Finance Manager's reason: the latest decision of this round, when it
      // is his send-back to this step — never decisionReason, which an earlier
      // round or step may have left.
      const returnedHere =
        reason?.kind === 'RETURNED_TO_STEP' && reason.latest.stepIndex === edit.currentStepIndex + 1 ? reason : null;
      relayedBefore = returnedHere?.earlier ?? [];
      signedForm = {
        editId: edit.id,
        decisionToken: decisionTokenFor(
          edit,
          bound.map((b) => b.id)
        ),
        keptPageIds: bound.filter((b) => b.kind === SIGNED_FORM_KIND).map((b) => b.id),
        dueText: edit.slaDueAt ? omanDateTime(edit.slaDueAt) : null,
        overdue: edit.slaDueAt ? minutesRemaining(edit.slaDueAt) < 0 : false,
        sentBackReason: returnedHere ? returnedHere.latest.reason : null,
      };
    }
    const d = edit.customerDraft;
    initial = {
      editId: edit.id,
      state: edit.state,
      // Finding 18: the reason is shown by this page, above the form, from the
      // decision rows — with who sent it back, at which step, and the earlier
      // reasons of the round. The form's own one-line banner is never fed.
      decisionReason: null,
      // The step in words (lib/approval-chains.ts stepName): "Sales Director",
      // "Signed application" — never the enum the form would print.
      pendingRole: edit.pendingRole ? stepName(edit.pendingRole) : null,
      customer: {
        legalName: d?.legalName ?? '',
        paymentTerms: d?.paymentTerms ?? 'CASH',
        crNumber: d?.crNumber ?? '',
        channelId: d?.channelId ?? '',
        subChannelId: d?.subChannelId ?? '',
        primaryPhone: d?.primaryPhone ?? '',
        altPhone: d?.altPhone ?? '',
        contactPerson: d?.contactPerson ?? '',
        contactRole: d?.contactRole ?? '',
        notes: d?.notes ?? '',
        crPhotoAttachmentId: d?.crPhotoAttachmentId ?? null,
        email: d?.email ?? '',
      },
      credit: {
        requestedCreditLimit:
          edit.requestedCreditLimit != null ? Number(edit.requestedCreditLimit) : null,
        requestedPaymentTermDays: edit.requestedPaymentTermDays,
      },
      guaranteeAttachmentIds: docsOf('GUARANTEE'),
      creditDocuments: Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, docsOf(k)])) as Record<
        CreditDocumentKind,
        string[]
      >,
      branches: edit.branchDrafts.map((b) => ({
        branchName: b.branchName,
        address: b.address === '(address pending)' ? '' : b.address,
        areaDescription: b.areaDescription ?? '',
        gpsLat: b.gpsLat,
        gpsLng: b.gpsLng,
        gpsAccuracy: b.gpsAccuracy,
        gpsCapturedAt: b.gpsCapturedAt ? b.gpsCapturedAt.toISOString() : null,
        gpsManualReason: manualGpsReasonForPoint(edit.fieldChanges, b.gpsLat, b.gpsLng),
        dayOfVisit: b.dayOfVisit,
        openingHours: b.openingHours ?? '',
        deliveryWindow: b.deliveryWindow ?? '',
        coolersCount: b.coolersCount,
        standsCount: b.standsCount,
        emptyBottlesCount: b.emptyBottlesCount,
        shopPhotoAttachmentId: b.shopPhotoAttachmentId,
        signboardPhotoAttachmentId: b.signboardPhotoAttachmentId,
        extraPhotoAttachmentIds: Array.isArray(b.extraPhotoAttachmentIds)
          ? (b.extraPhotoAttachmentIds as string[])
          : [],
      })),
    };
  }

  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
    include: { subChannels: { where: { isActive: true }, orderBy: { label: 'asc' } } },
  });

  const routeLabel = me.ownedRoute
    ? `${me.ownedRoute.region.name} · ${me.ownedRoute.code}`
    : null;

  return (
    <main className="pb-24">
      <PageHeader
        title={initial ? (initial.customer.legalName || 'New customer') : 'New customer'}
        subtitle={
          routeLabel
            ? `Register a new shop on your route (${routeLabel})`
            : 'Register a new shop'
        }
      />
      {startedOn && me.ownedRoute && (
        <div className="mx-4 mt-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 sm:mx-6 sm:mt-6">
          This request was started on route {startedOn}. You now work route {me.ownedRoute.code}, so
          it cannot be saved or sent again. Withdraw it at the bottom of this page, and the salesman
          of route {startedOn} adds the shop afresh.
        </div>
      )}
      {sentBack && (
        <div className="mx-4 mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200 [overflow-wrap:anywhere] sm:mx-6 sm:mt-6">
          <p>
            <strong className="font-semibold">Returned for correction:</strong>{' '}
            {sentBack.latest.reason ?? 'No reason was recorded.'}
          </p>
          <SendBackWho entry={sentBack.latest} when={omanDateTime} className="mt-1" />
          <EarlierSendBacks earlier={sentBack.earlier} when={omanDateTime} className="mt-2" />
        </div>
      )}
      {signedForm && me.ownedRoute?.isActive && !startedOn && (
        <>
          {/* What a Finance Manager's send-back was relaying (a GM's reason): the
              card below says his own. */}
          <EarlierSendBacks
            earlier={relayedBefore}
            when={omanDateTime}
            heading="Before that, in this round:"
            className="mx-4 mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 [overflow-wrap:anywhere] sm:mx-6 sm:mt-6"
          />
          <SignedFormUpload {...signedForm} />
        </>
      )}
      {!me.ownedRoute || !me.ownedRoute.isActive ? (
        <div className="m-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 sm:m-6">
          {me.ownedRoute
            ? 'Your route is inactive — ask your supervisor before registering new customers.'
            : 'You have no route assigned — ask your supervisor before registering new customers.'}
        </div>
      ) : (
        <CreateCustomerForm
          channels={channels}
          initial={initial}
          sessionUserId={session.user.id}
          startedOnOtherRoute={startedOn !== null}
        />
      )}
      {/* Launch fix: his own draft, or one sent back to him, can be withdrawn —
          an open request blocks its CR and shop for everyone. Not one in review,
          except at his own signed-application step (owner decisions 2026-10-11:
          the customer may not sign). */}
      {initial && (initial.state === 'DRAFT' || initial.state === 'NEEDS_CORRECTION' || signedForm) && (
        <WithdrawRequest
          editId={initial.editId}
          isDraft={initial.state === 'DRAFT'}
          atSignedForm={signedForm !== null}
        />
      )}
    </main>
  );
}
