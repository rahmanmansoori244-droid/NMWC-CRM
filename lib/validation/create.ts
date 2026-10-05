/**
 * Zod schemas + pure mandatory-field gate for the net-new-customer CREATE
 * request (Phase 1 creation flow). Sibling of lib/validation/edit.ts but a
 * separate shape on purpose:
 *   - no customerId / branchId — nothing exists yet; branches are keyed by
 *     array index (`branch.<i>.<field>` error keys);
 *   - legalName + paymentTerms are REQUIRED (the salesman names the customer
 *     and picks the chain-routing terms up front);
 *   - route/region are NOT accepted from the client — the server derives both
 *     from the salesman's owned route (owner-confirmed: a salesman creates
 *     only on their own route);
 *   - photo slots carry unbound Attachment ids (bound to real slots at
 *     finalize), so the payload has *AttachmentId fields the edit schema
 *     never needed.
 */
import { z } from 'zod';
import { submissionIdSchema } from '../submission';
import { DayOfWeek, PaymentTerms } from '@prisma/client';
import { gpsManualReasonSchema } from '../gps-manual';
import { isGpsTooInaccurate, gpsTooInaccurateMessage } from '../gps-accuracy';
// stripHtml / strippedStr moved to ./fields so the UPDATE payload strips before it
// validates too (N02); the optional text fields below moved to optionalText there
// (review of phase 2), because they checked the raw length and stripped after.
// Phones: UXI-006 accepted Arabic-Indic digits here with a
// regex of its own, which refused the Persian digits lib/phone.ts now folds and
// let through strings it could not normalize; createPhone applies isValidPhoneFormat
// itself (F19). The value stays as typed — services/creates.ts normalizes it.
import { cappedArray, createPhone, optionalText, strippedStr } from './fields';

/**
 * The limits a create request always had: 10 branches, and 10 attachments in
 * each list (the form offers 10 branches, 10 guarantee documents and two extra
 * photos a branch). Each array's length is now checked before any element is
 * read (cappedArray): zod's own .max(10) parsed every element of a longer array
 * first, and 300,000 empty branches (a 0.9 MB body) took 14 s to be refused in
 * a local run (review of the fix for the adversarial pass after phase 2,
 * finding 4).
 */
export const MAX_CREATE_BRANCHES = 10;
export const MAX_CREATE_ATTACHMENTS = 10;
export const TOO_MANY_CREATE_BRANCHES_MESSAGE = `One request can add at most ${MAX_CREATE_BRANCHES} branches.`;
export const TOO_MANY_EXTRA_PHOTOS_MESSAGE = `A branch can have at most ${MAX_CREATE_ATTACHMENTS} extra photos.`;
export const TOO_MANY_GUARANTEES_MESSAGE = `A request can have at most ${MAX_CREATE_ATTACHMENTS} guarantee documents.`;

const optionalStr = <T extends z.ZodTypeAny>(schema: T) =>
  schema.optional().or(z.literal('').transform(() => undefined));

export const createCustomerDraftSchema = z.object({
  legalName: strippedStr(2, 200, 'Legal name must be at least 2 characters.'),
  // Routing key: CASH → SUP→ACC chain; CREDIT → SUP→FM→GM→ACC chain.
  paymentTerms: z.nativeEnum(PaymentTerms),
  crNumber: optionalStr(z.string().max(50).transform((v) => v.trim())),
  channelId: optionalStr(z.string().cuid()),
  subChannelId: optionalStr(z.string().cuid()),
  primaryPhone: optionalStr(createPhone),
  altPhone: optionalStr(createPhone),
  contactPerson: optionalStr(strippedStr(2, 200, 'Contact person must be at least 2 characters.')),
  contactRole: optionalText(200),
  notes: optionalText(5000),
  crPhotoAttachmentId: optionalStr(z.string().cuid()),
});

