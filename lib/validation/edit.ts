/**
 * Zod schemas for the customer UPDATE payload: the enrichment edit form, and the
 * Steward/Manager direct write through the same action. Parsed on the server
 * (services/edits.ts); the form does not use a resolver.
 *
 * The shape mirrors PRD §5/§6 — Customer-level + Branch-level fields the
 * salesman is allowed to edit. Field locks (Credit customers) are enforced at
 * the service layer using lib/permissions.isFieldLocked, not here.
 *
 * Patch v2 (auditor recheck 2026-09-27, phase 2). The form used to send every
 * field it had loaded, and an empty box meant "leave it" — so an untouched
 * stale value overwrote a newer one (F06) and nothing could ever be cleared
 * (F20). Now:
 *   - a key that is ABSENT keeps the stored value;
 *   - null CLEARS it, only on the fields lib/edit-values.ts lists as clearable,
 *     for every role (every other field refuses null with its own message);
 *   - a value SETS it;
 *   - every key sent carries the value the form loaded for it in `customerBase`
 *     / a branch's `base`, so the server can tell a deliberate change from a
 *     value that moved since the page opened (lib/edit-values.ts);
 *   - text is stripped of HTML BEFORE its length is checked (N02), phones are
 *     validated and normalized (F19), and nothing is coerced — z.coerce turned
 *     null into 0 and into 1970-01-01.
 * `v` must be EDIT_PAYLOAD_VERSION; the service checks it before parsing, so a
 * tab still running the old bundle is told to reload instead of being refused
 * field by field.
 */
import { z } from 'zod';
import { CustomerStatus, DayOfWeek, PaymentTerms } from '@prisma/client';
import { gpsManualReasonSchema } from '../gps-manual';
import { submissionIdSchema } from '../submission';
import {
  BRANCH_EDIT_FIELDS,
  CUSTOMER_EDIT_FIELDS,
  EDIT_PAYLOAD_VERSION,
  GPS_COMPANIONS,
  type BaseValue,
  type BranchEditField,
} from '../edit-values';
import { clearablePhone, clearableText, requiredPhone, requiredText, stripHtml } from './fields';

// Defined beside the field lists so the browser can take it without zod.
export { EDIT_PAYLOAD_VERSION };

/** Before zod: a body without the current `v` is from a page opened before an app update. */
export function isCurrentEditPayload(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === EDIT_PAYLOAD_VERSION;
}

export const DUPLICATE_BRANCH_MESSAGE = 'The same branch is listed twice.';
export const GPS_PAIR_MESSAGE = 'Send the latitude and longitude together.';
export const GPS_COMPANIONS_NEED_POINT_MESSAGE =
  'Accuracy, capture time and a typed-in reason are sent only with a location.';
export const GPS_POINT_NEEDS_COMPANIONS_MESSAGE =
  'Send the capture time and the accuracy (empty when there is none) with the location.';
/**
 * Owner decision 3 (2026-09-29): a SALESMAN only ever sets equipmentConfirmed to
 * true (by ticking, or by entering a count); a Steward or Manager may also set it
 * back to false. The schema accepts both; services/edits.ts refuses a salesman's
 * false with this, on `branch.<id>.equipment`.
 */
export const EQUIPMENT_UNCONFIRM_MESSAGE =
  'Only a Data Steward or a Manager can mark the equipment as not counted.';

const CAPTURED_AT_MESSAGE = 'Send the time the location was captured.';

/** A required cuid (channel): null or '' is an attempt to remove it. */
const requiredId = (clearMsg: string) =>
  z.string({ invalid_type_error: clearMsg, required_error: clearMsg }).min(1, clearMsg).cuid();

/** A clearable cuid (sub-channel): '' and null both clear it. */
const clearableId = z
  .string()
  .nullable()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.string().cuid().nullable());

/** CR number: clearable (owner decision 2026-09-29), trimmed, blank = clear. */
const clearableCr = z
  .string()
  .max(50)
  .nullable()
  .transform((v) => (v === null ? null : v.trim() || null));

const count = (label: string, max: number) =>
  z
    .number({
      invalid_type_error: `${label} cannot be empty — enter 0.`,
      required_error: `${label} cannot be empty — enter 0.`,
    })
    .int(`${label} must be a whole number.`)
    .min(0, `${label} cannot be below 0.`)
    .max(max, `${label} cannot be more than ${max}.`);

