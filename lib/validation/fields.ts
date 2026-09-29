/**
 * Field schemas shared by the CREATE (lib/validation/create.ts) and UPDATE
 * (lib/validation/edit.ts) payloads, so the two forms cannot drift on what a
 * name, a free-text field or a phone number is.
 *
 * N02 (auditor recheck 2026-09-27): the UPDATE schema checked length BEFORE it
 * stripped HTML, so '<shop>' (6 characters raw, nothing once stripped) reached
 * the master as an empty legal name — on the Steward/Manager direct write too.
 * CREATE had already been fixed with strippedStr for its names, while its
 * optional text fields still checked the raw length and stripped after (review
 * of phase 2: '<b></b>' was stored as '', and 5,000 characters of notes wrapped
 * in a tag were refused). Every free-text field on both payloads now goes
 * through the strip-then-validate helpers below: strippedStr / requiredText for
 * the names and the UPDATE address, clearableText for UPDATE's optional text,
 * optionalText for CREATE's. The typed-in GPS reason strips first in its own
 * schema (lib/gps-manual.ts). The CR number, the phones and the ids are not free
 * text — trimmed or checked, never stripped.
 *
 * F19: a phone is checked with isValidPhoneFormat (lib/phone.ts, which folds
 * Arabic-Indic and Persian digits first) and the UPDATE schema outputs its
 * normalized form. The edit service used to call normalizePhone(x) ?? undefined,
 * which dropped an invalid number without a word and reported success.
 */
import { z } from 'zod';
import { INVALID_PHONE_MESSAGE, isValidPhoneFormat, normalizePhone } from '../phone';

/**
 * Every `<…>` tag removed, then trimmed: exactly what `s.replace(/<[^>]+>/g, '')
 * .trim()` returns. That expression took quadratic time on a run of '<' with no
 * '>' after it — from each '<' the regex read to the end of the string looking
 * for one — so 20,000 of them took 0.4 to 1.5 s of CPU in local runs, and the
 * edit payload ran it over every text field of every branch, in any number of
 * branches (adversarial pass after phase 2, finding 4). A tag needs a '>' to
 * close it, so none can start after the last '>': the regex runs only up to
 * it, and the rest is kept as it is. tests/unit/strip-html.test.ts holds the
 * output to the old expression on a seeded random corpus.
 *
 * The only copy: lib/gps-manual.ts and lib/import-row-check.ts call this one.
 */
export const stripHtml = (s: string): string => {
  const end = s.lastIndexOf('>') + 1;
  return (s.slice(0, end).replace(/<[^>]+>/g, '') + s.slice(end)).trim();
};

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
 * CREATE, an optional text field (contact role, notes, address, landmark,
 * hours, delivery window): clearableText's strip-then-validate, but CREATE has
 * nothing to clear, so a value that is nothing once stripped ('', '  ',
 * '<b></b>') is "not given", as an absent one is — services/creates.ts stores
 * either as null, and the address as its '(address pending)' placeholder. The
 * address is still required on submit: the submit gate asks for it
 * (collectMissingForCreate), so a draft can leave it out.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(stripHtml)
    .pipe(z.string().max(max))
    .optional()
    .transform((v) => (v === '' ? undefined : v));

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
