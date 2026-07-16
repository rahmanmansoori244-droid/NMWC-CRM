import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CreateCustomerForm, type CreateFormInitial } from './CreateCustomerForm';

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
  if (editParam) {
    const edit = await prisma.customerEdit.findUnique({
      where: { id: editParam },
      include: {
        customerDraft: true,
        branchDrafts: { orderBy: { id: 'asc' } },
      },
    });
    // Ownership: a create request is private to its submitter.
    if (!edit || edit.process !== 'CREATE' || edit.submittedById !== session.user.id) {
      notFound();
    }
    if (edit.state === 'APPROVED' && edit.customerId) {
      redirect(`/customers/${edit.customerId}`);
    }
    const guarantees = await prisma.attachment.findMany({
      where: { editId: edit.id, kind: 'GUARANTEE', deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const d = edit.customerDraft;
    // Liveness-filter every draft photo column, like the guarantee query
    // above: the draft columns are bare strings, and photo-gc's stale-claim
    // sweep soft-deletes the photos of long-idle requests without touching
    // the drafts. Passing a dead id through would render a filled-looking
    // slot over a 404 image and dead-end both submit AND draft save on a
    // generic "photo no longer exists" — filtered out, the slot renders
    // empty and the mandatory gate names exactly what to re-capture.
    const draftPhotoIds = [
      ...(d?.crPhotoAttachmentId ? [d.crPhotoAttachmentId] : []),
      ...edit.branchDrafts.flatMap((b) => [
        ...(b.shopPhotoAttachmentId ? [b.shopPhotoAttachmentId] : []),
        ...(b.signboardPhotoAttachmentId ? [b.signboardPhotoAttachmentId] : []),
        ...(Array.isArray(b.extraPhotoAttachmentIds)
          ? (b.extraPhotoAttachmentIds as string[])
          : []),
      ]),
    ];
    const liveDraftPhotos = draftPhotoIds.length
      ? await prisma.attachment.findMany({
          where: { id: { in: draftPhotoIds }, deletedAt: null },
          select: { id: true },
        })
      : [];
    const livePhotoIds = new Set(liveDraftPhotos.map((a) => a.id));
    const liveOrNull = (id: string | null) => (id && livePhotoIds.has(id) ? id : null);
    initial = {
      editId: edit.id,
      state: edit.state,
      decisionReason: edit.decisionReason,
      pendingRole: edit.pendingRole,
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
        crPhotoAttachmentId: liveOrNull(d?.crPhotoAttachmentId ?? null),
      },
      credit: {
        requestedCreditLimit:
          edit.requestedCreditLimit != null ? Number(edit.requestedCreditLimit) : null,
        requestedPaymentTermDays: edit.requestedPaymentTermDays,
      },
      guaranteeAttachmentIds: guarantees.map((g) => g.id),
      branches: edit.branchDrafts.map((b) => ({
        branchName: b.branchName,
        address: b.address === '(address pending)' ? '' : b.address,
        areaDescription: b.areaDescription ?? '',
        gpsLat: b.gpsLat,
        gpsLng: b.gpsLng,
        gpsAccuracy: b.gpsAccuracy,
        gpsCapturedAt: b.gpsCapturedAt ? b.gpsCapturedAt.toISOString() : null,
        dayOfVisit: b.dayOfVisit,
        openingHours: b.openingHours ?? '',
        deliveryWindow: b.deliveryWindow ?? '',
        coolersCount: b.coolersCount,
        standsCount: b.standsCount,
        emptyBottlesCount: b.emptyBottlesCount,
        shopPhotoAttachmentId: liveOrNull(b.shopPhotoAttachmentId),
        signboardPhotoAttachmentId: liveOrNull(b.signboardPhotoAttachmentId),
        extraPhotoAttachmentIds: (Array.isArray(b.extraPhotoAttachmentIds)
          ? (b.extraPhotoAttachmentIds as string[])
          : []
        ).filter((id) => livePhotoIds.has(id)),
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
        />
      )}
    </main>
  );
}