/**
 * ISO-8601 with a zone (Z or an offset), or a Date from a server-side caller.
 * Never z.coerce.date: new Date(null) is 1970-01-01.
 */
const capturedAt = z
  .union([z.date(), z.string().datetime({ offset: true, message: CAPTURED_AT_MESSAGE })], {
    errorMap: () => ({ message: CAPTURED_AT_MESSAGE }),
  })
  .transform((v) => (typeof v === 'string' ? new Date(v) : v));

/** What the form loaded for a field: the stored value as JSON carries it. */
export const baseValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function baseShape<F extends string>(fields: readonly F[]) {
  return Object.fromEntries(fields.map((f) => [f, baseValueSchema.optional()])) as {
    [K in F]: z.ZodOptional<typeof baseValueSchema>;
  };
}
/** Keys it does not know are dropped, not refused: only the keys sent in the patch are read. */
const customerBaseSchema = z.object(baseShape(CUSTOMER_EDIT_FIELDS));
const branchBaseSchema = z.object(baseShape(BRANCH_EDIT_FIELDS));

export const customerPatchSchema = z
  .object({
    legalName: requiredText(
      2,
      200,
      'Legal name must be at least 2 characters.',
      'Legal name cannot be removed.'
    ).optional(),
    // Accepted only so that a change can be refused with its own message
    // (services/edits.ts: terms move through Temix or the credit chain).
    paymentTerms: z
      .nativeEnum(PaymentTerms, { invalid_type_error: 'Payment terms cannot be removed.' })
      .optional(),
    crNumber: clearableCr.optional(),
    channelId: requiredId('Channel cannot be removed — pick one.').optional(),
    subChannelId: clearableId.optional(),
    primaryPhone: requiredPhone('Primary phone cannot be removed — enter the correct number.').optional(),
    altPhone: clearablePhone.optional(),
    contactPerson: requiredText(
      2,
      200,
      'Contact person must be at least 2 characters.',
      'Contact person cannot be removed.'
    ).optional(),
    contactRole: clearableText(200).optional(),
    // Never sent by a salesman's form (EL-01: status flips have their own lanes).
    status: z.nativeEnum(CustomerStatus, { invalid_type_error: 'Status cannot be removed.' }).optional(),
    notes: clearableText(5000).optional(),
  })
  .strict();

