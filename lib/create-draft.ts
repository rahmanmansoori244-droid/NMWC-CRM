/**
 * The new-customer form's copy on the phone (`nmwc:create:<userId>:<editId|new>`
 * and, for the signed-application pages, `nmwc:create:<userId>:signed:<editId>`).
 *
 * Code review 2026-11-10, finding 4: the copy held only the thirteen typed
 * boxes. A reload — Android discarding the tab while the camera is open, a pull
 * down at the top of the page, the Back gesture, a mis-tap on the bottom bar —
 * brought the form back without its shops, GPS points and photos, and a credit
 * request needs seven or more camera shots. After the first Save draft nothing
 * was kept at all.
 *
 * The copy now holds the whole form: the boxes, each shop's boxes and GPS point,
 * and the ids of the photos already uploaded. A photo is on the server the moment
 * it is taken; only its id is kept here, and the server checks every id again
 * when the request is saved (services/creates.ts), so an id that was changed in
 * the phone's storage gains nothing.
 *
 * The stored JSON is flat, and adds to what the old form wrote: the thirteen
 * text keys, `savedAt` and `unanswered` as before, plus
 *   v            2
 *   crPhotoId, guaranteeIds, creditDocs, branches
 *   base         for a copy laid over a saved draft: that draft's version when
 *                the copy was built (CustomerEdit.submissionId; the page passes
 *                it). The copy is put back only over that version.
 *   sent         the ids of this form's own saves that got no answer: a draft
 *                whose version is one of them is still the one this copy grew on.
 *   lastSent     { id, form }: the last send of a never-saved form, with the
 *                form as it was sent — so a reload that finds it landed can tell
 *                whether anything was added since.
 * A copy without `branches` is one the old form wrote (version 1, text only).
 *
 * Pure, and read by hand: no zod (it runs in the browser and in the Sign out
 * count), no React, no storage.
 */
import type { DayOfWeek, PaymentTerms } from '@prisma/client';
import { CREDIT_DOCUMENT_KINDS, MAX_PAGES_PER_DOCUMENT, type CreditDocumentKind } from './credit-documents';

export type CreateDraftGps = {
  lat: number;
  lng: number;
  accuracy?: number;
  /** ISO time. */
  capturedAt: string;
  isManual?: boolean;
  manualReason?: string;
};

export type CreateDraftBranch = {
  branchName: string;
  address: string;
  areaDescription: string;
  gps: CreateDraftGps | null;
  dayOfVisit: DayOfWeek | '';
  openingHours: string;
  deliveryWindow: string;
  coolers: number;
  stands: number;
  bottles: number;
  shopPhotoId: string | null;
  signboardPhotoId: string | null;
  /** By slot position; null for an empty slot. */
  extraPhotoIds: (string | null)[];
};

export type CreateDraftForm = {
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
  creditLimit: string;
  termDays: string;
  email: string;
  crPhotoId: string | null;
  guaranteeIds: string[];
  creditDocs: Record<CreditDocumentKind, string[]>;
  branches: CreateDraftBranch[];
};

/** The text boxes (the payment terms are a choice, kept beside them). */
const TEXT_KEYS = [
  'legalName',
  'crNumber',
  'channelId',
  'subChannelId',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'notes',
  'creditLimit',
  'termDays',
  'email',
] as const;

const DAYS: readonly string[] = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'];

/** What the form allows (it stops adding at ten shops); a copy is never read past them. */
export const MAX_DRAFT_BRANCHES = 10;
const MAX_EXTRA_PHOTOS = 10;
const MAX_GUARANTEES = 10;
const MAX_TEXT = 5000;

/** An attachment id as the app mints them (a cuid): it goes into a photo URL, so nothing else is read. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A submission id's shape (a UUID); the form checks an id it will ask about with the server's own schema. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyCreateBranch(): CreateDraftBranch {
  return {
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
    extraPhotoIds: [],
  };
}

const noDocuments = () =>
  Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, [] as string[]])) as Record<CreditDocumentKind, string[]>;

/** The form as it opens for a new customer: nothing typed, one shop, no photo. */
export function emptyCreateForm(): CreateDraftForm {
  return {
    legalName: '',
    paymentTerms: 'CASH',
    crNumber: '',
    channelId: '',
    subChannelId: '',
    primaryPhone: '',
    altPhone: '',
    contactPerson: '',
    contactRole: '',
    notes: '',
    creditLimit: '',
    termDays: '',
    email: '',
    crPhotoId: null,
    guaranteeIds: [],
    creditDocs: noDocuments(),
    branches: [emptyCreateBranch()],
  };
}

/**
 * The form as one comparable string: what decides "differs from what is saved".
 * Text trimmed (a trailing space is no change), the extra photos without their
 * empty slots, times as written. Two forms that would be saved as the same
 * request compare equal.
 */
