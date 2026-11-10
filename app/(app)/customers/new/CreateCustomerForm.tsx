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
 *    (CASH → SUP→ACC; CREDIT → SUP→SD→signed application→FM→GM→ACC since owner
 *    decisions 2026-10-11) + reveals the credit block.
 *
 * Owner decisions 2026-10-11: a CREDIT request asks for the customer's e-mail
 * and four credit documents (the owner's ID card, the membership certificate,
 * the VAT registration certificate and the tax card, 1..4 pages each —
 * CreditDocumentSlots), and no longer for a guarantee. The guarantee is a switch
 * (lib/credit-documents.ts GUARANTEE_REQUIRED_FOR_CREDIT), off: its slot is not
 * offered, and the guarantees a returned request already carries stay shown,
 * removable, and sent again. A CASH request shows and sends none of these.
 */
import { useCallback, useId, useEffect, useMemo, useRef, useState } from 'react';
import type { DayOfWeek, EditState, PaymentTerms } from '@prisma/client';
import { FormSection } from '@/components/nmwc/FormSection';
import { GpsCaptureButton, type Gps } from '@/components/nmwc/GpsCaptureButton';
import { GPS_MAX_ACCURACY_M, isGpsTooInaccurate } from '@/lib/gps-accuracy';
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
import { LabeledField as Field, errorTiedTo, groupNamedBy } from '@/components/nmwc/LabeledField';
import { typedNumber } from '@/lib/digits';
import {
  DEVICE_DRAFT_MAX_AGE_DAYS,
  createDraftKey,
  deviceDraftExpired,
  draftAgeText,
  onRequestClosed,
  onSignOut,
  signedFormDraftKey,
  sweepExpiredDeviceDrafts,
} from '@/lib/device-drafts';
import {
  comparableCreateForm,
  createFormSummary,
  emptyCreateBranch,
  emptyCreateForm,
  parseCreateCopy,
  serializeCreateCopy,
  type CreateDraftBranch,
  type CreateDraftForm,
} from '@/lib/create-draft';
import {
  LEAVE_FORM_LOST_QUESTION,
  LEAVE_FORM_QUESTION,
  useLeaveGuard,
  useNoPullToRefresh,
} from '@/lib/leave-guard';
import {
  CREDIT_DOCUMENT_KINDS,
  CREDIT_DOCUMENT_LABELS,
  GUARANTEE_REQUIRED_FOR_CREDIT,
  MAX_PAGES_PER_DOCUMENT,
  type CreditDocumentKind,
} from '@/lib/credit-documents';
import { CreditDocumentSlots, documentPages, type DocumentPages } from './CreditDocumentSlots';

type ChannelWithSubs = {
  id: string;
  key: string;
  label: string;
  subChannels: { id: string; key: string; label: string }[];
};

export type CreateFormInitial = {
  editId: string;
  /**
   * Code review 2026-11-10, finding 4: which save of the request this is — the
   * id of its last draft save or submit (CustomerEdit.submissionId), which the
   * page passes. What was added on the phone after a Save draft is put back
   * only over the version it was added to.
   */
  version?: string | null;
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
    /** Owner decisions 2026-10-11: CREDIT only ('' when none is on file). */
    email: string;
  };
  credit: {
    requestedCreditLimit: number | null;
    requestedPaymentTermDays: number | null;
  };
  guaranteeAttachmentIds: string[];
  /** Owner decisions 2026-10-11: each credit document's live pages on file, oldest first. */
  creditDocuments: Record<CreditDocumentKind, string[]>;
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
function extraPositions(ids: ReadonlyArray<string | null>): (string | null)[] {
  return [ids[0] ?? null, ids[1] ?? null, ...ids.slice(2)];
}

/**
 * The rendered error slots: a refusal keyed anything else is said at the top of
 * the form, so a submit never appears to do nothing. Owner decisions 2026-10-11:
 * the e-mail and each credit document's group.
 */
const RENDERED_ERROR_KEYS = new RegExp(
  `^(customer\\.(legalName|crNumber|crPhoto|channelId|subChannelId|primaryPhone|altPhone|contactPerson|contactRole|email)|credit\\.(requestedCreditLimit|requestedPaymentTermDays)|creditDoc\\.(${CREDIT_DOCUMENT_KINDS.join('|')})|guarantee|branch\\.\\d+\\.(branchName|address|areaDescription|gps|dayOfVisit|openingHours|deliveryWindow|shopPhoto|signboardPhoto)|_form)$`
);

/** What the CREDIT choice says (owner decisions 2026-10-11: lib/approval-chains.ts resolveChain). */
export const CREDIT_CHAIN_NOTE =
  "Credit: approval chain is Supervisor → Sales Director → signed application → Finance Manager → GM → Accountant. The customer's e-mail and the four credit documents below are required.";

/** The credit documents' pages as the request on file holds them. */
function initialCreditDocuments(
  docs: Partial<Record<CreditDocumentKind, string[]>> | undefined
): Record<CreditDocumentKind, DocumentPages> {
  return Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, documentPages(docs?.[k] ?? [])])) as Record<
    CreditDocumentKind,
    DocumentPages
  >;
}

let branchKeyCounter = 1;

/** A point's capture time as the copy keeps it. A time that cannot be read is given one fixed value, so the form never differs from itself. */
function isoOf(at: Date): string {
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
}

/**
 * A shop's boxes as the form holds them, from the shape the phone copy keeps
 * (lib/create-draft.ts): a client key of its own, the point's time as a Date,
 * the extra photos by slot position.
 */
function branchState(b: CreateDraftBranch): BState {
  return {
    key: branchKeyCounter++,
    branchName: b.branchName,
    address: b.address,
    areaDescription: b.areaDescription,
    gps: b.gps
      ? {
          lat: b.gps.lat,
          lng: b.gps.lng,
          accuracy: b.gps.accuracy,
          capturedAt: new Date(b.gps.capturedAt),
          ...(b.gps.isManual ? { isManual: true, manualReason: b.gps.manualReason } : {}),
        }
      : null,
    dayOfVisit: b.dayOfVisit,
    openingHours: b.openingHours,
    deliveryWindow: b.deliveryWindow,
    coolers: b.coolers,
    stands: b.stands,
    bottles: b.bottles,
    shopPhotoId: b.shopPhotoId,
    signboardPhotoId: b.signboardPhotoId,
    extraPhotoIds: extraPositions(b.extraPhotoIds),
  };
}