export const branchPatchSchema = z
  .object({
    branchId: z.string().cuid(),
    branchName: requiredText(1, 200, 'Branch name is required.', 'Branch name cannot be removed.').optional(),
    address: requiredText(
      3,
      500,
      'Address must be at least 3 characters.',
      'Address cannot be removed — correct it instead.'
    ).optional(),
    areaDescription: clearableText(500).optional(),

    // PROD-005: bound to Oman's actual envelope so a faulty device or a
    // copy/paste error can't land coordinates in the Indian Ocean. Oman spans
    // roughly 16°N–27°N and 51°E–60°E; we add ~1° of slack on each edge.
    gpsLat: z
      .number({ invalid_type_error: 'The location cannot be removed.' })
      .min(16, 'Latitude must be inside Oman (≥16°N).')
      .max(27, 'Latitude must be inside Oman (≤27°N).')
      .optional(),
    gpsLng: z
      .number({ invalid_type_error: 'The location cannot be removed.' })
      .min(51, 'Longitude must be inside Oman (≥51°E).')
      .max(61, 'Longitude must be inside Oman (≤61°E).')
      .optional(),
    // GPS companions: only with the point, no base. null = the point has no
    // reported accuracy (a typed-in one).
    gpsAccuracy: z.number().min(0).max(10000).nullable().optional(),
    gpsCapturedAt: capturedAt.optional(),
    // Item 41: present only when the salesman TYPED the point in. Not a Branch
    // column — services/edits.ts turns it into a marker on the gps entries.
    gpsManualReason: gpsManualReasonSchema.optional(),

    dayOfVisit: z
      .nativeEnum(DayOfWeek, {
        invalid_type_error: 'Day of visit cannot be removed once set — pick the right day.',
      })
      .optional(),
    openingHours: clearableText(100).optional(),
    deliveryWindow: clearableText(100).optional(),

    coolersCount: count('Coolers', 100).optional(),
    standsCount: count('Stands', 100).optional(),
    emptyBottlesCount: count('Empty bottles', 1000).optional(),
    // F21: the counts were confirmed at the shop. See EQUIPMENT_UNCONFIRM_MESSAGE.
    equipmentConfirmed: z
      .boolean({ invalid_type_error: 'Say whether the equipment was counted.' })
      .optional(),

    // Steward/Manager only for CLOSED/SUSPENDED flips (QA-009, services/edits.ts).
    status: z.nativeEnum(CustomerStatus, { invalid_type_error: 'Status cannot be removed.' }).optional(),

    /** What the form loaded for every key sent above, except branchId, gpsManualReason and the companions. */
    base: branchBaseSchema,
    /**
     * Ruling 1 ("Keep mine"): fields whose base the user moved to the value
     * found live after a STALE_FIELDS answer, knowingly replacing a value changed
     * after the form was opened. The stored change then carries `overrodeLive`.
     * Names not sent in this patch mean nothing.
     */
    overrides: z.array(z.enum(BRANCH_EDIT_FIELDS)).max(BRANCH_EDIT_FIELDS.length).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    // The point travels whole (ruling 7): both coordinates, with their capture
    // time and accuracy, or none of the four.
    const hasLat = b.gpsLat !== undefined;
    const hasLng = b.gpsLng !== undefined;
    if (hasLat !== hasLng) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [hasLat ? 'gpsLng' : 'gpsLat'], message: GPS_PAIR_MESSAGE });
      return;
    }
    if (hasLat) {
      if (b.gpsCapturedAt === undefined || b.gpsAccuracy === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [b.gpsCapturedAt === undefined ? 'gpsCapturedAt' : 'gpsAccuracy'],
          message: GPS_POINT_NEEDS_COMPANIONS_MESSAGE,
        });
      }
      return;
    }
    for (const k of ['gpsAccuracy', 'gpsCapturedAt', 'gpsManualReason'] as const) {
      if (b[k] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: GPS_COMPANIONS_NEED_POINT_MESSAGE });
        return;
      }
    }
  });

export const submitEditSchema = z
  .object({
    v: z.literal(EDIT_PAYLOAD_VERSION),
    customerId: z.string().cuid(),
    isDraft: z.boolean().default(false),
    /** Item 22: the phone's id for this payload, so a retry is never written twice. */
    submissionId: submissionIdSchema.optional(),
    customer: customerPatchSchema,
    /** What the form loaded for every key sent in `customer`. */
    customerBase: customerBaseSchema,
    /** Ruling 1: as a branch's `overrides`, for the customer's own fields. */
    customerOverrides: z.array(z.enum(CUSTOMER_EDIT_FIELDS)).max(CUSTOMER_EDIT_FIELDS.length).optional(),
    /** Only branches with at least one touched field. */
    branches: z.array(branchPatchSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const b of input.branches) {
      if (seen.has(b.branchId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: DUPLICATE_BRANCH_MESSAGE });
        return;
      }
      seen.add(b.branchId);
    }
  });

export type SubmitEditInput = z.input<typeof submitEditSchema>;
export type ParsedSubmitEdit = z.output<typeof submitEditSchema>;
export type CustomerPatchInput = z.input<typeof customerPatchSchema>;
export type BranchPatchInput = z.input<typeof branchPatchSchema>;
export type CustomerPatch = ParsedSubmitEdit['customer'];
export type BranchPatch = ParsedSubmitEdit['branches'][number];

/** Keys of a branch patch that are not fields, or are fields that carry no base. */
const BRANCH_NO_BASE: ReadonlySet<string> = new Set([
  'branchId',
  'base',
  'overrides',
  'gpsManualReason',
  ...GPS_COMPANIONS,
]);

/**
 * Every key sent without the value the form loaded for it, as `customer.<f>` /
 * `branch.<id>.<f>`. Any at all means the body was not built by this build's
 * form, and services/edits.ts answers FORM_OUTDATED rather than guess what the
 * value was changed from. A base entry may be null (the field was empty); it
 * may not be missing.
 */