export function comparableCreateForm(f: CreateDraftForm): string {
  return JSON.stringify([
    f.paymentTerms,
    TEXT_KEYS.map((k) => f[k].trim()),
    f.crPhotoId,
    f.guaranteeIds,
    CREDIT_DOCUMENT_KINDS.map((k) => f.creditDocs[k] ?? []),
    f.branches.map((b) => [
      b.branchName.trim(),
      b.address.trim(),
      b.areaDescription.trim(),
      b.gps
        ? [
            b.gps.lat,
            b.gps.lng,
            b.gps.accuracy ?? null,
            b.gps.capturedAt,
            b.gps.isManual === true,
            b.gps.isManual === true ? (b.gps.manualReason ?? '') : '',
          ]
        : null,
      b.dayOfVisit,
      b.openingHours.trim(),
      b.deliveryWindow.trim(),
      b.coolers,
      b.stands,
      b.bottles,
      b.shopPhotoId,
      b.signboardPhotoId,
      b.extraPhotoIds.filter((id): id is string => id !== null),
    ]),
  ]);
}

/** What a copy carries, for the line that names it: the shop's name and how much is in it. */
export function createFormSummary(f: CreateDraftForm): {
  name: string;
  shops: number;
  gpsPoints: number;
  photos: number;
} {
  let photos = (f.crPhotoId ? 1 : 0) + f.guaranteeIds.length;
  for (const k of CREDIT_DOCUMENT_KINDS) photos += (f.creditDocs[k] ?? []).length;
  let gpsPoints = 0;
  for (const b of f.branches) {
    if (b.gps) gpsPoints += 1;
    photos += (b.shopPhotoId ? 1 : 0) + (b.signboardPhotoId ? 1 : 0);
    photos += b.extraPhotoIds.filter((id) => id !== null).length;
  }
  return { name: f.legalName.trim(), shops: f.branches.length, gpsPoints, photos };
}

/**
 * Whether a text-only copy (version 1) holds anything the salesman typed. The
 * old autosave wrote an empty copy on every visit, and the next one said
 * "Restored the details you typed" over a blank form (item 22 review): an empty
 * copy is not announced.
 */
export function typedAnything(d: { readonly [key: string]: unknown }): boolean {
  if (d.paymentTerms === 'CREDIT') return true;
  return TEXT_KEYS.some((k) => typeof d[k] === 'string' && (d[k] as string).trim() !== '');
}

export type CreateCopy = {
  /** 1: written by the old form — the text boxes only. 2: the whole form. */
  version: 1 | 2;
  /** The form the copy holds. For a version-1 copy, its text over an otherwise blank form. */
  form: CreateDraftForm;
  /** When its content last changed, by the phone's clock (ms); not a number when unknown. */
  savedAt: unknown;
  unanswered: string[];
  base: string | null;
  sent: string[];
  lastSent: { id: string; form: string } | null;
};

const text = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1_000_000) : 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A list of ids: each a well-formed id, none twice, no more than `max`. */
function idList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const id = idOrNull(x);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function uuidList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((x): x is string => typeof x === 'string' && UUID.test(x));
  return [...new Set(out)].slice(-max);
}

/** A point, or null when it is not one: both coordinates and a readable capture time, or nothing. */
function gpsOf(v: unknown): CreateDraftGps | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as Record<string, unknown>;
  if (!finite(g.lat) || !finite(g.lng)) return null;
  if (typeof g.capturedAt !== 'string' || Number.isNaN(Date.parse(g.capturedAt))) return null;
  const manual = g.isManual === true;
  return {
    lat: g.lat,
    lng: g.lng,
    ...(finite(g.accuracy) ? { accuracy: g.accuracy } : {}),
    capturedAt: g.capturedAt,
    ...(manual ? { isManual: true } : {}),
    ...(manual && typeof g.manualReason === 'string' ? { manualReason: g.manualReason.slice(0, 500) } : {}),
  };
}

function branchOf(v: unknown): CreateDraftBranch | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const blank = emptyCreateBranch();
  const extras = Array.isArray(b.extraPhotoIds) ? b.extraPhotoIds.slice(0, MAX_EXTRA_PHOTOS).map(idOrNull) : [];
  return {
    branchName: text(b.branchName) ?? blank.branchName,
    address: text(b.address) ?? '',
    areaDescription: text(b.areaDescription) ?? '',
    gps: gpsOf(b.gps),
    dayOfVisit: typeof b.dayOfVisit === 'string' && DAYS.includes(b.dayOfVisit) ? (b.dayOfVisit as DayOfWeek) : '',
    openingHours: text(b.openingHours) ?? '',
    deliveryWindow: text(b.deliveryWindow) ?? '',
    coolers: count(b.coolers),
    stands: count(b.stands),
    bottles: count(b.bottles),
    shopPhotoId: idOrNull(b.shopPhotoId),
    signboardPhotoId: idOrNull(b.signboardPhotoId),
    extraPhotoIds: extras,
  };
}