/** …and back: a shop's boxes as the phone copy keeps them. */
function draftOfBranch(s: BState): CreateDraftBranch {
  const g = s.gps;
  return {
    branchName: s.branchName,
    address: s.address,
    areaDescription: s.areaDescription,
    gps: g
      ? {
          lat: g.lat,
          lng: g.lng,
          ...(typeof g.accuracy === 'number' ? { accuracy: g.accuracy } : {}),
          capturedAt: isoOf(g.capturedAt),
          ...(g.isManual ? { isManual: true } : {}),
          ...(g.isManual && typeof g.manualReason === 'string' ? { manualReason: g.manualReason } : {}),
        }
      : null,
    dayOfVisit: s.dayOfVisit,
    openingHours: s.openingHours,
    deliveryWindow: s.deliveryWindow,
    coolers: s.coolers,
    stands: s.stands,
    bottles: s.bottles,
    shopPhotoId: s.shopPhotoId,
    signboardPhotoId: s.signboardPhotoId,
    extraPhotoIds: s.extraPhotoIds,
  };
}

/** The request on file (a draft, a sent-back or a submitted one) as the form's boxes. */
function formOfInitial(initial: CreateFormInitial): CreateDraftForm {
  const ic = initial.customer;
  return {
    legalName: ic.legalName,
    paymentTerms: ic.paymentTerms,
    crNumber: ic.crNumber,
    channelId: ic.channelId,
    subChannelId: ic.subChannelId,
    primaryPhone: ic.primaryPhone,
    altPhone: ic.altPhone,
    contactPerson: ic.contactPerson,
    contactRole: ic.contactRole,
    notes: ic.notes,
    creditLimit:
      initial.credit.requestedCreditLimit != null ? String(initial.credit.requestedCreditLimit) : '',
    termDays:
      initial.credit.requestedPaymentTermDays != null
        ? String(initial.credit.requestedPaymentTermDays)
        : '',
    // Owner decisions 2026-10-11: CREDIT only — shown, checked and sent for credit.
    email: ic.email ?? '',
    crPhotoId: ic.crPhotoAttachmentId ?? null,
    guaranteeIds: [...(initial.guaranteeAttachmentIds ?? [])],
    creditDocs: Object.fromEntries(
      CREDIT_DOCUMENT_KINDS.map((k) => [k, [...(initial.creditDocuments?.[k] ?? [])]])
    ) as Record<CreditDocumentKind, string[]>,
    branches:
      initial.branches.length > 0
        ? initial.branches.map((b) => ({
            branchName: b.branchName,
            address: b.address,
            areaDescription: b.areaDescription,
            gps:
              b.gpsLat != null && b.gpsLng != null
                ? {
                    lat: b.gpsLat,
                    lng: b.gpsLng,
                    ...(b.gpsAccuracy != null ? { accuracy: b.gpsAccuracy } : {}),
                    capturedAt: b.gpsCapturedAt ?? new Date().toISOString(),
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
            extraPhotoIds: b.extraPhotoAttachmentIds,
          }))
        : [emptyCreateBranch()],
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the restored-copy banner shows (code review 2026-11-10, finding 4). */
type RestoreBanner = {
  /** 'new': a never-saved form came back. 'saved': what was added after the last Save draft. */
  kind: 'new' | 'saved';
  savedAt: unknown;
  summary: ReturnType<typeof createFormSummary>;
};

/** v1 copies (text only, written before finding 4 was fixed) keep the words they always had. */
const RESTORED_TEXT_ONLY =
  'Restored the details you typed on this phone. Branch details, GPS points and photos are not kept on the phone — add them again, then tap Save draft to keep everything.';

export function CreateCustomerForm({
  channels,
  initial,
  sessionUserId,
  startedOnOtherRoute = false,
  signedFormOpen = false,
}: {
  channels: ChannelWithSubs[];
  initial: CreateFormInitial | null;
  sessionUserId: string;
  /**
   * A draft or sent-back request started on a route he no longer works:
   * services/creates.ts refuses to save or send it, so it is shown read-only.
   * The page says why above the form and offers Withdraw below it.
   */
  startedOnOtherRoute?: boolean;
  /**
   * The request waits at his signed-application step (SignedFormUpload keeps the
   * pages he has added on the phone): this form, read-only then, leaves that copy
   * alone. At any other step a leftover of it is removed.
   */
  signedFormOpen?: boolean;
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
  // in the phone copy, so a reload can ask the server whether one landed.
  const unansweredRef = useRef<string[]>([]);
  // Finding 4: the same for a SAVED form's saves. The copy laid over a saved
  // draft is put back only over the version of the draft it grew on; a save
  // that got no answer may have become that version, so its id counts too.
  const sentRef = useRef<string[]>([]);
  // …the draft's version as this form knows it (the page's, then each answered
  // save's id), and the last send of a never-saved form with the form as sent.
  const versionRef = useRef<string | null>(initial?.version ?? null);
  const lastSentRef = useRef<{ id: string; form: string } | null>(null);
  // Set once nothing may write the phone copy any more on this page: the
  // request was submitted, or withdrawn, or the reload check found it on the
  // server and is leaving for it — not even an autosave already due, which can
  // fire before the re-render that would clear it. A saved DRAFT does not set
  // it (finding 4): the form goes on keeping what is added after Save draft.
  const phoneCopyGoneRef = useRef(false);
  // And once Sign out has deleted it (lib/device-drafts.ts): the form stays on
  // screen until the sign-in page loads, and its autosave wrote the copy back.
  useEffect(
    () =>
      onSignOut(() => {
        phoneCopyGoneRef.current = true;
      }),
    []
  );
  // The reload check can outlive the form (a tap on Work while it waits);
  // after unmount it must not remove, navigate or say anything.
  const unmountedRef = useRef(false);

  // A SUBMITTED request is read-only for the salesman until it is decided; a
  // withdrawn one (launch fix: REJECTED, services/creates.ts) for good; and one
  // started on a route he has left, which he can only withdraw.
  const closed = initial?.state === 'REJECTED';
  const readOnly = initial?.state === 'SUBMITTED' || closed || startedOnOtherRoute;

  // The boxes the form opens on: the request on file, or a blank form. One
  // value for the life of the form — "Discard these changes" goes back to it.
  const initialFormRef = useRef<CreateDraftForm | null>(null);
  if (initialFormRef.current === null) {
    initialFormRef.current = initial ? formOfInitial(initial) : emptyCreateForm();
  }
  const initialForm = initialFormRef.current;

  const [legalName, setLegalName] = useState(initialForm.legalName);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms>(initialForm.paymentTerms);
  const [crNumber, setCrNumber] = useState(initialForm.crNumber);
  const [channelId, setChannelId] = useState(initialForm.channelId);
  const [subChannelId, setSubChannelId] = useState(initialForm.subChannelId);
  const [primaryPhone, setPrimaryPhone] = useState(initialForm.primaryPhone);
  const [altPhone, setAltPhone] = useState(initialForm.altPhone);
  const [contactPerson, setContactPerson] = useState(initialForm.contactPerson);
  const [contactRole, setContactRole] = useState(initialForm.contactRole);
  const [notes, setNotes] = useState(initialForm.notes);
  const [crPhotoId, setCrPhotoId] = useState<string | null>(initialForm.crPhotoId);
  // Owner decisions 2026-10-11: CREDIT only — shown, checked and sent for credit.
  const [email, setEmail] = useState(initialForm.email);

  const [creditLimit, setCreditLimit] = useState(initialForm.creditLimit);
  const [termDays, setTermDays] = useState(initialForm.termDays);
  // The documents, and the key of the empty slot for the next one: a fresh
  // slot only when a new document is in. It was keyed by the number of
  // documents, so removing another one remounted it mid-upload and let Submit
  // go (item 22 review). One state, so the key moves with the list, never for
  // a document already on it. CreditDocumentSlots renders each list.
  const [guarantees, setGuarantees] = useState<DocumentPages>(() =>
    documentPages(initialForm.guaranteeIds)
  );
  const guaranteeIds = guarantees.ids;
  // Owner decisions 2026-10-11: offered while the switch is on; with it off,
  // only the guarantees a returned request already carries are shown (and kept).
  const showGuarantees = GUARANTEE_REQUIRED_FOR_CREDIT || guaranteeIds.length > 0;
  // The four credit documents, each like the guarantee list.
  const [creditDocs, setCreditDocs] = useState(() => initialCreditDocuments(initialForm.creditDocs));
  const setDocPages = useCallback(
    (kind: CreditDocumentKind) => (update: (p: DocumentPages) => DocumentPages) =>
      setCreditDocs((all) => ({ ...all, [kind]: update(all[kind]) })),
    []
  );

  const [branchStates, setBranchStates] = useState<BState[]>(() => initialForm.branches.map(branchState));
  // The CR slot reads its photo only when it mounts (as every slot does): a
  // restored copy, or a reset, remounts it. The shops remount by their new keys,
  // the document pages by their ids.
  const [slotGen, setSlotGen] = useState(0);

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
    // also count as missing, and NaN fails every comparison. typedNumber reads
    // Arabic-Indic digits and the Arabic decimal mark (lib/digits.ts): with
    // Number(), '٥٠٠' was "missing".
    if (!(typedNumber(creditLimit) > 0)) missingMandatory.push('Credit limit');
    if (!(typedNumber(termDays) >= 1)) missingMandatory.push('Payment term days');
    // Owner decisions 2026-10-11: the e-mail (its format is checked on the
    // server and said beside the field) and a page of each credit document.
    if (!email.trim()) missingMandatory.push('E-mail');
    for (const kind of CREDIT_DOCUMENT_KINDS) {
      if (creditDocs[kind].ids.length === 0) missingMandatory.push(CREDIT_DOCUMENT_LABELS[kind]);
    }
    if (GUARANTEE_REQUIRED_FOR_CREDIT && guaranteeIds.length === 0) missingMandatory.push('Guarantee document');
  }
  branchStates.forEach((s, i) => {
    const tag = `Branch ${i + 1}`;
    if (!s.address.trim() || s.address.trim().length < 3) missingMandatory.push(`${tag} address`);
    if (!s.gps) missingMandatory.push(`${tag} GPS`);
    else if (isGpsTooInaccurate(s.gps.accuracy, s.gps.isManual ? s.gps.manualReason : undefined))
      // The ±100 m standard (lib/gps-accuracy.ts), as collectMissingForCreate applies it.
      missingMandatory.push(`${tag} GPS within ${GPS_MAX_ACCURACY_M} m`);
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

  // ── The copy on the phone (UXI-002 posture: scoped per user + request). ──
  //
  // Code review 2026-11-10, finding 4. It held the typed text only, for a
  // never-saved form only: a reload brought the form back without its shops,
  // GPS points and photos, and after the first Save draft nothing was kept at
  // all. Now the whole form is kept (lib/create-draft.ts) — the photos are on
  // the server already, only their ids are here — and it is kept after Save
  // draft too, under the saved request's own key:
  //   - written only while the form differs from what is saved (a blank form,
  //     the request the page loaded, or the last answered Save draft), removed
  //     when it no longer differs, never on open;
  //   - half a second after a keystroke; at once when a photo or a GPS point is
  //     in; and when the page is hidden, goes or the form unmounts — Android
  //     drops a tab behind the camera without a word;
  //   - put back over a saved draft only when that draft is still the version
  //     the copy grew on (the server stays the source of truth for a draft saved
  //     again from another phone or tab);
  //   - kept seven days from its last change (lib/device-drafts.ts).
  // The automatic server save was not chosen: every open draft blocks its CR
  // number and shop for every salesman, the server refuses a draft with a
  // half-typed phone, and it needs the signal the copy does not.
  const draftKey = `nmwc:create:${sessionUserId}:${editId ?? 'new'}`;

  /** The form's boxes as the copy keeps them. */
  const formNow = useMemo<CreateDraftForm>(
    () => ({
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
      email,
      crPhotoId,
      guaranteeIds,
      creditDocs: Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, creditDocs[k].ids])) as Record<
        CreditDocumentKind,
        string[]
      >,
      branches: branchStates.map(draftOfBranch),
    }),
    [
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
      email,
      crPhotoId,
      guaranteeIds,
      creditDocs,
      branchStates,
    ]
  );
  const comparableNow = useMemo(() => comparableCreateForm(formNow), [formNow]);
  // What is saved, as the form compares itself with it: the boxes it mounted
  // with, then the form as sent by each answered Save draft.
  const baselineRef = useRef<string | null>(null);
  if (baselineRef.current === null) baselineRef.current = comparableNow;
  const dirty = comparableNow !== baselineRef.current;
  // The photos and points alone: a change of these is written at once.
  const mediaKey = useMemo(
    () =>
      JSON.stringify([
        formNow.crPhotoId,
        formNow.guaranteeIds,
        formNow.creditDocs,
        formNow.branches.map((b) => [b.gps, b.shopPhotoId, b.signboardPhotoId, b.extraPhotoIds]),
      ]),
    [formNow]
  );

  // Nothing is written before the restore below has run and its boxes are in
  // (one render, with them): a write from the mount's blank boxes would delete
  // the copy about to be put back.
  const [hydrated, setHydrated] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [banner, setBanner] = useState<RestoreBanner | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // Review of finding 4 (code review 2026-11-10): a never-saved form has ONE
  // slot per salesman, and its copy now carries the shop's GPS point and every
  // photo id. Put back with only a banner, the next shop's form opened filled
  // with the last one: typed over, it went out with the last shop's point and
  // photos, which the server cannot tell apart (they are his own uploads). So
  // a never-saved copy that comes back holds the form until he says which shop
  // it is: "Continue" this one, or "Start a new customer". Nothing in the form
  // can be changed or sent before that. A saved draft's copy is under that
  // draft's own key, so it cannot be another shop's, and is not held.
  const [mustChoose, setMustChoose] = useState<RestoreBanner | null>(null);
  const [confirmingNew, setConfirmingNew] = useState(false);
  // Held until he chooses; a send of it found already on the server (the reload
  // check below) is said instead, with the form locked.
  const choosing = mustChoose !== null && !readOnly && !arrived;
  // The copy as last written or restored, with its save time: its age runs
  // from the last change to it, not from the last visit.
  const stampRef = useRef<{ content: string; savedAt: number } | null>(null);
  // This render's form, for the writers below: they run from timers, page
  // events and the unmount, after the render that armed them.
  const liveRef = useRef({ form: formNow, comparable: comparableNow, key: draftKey, canWrite: false });
  liveRef.current = {
    form: formNow,
    comparable: comparableNow,
    key: draftKey,
    canWrite: hydrated && !readOnly && !arrived,
  };

  /** Writes the copy, or removes it when the form no longer differs from what is saved. */
  const writeCopy = useCallback(() => {
    const live = liveRef.current;
    if (typeof window === 'undefined' || !live.canWrite || phoneCopyGoneRef.current) return;
    try {
      // Nothing unsent, and no send to ask about: no copy. Removed, not just
      // skipped — clearing every field must not leave the old text to return.
      if (live.comparable === baselineRef.current && unansweredRef.current.length === 0) {
        stampRef.current = null;
        window.localStorage.removeItem(live.key);
        setStorageFailed(false);
        return;
      }
      const savedAt =
        stampRef.current?.content === live.comparable ? stampRef.current.savedAt : Date.now();
      window.localStorage.setItem(
        live.key,
        JSON.stringify(
          serializeCreateCopy({
            form: live.form,
            savedAt,
            unanswered: unansweredRef.current,
            base: versionRef.current,
            sent: sentRef.current,
            lastSent: lastSentRef.current,
          })
        )
      );
      stampRef.current = { content: live.comparable, savedAt };
      setStorageFailed(false);
    } catch {
      // A full or blocked storage: said on the form, and the leave question changes.
      setStorageFailed(true);
    }
  }, []);

  /** The request is on the server for good, or closed: the copy goes, and nothing writes it back. */
  const dropPhoneCopy = useCallback(() => {
    phoneCopyGoneRef.current = true;
    unansweredRef.current = [];
    sentRef.current = [];
    try {
      window.localStorage.removeItem(liveRef.current.key);
    } catch {
      /* ignore */
    }
  }, []);

  // Withdrawn (WithdrawRequest, beside this form): the copy of this request goes.
  useEffect(() => onRequestClosed(editId, dropPhoneCopy), [editId, dropPhoneCopy]);

  // The page is hidden (the camera, another app, the tab bar of the phone), is
  // going (a reload, Back), or the form unmounts (a tap on a link): write now —
  // the half-second timer may never fire.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') writeCopy();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', writeCopy);
    unmountedRef.current = false;
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', writeCopy);
      unmountedRef.current = true;
      writeCopy();
    };
  }, [writeCopy]);

  /** Puts a whole form into the boxes: new shop keys and a new CR slot, so every photo slot and GPS chip shows it. */
  const applyForm = useCallback((f: CreateDraftForm) => {
    setLegalName(f.legalName);
    setPaymentTerms(f.paymentTerms);
    setCrNumber(f.crNumber);
    setChannelId(f.channelId);
    setSubChannelId(f.subChannelId);
    setPrimaryPhone(f.primaryPhone);
    setAltPhone(f.altPhone);
    setContactPerson(f.contactPerson);
    setContactRole(f.contactRole);
    setNotes(f.notes);
    setCreditLimit(f.creditLimit);
    setTermDays(f.termDays);
    setEmail(f.email);
    setCrPhotoId(f.crPhotoId);
    setGuarantees(documentPages(f.guaranteeIds));
    setCreditDocs(initialCreditDocuments(f.creditDocs));
    setBranchStates(f.branches.map(branchState));
    setSlotGen((g) => g + 1);
  }, []);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(draftKey);
    } catch {
      raw = null;
    }
    const drop = () => {
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    };
    // This form's own copy is in hand (and said, below); the expired copies of
    // other forms do not stay on the phone for good.
    sweepExpiredDeviceDrafts(sessionUserId);
    if (readOnly) {
      // In review, withdrawn, or on a route he has left: nothing here can be
      // saved, so no copy of it is kept — nor of the signed-application pages
      // once that step is not the one it waits at.
      drop();
      if (editId && !signedFormOpen) {
        try {
          window.localStorage.removeItem(signedFormDraftKey(sessionUserId, editId));
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const copy = parseCreateCopy(raw);
    if (!copy) {
      setHydrated(true);
      return;
    }
    const age = draftAgeText(copy.savedAt);
    const copyComparable = comparableCreateForm(copy.form);
    // Whether it holds anything the boxes do not already show.
    const holds = copyComparable !== baselineRef.current;
    const numericAge = typeof copy.savedAt === 'number' && Number.isFinite(copy.savedAt);

    if (deviceDraftExpired(copy.savedAt)) {
      drop();
      if (holds) {
        setInfo(
          `An unsent copy of this form saved on this phone ${age ?? 'earlier'} was removed: unsent work is kept on the phone for ${DEVICE_DRAFT_MAX_AGE_DAYS} days.`
        );
      }
      setHydrated(true);
      return;
    }

    if (initial) {
      // Over a saved draft: only what was added on this phone to THIS version
      // of it. A draft saved again since (another phone, another tab) is the
      // truth; the copy is dropped, and said.
      const version = initial.version ?? null;
      const grewOnThis =
        copy.version === 2 &&
        copy.base !== null &&
        version !== null &&
        (version === copy.base || copy.sent.includes(version));
      if (!grewOnThis || !holds) {
        drop();
        if (!grewOnThis && copy.version === 2 && holds) {
          setInfo(
            'What you had added on this phone was not restored, because this draft was saved again since (from another phone or tab). The form shows what is saved now — check it and add anything that is missing.'
          );
        }
        setHydrated(true);
        return;
      }
      applyForm(copy.form);
      sentRef.current = copy.sent.filter((x) => x !== version);
      if (numericAge) stampRef.current = { content: copyComparable, savedAt: copy.savedAt as number };
      setBanner({ kind: 'saved', savedAt: copy.savedAt, summary: createFormSummary(copy.form) });
      setHydrated(true);
      return;
    }

    // A never-saved form. A copy the old form wrote (version 1) holds the typed
    // text only, and says so in the words it always had.
    const textOnly = copy.version === 1;
    if (textOnly) {
      const f = copy.form;
      setLegalName(f.legalName);
      setPaymentTerms(f.paymentTerms);
      setCrNumber(f.crNumber);
      setChannelId(f.channelId);
      setSubChannelId(f.subChannelId);
      setPrimaryPhone(f.primaryPhone);
      setAltPhone(f.altPhone);
      setContactPerson(f.contactPerson);
      setContactRole(f.contactRole);
      setNotes(f.notes);
      setCreditLimit(f.creditLimit);
      setTermDays(f.termDays);
      setEmail(f.email);
    } else {
      applyForm(copy.form);
      if (holds) setBanner({ kind: 'new', savedAt: copy.savedAt, summary: createFormSummary(copy.form) });
    }
    // Which shop is it? Asked before anything in it can be changed or sent —
    // the old text-only copy too: it carries the last shop's name and CR number.
    if (holds) setMustChoose({ kind: 'new', savedAt: copy.savedAt, summary: createFormSummary(copy.form) });
    lastSentRef.current = copy.lastSent;
    if (numericAge) stampRef.current = { content: copyComparable, savedAt: copy.savedAt as number };
    const unanswered = copy.unanswered.filter((x) => submissionIdSchema.safeParse(x).success);
    setHydrated(true);
    if (unanswered.length === 0) {
      if (textOnly && holds) setInfo(RESTORED_TEXT_ONLY);
      return;
    }
    // A send got no answer before this reload. Ask before inviting a rebuild.
    unansweredRef.current = unanswered;
    setInfo(
      textOnly
        ? 'Restored the details you typed on this phone. Your last send got no answer — checking whether it arrived…'
        : 'Your last send got no answer — checking whether it arrived…'
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
        // It landed: the request is on the server.
        if (r.receipt.state === 'DRAFT') {
          // A saved draft: open it. If the form holds more than that send
          // carried (a photo taken after it, text typed since), that goes with
          // him: the copy moves under the draft's own key, as grown on the
          // version this send made, and the draft's page puts it back.
          const live = liveRef.current;
          const last = lastSentRef.current;
          const addedSince = !textOnly && !(last?.id === id && last.form === live.comparable);
          if (addedSince) {
            try {
              window.localStorage.setItem(
                createDraftKey(sessionUserId, r.receipt.editId),
                JSON.stringify(
                  serializeCreateCopy({
                    form: live.form,
                    savedAt:
                      stampRef.current?.content === live.comparable ? stampRef.current.savedAt : Date.now(),
                    unanswered: [],
                    base: id,
                  })
                )
              );
            } catch {
              /* It could not be kept: the draft opens as it was saved. */
            }
          }
          // Nothing writes the never-saved copy back — not even an autosave already due.
          dropPhoneCopy();
          setArrived(true);
          hardReplace(`/customers/new?edit=${r.receipt.editId}`);
          return;
        }
        dropPhoneCopy();
        setArrived(true);
        setBanner(null);
        setInfo(`Your last send arrived after all. ${alreadyReceivedMessage(r.receipt)}`);
        return;
      }
      // Off the list: only what was checked and did not land. A send made
      // while the check ran, or one it could not ask about, stays.
      unansweredRef.current = unansweredRef.current.filter((x) => !checked.includes(x));
      writeCopy();
      if (noAnswer) {
        setInfo(
          textOnly
            ? 'Restored the details you typed on this phone. Your last send got no answer and may have arrived — when you have signal, check Work before adding photos again.'
            : 'Your last send got no answer and may have arrived — when you have signal, check Work before you send this form again.'
        );
        return;
      }
      // None landed: the form is all there is.
      setInfo(textOnly ? RESTORED_TEXT_ONLY : null);
    })();
    // Once, on mount (the ref above): the props it reads are this mount's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Half a second after any change (and once the restore is in, and when a
  // saved draft gives the form its own key).
  useEffect(() => {
    // Item 22: nothing is written once the request is in — a typo fixed after
    // "Already received" must not refill the never-saved copy with this shop.
    if (!hydrated || readOnly || arrived) return;
    const handle = setTimeout(writeCopy, 500);
    return () => clearTimeout(handle);
  }, [hydrated, readOnly, arrived, draftKey, comparableNow, formNow, writeCopy]);

  // At once when a photo or a GPS point is in: the next thing he does is open
  // the camera again, and the tab may not come back from it.
  const writtenMediaRef = useRef(mediaKey);
  useEffect(() => {
    if (writtenMediaRef.current === mediaKey) return;
    writtenMediaRef.current = mediaKey;
    writeCopy();
  }, [mediaKey, writeCopy]);

  // After "Start a blank form" / "Discard these changes": write (that is,
  // remove) as soon as the reset boxes are in, not half a second later.
  const writeAfterRenderRef = useRef(false);
  useEffect(() => {
    if (!writeAfterRenderRef.current) return;
    writeAfterRenderRef.current = false;
    writeCopy();
  });

  // Finding 4: leaving with unsent work asks first, and a pull down at the top
  // of the page does not reload it (lib/leave-guard.ts).
  useLeaveGuard(
    !readOnly && !arrived && (dirty || uploading > 0),
    storageFailed ? LEAVE_FORM_LOST_QUESTION : LEAVE_FORM_QUESTION
  );
  useNoPullToRefresh(!readOnly);

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
    email,
    crPhotoId,
    guaranteeIds,
    creditDocs,
    branchStates,
  ]);

  function setBranch(key: number, patch: Partial<BState>) {
    setBranchStates((list) => list.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  /**
   * Finding 4: "Start a blank form" (a never-saved form that came back) and
   * "Discard these changes" (what was added after the last Save draft). The
   * boxes go to a blank form, or to the draft as the page loaded it, and the
   * copy leaves the phone with the next render. A send still to be asked about
   * stays on it. Off while a photo is going up or a send is on its way.
   */
  function resetTo(form: CreateDraftForm) {
    if (submitLockRef.current || uploading > 0 || arrived) return;
    applyForm(form);
    setErrors({});
    setBanner(null);
    setConfirmingReset(false);
    setMustChoose(null);
    setConfirmingNew(false);
    stampRef.current = null;
    writeAfterRenderRef.current = true;
  }

  /**
   * A Save draft is on the server (answered now, or found already there). The
   * form is that request from here on: its address, its key on the phone, and
   * what it compares itself with — the form as it was sent. The copy it was sent
   * from goes; anything added while the save was on its way, or after it, is
   * kept under the request's own key (finding 4: it used to be lost).
   */
  function nowSavedAs(id: string, version: string, sentForm: string) {
    try {
      window.localStorage.removeItem(liveRef.current.key);
    } catch {
      /* ignore */
    }
    unansweredRef.current = [];
    sentRef.current = [];
    lastSentRef.current = null;
    stampRef.current = null;
    baselineRef.current = sentForm;
    versionRef.current = version;
    // Before the render that carries the new id: a write already due must not
    // go to the never-saved slot, where the next new customer would find it.
    liveRef.current = { ...liveRef.current, key: createDraftKey(sessionUserId, id) };
    setEditId(id);
    setBanner(null);
    setConfirmingReset(false);
    // Pin the URL to this request so a refresh resumes it (no reload).
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/customers/new?edit=${id}`);
    }
    writeCopy();
  }

  async function submit(isDraft: boolean) {
    // Try again repeats a Submit too, past the button disabled while a photo is
    // going up. The line beside the button says why nothing happens.
    if (!isDraft && uploading > 0) return;
    // A never-saved copy that came back is not sent before he says it is this shop.
    if (choosing) return;
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
        // Owner decisions 2026-10-11: credit only; never sent for cash.
        email: isCredit ? email.trim() || undefined : undefined,
      },
      credit: isCredit
        ? {
            requestedCreditLimit: creditLimit.trim() ? typedNumber(creditLimit) : undefined,
            requestedPaymentTermDays: termDays.trim() ? typedNumber(termDays) : undefined,
          }
        : undefined,
      // With the guarantee switched off, the ones a returned request carries are
      // still sent: unsent, the submit would release them (services/creates.ts).
      guaranteeAttachmentIds: isCredit ? guaranteeIds : [],
      // Owner decisions 2026-10-11: none for cash, so a request switched to cash
      // releases them.
      creditDocuments: isCredit
        ? (Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, creditDocs[k].ids])) as Record<
            CreditDocumentKind,
            string[]
          >)
        : {},
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
    // The form as this send carries it: what a saved draft is compared with afterwards.
    const sentForm = comparableNow;

    idsRef.current ??= new SubmissionIds();
    // The same payload after no answer keeps its id, so a retry is never written twice.
    const submissionId = idsRef.current.idFor(payload);
    // Item 22: this send's id goes on the phone BEFORE it is sent. A reload or
    // a killed tab mid-send runs no continuation, and the reload must still be
    // able to ask whether it landed (a never-saved form), or know that the
    // draft's new version is its own (a saved one). It comes off when an
    // outcome settles it.
    const neverSaved = !editId;
    const triedBefore = idsRef.current.doubt === 'this';
    const withThis = (ids: string[]) => [...ids.filter((x) => x !== submissionId), submissionId].slice(-3);
    const withoutThis = (ids: string[]) => ids.filter((x) => x !== submissionId);
    if (neverSaved) {
      unansweredRef.current = withThis(unansweredRef.current);
      lastSentRef.current = { id: submissionId, form: sentForm };
    } else {
      sentRef.current = withThis(sentRef.current);
    }
    writeCopy();

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
      const earlierOnPhone = [...unansweredRef.current, ...sentRef.current].some((x) => x !== submissionId);
      setNotice(
        noticeFor(outcome, { doubt: ids.doubt === 'none' && earlierOnPhone ? 'earlier' : ids.doubt })
      );
      {
        // Did not land: refused, or never read and no earlier try of it was.
        const refused = outcome.kind === 'answered' && !outcome.result.ok;
        const unread =
          outcome.kind === 'offline' || outcome.kind === 'signedOut' || outcome.kind === 'maintenance';
        if (refused || (unread && !triedBefore)) {
          if (neverSaved) unansweredRef.current = withoutThis(unansweredRef.current);
          else sentRef.current = withoutThis(sentRef.current);
          writeCopy();
        }
      }
      if (outcome.kind !== 'answered') return;
      const result = outcome.result;
      if (!result.ok) {
        if (result.fields) {
          // Any key without a rendered slot must still surface somewhere —
          // otherwise the submit appears to silently do nothing.
          const orphaned = Object.entries(result.fields).filter(([k]) => !RENDERED_ERROR_KEYS.test(k));
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
        if (res.state === 'DRAFT') {
          nowSavedAs(res.editId, submissionId, sentForm);
        } else {
          dropPhoneCopy();
          if (res.state === 'SUBMITTED' || res.state === 'APPROVED') setArrived(true);
        }
        return;
      }
      if (isDraft) {
        nowSavedAs(res.editId, submissionId, sentForm);
        setNotice({ tone: 'received', text: '✓ Draft saved. Finish and submit when ready.' });
      } else {
        dropPhoneCopy();
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

  const bannerAge = banner ? draftAgeText(banner.savedAt) : null;
  const resetBusy = sending || uploading > 0;

  if (choosing && mustChoose) {
    const held = mustChoose.summary;
    const heldAge = draftAgeText(mustChoose.savedAt);
    const heldName = held.name ? `“${held.name}”` : 'the unsaved form';
    return (
      <div className="space-y-4 p-4 sm:p-6">
        {info && (
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-base font-medium text-emerald-700 ring-1 ring-emerald-200">
            {info}
          </div>
        )}
        <section
          role="alert"
          aria-labelledby={`${uid}-held-title`}
          className="rounded-md bg-amber-50 px-3 py-3 text-amber-900 ring-1 ring-amber-300"
        >
          <h2 id={`${uid}-held-title`} className="text-base font-semibold">
            You have a new customer on this phone that was never saved
          </h2>
          <p className="mt-1 text-sm [overflow-wrap:anywhere]">
            {`“${held.name || 'no name yet'}” — ${plural(held.shops, 'shop')}, ${plural(held.gpsPoints, 'GPS point')}, ${plural(held.photos, 'photo')}. Saved on this phone ${heldAge ?? 'earlier'}.`}
          </p>
          <p className="mt-1 text-sm">
            Is this the shop you are at now? If it is another shop, start a new customer: this
            one’s GPS point and photos must not be sent with it.
          </p>
          {confirmingNew ? (
            <div className="mt-3">
              <p className="text-sm font-medium">
                {`Discard ${heldName}? It was never saved: its photos and GPS point will have to be taken again.`}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => resetTo(emptyCreateForm())}
                  className="min-h-11 rounded-md border border-red-300 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-50"
                >
                  Yes, discard it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingNew(false)}
                  className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setMustChoose(null)}
                className="min-h-11 rounded-md bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 [overflow-wrap:anywhere]"
              >
                {`Continue ${heldName}${heldAge ? ` (saved ${heldAge})` : ''}`}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingNew(true)}
                className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              >
                Start a new customer
              </button>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Launch fix (review): a sent-back request saved as a draft since is a
          DRAFT that still carries the reason (only a submit clears it), and the
          reason vanished after one Save draft. */}
      {(initial?.state === 'NEEDS_CORRECTION' || initial?.state === 'DRAFT') && initial.decisionReason && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          <strong className="font-semibold">Returned for correction:</strong>{' '}
          {initial.decisionReason}
        </div>
      )}
      {closed && (
        <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
          This request was withdrawn and is closed. Start a new request if the shop still needs adding.
        </div>
      )}
      {initial?.state === 'SUBMITTED' && (
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
      {/* Finding 4: what the phone copy put back, how old it is, and the way out.
          Amber, not the green of a success: it is a reminder to check what
          came back (review of finding 4).
          A never-saved form has one slot per salesman, so the banner names the
          shop it holds: at the next shop he starts a blank form instead of
          sending this one's photos and GPS point with it. No layer of its own
          (tests/unit/mobile-submit-bar.test.ts): the two-step confirm is inline. */}
      {banner && dirty && !arrived && (
        <div
          role="status"
          className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-300"
        >
          <p className="text-base font-medium">
            {banner.kind === 'new'
              ? 'Restored the details you typed on this phone — shops, GPS points and photos included.'
              : 'Restored what you added on this phone after your last Save draft.'}
          </p>
          <p className="mt-1 text-sm [overflow-wrap:anywhere]">
            {banner.kind === 'new'
              ? `Saved on this phone${bannerAge ? ` ${bannerAge}` : ''}: “${banner.summary.name || 'no name yet'}” — ${plural(banner.summary.shops, 'shop')}, ${plural(banner.summary.gpsPoints, 'GPS point')}, ${plural(banner.summary.photos, 'photo')}.`
              : `${bannerAge ? `Saved on this phone ${bannerAge}. ` : ''}It is not on the server yet — tap Save draft to keep it.`}
          </p>
          {confirmingReset ? (
            <div className="mt-2">
              <p className="text-sm font-medium">
                {banner.kind === 'new'
                  ? 'Discard this unsent form? Its photos will have to be taken again.'
                  : 'Go back to the draft as it was last saved? What you added since will be lost.'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={resetBusy}
                  onClick={() => resetTo(banner.kind === 'new' ? emptyCreateForm() : initialForm)}
                  className="min-h-11 rounded-md border border-red-300 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
                >
                  {banner.kind === 'new' ? 'Yes, start blank' : 'Yes, discard'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                >
                  {banner.kind === 'new' ? 'Keep it' : 'Keep them'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={resetBusy}
              onClick={() => setConfirmingReset(true)}
              className="mt-2 min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
            >
              {banner.kind === 'new' ? 'Start a blank form' : 'Discard these changes'}
            </button>
          )}
        </div>
      )}
      {storageFailed && !readOnly && !arrived && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 ring-1 ring-amber-200">
          This phone could not keep a copy of this form. Keep this page open, and tap Save draft often.
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
            ? CREDIT_CHAIN_NOTE
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
          <div {...groupNamedBy(`${uid}-crphoto`, errors['customer.crPhoto'])}>
            <p id={`${uid}-crphoto`} className="mb-1 block text-sm font-medium text-slate-700">
              CR document photo *
            </p>
            {errors['customer.crPhoto'] && (
              <p id={`${uid}-crphoto-error`} className="mb-1 text-xs font-medium text-red-600">
                {errors['customer.crPhoto']}
              </p>
            )}
            <div className="w-48">
              <PhotoCaptureSlot
                key={`cr-${slotGen}`}
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
              {...errorTiedTo(`${uid}-channel`, errors['customer.channelId'])}
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
              <p id={`${uid}-channel-error`} className="mt-0.5 text-xs font-medium text-red-600">
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
              {...errorTiedTo(`${uid}-subchannel`, errors['customer.subChannelId'])}
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
              <p id={`${uid}-subchannel-error`} className="mt-0.5 text-xs font-medium text-red-600">
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
          {/* Owner decisions 2026-10-11: asked of a credit customer only. 'off',
              like the phones: the browser would offer the salesman's own address. */}
          {isCredit && (
            <Field
              label="E-mail *"
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={email}
              onChange={setEmail}
              error={errors['customer.email']}
              disabled={readOnly}
              maxLength={254}
            />
          )}
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
        </FormSection>
      )}

      {/* Owner decisions 2026-10-11: the four credit documents, a page or more
          of each, handled like a CR copy (never cached, every view recorded). */}
      {isCredit && (
        <FormSection
          title="Credit documents"
          description={`Take a clear photo of every page — up to ${MAX_PAGES_PER_DOCUMENT} pages each.`}
          defaultOpen
        >
          <div className="grid gap-4">
            {CREDIT_DOCUMENT_KINDS.map((kind) => (
              <CreditDocumentSlots
                key={kind}
                id={`${uid}-doc-${kind}`}
                caption={`${CREDIT_DOCUMENT_LABELS[kind]} *`}
                kind={kind}
                pages={creditDocs[kind]}
                onPagesChange={setDocPages(kind)}
                max={MAX_PAGES_PER_DOCUMENT}
                required
                readOnly={readOnly}
                locked={photosLocked}
                error={errors[`creditDoc.${kind}`]}
                onBusyChange={onPhotoBusy}
              />
            ))}
            {showGuarantees && (
              <CreditDocumentSlots
                id={`${uid}-guarantee`}
                caption={
                  GUARANTEE_REQUIRED_FOR_CREDIT
                    ? 'Guarantee / security documents * (at least one)'
                    : 'Guarantee / security documents already attached (no longer required)'
                }
                kind="GUARANTEE"
                pages={guarantees}
                onPagesChange={setGuarantees}
                max={10}
                // Switched off: the ones on file stay, removable; none is added.
                allowNew={GUARANTEE_REQUIRED_FOR_CREDIT}
                required={GUARANTEE_REQUIRED_FOR_CREDIT}
                readOnly={readOnly}
                locked={photosLocked}
                error={errors['guarantee']}
                onBusyChange={onPhotoBusy}
              />
            )}
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

            <div {...groupNamedBy(`${uid}-gps-${idx}`, errors[`branch.${idx}.gps`])}>
              <p id={`${uid}-gps-${idx}`} className="mb-1 block text-sm font-medium text-slate-700">
                Location * (required to submit)
              </p>
              {errors[`branch.${idx}.gps`] && (
                <p id={`${uid}-gps-${idx}-error`} className="mb-1 text-xs font-medium text-red-600">
                  {errors[`branch.${idx}.gps`]}
                </p>
              )}
              {/* Launch fix: off on a request in review, like every other box —
                  "Recapture GPS" and "Enter coordinates manually" changed the
                  chip on a request nothing here could save. */}
              <GpsCaptureButton
                initial={s.gps}
                // Nothing is on file for a new customer: every point here is
                // judged at submit (finding 19), after a reload too.
                saved={null}
                onCapture={(g) => !readOnly && setBranch(s.key, { gps: g })}
                disabled={readOnly}
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
                  {...errorTiedTo(`${uid}-day-${idx}`, errors[`branch.${idx}.dayOfVisit`])}
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
                  <p id={`${uid}-day-${idx}-error`} className="mt-0.5 text-xs font-medium text-red-600">
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

            <div {...groupNamedBy(`${uid}-equipment-${idx}`)}>
              <p
                id={`${uid}-equipment-${idx}`}
                className="mb-2 block text-sm font-semibold uppercase tracking-wide text-slate-500"
              >
                Equipment at the shop
              </p>
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

            <div
              {...groupNamedBy(
                `${uid}-photos-${idx}`,
                errors[`branch.${idx}.shopPhoto`] ?? errors[`branch.${idx}.signboardPhoto`]
              )}
            >
              <p
                id={`${uid}-photos-${idx}`}
                className="mb-2 block text-sm font-semibold uppercase tracking-wide text-slate-500"
              >
                Photos
              </p>
              <p className="mb-2 text-xs text-slate-500">
                Required: shop front, signboard. Up to 2 extra photos optional.
              </p>
              {(errors[`branch.${idx}.shopPhoto`] || errors[`branch.${idx}.signboardPhoto`]) && (
                <p id={`${uid}-photos-${idx}-error`} className="mb-1 text-xs font-medium text-red-600">
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
          onClick={() => setBranchStates((list) => [...list, branchState(emptyCreateBranch())])}
          className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          + Add another branch
        </button>
      )}

      {!readOnly && (
        <>
          <div className="mb-3" />
          <div className="sticky bottom-[var(--nmwc-tabbar-h,0px)] -mx-4 mt-4 flex flex-col border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:-mx-6 sm:p-6">
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
