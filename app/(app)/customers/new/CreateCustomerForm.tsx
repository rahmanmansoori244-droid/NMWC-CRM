'use client';

/**
 * Net-new customer create-request form (Phase 1 creation flow).
 *
 * Sibling of EnrichmentForm with three structural differences:
 *  - nothing exists yet, so photo slots run PhotoCaptureSlot in UNBOUND mode
 *    (no attachTo) and the form carries the attachment ids; the server claims
 *    them onto the edit at save and binds them to real slots at finalize;
 *  - branches are a dynamic array (add/remove, 1–10) keyed by index;
 *  - paymentTerms is chosen up front and routes the approval chain
 *    (CASH → SUP→ACC, CREDIT → SUP→FM→GM→ACC) + reveals the credit block.
 */
import { useCallback, useId, useEffect, useRef, useState } from 'react';
import type { DayOfWeek, EditState, PaymentTerms } from '@prisma/client';
import { FormSection } from '@/components/nmwc/FormSection';
import { GpsCaptureButton, type Gps } from '@/components/nmwc/GpsCaptureButton';
import { StepperInput } from '@/components/nmwc/StepperInput';
import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';
import {
  fetchCreateReceipt,
  postForm,
  noticeFor,
  SubmissionIds,
  type SubmitNotice,
} from '@/lib/submit-client';
import {
  alreadyReceivedMessage,
  PHOTO_UPLOADING_MESSAGE,
  submissionIdSchema,
  type SubmitReceipt,
} from '@/lib/submission';
import { SubmitNoticeBox } from '@/components/nmwc/SubmitNoticeBox';
import { hardReplace } from '@/lib/navigate';
import { LabeledField as Field } from '@/components/nmwc/LabeledField';

type ChannelWithSubs = {
  id: string;
  key: string;
  label: string;
  subChannels: { id: string; key: string; label: string }[];
};

export type CreateFormInitial = {
  editId: string;
  state: EditState;
  decisionReason: string | null;
  pendingRole: string | null;
  customer: {
    legalName: string;
    paymentTerms: PaymentTerms;
    crNumber: string;
    channelId: string;
    subChannelId: string;
    primaryPhone: string;
    altPhone: string;
    contactPerson: string;
    contactRole: string;
    notes: string;
    crPhotoAttachmentId: string | null;
  };
  credit: {
    requestedCreditLimit: number | null;
    requestedPaymentTermDays: number | null;
  };
  guaranteeAttachmentIds: string[];
  branches: Array<{
    branchName: string;
    address: string;
    areaDescription: string;
    gpsLat: number | null;
    gpsLng: number | null;
    gpsAccuracy: number | null;
    gpsCapturedAt: string | null;
    /** Item 41: the reason, when this draft point was typed in (from the fieldChanges marker). */
    gpsManualReason: string | null;
    dayOfVisit: DayOfWeek | null;
    openingHours: string;
    deliveryWindow: string;
    coolersCount: number;
    standsCount: number;
    emptyBottlesCount: number;
    shopPhotoAttachmentId: string | null;
    signboardPhotoAttachmentId: string | null;
    extraPhotoAttachmentIds: string[];
  }>;
};

const DAYS: DayOfWeek[] = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'];

type BState = {
  /** Stable client key so removal doesn't remount later branches. */
  key: number;
  branchName: string;
  address: string;
  areaDescription: string;
  gps: Gps | null;
  dayOfVisit: DayOfWeek | '';
  openingHours: string;
  deliveryWindow: string;
  coolers: number;
  stands: number;
  bottles: number;
  shopPhotoId: string | null;
  signboardPhotoId: string | null;
  /** By slot position, null for an empty slot — see extraPositions. */
  extraPhotoIds: (string | null)[];
};

/**
 * The extra photos by slot position, never a compacted list (item 22 review).
 * Compacted, a photo moved to another position when a sibling finished or was
 * removed; the slots were keyed by the photo they showed, so a slot still
 * uploading remounted and let Submit go beside its running upload, and each
 * slot's onChange wrote back the list from its own render, dropping the photo
 * that had finished first. Compacted only for the payload. Any photo past the
 * two slots (not reachable from this form) is kept, as before.
 */
function extraPositions(ids: string[]): (string | null)[] {
  return [ids[0] ?? null, ids[1] ?? null, ...ids.slice(2)];
}

/**
 * Whether the never-saved phone copy holds anything the salesman typed. The
 * autosave wrote an empty copy on every visit, and the next one said "Restored
 * the details you typed" over a blank form (item 22 review): an empty copy is
 * not written, and one found anyway is not announced.
 */
function typedAnything(d: Record<string, unknown>): boolean {
  if (d.paymentTerms === 'CREDIT') return true;
  return [
    d.legalName,
    d.crNumber,
    d.channelId,
    d.subChannelId,
    d.primaryPhone,
    d.altPhone,
    d.contactPerson,
    d.contactRole,
    d.notes,
    d.creditLimit,
    d.termDays,
  ].some((v) => typeof v === 'string' && v.trim() !== '');
}

