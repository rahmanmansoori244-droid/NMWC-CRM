/**
 * Zod schemas for the enrichment-edit payload submitted by salesmen.
 * Used by both client (react-hook-form resolver) and server (input parsing).
 *
 * The shape mirrors PRD §5/§6 — Customer-level + Branch-level fields the
 * salesman is allowed to edit. Field locks (Credit customers) are enforced at
 * the service layer using lib/permissions.isFieldLocked, not here.
 */
import { z } from 'zod';
import { CustomerStatus, DayOfWeek, PaymentTerms } from '@prisma/client';

const phoneRegex = /^[\d\s\-+()]{7,20}$/;

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').trim();

export const customerEditSchema = z.object({
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

export const branchEditSchema = z.object({
  branchId: z.string().cuid(),
  branchName: z.string().min(1).max(200).transform(stripHtml).optional(),
  address: z.string().min(3).max(500).transform(stripHtml).optional(),
  areaDescription: z.string().max(500).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),

  gpsLat: z.number().min(-90).max(90).optional(),
  gpsLng: z.number().min(-180).max(180).optional(),
  gpsAccuracy: z.number().min(0).max(10000).optional(),
  gpsCapturedAt: z.coerce.date().optional(),

  dayOfVisit: z.nativeEnum(DayOfWeek).optional(),
  openingHours: z.string().max(100).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),
  deliveryWindow: z.string().max(100).transform(stripHtml).optional().or(z.literal('').transform(() => undefined)),

  coolersCount: z.coerce.number().int().min(0).max(100).optional(),
  standsCount: z.coerce.number().int().min(0).max(100).optional(),
  emptyBottlesCount: z.coerce.number().int().min(0).max(1000).optional(),

  status: z.nativeEnum(CustomerStatus).optional(),
});

export const submitEditSchema = z.object({
  customerId: z.string().cuid(),
  isDraft: z.boolean().default(false),
  customer: customerEditSchema,
  branches: z.array(branchEditSchema).min(0),
});

export type SubmitEditInput = z.infer<typeof submitEditSchema>;
export type CustomerEditInput = z.infer<typeof customerEditSchema>;
export type BranchEditInput = z.infer<typeof branchEditSchema>;
