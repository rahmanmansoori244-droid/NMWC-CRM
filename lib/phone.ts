/**
 * Oman phone normalization.
 * Goal: every reasonable user input is reduced to a single canonical form so
 * uniqueness checks and search work correctly. The canonical form is:
 *   +968XXXXXXXX  (8 local digits)
 *
 * Rules:
 * - Strip everything that is not a digit or '+'.
 * - If input has 8 digits and starts with 7,9 (Oman mobile/landline), prepend +968.
 * - If input has 11 digits and starts with 968, prepend '+'.
 * - If input has 11 digits and starts with '00968', strip the 00 and prepend '+'.
 * - Otherwise, keep the original digits prefixed with '+' if a country code looks present.
 *   We never reject — we keep the best-effort string.
 */

export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
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
  // Fallback: best-effort with leading + if length suggests country code
  if (digits.length >= 10) return '+' + digits;
  return digits; // probably partial; leave to caller's validation
}

const PHONE_REGEX = /^[\d\s\-+()]{7,20}$/;

export function isValidPhoneFormat(input: string | null | undefined): boolean {
  if (!input) return false;
  return PHONE_REGEX.test(input);
}