let branchKeyCounter = 1;
function emptyBranch(): BState {
  return {
    key: branchKeyCounter++,
    branchName: 'Main',
    address: '',
    areaDescription: '',
    gps: null,
    dayOfVisit: '',
    openingHours: '',
    deliveryWindow: '',
    coolers: 0,
    stands: 0,
    bottles: 0,
    shopPhotoId: null,
    signboardPhotoId: null,
    extraPhotoIds: extraPositions([]),
  };
}

export function CreateCustomerForm({
  channels,
  initial,
  sessionUserId,
}: {
  channels: ChannelWithSubs[];
  initial: CreateFormInitial | null;
  sessionUserId: string;
}) {
  // UAT-07: one id prefix per form instance, so the labels on the inline
  // selects can point at their controls. Branch rows append their own key.
  const uid = useId();
  // A submit on its way: plain state, not useTransition — while any server
  // action was in flight on the page, `pending` stayed true after the answer
  // (EnrichmentForm says how; post-merge review of 30ec23a).
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const [editId, setEditId] = useState<string | null>(initial?.editId ?? null);
  // Item 22: what happened to the last submit, said beside the button; the
  // submission ids that make a retry safe; and which button the retry repeats.
  const [notice, setNotice] = useState<SubmitNotice | null>(null);
  const idsRef = useRef<SubmissionIds | null>(null);
  const lastWasDraftRef = useRef(false);
  // Set when a retry learns the request had already arrived: nothing to send.
  const [arrived, setArrived] = useState(false);
  // Item 22: ids of sends from this never-saved form that got no answer. Kept
  // in the phone copy, so a reload can ask the server whether one landed — the
  // branches, points and photos never lived on the phone, and without the
  // answer the form could only say "add them again" to a request already in.
  const unansweredRef = useRef<string[]>([]);
  // Set once this form's request is known to be on the server: from then on
  // nothing may write the never-saved phone copy — not even an autosave
  // already due, which can fire before the re-render that would clear it.
  const phoneCopyGoneRef = useRef(false);
  // The reload check can outlive the form (a tap on Work while it waits);
  // after unmount it must not remove, navigate or say anything.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // A SUBMITTED request is read-only for the salesman until it is decided.
  const readOnly = initial?.state === 'SUBMITTED';

  const ic = initial?.customer;
  const [legalName, setLegalName] = useState(ic?.legalName ?? '');
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms>(ic?.paymentTerms ?? 'CASH');
  const [crNumber, setCrNumber] = useState(ic?.crNumber ?? '');
  const [channelId, setChannelId] = useState(ic?.channelId ?? '');
  const [subChannelId, setSubChannelId] = useState(ic?.subChannelId ?? '');
  const [primaryPhone, setPrimaryPhone] = useState(ic?.primaryPhone ?? '');
  const [altPhone, setAltPhone] = useState(ic?.altPhone ?? '');
  const [contactPerson, setContactPerson] = useState(ic?.contactPerson ?? '');
  const [contactRole, setContactRole] = useState(ic?.contactRole ?? '');
  const [notes, setNotes] = useState(ic?.notes ?? '');
  const [crPhotoId, setCrPhotoId] = useState<string | null>(ic?.crPhotoAttachmentId ?? null);

  const [creditLimit, setCreditLimit] = useState(
    initial?.credit.requestedCreditLimit != null ? String(initial.credit.requestedCreditLimit) : ''
  );
  const [termDays, setTermDays] = useState(
    initial?.credit.requestedPaymentTermDays != null
      ? String(initial.credit.requestedPaymentTermDays)
      : ''
  );
  // The documents, and the key of the empty slot for the next one: a fresh
  // slot only when a new document is in. It was keyed by the number of
  // documents, so removing another one remounted it mid-upload and let Submit
  // go (item 22 review). One state, so the key moves with the list, never for
  // a document already on it.
  const [guarantees, setGuarantees] = useState(() => ({
    ids: initial?.guaranteeAttachmentIds ?? [],
    emptySlot: 0,
  }));
  const guaranteeIds = guarantees.ids;

  const [branchStates, setBranchStates] = useState<BState[]>(() => {
    if (initial && initial.branches.length > 0) {
      return initial.branches.map((b) => ({
        key: branchKeyCounter++,
        branchName: b.branchName,
        address: b.address,
        areaDescription: b.areaDescription,
        gps:
          b.gpsLat != null && b.gpsLng != null
            ? {
                lat: b.gpsLat,
                lng: b.gpsLng,
                accuracy: b.gpsAccuracy ?? undefined,
                capturedAt: b.gpsCapturedAt ? new Date(b.gpsCapturedAt) : new Date(),
                // Resuming a draft or a returned request keeps the Manual badge and
                // the reason, so resubmitting does not silently drop them.
                ...(b.gpsManualReason ? { isManual: true, manualReason: b.gpsManualReason } : {}),
              }
            : null,
        dayOfVisit: b.dayOfVisit ?? '',
        openingHours: b.openingHours,
        deliveryWindow: b.deliveryWindow,
        coolers: b.coolersCount,
        stands: b.standsCount,
        bottles: b.emptyBottlesCount,
        shopPhotoId: b.shopPhotoAttachmentId,
        signboardPhotoId: b.signboardPhotoAttachmentId,
        extraPhotoIds: extraPositions(b.extraPhotoAttachmentIds),
      }));
    }
    return [emptyBranch()];
  });

  const subChannels = channels.find((c) => c.id === channelId)?.subChannels ?? [];
  const isCredit = paymentTerms === 'CREDIT';

  // Client mirror of collectMissingForCreate (lib/validation/create.ts) so the
  // salesman gets instant feedback before the server round trip.
  const missingMandatory: string[] = [];
  if (!legalName.trim() || legalName.trim().length < 2) missingMandatory.push('Legal name');
  if (!channelId) missingMandatory.push('Channel');
  if (!subChannelId) missingMandatory.push('Sub-channel');
  if (!primaryPhone.trim()) missingMandatory.push('Primary phone');
  if (!contactPerson.trim()) missingMandatory.push('Contact person');
  if (!crNumber.trim()) missingMandatory.push('CR number');
  if (!crPhotoId) missingMandatory.push('CR document photo');
  if (isCredit) {
    // `!(x > 0)` instead of `x <= 0`: NaN (e.g. a comma-decimal '12,5') must
    // also count as missing, and NaN fails every comparison.
    if (!(Number(creditLimit) > 0)) missingMandatory.push('Credit limit');
    if (!(Number(termDays) >= 1)) missingMandatory.push('Payment term days');
    if (guaranteeIds.length === 0) missingMandatory.push('Guarantee document');
  }
  branchStates.forEach((s, i) => {
    const tag = `Branch ${i + 1}`;
    if (!s.address.trim() || s.address.trim().length < 3) missingMandatory.push(`${tag} address`);
    if (!s.gps) missingMandatory.push(`${tag} GPS`);
    if (!s.dayOfVisit) missingMandatory.push(`${tag} day of visit`);
    if (!s.shopPhotoId) missingMandatory.push(`${tag} shop photo`);
    if (!s.signboardPhotoId) missingMandatory.push(`${tag} signboard photo`);
  });
  // Photos still going up, in every slot (item 22 review). One mid-upload is
  // not in the payload yet — its id arrives only when it is done — and the
  // document load of Work after Submit would abort it.
  const [uploading, setUploading] = useState(0);
  // No NEW photo once a submit is on its way: it could not be in the request
  // that already left, and the /work navigation after the answer would cut
  // its upload off (item 22 review).
  const photosLocked = sending || arrived;
  const onPhotoBusy = useCallback((busy: boolean) => setUploading((n) => n + (busy ? 1 : -1)), []);
  const submitBlocked = readOnly || arrived || uploading > 0 || missingMandatory.length > 0;

  // ── Local draft auto-save (UXI-002 posture: scoped per user + request). ──
  // Only for NEVER-server-saved forms: once a server draft exists (initial !=
  // null) the server is the source of truth — restoring a stale local copy
  // over it would silently mask edits made from another device.
  const draftKey = `nmwc:create:${sessionUserId}:${editId ?? 'new'}`;

  /** Item 22: the sends that may have landed, written to the phone copy at once. */
  const writeUnanswered = useCallback(
    (ids: string[]) => {
      unansweredRef.current = ids;
      if (phoneCopyGoneRef.current) return;
      try {
        const saved = JSON.parse(window.localStorage.getItem(draftKey) ?? '{}');
        window.localStorage.setItem(draftKey, JSON.stringify({ ...saved, unanswered: ids }));
      } catch {
        /* a full or blocked storage only loses the reload check */
      }
    },
    [draftKey]
  );

  /** Item 22: the request is on the server — the never-saved copy goes, for good. */
  const dropPhoneCopy = useCallback(() => {
    phoneCopyGoneRef.current = true;
    unansweredRef.current = [];
    try {
      window.localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [draftKey]);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || readOnly) return;
    restoredRef.current = true;
    if (initial) {
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
      return;
    }
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : null;
    if (!saved) return;
    try {
      const d = JSON.parse(saved);
      if (typeof d.legalName === 'string') setLegalName(d.legalName);
      if (d.paymentTerms === 'CASH' || d.paymentTerms === 'CREDIT') setPaymentTerms(d.paymentTerms);
      if (typeof d.crNumber === 'string') setCrNumber(d.crNumber);
      if (typeof d.channelId === 'string') setChannelId(d.channelId);
      if (typeof d.subChannelId === 'string') setSubChannelId(d.subChannelId);
      if (typeof d.primaryPhone === 'string') setPrimaryPhone(d.primaryPhone);
      if (typeof d.altPhone === 'string') setAltPhone(d.altPhone);
      if (typeof d.contactPerson === 'string') setContactPerson(d.contactPerson);
      if (typeof d.contactRole === 'string') setContactRole(d.contactRole);
      if (typeof d.notes === 'string') setNotes(d.notes);
      if (typeof d.creditLimit === 'string') setCreditLimit(d.creditLimit);
      if (typeof d.termDays === 'string') setTermDays(d.termDays);
      // Item 22: this form was never saved to the server (a server draft would
      // have been loaded instead), so nothing else was kept anywhere. The old
      // text said photos, GPS and branches were "kept on the server".
      const RESTORED =
        'Restored the details you typed on this phone. Branch details, GPS points and photos are not kept on the phone — add them again, then tap Save draft to keep everything.';
      const unanswered: string[] = Array.isArray(d.unanswered)
        ? d.unanswered.filter((x: unknown) => submissionIdSchema.safeParse(x).success)
        : [];
      if (unanswered.length === 0) {
        if (typedAnything(d)) setInfo(RESTORED);
      } else {
        // A send got no answer before this reload. Ask before inviting a rebuild.
        unansweredRef.current = unanswered;
        setInfo(
          'Restored the details you typed on this phone. Your last send got no answer — checking whether it arrived…'
        );
        void (async () => {
          let noAnswer = false;
          const checked: string[] = [];
          for (const id of [...unanswered].reverse()) {
            const r = await fetchCreateReceipt(id);
            // Gone (he moved on): do nothing to the page he is on now.
            if (unmountedRef.current) return;
            if (r.kind === 'noAnswer') {
              noAnswer = true;
              continue;
            }
            checked.push(id);
            if (!r.receipt) continue;
            // It landed: the request is on the server, the phone copy goes, and
            // nothing writes it back — not even an autosave already due.
            dropPhoneCopy();
            setArrived(true);
            if (r.receipt.state === 'DRAFT') {
              // A saved draft: open it, with its branches, points and photos.
              hardReplace(`/customers/new?edit=${r.receipt.editId}`);
              return;
            }
            setInfo(`Your last send arrived after all. ${alreadyReceivedMessage(r.receipt)}`);
            return;
          }
          // Off the list: only what was checked and did not land. A send made
          // while the check ran, or one it could not ask about, stays.
          writeUnanswered(unansweredRef.current.filter((x) => !checked.includes(x)));
          if (noAnswer) {
            setInfo(
              'Restored the details you typed on this phone. Your last send got no answer and may have arrived — when you have signal, check Work before adding photos again.'
            );
            return;
          }
          // None landed: the form is all there is.
          setInfo(RESTORED);
        })();
      }
    } catch {
      /* ignore */
    }
    // restoredRef guards against re-runs; `initial` is stable per mount.
  }, [draftKey, readOnly, initial, dropPhoneCopy, writeUnanswered]);

  useEffect(() => {
    // Item 22: nothing is written once the request is in — a typo fixed after
    // "Already received" must not refill the never-saved copy with this shop.
    if (readOnly || arrived) return;
    const handle = setTimeout(() => {
      if (typeof window === 'undefined' || phoneCopyGoneRef.current) return;
      const copy = {
        legalName,
        paymentTerms,
        crNumber,
        channelId,
        subChannelId,
        primaryPhone,
        altPhone,
        contactPerson,
        contactRole,
        notes,
        creditLimit,
        termDays,
        savedAt: Date.now(),
        unanswered: unansweredRef.current,
      };
      // Nothing typed and no send to ask about: no copy. Removed, not just
      // skipped — clearing every field must not leave the old text to return.
      if (!typedAnything(copy) && unansweredRef.current.length === 0) {
        window.localStorage.removeItem(draftKey);
        return;
      }
      window.localStorage.setItem(draftKey, JSON.stringify(copy));
    }, 500);
    return () => clearTimeout(handle);
  }, [
    readOnly,
    arrived,
    draftKey,
    legalName,
    paymentTerms,
    crNumber,
    channelId,
    subChannelId,
    primaryPhone,
    altPhone,
    contactPerson,
    contactRole,
    notes,
    creditLimit,
    termDays,
  ]);

  // Item 22: a green "saved" or "received" no longer describes the form once it
  // changes; a failure notice stays until the next try replaces it.
  useEffect(() => {
    setNotice((n) => (n?.tone === 'received' ? null : n));
  }, [
    legalName,
    paymentTerms,
    crNumber,
    channelId,
    subChannelId,
    primaryPhone,
    altPhone,
    contactPerson,
    contactRole,
    notes,
    creditLimit,
    termDays,
    crPhotoId,
    guaranteeIds,
    branchStates,
  ]);

  function setBranch(key: number, patch: Partial<BState>) {
    setBranchStates((list) => list.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  async function submit(isDraft: boolean) {
    // Try again repeats a Submit too, past the button disabled while a photo is
    // going up. The line beside the button says why nothing happens.
    if (!isDraft && uploading > 0) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSending(true);
    setErrors({});
    setInfo(null);
    // The notice stays while this try is in flight — its Try again reads
    // "Trying…" under the thumb — and each outcome below replaces it.
    lastWasDraftRef.current = isDraft;

    const payload = {
      editId: editId ?? undefined,
      isDraft,
      customer: {
        legalName: legalName.trim(),
        paymentTerms,
        crNumber: crNumber.trim() || undefined,
        channelId: channelId || undefined,
        subChannelId: subChannelId || undefined,
        primaryPhone: primaryPhone.trim() || undefined,
        altPhone: altPhone.trim() || undefined,
        contactPerson: contactPerson.trim() || undefined,
        contactRole: contactRole.trim() || undefined,
        notes: notes.trim() || undefined,
        crPhotoAttachmentId: crPhotoId ?? undefined,
      },
      credit: isCredit
        ? {
            requestedCreditLimit: creditLimit.trim() ? Number(creditLimit) : undefined,
            requestedPaymentTermDays: termDays.trim() ? Number(termDays) : undefined,
          }
        : undefined,
      guaranteeAttachmentIds: isCredit ? guaranteeIds : [],
      branches: branchStates.map((s) => ({
        branchName: s.branchName.trim() || 'Main',
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
        shopPhotoAttachmentId: s.shopPhotoId ?? undefined,
        signboardPhotoAttachmentId: s.signboardPhotoId ?? undefined,
        extraPhotoAttachmentIds: s.extraPhotoIds.filter((id): id is string => id != null),
      })),
    };

    idsRef.current ??= new SubmissionIds();
    // The same payload after no answer keeps its id, so a retry is never written twice.
    const submissionId = idsRef.current.idFor(payload);
    // Item 22: on a never-saved form this send's id goes on the phone BEFORE it
    // is sent. A reload or a killed tab mid-send runs no continuation, and the
    // reload must still be able to ask whether it landed. It comes off when an
    // outcome settles it.
    const neverSaved = !editId;
    const triedBefore = idsRef.current.doubt === 'this';
    if (neverSaved) {
      writeUnanswered([...unansweredRef.current.filter((x) => x !== submissionId), submissionId].slice(-3));
    }

    try {
      // Item 22: over fetch, not the server action (lib/submit-client.ts).
      const outcome = await postForm<SubmitReceipt>('customer-create', { ...payload, submissionId });
      const ids = idsRef.current!;
      ids.settle(outcome);
      // null for a first-time success; every other outcome is said beside
      // the button. The sends kept on the phone count as a doubt too: after
      // a reload they are not in this form's SubmissionIds, and an offline
      // try read "nothing was sent" over one that may have arrived (item 22
      // review). Read before this send's own id comes off the list below.
      const earlierOnPhone = unansweredRef.current.some((x) => x !== submissionId);
      setNotice(
        noticeFor(outcome, { doubt: ids.doubt === 'none' && earlierOnPhone ? 'earlier' : ids.doubt })
      );
      if (neverSaved) {
        // Did not land: refused, or never read and no earlier try of it was.
        const refused = outcome.kind === 'answered' && !outcome.result.ok;
        const unread =
          outcome.kind === 'offline' || outcome.kind === 'signedOut' || outcome.kind === 'maintenance';
        if (refused || (unread && !triedBefore)) {
          writeUnanswered(unansweredRef.current.filter((x) => x !== submissionId));
        }
      }
      if (outcome.kind !== 'answered') return;
      const result = outcome.result;
      if (!result.ok) {
        if (result.fields) {
          // Any key without a rendered slot must still surface somewhere —
          // otherwise the submit appears to silently do nothing.
          const rendered =
            /^(customer\.(legalName|crNumber|crPhoto|channelId|subChannelId|primaryPhone|altPhone|contactPerson|contactRole)|credit\.(requestedCreditLimit|requestedPaymentTermDays)|guarantee|branch\.\d+\.(branchName|address|areaDescription|gps|dayOfVisit|openingHours|deliveryWindow|shopPhoto|signboardPhoto)|_form)$/;
          const orphaned = Object.entries(result.fields).filter(([k]) => !rendered.test(k));
          setErrors({
            ...result.fields,
            ...(orphaned.length > 0 && !result.fields._form
              ? { _form: orphaned.map(([, v]) => v).join(' · ') }
              : {}),
          });
        }
        return;
      }
      const res = result.data;
      if (res.replayed) {
        // It had already arrived: said above, beside the button. Stay. The
        // request exists on the server now, so the never-saved copy on the
        // phone goes — else the next "New customer" opens pre-filled with
        // this shop. A saved draft becomes this form's request.
        dropPhoneCopy();
        if (res.state === 'DRAFT') {
          setEditId(res.editId);
          if (typeof window !== 'undefined') {
            window.history.replaceState(null, '', `/customers/new?edit=${res.editId}`);
          }
        } else if (res.state === 'SUBMITTED' || res.state === 'APPROVED') {
          setArrived(true);
        }
        return;
      }
      dropPhoneCopy();
      if (isDraft) {
        setEditId(res.editId);
        setNotice({ tone: 'received', text: '✓ Draft saved. Finish and submit when ready.' });
        // Pin the URL to this request so a refresh resumes it (no reload).
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', `/customers/new?edit=${res.editId}`);
        }
      } else {
        // Item 22: said beside the button BEFORE moving on — the next page can
        // be slow or fail to load on weak signal. A document load of Work
        // (lib/navigate.ts): the router cache would still list this as a
        // draft, forward or on Back.
        setArrived(true);
        setNotice({ tone: 'received', text: '✓ Submitted for approval. It arrived — nothing more to do.' });
        hardReplace('/work');
      }
    } finally {
      submitLockRef.current = false;
      setSending(false);
    }
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {initial?.state === 'NEEDS_CORRECTION' && initial.decisionReason && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          <strong className="font-semibold">Returned for correction:</strong>{' '}
          {initial.decisionReason}
        </div>
      )}
      {readOnly && (
        <div className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 ring-1 ring-sky-200">
          This request is in review — current step:{' '}
          <strong>{initial?.pendingRole?.replace('_', ' ') ?? '…'}</strong>. You will be notified
          when it is decided.
        </div>
      )}
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

      <FormSection title="Payment terms" defaultOpen>
        <div className="flex gap-3">
          {(['CASH', 'CREDIT'] as const).map((t) => (
            <label
              key={t}
              className={`flex-1 cursor-pointer rounded-lg border px-4 py-3 text-center text-sm font-semibold transition ${
                paymentTerms === t
                  ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-500'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              } ${readOnly ? 'pointer-events-none opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="paymentTerms"
                value={t}
                checked={paymentTerms === t}
                onChange={() => setPaymentTerms(t)}
                disabled={readOnly}
                className="sr-only"
              />
              {t === 'CASH' ? 'Cash' : 'Credit'}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {isCredit
            ? 'Credit: approval chain is Supervisor → Finance Manager → GM → Accountant, and a credit application is required below.'
            : 'Cash: approval chain is Supervisor → Accountant.'}
        </p>
      </FormSection>

      <FormSection title="Identity" defaultOpen>
        <div className="grid gap-3">
          <Field
            label="Legal name *"
            error={errors['customer.legalName']}
            value={legalName}
            onChange={setLegalName}
            disabled={readOnly}
            maxLength={200}
          />
          <Field
            label="CR number *"
            error={errors['customer.crNumber']}
            value={crNumber}
            onChange={setCrNumber}
            disabled={readOnly}
            maxLength={50}
          />
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              CR document photo *
            </label>
            {errors['customer.crPhoto'] && (
              <p className="mb-1 text-xs font-medium text-red-600">{errors['customer.crPhoto']}</p>
            )}
            <div className="w-48">
              <PhotoCaptureSlot
                kind="CR"
                required
                disabled={readOnly || photosLocked}
                initial={
                  crPhotoId
                    ? { attachmentId: crPhotoId, remoteUrl: `/api/photos/${crPhotoId}` }
                    : null
                }
                onChange={(p) => !readOnly && setCrPhotoId(p?.attachmentId ?? null)}
                onBusyChange={onPhotoBusy}
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
              disabled={readOnly}
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500 disabled:bg-slate-100"
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
              disabled={readOnly}
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm disabled:bg-slate-100"
            >
              <option value="">— Pick a channel —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {errors['customer.channelId'] && (
              <p className="mt-0.5 text-xs font-medium text-red-600">
                {errors['customer.channelId']}
              </p>
            )}
          </div>
          <div>
            <label htmlFor={`${uid}-subchannel`} className="mb-1 block text-sm font-medium text-slate-700">Sub-channel *</label>
            <select
              id={`${uid}-subchannel`}
              value={subChannelId}
              onChange={(e) => setSubChannelId(e.currentTarget.value)}
              disabled={!channelId || readOnly}
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm disabled:bg-slate-100"
            >
              <option value="">— Pick a sub-channel —</option>
              {subChannels.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {errors['customer.subChannelId'] && (
              <p className="mt-0.5 text-xs font-medium text-red-600">
                {errors['customer.subChannelId']}
              </p>
            )}
          </div>
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
            disabled={readOnly}
            maxLength={20}
          />
          <Field
            label="Alt phone"
            type="tel"
            autoComplete="off"
            placeholder="+968 …"
            value={altPhone}
            onChange={setAltPhone}
            error={errors['customer.altPhone']}
            disabled={readOnly}
            maxLength={20}
          />
          <Field
            label="Contact person *"
            value={contactPerson}
            onChange={setContactPerson}
            error={errors['customer.contactPerson']}
            disabled={readOnly}
            maxLength={200}
          />
          <Field
            label="Contact role"
            value={contactRole}
            onChange={setContactRole}
            error={errors['customer.contactRole']}
            disabled={readOnly}
            maxLength={200}
          />
        </div>
      </FormSection>

      {isCredit && (
        <FormSection
          title="Credit application"
          description="Finance Manager and GM approve or reject these requested figures — they cannot amend them."
          defaultOpen
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Requested credit limit (OMR) *"
              placeholder="500.000"
              value={creditLimit}
              onChange={setCreditLimit}
              error={errors['credit.requestedCreditLimit']}
              disabled={readOnly}
              inputMode="decimal"
            />
            <Field
              label="Requested payment term (days) *"
              placeholder="30"
              value={termDays}
              onChange={setTermDays}
              error={errors['credit.requestedPaymentTermDays']}
              disabled={readOnly}
              inputMode="numeric"
            />
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Guarantee / security documents * (at least one)
            </label>
            {errors['guarantee'] && (
              <p className="mb-1 text-xs font-medium text-red-600">{errors['guarantee']}</p>
            )}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {guaranteeIds.map((gid) => (
                <PhotoCaptureSlot
                  key={gid}
                  kind="GUARANTEE"
                  disabled={readOnly || photosLocked}
                  initial={{ attachmentId: gid, remoteUrl: `/api/photos/${gid}` }}
                  onChange={(p) => {
                    if (readOnly) return;
                    const next = p?.attachmentId;
                    // A retake replaces this document in place. Only a removal was
                    // handled: the screen showed the new document while the request
                    // still sent the old id (found by the item-22 review agent).
                    setGuarantees((g) =>
                      !next
                        ? { ...g, ids: g.ids.filter((x) => x !== gid) }
                        : next === gid
                          ? g
                          : {
                              ...g,
                              ids: g.ids
                                .map((x) => (x === gid ? next : x))
                                .filter((x, i, all) => all.indexOf(x) === i),
                            }
                    );
                  }}
                  onBusyChange={onPhotoBusy}
                />
              ))}
              {!readOnly && guaranteeIds.length < 10 && (
                <PhotoCaptureSlot
                  // Reset the empty slot after each successful capture so a
                  // fresh one appears for the next document.
                  key={`empty-${guarantees.emptySlot}`}
                  kind="GUARANTEE"
                  required={guaranteeIds.length === 0}
                  onChange={(p) => {
                    const id = p?.attachmentId;
                    if (id) {
                      setGuarantees((g) =>
                        g.ids.includes(id) ? g : { ids: [...g.ids, id], emptySlot: g.emptySlot + 1 }
                      );
                    }
                  }}
                  onBusyChange={onPhotoBusy}
                  disabled={photosLocked}
                />
              )}
            </div>
          </div>
        </FormSection>
      )}

      {branchStates.map((s, idx) => (
        <FormSection
          key={s.key}
          title={`Branch ${idx + 1}${s.branchName ? ': ' + s.branchName : ''}`}
          description="On your route — region and route are set automatically."
        >
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field
                label="Branch name *"
                value={s.branchName}
                onChange={(v) => setBranch(s.key, { branchName: v })}
                error={errors[`branch.${idx}.branchName`]}
                disabled={readOnly}
                maxLength={200}
              />
              <Field
                label="Address *"
                value={s.address}
                onChange={(v) => setBranch(s.key, { address: v })}
                error={errors[`branch.${idx}.address`]}
                disabled={readOnly}
                textarea
                maxLength={500}
              />
              <Field
                label="Landmark / area description"
                value={s.areaDescription}
                onChange={(v) => setBranch(s.key, { areaDescription: v })}
                error={errors[`branch.${idx}.areaDescription`]}
                disabled={readOnly}
                textarea
                maxLength={500}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                Location * (required to submit)
              </label>
              {errors[`branch.${idx}.gps`] && (
                <p className="mb-1 text-xs font-medium text-red-600">
                  {errors[`branch.${idx}.gps`]}
                </p>
              )}
              <GpsCaptureButton
                initial={s.gps}
                onCapture={(g) => !readOnly && setBranch(s.key, { gps: g })}
                required
              />
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div>
                {/* Keyed on the map index, NOT on s.key: that comes from a
                    module-level counter, which on the server keeps incrementing
                    across requests while the client's starts again at 1 — so the
                    same branch would render one id on the server and another after
                    hydration. The index is stable on both sides and unique within
                    the form. */}
                <label htmlFor={`${uid}-day-${idx}`} className="mb-1 block text-sm font-medium text-slate-700">
                  Day of visit *
                </label>
                <select
                  id={`${uid}-day-${idx}`}
                  value={s.dayOfVisit}
                  onChange={(e) =>
                    setBranch(s.key, { dayOfVisit: e.currentTarget.value as DayOfWeek | '' })
                  }
                  disabled={readOnly}
                  className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm disabled:bg-slate-100"
                >
                  <option value="">—</option>
                  {DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                {errors[`branch.${idx}.dayOfVisit`] && (
                  <p className="mt-0.5 text-xs font-medium text-red-600">
                    {errors[`branch.${idx}.dayOfVisit`]}
                  </p>
                )}
              </div>
              <Field
                label="Opening hours"
                placeholder="08:00 – 22:00"
                value={s.openingHours}
                onChange={(v) => setBranch(s.key, { openingHours: v })}
                error={errors[`branch.${idx}.openingHours`]}
                disabled={readOnly}
                maxLength={100}
              />
              <Field
                label="Delivery window"
                placeholder="10:00 – 14:00"
                value={s.deliveryWindow}
                onChange={(v) => setBranch(s.key, { deliveryWindow: v })}
                error={errors[`branch.${idx}.deliveryWindow`]}
                disabled={readOnly}
                maxLength={100}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold uppercase tracking-wide text-slate-500">
                Equipment at the shop
              </label>
              <div className="grid gap-2 lg:grid-cols-3">
                <StepperInput
                  name={`coolers-${s.key}`}
                  label="Coolers"
                  value={s.coolers}
                  onChange={(n) => setBranch(s.key, { coolers: n })}
                  disabled={readOnly}
                />
                <StepperInput
                  name={`stands-${s.key}`}
                  label="Stands"
                  value={s.stands}
                  onChange={(n) => setBranch(s.key, { stands: n })}
                  disabled={readOnly}
                />
                <StepperInput
                  name={`bottles-${s.key}`}
                  label="Empty bottles"
                  value={s.bottles}
                  onChange={(n) => setBranch(s.key, { bottles: n })}
                  max={1000}
                  disabled={readOnly}
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold uppercase tracking-wide text-slate-500">
                Photos
              </label>
              <p className="mb-2 text-xs text-slate-500">
                Required: shop front, signboard. Up to 2 extra photos optional.
              </p>
              {(errors[`branch.${idx}.shopPhoto`] || errors[`branch.${idx}.signboardPhoto`]) && (
                <p className="mb-1 text-xs font-medium text-red-600">
                  {errors[`branch.${idx}.shopPhoto`] ?? errors[`branch.${idx}.signboardPhoto`]}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <PhotoCaptureSlot
                  kind="SHOP"
                  required
                  disabled={readOnly || photosLocked}
                  capturedLat={s.gps?.lat}
                  capturedLng={s.gps?.lng}
                  initial={
                    s.shopPhotoId
                      ? { attachmentId: s.shopPhotoId, remoteUrl: `/api/photos/${s.shopPhotoId}` }
                      : null
                  }
                  onChange={(p) =>
                    !readOnly && setBranch(s.key, { shopPhotoId: p?.attachmentId ?? null })
                  }
                  onBusyChange={onPhotoBusy}
                />
                <PhotoCaptureSlot
                  kind="SIGNBOARD"
                  required
                  disabled={readOnly || photosLocked}
                  capturedLat={s.gps?.lat}
                  capturedLng={s.gps?.lng}
                  initial={
                    s.signboardPhotoId
                      ? {
                          attachmentId: s.signboardPhotoId,
                          remoteUrl: `/api/photos/${s.signboardPhotoId}`,
                        }
                      : null
                  }
                  onChange={(p) =>
                    !readOnly && setBranch(s.key, { signboardPhotoId: p?.attachmentId ?? null })
                  }
                  onBusyChange={onPhotoBusy}
                />
                {[0, 1].map((slotIdx) => {
                  const existing = s.extraPhotoIds[slotIdx] ?? null;
                  return (
                    <PhotoCaptureSlot
                      // By position only, and each slot writes only its own
                      // position, into the list as it is NOW (extraPositions).
                      key={`extra-${slotIdx}`}
                      kind="FREE"
                      disabled={readOnly || photosLocked}
                      capturedLat={s.gps?.lat}
                      capturedLng={s.gps?.lng}
                      initial={
                        existing
                          ? { attachmentId: existing, remoteUrl: `/api/photos/${existing}` }
                          : null
                      }
                      onChange={(p) => {
                        if (readOnly) return;
                        const id = p?.attachmentId ?? null;
                        setBranchStates((list) =>
                          list.map((b) =>
                            b.key === s.key
                              ? {
                                  ...b,
                                  extraPhotoIds: b.extraPhotoIds.map((v, i) =>
                                    i === slotIdx ? id : v
                                  ),
                                }
                              : b
                          )
                        );
                      }}
                      onBusyChange={onPhotoBusy}
                    />
                  );
                })}
              </div>
            </div>

            {!readOnly && branchStates.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setBranchStates((list) => list.filter((b) => b.key !== s.key))
                }
                className="justify-self-start rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                Remove branch {idx + 1}
              </button>
            )}
          </div>
        </FormSection>
      ))}

      {!readOnly && branchStates.length < 10 && (
        <button
          type="button"
          onClick={() => setBranchStates((list) => [...list, emptyBranch()])}
          className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          + Add another branch
        </button>
      )}

      {!readOnly && (
        <>
          <div className="mb-3" />
          <div className="sticky bottom-0 -mx-4 mt-4 flex flex-col border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:-mx-6 sm:p-6">
            <SubmitNoticeBox
              notice={notice}
              busy={sending}
              onRetry={() => submit(lastWasDraftRef.current)}
            />
            {!arrived && uploading > 0 && (
              <p className="mb-2 text-sm font-medium text-slate-600">{PHOTO_UPLOADING_MESSAGE}</p>
            )}
            <div className="flex items-center justify-start gap-3">
              <button
                type="button"
                disabled={sending || submitBlocked}
                onClick={() => submit(false)}
                className="rounded-md bg-brand-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                title={
                  uploading > 0
                    ? PHOTO_UPLOADING_MESSAGE
                    : missingMandatory.length > 0
                      ? `Missing: ${missingMandatory.join(', ')}`
                      : ''
                }
              >
                {arrived ? 'Sent ✓' : sending ? 'Submitting…' : 'Submit for approval ▶'}
              </button>
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

          {missingMandatory.length > 0 && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              <strong className="font-semibold">Cannot submit yet — missing:</strong>{' '}
              {missingMandatory.join(', ')}. Save as a draft and finish the rest before
              submitting.
            </div>
          )}
        </>
      )}
    </div>
  );
}
