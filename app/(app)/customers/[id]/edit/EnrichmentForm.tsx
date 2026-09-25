'use client';

import { useCallback, useId, useState, useTransition, useEffect, useRef } from 'react';
import { Role, type CustomerStatus, type DayOfWeek, type PaymentTerms } from '@prisma/client';
import { FormSection } from '@/components/nmwc/FormSection';
import { surfaceUnrenderedErrors, enrichmentFormRendersError } from '@/lib/form-errors';
import { GpsCaptureButton, type Gps } from '@/components/nmwc/GpsCaptureButton';
import { StepperInput } from '@/components/nmwc/StepperInput';
import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';
import { postForm, noticeFor, SubmissionIds, type SubmitNotice } from '@/lib/submit-client';
import { PHOTO_UPLOADING_MESSAGE, type SubmitReceipt } from '@/lib/submission';
import { SubmitNoticeBox } from '@/components/nmwc/SubmitNoticeBox';
import { hardReplace } from '@/lib/navigate';
import { draftIsStale, enrichmentBase } from '@/lib/enrichment-draft';
import { isRequired, type SubmitGate } from '@/lib/submit-gate';
import { LabeledField as Field } from '@/components/nmwc/LabeledField';

type CustomerWithBranches = {
  id: string;
  nmwcCode: string;
  legalName: string;
  paymentTerms: PaymentTerms;
  crNumber: string | null;
  channelId: string | null;
  subChannelId: string | null;
  primaryPhone: string | null;
  altPhone: string | null;
  contactPerson: string | null;
  contactRole: string | null;
  status: CustomerStatus;
  notes: string | null;
  crPhotoId: string | null;
  // UXI-003: server-side updatedAt is the freshness anchor for the
  // localStorage draft restore. If the customer has been touched server-side
  // since the draft was saved we warn the user before overwriting the form.
  updatedAt: Date;
  branches: Array<{
    id: string;
    branchName: string;
    address: string;
    areaDescription: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    gpsAccuracy: number | null;
    gpsCapturedAt: Date | null;
    dayOfVisit: DayOfWeek | null;
    openingHours: string | null;
    deliveryWindow: string | null;
    coolersCount: number;
    standsCount: number;
    emptyBottlesCount: number;
    status: CustomerStatus;
    shopPhotoId: string | null;
    signboardPhotoId: string | null;
    region: { name: string };
    route: { code: string };
  }>;
};

type ChannelWithSubs = {
  id: string;
  key: string;
  label: string;
  subChannels: { id: string; key: string; label: string }[];
};

const DAYS: DayOfWeek[] = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'];

