import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { parseChain } from '@/lib/approval-chains';
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

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
          branches: { select: { regionId: true, deletedAt: true } },
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
          route: { select: { code: true } },
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
  if (
    session.user.role === Role.SUPERVISOR &&
    edit.submittedBy.supervisorId !== session.user.id
  ) {
    notFound(); // hide existence — same posture as other scope misses
  }
  // RBAC-05-003 / Phase 1: MANAGER and ACCOUNTANT region scope on the detail
  // page too — a deep link must not show another region's request. For CREATE
  // the scope regions come from the DRAFT branches (customerId is null).
  if (session.user.role === Role.MANAGER || session.user.role === Role.ACCOUNTANT) {
    const { loadScope } = await import('@/lib/access');
    const scope = await loadScope(session.user.id);
    const regionIds = isCreate
      ? edit.branchDrafts.map((b) => b.regionId)
      : (edit.customer?.branches ?? []).filter((b) => !b.deletedAt).map((b) => b.regionId);
    const inScope = regionIds.some((r) => scope.managedRegionIds.includes(r));
    if (!inScope) notFound();
  }
  // FINANCE_MANAGER / GM are org-wide approvers (owner-confirmed) — no region gate.

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
            className={`rounded-md px-3 py-2 text-sm font-medium ring-1 ring-inset ${
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
          <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
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
                  <li key={s.id} className="flex items-start justify-between gap-3 px-4 py-2">
                    <span>
                      <strong
                        className={
                          s.decision === 'APPROVED' ? 'text-emerald-700' : 'text-red-700'
                        }
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
              <DetailRow label="Primary phone" value={draft.primaryPhone} />
              <DetailRow label="Alt phone" value={draft.altPhone} />
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
                      b.gpsLat != null && b.gpsLng != null
                        ? `${b.gpsLat.toFixed(5)}, ${b.gpsLng.toFixed(5)}${b.gpsAccuracy != null ? ` (±${Math.round(b.gpsAccuracy)}m)` : ''}`
                        : null
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
                before={c.before}
                after={c.after}
              />
            ))}
          </DiffSection>
        )}

        {!isCreate &&
          [...branchChangesByBranch.entries()].map(([branchId, list]) => {
            const b = branchMap.get(branchId);
            return (
              <DiffSection key={branchId} title={`Branch: ${b?.branchName ?? branchId} (${b?.route.code ?? ''})`}>
                {list.map((c) => (
                  <DiffRow key={c.field} label={c.field} before={c.before} after={c.after} />
                ))}
              </DiffSection>
            );
          })}

        {!isCreate && changes.length === 0 && (
          <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">
            No field changes were captured on this edit.
          </p>
        )}
      </div>

      {isPending && (
        <div className="sticky bottom-0 -mx-4 mt-4 border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:-mx-6 sm:p-6">
          <ApproveRejectActions editId={edit.id} />
        </div>
      )}
    </main>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
      <header className="border-b border-slate-200 bg-slate-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </header>
      <div className="divide-y divide-slate-100">{children}</div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === '') return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2.5 text-sm">
      <div className="font-medium text-slate-600">{label}</div>
      <div className="break-words text-slate-900">{String(value)}</div>
    </div>
  );
}

/** Photo thumbnails streamed through the scope-checked /api/photos route. */
function PhotoRow({ label, ids }: { label: string; ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2.5 text-sm">
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
    <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
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
}: {
  label: string;
  before: unknown;
  after: unknown;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr_1fr] gap-3 px-4 py-3 text-sm">
      <div className="font-medium text-slate-600">{label}</div>
      <div className="rounded-md bg-red-50 px-2 py-1 text-red-700 ring-1 ring-red-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">Before</div>
        <div className="break-words">{formatValue(before)}</div>
      </div>
      <div className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 ring-1 ring-emerald-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">After</div>
        <div className="break-words">{formatValue(after)}</div>
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
