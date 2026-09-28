'use client';

import { useCallback, useId, useState, useEffect, useRef } from 'react';
import { Role, type CustomerStatus, type DayOfWeek, type PaymentTerms } from '@prisma/client';
import { FormSection } from '@/components/nmwc/FormSection';
import {
  surfaceUnrenderedErrors,
  enrichmentFormRendersError,
  withReloadHintForUnshownBranches,
} from '@/lib/form-errors';
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
import { EDIT_PAYLOAD_VERSION, fieldLabel, type BaseValue } from '@/lib/edit-values';
import {
  buildEnrichmentPatch,
  conflictsFrom,
  countedNow,
  countsMoved,
  loadedFormState,
  NO_KEPT_FIELDS,
  openConflicts,
  resolveConflict,
  restoreBranchStates,
  restoreKept,
  type Conflicts,
  type FormBranch,
  type FormCustomer,
  type FormGps,
  type KeptFields,
  type LoadedBranch,
  type LoadedCustomer,
} from '@/lib/enrichment-patch';

type CustomerWithBranches = Omit<LoadedCustomer, 'branches'> & {
  id: string;
  nmwcCode: string;
  paymentTerms: PaymentTerms;
  crPhotoId: string | null;
  branches: Array<
    LoadedBranch & {
      branchName: string;
      status: CustomerStatus;
      shopPhotoId: string | null;
      signboardPhotoId: string | null;
      region: { name: string };
      route: { code: string };
    }
  >;
};

/** The customer text boxes a phone draft holds (lib/enrichment-draft.ts). */
const DRAFT_TEXT_FIELDS = [
  'legalName',
  'crNumber',
  'channelId',
  'subChannelId',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'notes',
] as const;

/** Why Submit waits after a STALE_FIELDS answer (ruling 1). */
const UNRESOLVED_TITLE =
  'Some details changed after you opened this form. Choose “Keep mine” or “Use this value” for each one above, then submit.';

