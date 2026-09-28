/**
 * Oman phone normalization.
 * Goal: every reasonable user input is reduced to a single canonical form so
 * uniqueness checks and search work correctly. The canonical form is:
 *   +968XXXXXXXX  (8 local digits)
 *
 * Rules:
 * - Convert Arabic-Indic digits (٠..٩) to ASCII digits — Arabic keyboards on
 *   Omani Android phones are common and JS `\d` is ASCII-only by default
 *   (UXI-006). Without this, perfectly typed `٩١٢٣٤٥٦٧` returned null.
 * - F19 (auditor recheck 2026-09-27): Extended Arabic-Indic / Persian digits
 *   (۰..۹, U+06F0–U+06F9) too. Some Arabic keyboards type those, and lib/cr.ts
 *   has folded them in CR numbers since item 16; a phone typed on the same
 *   keyboard was refused while its CR was accepted.
 * - Strip everything else that is not a digit or '+'.
 * - Accept 8 local digits, or 11 digits with country prefix `968`, or `00968`.
 * - Reject anything that doesn't match those — previous code returned a
 *   "best-effort" 12-digit junk string, which the partial unique index later
 *   collided on. Better to reject loudly so the user can fix the source.
 *
 * lib/scrub.ts PHONE_PATTERN must redact every form accepted here: a digit
 * class added to this file is added there in the same change.
 */

/** What every form says about a phone this file refuses (CREATE, UPDATE). */
export const INVALID_PHONE_MESSAGE = 'Enter a valid Oman number (8 digits, or +968 XXXXXXXX).';

// Each range is written as escapes, as in lib/cr.ts: two blocks of look-alike
// digits are easier to review as code points than as glyphs.
const ARABIC_INDIC_DIGIT = /[٠-٩]/g;
const PERSIAN_DIGIT = /[۰-۹]/g;

function asciifyDigits(s: string): string {
  return s
    .replace(ARABIC_INDIC_DIGIT, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGIT, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = asciifyDigits(input.trim());
  if (!trimmed) return null;

  // Keep + and digits only
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (!cleaned) return null;

  let digits = cleaned.replace(/\+/g, '');

  // 00968XXXXXXXX → 968XXXXXXXX
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('968') && digits.length === 11) {
    return '+' + digits;
  }
  if (digits.length === 8) {
    return '+968' + digits;
  }
  // UXI-006: don't fall back to a "best-effort" string. A 6-digit or 12-digit
  // input is almost certainly a typo (extension grafted on, missing zero,
  // pasted with extra junk). Returning null forces the validator at the call
  // site to surface a real "phone format invalid" error.
  return null;
}

// Tested on the ASCII-folded input, so ASCII digits are all it needs.
const PHONE_REGEX = /^[\d\s\-+()]{7,20}$/;

/**
 * The one rule for "is this a phone": the CREATE and UPDATE schemas
 * (lib/validation/fields.ts) and the import row check call it. normalizePhone
 * alone is not a validator — it strips letters, so 'call 91234567' normalizes.
 */
export function isValidPhoneFormat(input: string | null | undefined): boolean {
  if (!input) return false;
  // Validate AFTER asciifying so an Arabic-keyboard input doesn't fail the
  // length / character check.
  const ascii = asciifyDigits(input);
  return PHONE_REGEX.test(ascii) && normalizePhone(input) !== null;
}