export const createBranchDraftSchema = z.object({
  branchName: strippedStr(1, 200, 'Branch name is required.'),
  address: optionalText(500),
  areaDescription: optionalText(500),
  // PROD-005 Oman envelope — same bounds as branchEditSchema.
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
  // Item 41: present only when the point was typed in. Not an EditBranchDraft
  // column — services/creates.ts stores it as a marker in fieldChanges.
  gpsManualReason: gpsManualReasonSchema.optional(),
  dayOfVisit: z.nativeEnum(DayOfWeek).optional(),
  openingHours: optionalText(100),
  deliveryWindow: optionalText(100),
  coolersCount: z.coerce.number().int().min(0).max(100).default(0),
  standsCount: z.coerce.number().int().min(0).max(100).default(0),
  emptyBottlesCount: z.coerce.number().int().min(0).max(1000).default(0),
  shopPhotoAttachmentId: optionalStr(z.string().cuid()),
  signboardPhotoAttachmentId: optionalStr(z.string().cuid()),
  extraPhotoAttachmentIds: cappedArray(
    z.array(z.string().cuid()),
    MAX_CREATE_ATTACHMENTS,
    TOO_MANY_EXTRA_PHOTOS_MESSAGE
  ).default([]),
});

export const submitCreateSchema = z.object({
  /** Present when resuming a DRAFT or re-submitting after NEEDS_CORRECTION. */
  editId: z.string().cuid().optional(),
  isDraft: z.boolean().default(false),
  customer: createCustomerDraftSchema,
  /** Item 22: the phone's id for this payload, so a retry is never written twice. */
  submissionId: submissionIdSchema.optional(),
  /**
   * CREDIT application figures. FM/GM approve or reject these REQUESTED
   * values — no amendment (owner-confirmed) — and finalize copies them onto
   * Customer.creditLimit / paymentTermDays verbatim.
   * OMR Decimal(14,3): ≤3 decimal places, exact in an IEEE double at this
   * magnitude (≤1e11 × 1000 < 2^53).
   */
  credit: z
    .object({
      requestedCreditLimit: z.coerce
        .number()
        .positive('Credit limit must be greater than zero.')
        .max(99_999_999_999)
        .transform((v) => Math.round(v * 1000) / 1000)
        .optional(),
      requestedPaymentTermDays: z.coerce
        .number()
        .int()
        .min(1, 'Payment term must be at least 1 day.')
        .max(365)
        .optional(),
    })
    .optional(),
  /** Guarantee / security documents (CREDIT): unbound GUARANTEE attachments. */
  guaranteeAttachmentIds: cappedArray(
    z.array(z.string().cuid()),
    MAX_CREATE_ATTACHMENTS,
    TOO_MANY_GUARANTEES_MESSAGE
  ).default([]),
  branches: cappedArray(
    z.array(createBranchDraftSchema).min(1, 'At least one branch is required.'),
    MAX_CREATE_BRANCHES,
    TOO_MANY_CREATE_BRANCHES_MESSAGE
  ),
});

export type SubmitCreateInput = z.input<typeof submitCreateSchema>;
export type ParsedSubmitCreate = z.output<typeof submitCreateSchema>;

/**
 * Mandatory-field gate for SUBMITTING a create request (drafts bypass).
 * Mirrors the UPDATE-flow collectMissingMandatory rules (PRD §6) plus the
 * owner-confirmed credit block. Pure — unit-tested in
 * tests/unit/create-flow.test.ts. Keys match the form's error slots:
 * `customer.<f>`, `credit.<f>`, `branch.<i>.<f>`, `guarantee`.
 *
 * Note crNumber is required for BOTH payment terms on a net-new customer
 * (owner-confirmed) — unlike the UPDATE flow where a salesman may be locked
 * out of the CR field on CREDIT customers.
 */