/** The GPS button takes a Date; a restored draft or a live value carries an ISO string. */
const gpsForButton = (g: FormGps | null): Gps | null =>
  g
    ? {
        lat: g.lat,
        lng: g.lng,
        accuracy: g.accuracy ?? undefined,
        capturedAt: new Date(g.capturedAt),
        isManual: g.isManual,
        manualReason: g.manualReason,
      }
    : null;

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

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
  // A submit on its way: plain state, not useTransition. Next dispatches every
  // server action inside a transition and React settles pending transitions
  // together, so while ANY action was in flight on the page — a stalled photo
  // attach — this form's own `pending` stayed true after its answer:
  // "Submitting…", a disabled "Trying…", and the slots locked with their Retry
  // upload hidden (post-merge review of 30ec23a).
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<string | null>(null);
  // UXI-004: synchronous lock so a rapid double-tap on Submit never fires the
  // request twice. `sending` is state, and flips only on the next render.
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
  // Phase 2 (F06): the same values, field by field — every field sent carries
  // its value from here as its base (lib/enrichment-patch.ts). The page's
  // values, never the phone draft's; moved only by "Keep mine" / "Use this value".
  const loadedRef = useRef<LoadedCustomer>(customer);

  // The boxes: the customer's, and each branch's by id.
  const [values, setValues] = useState<FormCustomer>(() => loadedFormState(customer).customer);
  const [branchStates, setBranchStates] = useState<Record<string, FormBranch>>(
    () => loadedFormState(customer).branches
  );
  const setValue = (key: keyof FormCustomer) => (v: string) => setValues((c) => ({ ...c, [key]: v }));
  const { legalName, crNumber, channelId, subChannelId, primaryPhone, contactPerson } = values;

  // Ruling 1 (phase 2): the fields a STALE_FIELDS answer named, with the value
  // found live — until he chooses "Keep mine" or "Use this value" for each —
  // and the fields he kept, which the next submit says it knowingly replaces.
  const [conflicts, setConflicts] = useState<Conflicts>({});
  const [kept, setKept] = useState<KeptFields>(NO_KEPT_FIELDS);
  // Bumped by each choice: the phone copy then carries the moved base.
  const [rebaseGen, setRebaseGen] = useState(0);
  const patchOptions = { role: userRole, lockName, lockCr };
  const patch = buildEnrichmentPatch(
    loadedRef.current,
    { customer: values, branches: branchStates },
    { ...patchOptions, kept }
  );
  // A conflict on a field no longer sent is moot; one still sent would be refused again.
  const unresolved = openConflicts(conflicts, patch);
  const shownBranchIds = new Set(customer.branches.map((b) => b.id));

  // Available sub-channels for chosen channel
  const subChannels = channels.find((c) => c.id === channelId)?.subChannels ?? [];

  // Photo slots are wired server-side the moment a capture finishes
  // (PhotoCaptureSlot → /api/photos/attach), but the mandatory gate below used to
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
  const photosLocked = sending || arrived;

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
    unresolved.length > 0 ||
    (userRole === Role.SALESMAN && missingMandatory.length > 0);
  const submitTitle = !canSubmit
    ? 'Pending edit already in review'
    : uploading > 0
      ? PHOTO_UPLOADING_MESSAGE
      : unresolved.length > 0
        ? UNRESOLVED_TITLE
        : missingMandatory.length > 0
          ? `Missing: ${missingMandatory.join(', ')}`
          : '';

  // ── Local draft auto-save (IndexedDB-lite via localStorage for v1) ───────
  // UXI-002: scope by user. Whether a saved draft may be restored is decided
  // by the server values it started from (item 22, lib/enrichment-draft.ts).
  const draftKey = `nmwc:draft:${sessionUserId}:${customer.id}`;
  // GpsCaptureButton reads its `initial` only when it mounts. A restore replaces
  // the branch GPS after that, so the chip kept showing the old point while the
  // form submitted the restored one — including a typed point and its reason
  // (item 41) the salesman could not see. Bumped on restore to remount them,
  // and when "Use this value" takes the live point into the box.
  const [restoreGeneration, setRestoreGeneration] = useState(0);
  // Restore runs ONCE per draft key, on mount. The page's props also change
  // mid-session — the salesman's own CR photo attach revalidates it — and a
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
      // and every such draft used to be thrown away here. Phase 2: a draft with
      // no starting values at all is dropped too (lib/enrichment-draft.ts).
      if (draftIsStale(d, baseRef.current!)) {
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
      setValues((c) => {
        const next = { ...c };
        for (const k of DRAFT_TEXT_FIELDS) if (typeof d[k] === 'string') next[k] = d[k];
        return next;
      });
      // Phase 2: per branch the page shows, never a branch handed to another
      // route since (it used to be sent, and refused).
      if (d.branchStates) {
        setBranchStates((prev) => restoreBranchStates(prev, d.branchStates, customer.branches));
        setRestoreGeneration((g) => g + 1);
      }
      if (d.kept) setKept(restoreKept(d.kept, customer.branches));
      setInfo('Restored a local draft from your last visit.');
    } catch {
      /* ignore */
    }
  }, [draftKey, customer.branches]);

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
          legalName: values.legalName,
          crNumber: values.crNumber,
          channelId: values.channelId,
          subChannelId: values.subChannelId,
          primaryPhone: values.primaryPhone,
          altPhone: values.altPhone,
          contactPerson: values.contactPerson,
          contactRole: values.contactRole,
          notes: values.notes,
          branchStates,
          savedAt: Date.now(),
          base: baseRef.current,
          // Ruling 1: a "Keep mine" survives a reload with the draft, so the
          // approver is still told what it replaces.
          ...(kept.customer.length > 0 || Object.keys(kept.branches).length > 0 ? { kept } : {}),
        })
      );
    }, 500);
    autosaveTimerRef.current = handle;
    // Item 22: a green "saved" no longer describes the form once it changes.
    setNotice((n) => (n?.tone === 'received' ? null : n));
    return () => clearTimeout(handle);
  }, [draftKey, values, branchStates, kept, rebaseGen]);

  function setBranch(id: string, change: Partial<FormBranch>) {
    setBranchStates((s) => ({ ...s, [id]: { ...s[id]!, ...change } }));
  }

  /**
   * Ruling 1: his answer to one field a STALE_FIELDS reply named. Nothing
   * moves until he answers, field by field; lib/enrichment-patch.ts
   * resolveConflict says what each answer does.
   */
  function choose(slot: string, choice: 'mine' | 'theirs') {
    const live = conflicts[slot];
    if (!live) return;
    const next = resolveConflict(
      choice,
      live,
      loadedRef.current,
      { customer: values, branches: branchStates },
      kept,
      patchOptions
    );
    loadedRef.current = next.loaded;
    // The phone copy now starts from these values (the autosave runs on rebaseGen).
    baseRef.current = enrichmentBase(next.loaded);
    setValues(next.state.customer);
    setBranchStates(next.state.branches);
    setKept(next.kept);
    setConflicts((c) => without(c, slot));
    setErrors((e) => without(e, slot));
    if (choice === 'theirs' && slot.endsWith('.gps')) setRestoreGeneration((g) => g + 1);
    setRebaseGen((g) => g + 1);
  }

  async function submit(isDraft: boolean) {
    // Try again repeats a Submit too, and its button is not the one disabled
    // while a photo is going up; a success here would leave and abort it. The
    // line beside the button says why nothing happens.
    if (!isDraft && uploading > 0) return;
    // Ruling 1: a field still in conflict would only be refused again. A draft
    // is never checked for it — nothing is written from one.
    if (!isDraft && unresolved.length > 0) return;
    // UXI-004: synchronous lock so a fast double-tap on the Submit button
    // can't fire two parallel requests before `sending` renders.
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSending(true);
    setErrors({});
    setInfo(null);
    // The notice stays while this try is in flight — its Try again reads
    // "Trying…" under the thumb — and each outcome below replaces it.
    lastWasDraftRef.current = isDraft;

    // Phase 2 (F06, F20): only what was touched, each with the value the page
    // loaded; an emptied box is null. EL-01: a salesman's never has a status.
    const body = { v: EDIT_PAYLOAD_VERSION, customerId: customer.id, isDraft, ...patch };
    idsRef.current ??= new SubmissionIds();
    // The same payload after no answer keeps its id, so a retry is never written twice.
    const submissionId = idsRef.current.idFor(body);

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
        // Ruling 1: fields changed after the page opened, with the values now
        // saved. His typing stays; each waits for his choice.
        const stale =
          result.code === 'STALE_FIELDS' && result.fields && result.current
            ? conflictsFrom(result.fields, result.current)
            : null;
        if (stale) setConflicts(stale);
        if (result.fields) {
          // A key with no slot on this form still surfaces, at the top — with
          // "reload" when it names a branch this page does not show (ruling 11).
          // A conflict is shown in the list of them.
          const fields = withReloadHintForUnshownBranches(result.fields, shownBranchIds);
          setErrors(
            surfaceUnrenderedErrors(
              fields,
              (k) => enrichmentFormRendersError(k, shownBranchIds) || !!stale?.[k]
            )
          );
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
      // client navigation — or Back afterwards — showed the old values.
      // `sending` ends as soon as this returns, long before the next page is
      // in: `arrived`, not `sending`, is what keeps the bar locked.
      hardReplace(`/customers/${customer.id}`);
    } finally {
      submitLockRef.current = false;
      setSending(false);
    }
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
      {unresolved.length > 0 && (
        <ConflictList
          slots={unresolved}
          conflicts={conflicts}
          branches={customer.branches}
          channels={channels}
          onChoose={choose}
        />
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
            onChange={setValue('legalName')}
            disabled={lockName}
          />
          <Field
            label="CR number"
            error={errors['customer.crNumber']}
            value={crNumber}
            onChange={setValue('crNumber')}
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
              value={values.notes}
              onChange={(e) => setValue('notes')(e.currentTarget.value)}
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
                // A new channel empties the sub-channel, and the submit sends that
                // (null) unless one of the new channel's is picked (F16).
                const next = e.currentTarget.value;
                setValues((c) => ({ ...c, channelId: next, subChannelId: '' }));
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
              onChange={(e) => setValue('subChannelId')(e.currentTarget.value)}
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
                value={values.status}
                onChange={(e) => setValue('status')(e.currentTarget.value as CustomerStatus)}
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
            onChange={setValue('primaryPhone')}
            error={errors['customer.primaryPhone']}
          />
          <Field
            label="Alt phone"
            type="tel"
            autoComplete="off"
            placeholder="+968 …"
            value={values.altPhone}
            onChange={setValue('altPhone')}
            error={errors['customer.altPhone']}
          />
          <Field
            label="Contact person *"
            value={contactPerson}
            onChange={setValue('contactPerson')}
            error={errors['customer.contactPerson']}
          />
          <Field label="Contact role" value={values.contactRole} onChange={setValue('contactRole')} />
        </div>
      </FormSection>

      {customer.branches.map((b, idx) => {
        const s = branchStates[b.id];
        if (!s) return null;
        // What the page loaded for it (moved by a conflict choice): decides the "Counted" box.
        const lb = loadedRef.current.branches.find((x) => x.id === b.id) ?? b;
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
                  initial={gpsForButton(s.gps)}
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
                    onChange={(n) => setBranch(b.id, { coolers: n, confirmed: true })}
                  />
                  <StepperInput
                    name={`stands-${b.id}`}
                    label="Stands"
                    value={s.stands}
                    onChange={(n) => setBranch(b.id, { stands: n, confirmed: true })}
                  />
                  <StepperInput
                    name={`bottles-${b.id}`}
                    label="Empty bottles"
                    value={s.bottles}
                    onChange={(n) => setBranch(b.id, { bottles: n, confirmed: true })}
                    max={1000}
                  />
                </div>
                {/* F21: a stored 0 is also the column's default, so a real zero is
                    said by this tick (Branch.equipmentConfirmed); entering a count
                    is counting, so each stepper ticks it too. Owner decision 3: a
                    salesman only ever sets it; once it is on file, he sees it said. */}
                {userRole === Role.SALESMAN && lb.equipmentConfirmed ? (
                  <p className="mt-2 text-sm font-medium text-emerald-700">✓ Equipment counted</p>
                ) : (
                  <label className="mt-2 flex min-h-11 items-center gap-3 text-base text-slate-700">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 rounded border-slate-300 disabled:opacity-60"
                      checked={countedNow(lb, s)}
                      // A count that moved says it was counted: unticking would not hold.
                      disabled={countsMoved(lb, s)}
                      onChange={(e) => setBranch(b.id, { confirmed: e.currentTarget.checked })}
                    />
                    Counted at the shop (tick even if there is none)
                  </label>
                )}
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
          busy={sending}
          onRetry={() => submit(lastWasDraftRef.current)}
        />
        {canSubmit && !arrived && uploading > 0 && (
          <p className="mb-2 text-sm font-medium text-slate-600">{PHOTO_UPLOADING_MESSAGE}</p>
        )}
        {canSubmit && !arrived && unresolved.length > 0 && (
          <p className="mb-2 text-sm font-medium text-amber-800">{UNRESOLVED_TITLE}</p>
        )}
        <div className="flex items-center justify-start gap-3">
          <button
            type="button"
            disabled={sending || submitBlocked}
            onClick={() => submit(false)}
            className="rounded-md bg-brand-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            title={submitTitle}
          >
            {arrived ? 'Sent ✓' : sending ? 'Submitting…' : 'Submit for approval ▶'}
          </button>
          {/* Off once it arrived, as on the create form: a tap while the next
              page loads (or after a replayed answer, which stays) wrote a stray
              DRAFT and swapped "It arrived" for "…until you submit". */}
          <button
            type="button"
            disabled={sending || arrived}
            onClick={() => submit(true)}
            className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-base font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {sending ? 'Saving…' : 'Save draft'}
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

/**
 * Ruling 1 (phase 2): the fields a STALE_FIELDS answer named, each with the
 * value saved now and the two choices. One list at the top, for every field —
 * the form gives most fields no error line of their own (the phase-2 cut: no
 * new error slots); a field that has one also shows the server's words there.
 * The value shown is only ever one of the sender's own fields, on a branch he
 * may edit (services/edits.ts staleFieldsError).
 */
function ConflictList({
  slots,
  conflicts,
  branches,
  channels,
  onChoose,
}: {
  slots: readonly string[];
  conflicts: Conflicts;
  branches: ReadonlyArray<{ id: string }>;
  channels: ChannelWithSubs[];
  onChoose: (slot: string, choice: 'mine' | 'theirs') => void;
}) {
  return (
    <section
      aria-label="Changed after you opened this form"
      className="rounded-md bg-amber-50 px-3 py-3 text-amber-900 ring-1 ring-amber-200"
    >
      <h2 className="text-base font-semibold">Changed after you opened this form</h2>
      <p className="mt-0.5 text-sm">
        Nothing was sent. For each one: keep what you entered, or use the value saved now.
      </p>
      <ul className="mt-2 divide-y divide-amber-200">
        {slots.map((slot) => (
          <li key={slot} className="py-2">
            <p className="text-sm font-semibold">{conflictLabel(slot, branches)}</p>
            <p className="text-sm [overflow-wrap:anywhere]">
              Now: {nowText(slot, conflicts[slot] ?? {}, channels)}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onChoose(slot, 'mine')}
                className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              >
                Keep mine
              </button>
              <button
                type="button"
                onClick={() => onChoose(slot, 'theirs')}
                className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              >
                Use this value
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 'Contact person', or 'Branch 2: Location'. */
function conflictLabel(slot: string, branches: ReadonlyArray<{ id: string }>): string {
  const m = /^branch\.([^.]+)\.(.+)$/.exec(slot);
  if (!m) return fieldLabel(slot);
  const n = branches.findIndex((b) => b.id === m[1]) + 1;
  const what = m[2] === 'gps' ? 'Location' : m[2] === 'equipment' ? 'Equipment' : fieldLabel(slot);
  return `Branch ${n}: ${what}`;
}

/** The value saved now, as a person reads it. */
function nowText(slot: string, live: Readonly<Record<string, BaseValue>>, channels: ChannelWithSubs[]): string {
  const prefix = slot.slice(0, slot.lastIndexOf('.') + 1);
  const at = (f: string) => live[`${prefix}${f}`] ?? null;
  if (slot.startsWith('branch.') && slot.endsWith('.gps')) {
    const lat = at('gpsLat');
    const lng = at('gpsLng');
    if (typeof lat !== 'number' || typeof lng !== 'number') return 'empty';
    const acc = at('gpsAccuracy');
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}${typeof acc === 'number' ? ` (±${Math.round(acc)}m)` : ''}`;
  }
  if (slot.startsWith('branch.') && slot.endsWith('.equipment')) {
    const n = (f: string) => (typeof at(f) === 'number' ? at(f) : 0);
    return `${n('coolersCount')} coolers · ${n('standsCount')} stands · ${n('emptyBottlesCount')} empty bottles · ${
      at('equipmentConfirmed') === true ? 'counted' : 'not counted'
    }`;
  }
  const v = live[slot] ?? null;
  if (v === null || v === '') return 'empty';
  if (slot === 'customer.channelId') {
    return channels.find((c) => c.id === v)?.label ?? 'a channel no longer offered';
  }
  if (slot === 'customer.subChannelId') {
    return (
      channels.flatMap((c) => c.subChannels).find((s) => s.id === v)?.label ?? 'a sub-channel no longer offered'
    );
  }
  return String(v);
}
