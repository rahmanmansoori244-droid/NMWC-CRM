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
 * - Strip everything else that is not a digit or '+'.
 * - Accept 8 local digits, or 11 digits with country prefix `968`, or `00968`.
 * - Reject anything that doesn't match those — previous code returned a
 *   "best-effort" 12-digit junk string, which the partial unique index later
 *   collided on. Better to reject loudly so the user can fix the source.
 */

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function asciifyDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const idx = ARABIC_INDIC_DIGITS.indexOf(ch);
    out += idx >= 0 ? String(idx) : ch;
  }
  return out;
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

const PHONE_REGEX = /^[\d\s\-+()٠-٩]{7,20}$/;

export function isValidPhoneFormat(input: string | null | undefined): boolean {
  if (!input) return false;
  // Validate AFTER asciifying so an Arabic-keyboard input doesn't fail the
  // length / character check.
  const ascii = asciifyDigits(input);
  return PHONE_REGEX.test(ascii) && normalizePhone(input) !== null;
}