export function collectMissingForCreate(input: ParsedSubmitCreate): Record<string, string> {
  const errors: Record<string, string> = {};
  const c = input.customer;
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  if (!isStr(c.channelId)) errors['customer.channelId'] = 'Channel is required.';
  if (!isStr(c.subChannelId)) errors['customer.subChannelId'] = 'Sub-channel is required.';
  if (!isStr(c.primaryPhone)) errors['customer.primaryPhone'] = 'Primary phone is required.';
  if (!isStr(c.contactPerson)) errors['customer.contactPerson'] = 'Contact person is required.';
  if (!isStr(c.crNumber)) errors['customer.crNumber'] = 'CR number is required.';
  if (!isStr(c.crPhotoAttachmentId)) {
    errors['customer.crPhoto'] = 'CR document photo is required.';
  }

  if (c.paymentTerms === PaymentTerms.CREDIT) {
    if (!isNum(input.credit?.requestedCreditLimit) || input.credit!.requestedCreditLimit! <= 0) {
      errors['credit.requestedCreditLimit'] = 'Requested credit limit (OMR) is required.';
    }
    if (
      !isNum(input.credit?.requestedPaymentTermDays) ||
      input.credit!.requestedPaymentTermDays! < 1
    ) {
      errors['credit.requestedPaymentTermDays'] = 'Requested payment term (days) is required.';
    }
    if (input.guaranteeAttachmentIds.length === 0) {
      errors['guarantee'] = 'At least one guarantee / security document is required for credit.';
    }
  }

  input.branches.forEach((b, i) => {
    const tag = `Branch ${i + 1}`;
    if (!isStr(b.address) || b.address!.trim().length < 3) {
      errors[`branch.${i}.address`] = `${tag}: address is required.`;
    }
    if (!isNum(b.gpsLat) || !isNum(b.gpsLng)) {
      errors[`branch.${i}.gps`] = `${tag}: GPS coordinates are required.`;
    } else if (isGpsTooInaccurate(b.gpsAccuracy, b.gpsManualReason)) {
      // The ±100 m standard (lib/gps-accuracy.ts): a captured point only.
      errors[`branch.${i}.gps`] = gpsTooInaccurateMessage(tag, b.gpsAccuracy as number);
    }
    if (!isStr(b.dayOfVisit)) {
      errors[`branch.${i}.dayOfVisit`] = `${tag}: day of visit is required.`;
    }
    if (!isStr(b.shopPhotoAttachmentId)) {
      errors[`branch.${i}.shopPhoto`] = `${tag}: shop photo is required.`;
    }
    if (!isStr(b.signboardPhotoAttachmentId)) {
      errors[`branch.${i}.signboardPhoto`] = `${tag}: signboard photo is required.`;
    }
  });

  return errors;
}

/**
 * Cycle counter on (re-)submit of the SAME CustomerEdit row (CREATE requests
 * reuse their row across NEEDS_CORRECTION → resubmit because the row owns the
 * drafts/attachments/credit data — owner-confirmed).
 *
 * INVARIANT (see submitEditCore's chainFields comment): the step-back loop
 * guard and separation-of-duty queries key EditApproval rows off `cycle`. Any
 * transition INTO SUBMITTED on a row that was ever submitted before MUST bump
 * the cycle, or stale prior-cycle decisions poison those queries. `submittedAt`
 * is the "was ever submitted" marker — it survives a NEEDS_CORRECTION →
 * save-as-DRAFT detour, so the bump cannot be dodged by drafting first.
 */
export function resolveCycleOnSubmit(
  prior: { cycle: number; submittedAt: Date | null },
  isDraft: boolean
): number {
  if (isDraft) return prior.cycle;
  return prior.submittedAt ? prior.cycle + 1 : prior.cycle;
}

/** Collect every attachment id referenced by a create payload (deduped check is the caller's). */
export function collectAttachmentIds(input: ParsedSubmitCreate): {
  all: string[];
  byKind: Array<{ id: string; expect: 'CR' | 'SHOP' | 'SIGNBOARD' | 'FREE' | 'GUARANTEE' }>;
} {
  const byKind: Array<{ id: string; expect: 'CR' | 'SHOP' | 'SIGNBOARD' | 'FREE' | 'GUARANTEE' }> =
    [];
  if (input.customer.crPhotoAttachmentId) {
    byKind.push({ id: input.customer.crPhotoAttachmentId, expect: 'CR' });
  }
  for (const g of input.guaranteeAttachmentIds) byKind.push({ id: g, expect: 'GUARANTEE' });
  for (const b of input.branches) {
    if (b.shopPhotoAttachmentId) byKind.push({ id: b.shopPhotoAttachmentId, expect: 'SHOP' });
    if (b.signboardPhotoAttachmentId) {
      byKind.push({ id: b.signboardPhotoAttachmentId, expect: 'SIGNBOARD' });
    }
    for (const x of b.extraPhotoAttachmentIds) byKind.push({ id: x, expect: 'FREE' });
  }
  return { all: byKind.map((e) => e.id), byKind };
}