export function EnrichmentForm({
  customer,
  channels,
  lockName,
  lockCr,
  userRole,
  canSubmit,
  pendingReplacesDraft = false,
  sessionUserId,
  gate: gateProp,
}: {
  customer: CustomerWithBranches;
  channels: ChannelWithSubs[];
  /** Salesman cannot change legalName (always true for SALESMAN). */
  lockName: boolean;
  /** Salesman cannot change crNumber when customer is on CREDIT terms. */
  lockCr: boolean;
  userRole: Role;
  canSubmit: boolean;
  /**
   * Item 22: approving this customer's pending request changes the values this
   * draft started from, which then replaces the draft — a pending update, or a
   * reactivation of a customer that is not ACTIVE (pendingReplacesDraft in
   * lib/submission-replay.ts). False for a pending close, which leaves it alone.
   */
  pendingReplacesDraft?: boolean;
  // UXI-002: scope localStorage drafts by user. A shared device used by two
  // salesmen on the same customer would otherwise inject one user's typing
  // into the other's session.
  sessionUserId: string;
  /** Which fields block a salesman's submit (FULL / CORE) — see lib/submit-gate.ts. */
  gate?: SubmitGate;
}) {
  const gate: SubmitGate = gateProp ?? 'FULL';
  const req = (field: string) => isRequired(field, gate);
  const star = (field: string) => (req(field) ? ' *' : '');
  // UAT-07: one id prefix per form instance, so the labels on the inline
  // selects can point at their controls. Branch rows append their own key.
  const uid = useId();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<string | null>(null);
  // UXI-004: synchronous lock so a rapid double-tap on Submit never fires the
  // server action twice. `pending` from useTransition flips asynchronously.
  const submitLockRef = useRef(false);
  // Item 22: what happened to the last submit, said beside the button; the
  // submission ids that make a retry safe; and which button the retry repeats.
  const [notice, setNotice] = useState<SubmitNotice | null>(null);
  const idsRef = useRef<SubmissionIds | null>(null);
  const lastWasDraftRef = useRef(false);
  // Set when a retry learns the submit had already arrived: nothing to send.
  const [arrived, setArrived] = useState(false);
  // Item 22: the server values this form started from. The phone draft is stale
  // only when these change on the server — not when a photo bumps updatedAt.
  const baseRef = useRef<string | null>(null);
  if (baseRef.current === null) baseRef.current = enrichmentBase(customer);

  // Customer-level state
  const [legalName, setLegalName] = useState(customer.legalName);
  const [crNumber, setCrNumber] = useState(customer.crNumber ?? '');
  const [channelId, setChannelId] = useState(customer.channelId ?? '');
  const [subChannelId, setSubChannelId] = useState(customer.subChannelId ?? '');
  const [primaryPhone, setPrimaryPhone] = useState(customer.primaryPhone ?? '');
  const [altPhone, setAltPhone] = useState(customer.altPhone ?? '');
  const [contactPerson, setContactPerson] = useState(customer.contactPerson ?? '');
  const [contactRole, setContactRole] = useState(customer.contactRole ?? '');
  const [status, setStatus] = useState<CustomerStatus>(customer.status);
  const [notes, setNotes] = useState(customer.notes ?? '');

  // Branch-level state — keyed by branch id
  type BState = {
    address: string;
    areaDescription: string;
    gps: Gps | null;
    dayOfVisit: DayOfWeek | '';
    openingHours: string;
    deliveryWindow: string;
    coolers: number;
    stands: number;
    bottles: number;
  };
  const [branchStates, setBranchStates] = useState<Record<string, BState>>(() => {
    const out: Record<string, BState> = {};
    for (const b of customer.branches) {
      out[b.id] = {
        address: b.address,
        areaDescription: b.areaDescription ?? '',
        gps:
          b.gpsLat != null && b.gpsLng != null
            ? {
                lat: b.gpsLat,
                lng: b.gpsLng,
                accuracy: b.gpsAccuracy ?? undefined,
                capturedAt: b.gpsCapturedAt ?? new Date(),
              }
            : null,
        dayOfVisit: b.dayOfVisit ?? '',
        openingHours: b.openingHours ?? '',
        deliveryWindow: b.deliveryWindow ?? '',
        coolers: b.coolersCount,
        stands: b.standsCount,
        bottles: b.emptyBottlesCount,
      };
    }
    return out;
  });

  // Available sub-channels for chosen channel
  const subChannels = channels.find((c) => c.id === channelId)?.subChannels ?? [];

  // Photo slots are wired server-side the moment a capture finishes
  // (PhotoCaptureSlot → attachPhotoAction), but the mandatory gate below used to
  // read the INITIAL server snapshot only — so after taking the three required
  // photos the Submit button stayed disabled ("Missing: shop photo …") until the
  // salesman reloaded the page. Track the live slot state instead (go-live fix).
  const [crPhotoId, setCrPhotoId] = useState<string | null>(customer.crPhotoId);
  const [branchPhotos, setBranchPhotos] = useState<
    Record<string, { shop: string | null; signboard: string | null }>
  >(() =>
    Object.fromEntries(
      customer.branches.map((b) => [b.id, { shop: b.shopPhotoId, signboard: b.signboardPhotoId }])
    )
  );
  function setBranchPhoto(branchId: string, slot: 'shop' | 'signboard', id: string | null) {
    setBranchPhotos((s) => ({ ...s, [branchId]: { ...s[branchId], [slot]: id } }));
  }
  // Photos still going up, in every slot — optional ones and retakes included,
  // which the gate below never sees (it reads a photo only once attached).
  // Submit leaves by a document load, and that aborts an upload in flight: the
  // photo was lost while the salesman read "It arrived" (item 22 review).
  const [uploading, setUploading] = useState(0);
  const onPhotoBusy = useCallback((busy: boolean) => setUploading((n) => n + (busy ? 1 : -1)), []);
  // …and no NEW photo once a submit is on its way. Submit is held while a photo
  // uploads, but a photo started after the tap would still be cut off by the
  // page load that follows the answer — silently, beside "It arrived".
  const photosLocked = pending || arrived;

  // Client-side mandatory-field gate. Mirrors the server check in
  // services/edits.ts so the salesman gets immediate feedback and can't
  // even press "Submit for approval" until everything is filled.
  const missingMandatory: string[] = [];
  if (userRole === Role.SALESMAN) {
    // 2026-05-11: locked fields are NOT the salesman's responsibility. If the
    // master is missing legalName or CR for this customer, that's a Steward
    // queue item — not a salesman blocker. Don't include them in the
    // "missing — cannot submit" pill.
    if (!lockName && !legalName.trim()) missingMandatory.push('Legal name');
    if (!channelId) missingMandatory.push('Channel');
    if (req('subChannelId') && !subChannelId) missingMandatory.push('Sub-channel');
    if (!primaryPhone.trim()) missingMandatory.push('Primary phone');
    if (!contactPerson.trim()) missingMandatory.push('Contact person');
    if (req('crNumber') && !lockCr && !crNumber.trim()) missingMandatory.push('CR number');
    if (req('crPhoto') && !crPhotoId) missingMandatory.push('CR document photo');
    customer.branches.forEach((b, i) => {
      const s = branchStates[b.id];
      const tag = `Branch ${i + 1}`;
      if (!s) return;
      if (!s.address.trim() || s.address.trim().length < 3)
        missingMandatory.push(`${tag} address`);
      if (!s.gps || s.gps.lat == null || s.gps.lng == null)
        missingMandatory.push(`${tag} GPS`);
      if (req('dayOfVisit') && !s.dayOfVisit) missingMandatory.push(`${tag} day of visit`);
      if (!branchPhotos[b.id]?.shop) missingMandatory.push(`${tag} shop photo`);
      if (req('signboardPhoto') && !branchPhotos[b.id]?.signboard)
        missingMandatory.push(`${tag} signboard photo`);
    });
  }
  // For every role: a Manager's direct write leaves the same way.
  const submitBlocked =
    !canSubmit ||
    arrived ||
    uploading > 0 ||
    (userRole === Role.SALESMAN && missingMandatory.length > 0);
  const submitTitle = !canSubmit
    ? 'Pending edit already in review'
    : uploading > 0
      ? PHOTO_UPLOADING_MESSAGE
      : missingMandatory.length > 0
        ? `Missing: ${missingMandatory.join(', ')}`
        : '';

  // ── Local draft auto-save (IndexedDB-lite via localStorage for v1) ───────
  // UXI-002: scope by user. UXI-003: scope by customer.updatedAt as well —
  // when the customer has been edited server-side since the draft was
  // written, the next mount uses a fresh key (so old draft is ignored) and
  // we warn the user that there are newer server changes.
  const customerUpdatedAtMs = new Date(customer.updatedAt).getTime();
  const draftKey = `nmwc:draft:${sessionUserId}:${customer.id}`;
  // GpsCaptureButton reads its `initial` only when it mounts. A restore replaces
  // the branch GPS after that, so the chip kept showing the old point while the
  // form submitted the restored one — including a typed point and its reason
  // (item 41) the salesman could not see. Bumped on restore to remount them.
  const [restoreGeneration, setRestoreGeneration] = useState(0);
  // Restore runs ONCE per draft key, on mount. customerUpdatedAtMs also changes
  // mid-session — the salesman's own CR photo attach revalidates this page — and a
  // re-run then re-applied the draft over live typing, remounted the GPS buttons
  // (losing an open manual entry or an in-flight capture), or told the salesman
  // their own draft was stale. A ref, so a StrictMode double run also counts once.
  const restoredForKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredForKeyRef.current === draftKey) return;
    restoredForKeyRef.current = draftKey;
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : null;
    if (!saved) return;
    try {
      const d = JSON.parse(saved);
      // UXI-003: stale-draft guard. If the server values the draft started from
      // have changed since, prefer server data and tell the user. Item 22: by
      // the values, not updatedAt — a photo taken after typing bumps updatedAt,
      // and every such draft used to be thrown away here.
      if (draftIsStale(d, baseRef.current!, customerUpdatedAtMs)) {
        setInfo(
          'Your offline draft is older than the latest server changes. The form has been refreshed — re-enter anything you still need.'
        );
        try {
          window.localStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
        return;
      }
      if (typeof d.legalName === 'string') setLegalName(d.legalName);
      if (typeof d.crNumber === 'string') setCrNumber(d.crNumber);
      if (typeof d.channelId === 'string') setChannelId(d.channelId);
      if (typeof d.subChannelId === 'string') setSubChannelId(d.subChannelId);
      if (typeof d.primaryPhone === 'string') setPrimaryPhone(d.primaryPhone);
      if (typeof d.altPhone === 'string') setAltPhone(d.altPhone);
      if (typeof d.contactPerson === 'string') setContactPerson(d.contactPerson);
      if (typeof d.contactRole === 'string') setContactRole(d.contactRole);
      if (typeof d.notes === 'string') setNotes(d.notes);
      if (d.branchStates) {
        setBranchStates((prev) => ({ ...prev, ...d.branchStates }));
        setRestoreGeneration((g) => g + 1);
      }
      setInfo('Restored a local draft from your last visit.');
    } catch {
      /* ignore */
    }
  }, [draftKey, customerUpdatedAtMs]);

  // Set when a submit arrived and the page is leaving: from then on nothing
  // writes the phone copy — not a keystroke's autosave already due, which fired
  // after the removal and brought back what had just arrived, nor a GPS fix
  // landing during the document load (item 22 review; the create form's
  // phoneCopyGoneRef). The pending timer, so a replay that stays can drop it.
  const draftGoneRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save every change (debounced)
  useEffect(() => {
    const handle = setTimeout(() => {
      if (typeof window === 'undefined' || draftGoneRef.current) return;
      window.localStorage.setItem(
        draftKey,
        JSON.stringify({
          legalName,
          crNumber,
          channelId,
          subChannelId,
          primaryPhone,
          altPhone,
          contactPerson,
          contactRole,
          notes,
          branchStates,
          savedAt: Date.now(),
          base: baseRef.current,
        })
      );
    }, 500);
    autosaveTimerRef.current = handle;
    // Item 22: a green "saved" no longer describes the form once it changes.
    setNotice((n) => (n?.tone === 'received' ? null : n));
    return () => clearTimeout(handle);
  }, [
    draftKey,
    legalName,
    crNumber,
    channelId,
    subChannelId,
    primaryPhone,
    altPhone,
    contactPerson,
    contactRole,
    notes,
    branchStates,
  ]);

  function setBranch(id: string, patch: Partial<BState>) {
    setBranchStates((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  }

  async function submit(isDraft: boolean) {
    // Try again repeats a Submit too, and its button is not the one disabled
    // while a photo is going up; a success here would leave and abort it. The
    // line beside the button says why nothing happens.
    if (!isDraft && uploading > 0) return;
    // UXI-004: synchronous lock so a fast double-tap on the Submit button
    // can't fire two parallel server actions before useTransition flips.
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setErrors({});
    setInfo(null);
    // The notice stays while this try is in flight — its Try again reads
    // "Trying…" under the thumb — and each outcome below replaces it.
    lastWasDraftRef.current = isDraft;

    // EL-01 mirror: salesmen cannot SUBMIT a customer-level status flip via
    // the regular edit form. Drop the status field from the payload entirely
    // for SALESMAN — the server-side guard rejects it anyway, but stripping
    // here gives a cleaner UX (no "Use the close action" error if the user
    // never touched the field).
    const submittedStatus = userRole === Role.SALESMAN ? customer.status : status;

    const customerPayload = {
      legalName: lockName ? undefined : legalName.trim() || undefined,
      crNumber: lockCr ? undefined : crNumber.trim() || undefined,
      channelId: channelId || undefined,
      subChannelId: subChannelId || undefined,
      primaryPhone: primaryPhone.trim() || undefined,
      altPhone: altPhone.trim() || undefined,
      contactPerson: contactPerson.trim() || undefined,
      contactRole: contactRole.trim() || undefined,
      status: submittedStatus,
      notes: notes.trim() || undefined,
    };
    const branches = Object.entries(branchStates).map(([branchId, s]) => ({
      branchId,
      address: s.address.trim() || undefined,
      areaDescription: s.areaDescription.trim() || undefined,
      gpsLat: s.gps?.lat,
      gpsLng: s.gps?.lng,
      gpsAccuracy: s.gps?.accuracy,
      gpsCapturedAt: s.gps?.capturedAt,
      // Item 41: a typed-in point says so, with the reason the salesman gave.
      gpsManualReason: s.gps?.isManual ? s.gps.manualReason : undefined,
      dayOfVisit: s.dayOfVisit || undefined,
      openingHours: s.openingHours.trim() || undefined,
      deliveryWindow: s.deliveryWindow.trim() || undefined,
      coolersCount: s.coolers,
      standsCount: s.stands,
      emptyBottlesCount: s.bottles,
    }));

    const body = { customerId: customer.id, isDraft, customer: customerPayload, branches };
    idsRef.current ??= new SubmissionIds();
    // The same payload after no answer keeps its id, so a retry is never written twice.
    const submissionId = idsRef.current.idFor(body);

    start(async () => {
      try {
        // Item 22: over fetch, not the server action (lib/submit-client.ts says
        // why). The answer is the action's own `{ ok, data?, code, message,
        // fields? }` (PROD-006, lib/errors.ts runAction) — or what is known
        // when there was none.
        const outcome = await postForm<SubmitReceipt>('customer-edit', { ...body, submissionId });
        const ids = idsRef.current!;
        ids.settle(outcome);
        // null for a first-time success and for field errors, which say
        // themselves; every other outcome is said beside the button.
        setNotice(noticeFor(outcome, { doubt: ids.doubt }));
        if (outcome.kind !== 'answered') return;
        const result = outcome.result;
        if (!result.ok) {
          if (result.fields) {
            // A key with no slot on this form still surfaces, at the top.
            setErrors(surfaceUnrenderedErrors(result.fields, enrichmentFormRendersError));
          }
          return;
        }
        const res = result.data;
        if (res.replayed) {
          // It had already arrived: said above, beside the button. Stay — there
          // is nothing to send, and moving on would hide the answer.
          if (res.state === 'SUBMITTED' || res.state === 'APPROVED') {
            // The form stays, so a later edit may still save: drop only the
            // autosave already due, which would write back what just arrived.
            if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
            if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey);
            if (!isDraft) setArrived(true);
          }
          return;
        }
        if (isDraft) {
          // Owner decision (item 22): the draft stays on this phone, as the
          // guide promises — no longer deleted by a successful save.
          setNotice({
            tone: 'received',
            // When approving what is pending replaces this draft
            // (lib/enrichment-draft.ts) — say so now, not after. A pending
            // close does not; see pendingReplacesDraft in lib/submission-replay.ts.
            text: pendingReplacesDraft
              ? '✓ Draft saved on this phone. If the changes already waiting are approved first, they replace it.'
              : '✓ Draft saved. It stays on this phone until you submit.',
          });
          return;
        }
        draftGoneRef.current = true;
        if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey);
        // Item 22: said beside the button BEFORE moving on — on weak signal the
        // next page can take a while, or fail to load, and the salesman must
        // already know that this arrived.
        setArrived(true);
        setNotice({
          tone: 'received',
          text:
            res.state === 'APPROVED'
              ? `✓ Saved (auto-approved as ${userRole}).`
              : '✓ Submitted for approval. It arrived — nothing more to do.',
        });
        // UXI-005: replace, not push, so Back doesn't return to a stale,
        // fully-populated form that encourages a duplicate submit. A document
        // load (lib/navigate.ts): revalidatePath in a route handler does not
        // clear the browser's router cache (a server action's did), so a
        // client navigation — or Back afterwards — showed the old values. The
        // transition ends as soon as this returns, long before the next page
        // is in: `arrived`, not `pending`, is what keeps the bar locked.
        hardReplace(`/customers/${customer.id}`);
      } finally {
        submitLockRef.current = false;
      }
    });
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {info && (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-base font-medium text-emerald-700 ring-1 ring-emerald-200">
          {info}
        </div>
      )}
      {errors._form && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-base font-medium text-red-700 ring-1 ring-red-200">
          {errors._form}
        </div>
      )}

      <FormSection
        title="Identity"
        description={
          lockName && lockCr
            ? 'Legal name and CR are locked — only the Steward can change them. Fill the rest below.'
            : lockName
              ? 'Legal name is locked (Steward-only). The CR is editable.'
              : undefined
        }
        locked={lockName && lockCr}
        defaultOpen={true}
      >
        <div className="grid gap-3">
          <Field
            label="Legal name *"
            error={errors['customer.legalName']}
            value={legalName}
            onChange={setLegalName}
            disabled={lockName}
          />
          <Field
            label="CR number"
            error={errors['customer.crNumber']}
            value={crNumber}
            onChange={setCrNumber}
            disabled={lockCr}
          />
          <Field label="NMWC code" value={customer.nmwcCode} onChange={() => {}} disabled mono />
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              CR document photo{star('crPhoto')}
            </label>
            <div className="w-48">
              <PhotoCaptureSlot
                kind="CR"
                required={req('crPhoto')}
                initial={
                  customer.crPhotoId
                    ? { attachmentId: customer.crPhotoId, remoteUrl: `/api/photos/${customer.crPhotoId}` }
                    : null
                }
                attachTo={{ kind: 'customer', customerId: customer.id, slot: 'CR' }}
                onChange={(p) => setCrPhotoId(p?.attachmentId ?? null)}
                onBusyChange={onPhotoBusy}
                disabled={photosLocked}
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${uid}-notes`} className="mb-1 block text-sm font-medium text-slate-700">Notes</label>
            <textarea
              id={`${uid}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              maxLength={5000}
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
              rows={3}
            />
          </div>
        </div>
      </FormSection>

      <FormSection title="Channel & classification">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-channel`} className="mb-1 block text-sm font-medium text-slate-700">Channel *</label>
            <select
              id={`${uid}-channel`}
              value={channelId}
              onChange={(e) => {
                setChannelId(e.currentTarget.value);
                setSubChannelId('');
              }}
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm"
            >
              <option value="">— Pick a channel —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-subchannel`} className="mb-1 block text-sm font-medium text-slate-700">
              Sub-channel{star('subChannelId')}
            </label>
            <select
              id={`${uid}-subchannel`}
              value={subChannelId}
              onChange={(e) => setSubChannelId(e.currentTarget.value)}
              disabled={!channelId}
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm disabled:bg-slate-100"
            >
              <option value="">— Pick a sub-channel —</option>
              {subChannels.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {/* EL-01 mirror: salesmen cannot flip customer-level status from
              this form. Status changes go through the dedicated
              close-shop / reactivation actions on the customer profile. */}
          {userRole !== Role.SALESMAN && (
            <div>
              <label htmlFor={`${uid}-status`} className="mb-1 block text-sm font-medium text-slate-700">Status</label>
              <select
                id={`${uid}-status`}
                value={status}
                onChange={(e) => setStatus(e.currentTarget.value as CustomerStatus)}
                className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm"
              >
                <option value="ACTIVE">Active</option>
                <option value="CLOSED">Closed</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </div>
          )}
        </div>
      </FormSection>

      <FormSection title="Contact">
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Primary phone *"
            type="tel"
            autoComplete="off"
            placeholder="+968 9XXX XXXX"
            value={primaryPhone}
            onChange={setPrimaryPhone}
            error={errors['customer.primaryPhone']}
          />
          <Field
            label="Alt phone"
            type="tel"
            autoComplete="off"
            placeholder="+968 …"
            value={altPhone}
            onChange={setAltPhone}
            error={errors['customer.altPhone']}
          />
          <Field
            label="Contact person *"
            value={contactPerson}
            onChange={setContactPerson}
            error={errors['customer.contactPerson']}
          />
          <Field label="Contact role" value={contactRole} onChange={setContactRole} />
        </div>
      </FormSection>

      {customer.branches.map((b, idx) => {
        const s = branchStates[b.id];
        if (!s) return null;
        return (
          <FormSection
            key={b.id}
            title={`Branch ${idx + 1}: ${b.branchName}`}
            description={`${b.region.name} · ${b.route.code}`}
          >
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Address *"
                  value={s.address}
                  onChange={(v) => setBranch(b.id, { address: v })}
                  textarea
                />
                <Field
                  label="Landmark / area description"
                  value={s.areaDescription}
                  onChange={(v) => setBranch(b.id, { areaDescription: v })}
                  textarea
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Location * (required to submit)
                </label>
                <GpsCaptureButton
                  key={restoreGeneration}
                  initial={s.gps}
                  onCapture={(g) => setBranch(b.id, { gps: g })}
                  required
                />
                {errors[`branch.${b.id}.gps`] && (
                  <p className="mt-1 text-sm font-medium text-red-600">{errors[`branch.${b.id}.gps`]}</p>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label htmlFor={`${uid}-day-${b.id}`} className="mb-1 block text-sm font-medium text-slate-700">
                    Day of visit{star('dayOfVisit')}
                  </label>
                  <select
                    id={`${uid}-day-${b.id}`}
                    value={s.dayOfVisit}
                    onChange={(e) =>
                      setBranch(b.id, { dayOfVisit: e.currentTarget.value as DayOfWeek | '' })
                    }
                    className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm"
                  >
                    <option value="">—</option>
                    {DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <Field
                  label="Opening hours"
                  placeholder="08:00 – 22:00"
                  value={s.openingHours}
                  onChange={(v) => setBranch(b.id, { openingHours: v })}
                />
                <Field
                  label="Delivery window"
                  placeholder="10:00 – 14:00"
                  value={s.deliveryWindow}
                  onChange={(v) => setBranch(b.id, { deliveryWindow: v })}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Equipment at the shop
                </label>
                <div className="grid gap-2 lg:grid-cols-3">
                  <StepperInput
                    name={`coolers-${b.id}`}
                    label="Coolers"
                    value={s.coolers}
                    onChange={(n) => setBranch(b.id, { coolers: n })}
                  />
                  <StepperInput
                    name={`stands-${b.id}`}
                    label="Stands"
                    value={s.stands}
                    onChange={(n) => setBranch(b.id, { stands: n })}
                  />
                  <StepperInput
                    name={`bottles-${b.id}`}
                    label="Empty bottles"
                    value={s.bottles}
                    onChange={(n) => setBranch(b.id, { bottles: n })}
                    max={1000}
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Photos
                </label>
                <p className="mb-2 text-xs text-slate-500">
                  Tap each slot to capture from your camera.{' '}
                  {req('signboardPhoto')
                    ? 'Required: shop front, signboard. CR document (in Identity section above) and 2 free photos optional.'
                    : 'Required: shop front. Signboard, CR document (in Identity section above) and 2 free photos are optional but count towards completeness.'}
                </p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <PhotoCaptureSlot
                    kind="SHOP"
                    required
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    initial={
                      b.shopPhotoId
                        ? {
                            attachmentId: b.shopPhotoId,
                            remoteUrl: `/api/photos/${b.shopPhotoId}`,
                          }
                        : null
                    }
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'SHOP' }}
                    onChange={(p) => setBranchPhoto(b.id, 'shop', p?.attachmentId ?? null)}
                    onBusyChange={onPhotoBusy}
                    disabled={photosLocked}
                  />
                  <PhotoCaptureSlot
                    kind="SIGNBOARD"
                    required={req('signboardPhoto')}
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    initial={
                      b.signboardPhotoId
                        ? {
                            attachmentId: b.signboardPhotoId,
                            remoteUrl: `/api/photos/${b.signboardPhotoId}`,
                          }
                        : null
                    }
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'SIGNBOARD' }}
                    onChange={(p) => setBranchPhoto(b.id, 'signboard', p?.attachmentId ?? null)}
                    onBusyChange={onPhotoBusy}
                    disabled={photosLocked}
                  />
                  <PhotoCaptureSlot
                    kind="FREE"
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'FREE' }}
                    onBusyChange={onPhotoBusy}
                    disabled={photosLocked}
                  />
                  <PhotoCaptureSlot
                    kind="FREE"
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'FREE' }}
                    onBusyChange={onPhotoBusy}
                    disabled={photosLocked}
                  />
                </div>
              </div>
            </div>
          </FormSection>
        );
      })}

      {/* B-25: sticky bar — Submit on the LEFT (left-thumb in market when
          phone is held in left hand holding the customer profile sheet),
          Save Draft on the right. gap-3 prevents fat-finger confusion, and
          mb-3 above the bar gives a 12px safe-zone over the previous content. */}
      <div className="mb-3" />
      <div className="sticky bottom-0 -mx-4 mt-4 flex flex-col border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:-mx-6 sm:p-6">
        <SubmitNoticeBox
          notice={notice}
          busy={pending}
          onRetry={() => submit(lastWasDraftRef.current)}
        />
        {canSubmit && !arrived && uploading > 0 && (
          <p className="mb-2 text-sm font-medium text-slate-600">{PHOTO_UPLOADING_MESSAGE}</p>
        )}
        <div className="flex items-center justify-start gap-3">
          <button
            type="button"
            disabled={pending || submitBlocked}
            onClick={() => submit(false)}
            className="rounded-md bg-brand-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            title={submitTitle}
          >
            {arrived ? 'Sent ✓' : pending ? 'Submitting…' : 'Submit for approval ▶'}
          </button>
          {/* Off once it arrived, as on the create form: a tap while the next
              page loads (or after a replayed answer, which stays) wrote a stray
              DRAFT and swapped "It arrived" for "…until you submit". */}
          <button
            type="button"
            disabled={pending || arrived}
            onClick={() => submit(true)}
            className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-base font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {pending ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </div>

      {userRole === Role.SALESMAN && missingMandatory.length > 0 && canSubmit && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          <strong className="font-semibold">Cannot submit yet — missing:</strong>{' '}
          {missingMandatory.join(', ')}. Save as a draft and finish the rest before submitting.
        </div>
      )}
    </div>
  );
}