export function keysWithoutBase(input: ParsedSubmitEdit): string[] {
  const out: string[] = [];
  const customer = input.customer as Record<string, unknown>;
  const customerBase = input.customerBase as Record<string, BaseValue | undefined>;
  for (const k of Object.keys(customer)) {
    if (customer[k] !== undefined && customerBase[k] === undefined) out.push(`customer.${k}`);
  }
  for (const b of input.branches) {
    const sent = b as Record<string, unknown>;
    const base = b.base as Partial<Record<BranchEditField, BaseValue>>;
    for (const k of Object.keys(sent)) {
      if (BRANCH_NO_BASE.has(k) || sent[k] === undefined) continue;
      if (base[k as BranchEditField] === undefined) out.push(`branch.${b.branchId}.${k}`);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The payload before patch v2 — every field, '' meaning "leave it".
//
// @deprecated Only services/edits.ts still parses this, until it moves to
// submitEditSchema above (phase 2, the server part). Delete it then: nothing
// else may take it up, because it is exactly the shape F06 and F20 are about.
// Kept verbatim from before patch v2; its stripHtml is the one in ./fields,
// which is the same function.
// ─────────────────────────────────────────────────────────────────────────────

const phoneRegex = /^[\d\s\-+()]{7,20}$/;

const legacyCustomerEditSchema = z.object({
  // Identity (locked for Salesman on Credit customers — checked server-side)
  legalName: z.string().min(2).max(200).transform(stripHtml).optional(),
  paymentTerms: z.nativeEnum(PaymentTerms).optional(),
  crNumber: z
    .string()
    .max(50)
    .transform((v) => v.trim())
    .optional()
    .or(z.literal('').transform(() => undefined)),

  // Channel
  channelId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),
  subChannelId: z.string().cuid().optional().or(z.literal('').transform(() => undefined)),

  // Contact
  primaryPhone: z
    .string()
    .regex(phoneRegex, 'Phone must be 7-20 chars: digits, +, -, ( ), spaces')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  altPhone: z
    .string()
    .regex(phoneRegex)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  contactPerson: z.string().min(2).max(200).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),
  contactRole: z.string().max(200).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),

  // Status (mark closed/reactivate)
  status: z.nativeEnum(CustomerStatus).optional(),
  notes: z.string().max(5000).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),
});

const legacyBranchEditSchema = z.object({
  branchId: z.string().cuid(),
  branchName: z.string().min(1).max(200).transform(stripHtml).optional(),
  address: z.string().min(3).max(500).transform(stripHtml).optional(),
  areaDescription: z.string().max(500).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),

  // PROD-005: bound to Oman's actual envelope so a faulty device or a
  // copy/paste error can't land coordinates in the Indian Ocean. Oman spans
  // roughly 16°N–27°N and 51°E–60°E; we add ~1° of slack on each edge.
  gpsLat: z
    .number()
    .min(16, 'Latitude must be inside Oman (≥16°N).')
    .max(27, 'Latitude must be inside Oman (≤27°N).')
    .optional(),
  gpsLng: z
    .number()
    .min(51, 'Longitude must be inside Oman (≥51°E).')
    .max(61, 'Longitude must be inside Oman (≤61°E).')
    .optional(),
  gpsAccuracy: z.number().min(0).max(10000).optional(),
  gpsCapturedAt: z.coerce.date().optional(),
  // Item 41: present only when the salesman TYPED the point in. Not a Branch
  // column — services/edits.ts turns it into a marker on the gps entries.
  gpsManualReason: gpsManualReasonSchema.optional(),

  dayOfVisit: z.nativeEnum(DayOfWeek).optional(),
  openingHours: z.string().max(100).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),
  deliveryWindow: z.string().max(100).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),

  coolersCount: z.coerce.number().int().min(0).max(100).optional(),
  standsCount: z.coerce.number().int().min(0).max(100).optional(),
  emptyBottlesCount: z.coerce.number().int().min(0).max(1000).optional(),

  status: z.nativeEnum(CustomerStatus).optional(),
});

/** @deprecated See the note above: services/edits.ts only, until it parses submitEditSchema. */
export const legacySubmitEditSchema = z.object({
  customerId: z.string().cuid(),
  isDraft: z.boolean().default(false),
  customer: legacyCustomerEditSchema,
  branches: z.array(legacyBranchEditSchema).min(0),
  /** Item 22: the phone's id for this payload, so a retry is never written twice. */
  submissionId: submissionIdSchema.optional(),
});

/** @deprecated See legacySubmitEditSchema. */
export type LegacySubmitEditInput = z.infer<typeof legacySubmitEditSchema>;