/**
 * Reads a stored copy. Null when there is none or it is not a copy at all.
 * Tolerant otherwise: a key of the wrong type keeps the blank form's value, an
 * id that is not an id is dropped, and nothing past the form's own limits is
 * read (ten shops, ten extra photos and guarantees, four pages a document).
 */
export function parseCreateCopy(raw: string | null | undefined): CreateCopy | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;

  const form = emptyCreateForm();
  for (const k of TEXT_KEYS) {
    const v = text(d[k]);
    if (v !== null) form[k] = v;
  }
  if (d.paymentTerms === 'CASH' || d.paymentTerms === 'CREDIT') form.paymentTerms = d.paymentTerms;

  const version: 1 | 2 = Array.isArray(d.branches) ? 2 : 1;
  if (version === 2) {
    form.crPhotoId = idOrNull(d.crPhotoId);
    form.guaranteeIds = idList(d.guaranteeIds, MAX_GUARANTEES);
    const docs = d.creditDocs && typeof d.creditDocs === 'object' ? (d.creditDocs as Record<string, unknown>) : {};
    for (const k of CREDIT_DOCUMENT_KINDS) form.creditDocs[k] = idList(docs[k], MAX_PAGES_PER_DOCUMENT);
    const branches = (d.branches as unknown[])
      .slice(0, MAX_DRAFT_BRANCHES)
      .map(branchOf)
      .filter((b): b is CreateDraftBranch => b !== null);
    // The form always has a shop.
    form.branches = branches.length > 0 ? branches : [emptyCreateBranch()];
  }

  const last = d.lastSent && typeof d.lastSent === 'object' ? (d.lastSent as Record<string, unknown>) : null;
  return {
    version,
    form,
    savedAt: d.savedAt,
    unanswered: uuidList(d.unanswered, 3),
    base: typeof d.base === 'string' && d.base.length > 0 && d.base.length <= 100 ? d.base : null,
    sent: uuidList(d.sent, 3),
    lastSent:
      last && typeof last.id === 'string' && UUID.test(last.id) && typeof last.form === 'string'
        ? { id: last.id, form: last.form }
        : null,
  };
}

/** The copy as it is stored: flat, the text keys where the old form wrote them. */
export function serializeCreateCopy(copy: {
  form: CreateDraftForm;
  savedAt: number;
  unanswered: readonly string[];
  base?: string | null;
  sent?: readonly string[];
  lastSent?: { id: string; form: string } | null;
}): Record<string, unknown> {
  const { form } = copy;
  return {
    v: 2,
    legalName: form.legalName,
    paymentTerms: form.paymentTerms,
    crNumber: form.crNumber,
    channelId: form.channelId,
    subChannelId: form.subChannelId,
    primaryPhone: form.primaryPhone,
    altPhone: form.altPhone,
    contactPerson: form.contactPerson,
    contactRole: form.contactRole,
    notes: form.notes,
    creditLimit: form.creditLimit,
    termDays: form.termDays,
    email: form.email,
    savedAt: copy.savedAt,
    unanswered: [...copy.unanswered],
    crPhotoId: form.crPhotoId,
    guaranteeIds: form.guaranteeIds,
    creditDocs: form.creditDocs,
    branches: form.branches,
    ...(copy.base ? { base: copy.base } : {}),
    ...(copy.sent && copy.sent.length > 0 ? { sent: [...copy.sent] } : {}),
    ...(copy.lastSent ? { lastSent: copy.lastSent } : {}),
  };
}

/**
 * Whether a stored new-customer copy holds unsent work, for the Sign out count
 * (lib/device-drafts.ts). `slot` is what follows the user id in its key: `new`,
 * a request id, or `signed:<request id>`.
 *   - never saved (`new`): something typed or photographed, or a send that got
 *     no answer and still has to be asked about;
 *   - laid over a saved draft, or the signed-application pages: always — the
 *     forms write those only while they differ from what is saved.
 */
export function createCopyHoldsWork(slot: string, raw: string | null): boolean {
  if (slot !== 'new') return true;
  const copy = parseCreateCopy(raw);
  if (!copy) return true;
  if (copy.unanswered.length > 0) return true;
  if (copy.version === 1) return typedAnything(copy.form);
  return comparableCreateForm(copy.form) !== comparableCreateForm(emptyCreateForm());
}

/* ── The signed-application pages (SignedFormUpload) ─────────────────────── */

export type SignedPagesCopy = {
  savedAt: unknown;
  /** The page as it was rendered when the pages were added (lib/decision-token.ts). */
  token: string;
  ids: string[];
};

/** Reads the signed-application copy: well-formed ids, none twice, no more than `max`. */
export function parseSignedPagesCopy(raw: string | null | undefined, max: number): SignedPagesCopy | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;
  if (typeof d.token !== 'string') return null;
  return { savedAt: d.savedAt, token: d.token, ids: idList(d.ids, max) };
}
