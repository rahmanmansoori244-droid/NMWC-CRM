/**
 * Field schemas shared by the CREATE (lib/validation/create.ts) and UPDATE
 * (lib/validation/edit.ts) payloads, so the two forms cannot drift on what a
 * name, a free-text field or a phone number is.
 *
 * N02 (auditor recheck 2026-09-27): the UPDATE schema checked length BEFORE it
 * stripped HTML, so '<shop>' (6 characters raw, nothing once stripped) reached
 * the master as an empty legal name — on the Steward/Manager direct write too.
 * CREATE had already been fixed with strippedStr; every text field on both
 * payloads now goes through the same strip-then-validate helpers below.
 *
 * F19: a phone is checked with isValidPhoneFormat (lib/phone.ts, which folds
 * Arabic-Indic and Persian digits first) and the UPDATE schema outputs its
 * normalized form. The edit service used to call normalizePhone(x) ?? undefined,
 * which dropped an invalid number without a word and reported success.
 */
import { z } from 'zod';
import { INVALID_PHONE_MESSAGE, isValidPhoneFormat, normalizePhone } from '../phone';

export const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').trim();

/**
 * Strip HTML FIRST, then enforce length on what actually gets stored —
 * `min` before `transform` would let '<Shop>' (6 raw chars, empty after
 * strip) reach the DB as an empty legal name. The raw bound (twice the stored
 * one) only stops an absurd payload before the regex runs over it.
 */
export const strippedStr = (min: number, max: number, msg?: string) =>
  z
    .string()
    .max(max * 2)
    .transform(stripHtml)
    .pipe(z.string().min(min, msg).max(max));

/**
 * A text field that must keep a value once it has one (legal name, contact
 * person, branch name, address). Absent from the patch = keep; null = an attempt
 * to remove it, refused with `clearMsg`; a string is stripped, then checked.
 */
export const requiredText = (min: number, max: number, minMsg: string, clearMsg: string) =>
  z
    .string({ invalid_type_error: clearMsg, required_error: clearMsg })
    .max(max * 2)
    .transform(stripHtml)
    .pipe(z.string().min(min, minMsg).max(max));

/**
 * A text field that may be emptied (notes, contact role, landmark, hours,
 * delivery window). null clears it; so does a value that is nothing once
 * stripped ('', '  ', '<b></b>'). `.nullable()` sits on the pipeline rather
 * than a union, so a length error keeps its own message instead of zod's
 * "Invalid input".
 */
export const clearableText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(stripHtml)
    .pipe(z.string().max(max))
    .nullable()
    .transform((v) => (v === '' ? null : v));

/**
 * The UPDATE phone rule: null when blank (the caller decides what blank means),
 * false when it is not a phone (the issue is already added), otherwise the
 * normalized number. Validated first, then normalized — never normalized alone.
 */
function checkPhone(v: string, ctx: z.RefinementCtx): string | null | false {
  const t = v.trim();
  if (!t) return null;
  if (!isValidPhoneFormat(t)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: INVALID_PHONE_MESSAGE });
    return false;
  }
  return normalizePhone(t) as string;
}

/**
 * UPDATE, a phone that must keep a value (primary phone): null or blank is
 * refused with `clearMsg`; a number is validated, then output normalized
 * ('+968XXXXXXXX'), so what is compared and written is what the master holds.
 */
export const requiredPhone = (clearMsg: string) =>
  z.string({ invalid_type_error: clearMsg, required_error: clearMsg }).transform((v, ctx) => {
    const p = checkPhone(v, ctx);
    if (p === false) return z.NEVER;
    if (p === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: clearMsg });
      return z.NEVER;
    }
    return p;
  });

/** UPDATE, a phone that may be emptied (alt phone): null or blank clears it. */
export const clearablePhone = z
  .string()
  .nullable()
  .transform((v, ctx) => {
    if (v === null) return null;
    const p = checkPhone(v, ctx);
    return p === false ? z.NEVER : p;
  });

/**
 * CREATE: the same phone rule, but the value is kept as typed —
 * services/creates.ts normalizes it and stores both, so what CREATE writes does
 * not change. Blank is "not given" there (optionalStr), never reaching this.
 */
export const createPhone = z
  .string()
  .max(40, INVALID_PHONE_MESSAGE)
  .refine(isValidPhoneFormat, INVALID_PHONE_MESSAGE);
