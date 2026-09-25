import { notFound, redirect } from 'next/navigation';
import { LocationLinks, PhoneLink } from '@/components/nmwc/ContactLinks';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { parseChain } from '@/lib/approval-chains';
import { manualGpsReasonForBranch, manualGpsReasonForPoint } from '@/lib/gps-manual';
import { AlertTriangle } from 'lucide-react';
import { ApproveRejectActions } from './ApproveRejectActions';

export const metadata = { title: 'Approval · NMWC' };

type FieldChange = { field: string; before: unknown; after: unknown };

const APPROVER_ROLES: Role[] = [
  Role.SUPERVISOR,
  Role.MANAGER,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
  Role.GM,
];

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!APPROVER_ROLES.includes(session.user.role)) {
    redirect('/home');
  }
  const { id } = await params;

  const edit = await prisma.customerEdit.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          legalName: true,
          nmwcCode: true,
          // Go-live review: photos are attached LIVE (outside fieldChanges), so a
          // reviewer of an enrichment edit must see the customer's CURRENT photo
          // slots + GPS to judge it — the diff alone shows only text fields.
          crPhotoId: true,
          branches: {
            select: {
              id: true,
              branchName: true,
              branchCode: true,
              address: true,
              gpsLat: true,
              gpsLng: true,
              gpsAccuracy: true,
              gpsCapturedAt: true,
              shopPhotoId: true,
              signboardPhotoId: true,
              routeId: true,
              regionId: true,
              deletedAt: true,
              route: { select: { code: true } },
            },
          },
        },
      },
      submittedBy: { select: { id: true, fullName: true, supervisorId: true } },
      reviewedBy: { select: { fullName: true } },
      // Phase 1 creation flow: the CREATE payload lives in typed drafts.
      customerDraft: {
        include: {
          channel: { select: { label: true } },
          subChannel: { select: { label: true } },
        },
      },
      branchDrafts: {
        include: {
          region: { select: { name: true } },
          route: { select: { code: true, regionId: true } }, // final-hunt #7/#15: current region for visibility
        },
      },
      // Per-step decision history for the chain timeline.
      steps: {
        orderBy: { at: 'asc' },
        include: { actor: { select: { fullName: true } } },
      },
    },
  });
  if (!edit) notFound();

  const isCreate = edit.process === 'CREATE';

  // Supervisor can only see their own team's requests.
  if (session.user.role === Role.SUPERVISOR && edit.submittedBy.supervisorId !== session.user.id) {
    notFound(); // hide existence — same posture as other scope misses
  }
  const { loadScope, filterBranchesByScope } = await import('@/lib/access');
  const scope = await loadScope(session.user.id);
  // RBAC-05-003 / Phase 1: MANAGER and ACCOUNTANT region scope on the detail
  // page too — a deep link must not show another region's request. For CREATE
  // the scope regions come from the DRAFT branches (customerId is null).
  if (session.user.role === Role.MANAGER || session.user.role === Role.ACCOUNTANT) {
    const regionIds = isCreate
      ? edit.branchDrafts.map((b) => b.route.regionId) // final-hunt #7/#15: current route region
      : (edit.customer?.branches ?? []).filter((b) => !b.deletedAt).map((b) => b.regionId);
    const inScope = regionIds.some((r) => scope.managedRegionIds.includes(r));
    if (!inScope) notFound();
  }
  // FINANCE_MANAGER / GM are org-wide approvers (owner-confirmed) — no region gate.

  // Live photo slots + GPS of the customer under review (UPDATE only). Branches
  // are narrowed to the reviewer's scope (RBAC-05-001 posture: a multi-region
  // customer must not leak another region's photos to a regional Manager).
  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  const liveBranches = isCreate
    ? []
    : filterBranchesByScope(sessionUser, edit.customer?.branches ?? [], scope);
  const extraPhotos =
    liveBranches.length > 0
      ? await prisma.attachment.findMany({
          where: { branchExtraId: { in: liveBranches.map((b) => b.id) }, deletedAt: null },
          select: { id: true, branchExtraId: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];

  const chain = parseChain(edit.approvalChain);
  const isPending = edit.state === 'SUBMITTED';
  const displayName = isCreate
    ? (edit.customerDraft?.legalName ?? '—')
    : (edit.customer?.legalName ?? '—');
  const subtitleCode = isCreate ? 'New customer request' : edit.customer?.nmwcCode;

  // UPDATE diff payload (empty for CREATE — its payload is the drafts).
  const changes = isCreate ? [] : ((edit.fieldChanges as unknown as FieldChange[]) ?? []);
  const customerChanges = changes.filter((c) => c.field.startsWith('customer.'));
  const branchChangesByBranch = new Map<string, FieldChange[]>();
  for (const c of changes) {
    if (c.field.startsWith('branch.')) {
      const rest = c.field.slice('branch.'.length);
      const dot = rest.indexOf('.');
      if (dot < 0) continue;
      const branchId = rest.slice(0, dot);
      const list = branchChangesByBranch.get(branchId) ?? [];
      list.push({ ...c, field: rest.slice(dot + 1) });
      branchChangesByBranch.set(branchId, list);
    }
  }

  // Resolve branch names for the UPDATE diff sections
  const branchIds = [...branchChangesByBranch.keys()];
  const branches = branchIds.length
    ? await prisma.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, branchName: true, route: { select: { code: true } } },
      })
    : [];
  const branchMap = new Map(branches.map((b) => [b.id, b]));

  // Channel / sub-channel diffs carry cuids; reviewers need the labels.
  const refIds = changes
    .filter((c) => c.field.endsWith('channelId') || c.field.endsWith('subChannelId'))
    .flatMap((c) => [c.before, c.after])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const [channelRefs, subChannelRefs] = refIds.length
    ? await Promise.all([
        prisma.channel.findMany({ where: { id: { in: refIds } }, select: { id: true, label: true } }),
        prisma.subChannel.findMany({
          where: { id: { in: refIds } },
          select: { id: true, label: true },
        }),
      ])
    : [[], []];
  const refLabel = new Map<string, string>([
    ...channelRefs.map((c) => [c.id, c.label] as const),
    ...subChannelRefs.map((s) => [s.id, s.label] as const),
  ]);
  const display = (field: string, v: unknown): unknown =>
    (field.endsWith('channelId') || field.endsWith('subChannelId')) &&
    typeof v === 'string' &&
    refLabel.has(v)
      ? refLabel.get(v)
      : v;
  /** Proposed GPS per branch (after-values), for a "view on map" link. */
  const proposedGps = (list: FieldChange[]): { lat: number; lng: number } | null => {
    const lat = list.find((c) => c.field === 'gpsLat')?.after;
    const lng = list.find((c) => c.field === 'gpsLng')?.after;
    return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
  };

  // Guarantee documents (CREATE-CREDIT): edit-claimed GUARANTEE attachments.
  const guaranteeDocs = isCreate
    ? await prisma.attachment.findMany({
        where: { editId: edit.id, kind: 'GUARANTEE', deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  const draft = edit.customerDraft;
  const isCredit = isCreate && draft?.paymentTerms === 'CREDIT';

  return (
    <main className="pb-24">
      <PageHeader
        title={displayName}
        subtitle={`${subtitleCode} · submitted by ${edit.submittedBy.fullName}${edit.submittedAt ? ' · ' + new Date(edit.submittedAt).toLocaleString('en-GB') : ''}`}
        actions={
          edit.customerId ? (
            <Link
              href={`/customers/${edit.customerId}`}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Open profile
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {!isPending && (
          <div
            className={`rounded-md px-3 py-2 text-sm font-medium ring-1 ring-inset [overflow-wrap:anywhere] ${
              edit.state === 'APPROVED'
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-amber-50 text-amber-800 ring-amber-200'
            }`}
          >
            Decision: <strong>{edit.state}</strong>
            {edit.reviewedBy ? ` by ${edit.reviewedBy.fullName}` : ''}
            {edit.reviewedAt ? ` on ${new Date(edit.reviewedAt).toLocaleString('en-GB')}` : ''}
            {edit.decisionReason ? (
              <p className="mt-1 italic">&ldquo;{edit.decisionReason}&rdquo;</p>
            ) : null}
          </div>
        )}

        {/* Chain progress — which step this request is on, and every decision
            taken so far (append-only EditApproval history). */}
        {chain.length > 0 && (
          <section className={SECTION}>
            <header className="border-b border-slate-200 bg-slate-50 px-4 py-2">
              <h2 className="text-sm font-semibold text-slate-700">Approval chain</h2>
            </header>
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs">
              {chain.map((s, i) => {
                const isCurrent = isPending && i === edit.currentStepIndex;
                const isPast = edit.state === 'APPROVED' || i < edit.currentStepIndex;
                return (
                  <span key={i} className="flex items-center gap-2">
                    {i > 0 && <span className="text-slate-300">→</span>}
                    <span
                      className={`rounded-full px-2.5 py-1 font-semibold ${
                        isCurrent
                          ? 'bg-brand-600 text-white'
                          : isPast
                            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                            : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {s.role.replace('_', ' ')}
                    </span>
                  </span>
                );
              })}
            </div>
            {edit.steps.length > 0 && (
              <ul className="divide-y divide-slate-100 border-t border-slate-100 text-xs">
                {edit.steps.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-col gap-0.5 px-4 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                  >
                    <span className="min-w-0">
                      <strong
                        className={s.decision === 'APPROVED' ? 'text-emerald-700' : 'text-red-700'}
                      >
                        {s.decision}
                      </strong>{' '}
                      at {s.role.replace('_', ' ')} step by {s.actor.fullName}
                      {s.reason ? <em className="text-slate-600"> — “{s.reason}”</em> : null}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      {new Date(s.at).toLocaleString('en-GB')}
                      {s.cycle > 1 ? ` · round ${s.cycle}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ── CREATE request: proposed customer + branches from the drafts ── */}
        {isCreate && draft && (
          <>
            <DetailSection title={`New ${draft.paymentTerms} customer`}>
              <DetailRow label="Legal name" value={draft.legalName} />
              <DetailRow label="CR number" value={draft.crNumber} />
              <DetailRow
                label="Channel"
                value={
                  draft.channel
                    ? `${draft.channel.label}${draft.subChannel ? ' / ' + draft.subChannel.label : ''}`
                    : null
                }
              />
              <DetailRow
                label="Primary phone"
                value={draft.primaryPhone ? <PhoneLink phone={draft.primaryPhone} /> : null}
              />
              <DetailRow
                label="Alt phone"
                value={draft.altPhone ? <PhoneLink phone={draft.altPhone} /> : null}
              />
              <DetailRow
                label="Contact"
                value={
                  draft.contactPerson
                    ? `${draft.contactPerson}${draft.contactRole ? ' (' + draft.contactRole + ')' : ''}`
                    : null
                }
              />
              <DetailRow label="Notes" value={draft.notes} />
              {draft.crPhotoAttachmentId && (
                <PhotoRow label="CR document" ids={[draft.crPhotoAttachmentId]} />
              )}
            </DetailSection>

            {isCredit && (
              <DetailSection title="Credit application (requested — approve or reject, no amendment)">
                <DetailRow
                  label="Credit limit"
                  value={
                    edit.requestedCreditLimit != null
                      ? `OMR ${Number(edit.requestedCreditLimit).toFixed(3)}`
                      : null
                  }
                />
                <DetailRow
                  label="Payment term"
                  value={
                    edit.requestedPaymentTermDays != null
                      ? `${edit.requestedPaymentTermDays} days`
                      : null
                  }
                />
                <PhotoRow
                  label={`Guarantee documents (${guaranteeDocs.length})`}
                  ids={guaranteeDocs.map((g) => g.id)}
                />
              </DetailSection>
            )}

            {edit.branchDrafts.map((b, i) => {
              const extras = Array.isArray(b.extraPhotoAttachmentIds)
                ? (b.extraPhotoAttachmentIds as string[])
                : [];
              const photoIds = [
                ...(b.shopPhotoAttachmentId ? [b.shopPhotoAttachmentId] : []),
                ...(b.signboardPhotoAttachmentId ? [b.signboardPhotoAttachmentId] : []),
                ...extras,
              ];
              return (
                <DetailSection
                  key={b.id}
                  title={`Branch ${i + 1}: ${b.branchName} (${b.region.name} · ${b.route.code})`}
                >
                  <DetailRow label="Address" value={b.address} />
                  <DetailRow label="Landmark" value={b.areaDescription} />
                  <DetailRow
                    label="GPS"
                    value={
                      b.gpsLat != null && b.gpsLng != null ? (
                        <span className="flex flex-col items-start gap-2">
                          <span className="font-mono">
                            {`${b.gpsLat.toFixed(5)}, ${b.gpsLng.toFixed(5)}${b.gpsAccuracy != null ? ` (±${Math.round(b.gpsAccuracy)}m)` : ''}`}
                          </span>
                          <LocationLinks lat={b.gpsLat} lng={b.gpsLng} />
                          <ManualGpsNote reason={manualGpsReasonForPoint(edit.fieldChanges, b.gpsLat, b.gpsLng)} />
                        </span>
                      ) : null
                    }
                  />
                  <DetailRow label="Day of visit" value={b.dayOfVisit} />
                  <DetailRow label="Opening hours" value={b.openingHours} />
                  <DetailRow label="Delivery window" value={b.deliveryWindow} />
                  <DetailRow
                    label="Equipment"
                    value={`${b.coolersCount} coolers · ${b.standsCount} stands · ${b.emptyBottlesCount} empty bottles`}
                  />
                  {photoIds.length > 0 && <PhotoRow label="Photos" ids={photoIds} />}
                </DetailSection>
              );
            })}
          </>
        )}

        {/* ── UPDATE edit: before/after diff of the live customer ── */}
        {!isCreate && customerChanges.length > 0 && (
          <DiffSection title="Customer">
            {customerChanges.map((c) => (
              <DiffRow
                key={c.field}
                label={c.field.replace('customer.', '')}
                before={display(c.field, c.before)}
                after={display(c.field, c.after)}
                phone={c.field === 'customer.primaryPhone' || c.field === 'customer.altPhone'}
              />
            ))}
          </DiffSection>
        )}

        {!isCreate &&
          [...branchChangesByBranch.entries()].map(([branchId, list]) => {
            const b = branchMap.get(branchId);
            const gps = proposedGps(list);
            const manualReason = manualGpsReasonForBranch(edit.fieldChanges, branchId);
            return (
              <DiffSection
                key={branchId}
                title={`Branch: ${b?.branchName ?? branchId} (${b?.route.code ?? ''})`}
              >
                {list.map((c) => (
                  <DiffRow
                    key={c.field}
                    label={c.field}
                    before={display(c.field, c.before)}
                    after={display(c.field, c.after)}
                  />
                ))}
                {gps && (
                  <div className="px-4 py-2.5 text-sm">
                    <LocationLinks lat={gps.lat} lng={gps.lng} pinLabel="View proposed location on map" />
                  </div>
                )}
                {manualReason && (
                  <div className="px-4 pb-2.5">
                    <ManualGpsNote reason={manualReason} />
                  </div>
                )}
              </DiffSection>
            );
          })}

        {/* Live evidence: what the customer looks like RIGHT NOW. Photos are
            wired at capture time (not inside the edit), so this is what an
            approval will lock in — the EL-04 gate re-checks these same slots. */}
        {!isCreate && edit.customer && (
          <DetailSection title="Photos & location on file (current)">
            <PhotoRow
              label="CR document"
              ids={edit.customer.crPhotoId ? [edit.customer.crPhotoId] : []}
              emptyText="No CR document photo yet"
            />
            {liveBranches.map((b) => {
              const extras = extraPhotos.filter((p) => p.branchExtraId === b.id).map((p) => p.id);
              return (
                <div key={b.id} className="divide-y divide-slate-100">
                  <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {b.branchName} · {b.branchCode} · {b.route.code}
                  </div>
                  <PhotoRow
                    label="Shop front"
                    ids={b.shopPhotoId ? [b.shopPhotoId] : []}
                    emptyText="No shop photo yet"
                  />
                  <PhotoRow
                    label="Signboard"
                    ids={b.signboardPhotoId ? [b.signboardPhotoId] : []}
                    emptyText="No signboard photo yet"
                  />
                  {extras.length > 0 && <PhotoRow label="Other photos" ids={extras} />}
                  <div className={ROW}>
                    <div className="font-medium text-slate-600">Location on file</div>
                    <div className="text-slate-900">
                      {b.gpsLat != null && b.gpsLng != null ? (
                        <>
                          <span className="font-mono">
                            {b.gpsLat.toFixed(5)}, {b.gpsLng.toFixed(5)}
                          </span>
                          {b.gpsAccuracy != null ? ` (±${Math.round(b.gpsAccuracy)}m)` : ''}
                          {b.gpsCapturedAt
                            ? ` · captured ${new Date(b.gpsCapturedAt).toLocaleString('en-GB')}`
                            : ''}
                          <span className="mt-2 block">
                            <LocationLinks lat={b.gpsLat} lng={b.gpsLng} pinLabel="Open in Google Maps" />
                          </span>
                        </>
                      ) : (
                        <span className="text-slate-500">No GPS on file</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </DetailSection>
        )}

        {!isCreate && changes.length === 0 && (
          <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">
            No field changes were captured on this edit.
          </p>
        )}
      </div>

      {isPending && (
        // No negative margin: this bar is a child of <main>, which has no horizontal
        // padding to cancel, so `-mx-4 sm:-mx-6` made it wider than the screen — a
        // sideways scroll on every phone and a 24px scrollbar on desktop (item 37).
        <div className="sticky bottom-0 mt-4 border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:p-6">
          <ApproveRejectActions editId={edit.id} />
        </div>
      )}
    </main>
  );
}

/**
 * Benchmark item 37 — this screen broke on a phone. Two rules, measured at 360px:
 *
 * ROW: label above value on a phone, the old two columns from 640px (sm). The
 * value track is minmax(0,1fr), never a bare `1fr`: a bare 1fr track has an
 * `auto` minimum, so its longest unbreakable word (a phone number, an ISO date,
 * a URL) sized the column and pushed the After column and Approve off-screen.
 * `break-words` does not help there — it does not lower the minimum width.
 *
 * SECTION: `[overflow-wrap:anywhere]`, inherited by everything inside, is what
 * actually lets an unbreakable token wrap; `break-words` left the page 425–483px.
 */
const ROW = 'grid grid-cols-1 gap-1 px-4 py-2.5 text-sm sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-3';
const SECTION =
  'overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200 [overflow-wrap:anywhere]';

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={SECTION}>
      <header className="border-b border-slate-200 bg-slate-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </header>
      <div className="divide-y divide-slate-100">{children}</div>
    </section>
  );
}

/**
 * Item 41: the salesman typed this point in because GPS did not work. Said
 * plainly, with their reason, where the approver looks at the location — bulk
 * approval shows a pill for the same thing on the queue card.
 */
function ManualGpsNote({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-sm text-amber-900 ring-1 ring-amber-200">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span className="font-semibold">Location typed in by hand.</span> GPS did not work: “{reason}”
      </span>
    </p>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className={ROW}>
      <div className="font-medium text-slate-600">{label}</div>
      <div className="break-words text-slate-900">{value}</div>
    </div>
  );
}

/** Photo thumbnails streamed through the scope-checked /api/photos route. */
function PhotoRow({
  label,
  ids,
  emptyText,
}: {
  label: string;
  ids: string[];
  /** When given, render a "missing" row instead of nothing for an empty slot. */
  emptyText?: string;
}) {
  if (ids.length === 0) {
    if (!emptyText) return null;
    return (
      <div className={ROW}>
        <div className="font-medium text-slate-600">{label}</div>
        <div className="text-slate-500">{emptyText}</div>
      </div>
    );
  }
  return (
    <div className={ROW}>
      <div className="font-medium text-slate-600">{label}</div>
      <div className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <a key={id} href={`/api/photos/${id}`} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/photos/${id}`}
              alt={label}
              className="h-20 w-20 rounded-md object-cover ring-1 ring-slate-200"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={SECTION}>
      <header className="border-b border-slate-200 bg-slate-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </header>
      <div className="divide-y divide-slate-100">{children}</div>
    </section>
  );
}

function DiffRow({
  label,
  before,
  after,
  phone,
}: {
  label: string;
  before: unknown;
  after: unknown;
  /** The values are phone numbers: render them tap-to-call (item 40). */
  phone?: boolean;
}) {
  const show = (v: unknown) =>
    phone && typeof v === 'string' && v ? <PhoneLink phone={v} /> : formatValue(v);
  return (
    // Label on its own line, Before/After side by side on a phone; the old
    // three columns from 640px. minmax(0,1fr), never a bare 1fr (see ROW).
    <div className="grid grid-cols-2 gap-2 px-4 py-3 text-sm sm:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
      <div className="col-span-2 font-medium text-slate-600 sm:col-span-1">{label}</div>
      <div className="rounded-md bg-red-50 px-2 py-1 text-red-700 ring-1 ring-red-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">Before</div>
        <div className="break-words">{show(before)}</div>
      </div>
      <div className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 ring-1 ring-emerald-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">After</div>
        <div className="break-words">{show(after)}</div>
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toLocaleString('en-GB');
  return JSON.stringify(v);
}
