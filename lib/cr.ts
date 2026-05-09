/**
 * Commercial Registration (CR) number normalization.
 *
 * UXI-014: PRD §8 says "auto-normalized (uppercase, strip spaces)". The
 * previous implementation also stripped hyphens, slashes, dots, underscores —
 * which collapsed `1234567/2024` and `12345672024` to the same value and
 * caused false-positive dedupe matches. Strip whitespace + uppercase only.
 *
 * Examples:
 *   "1234567"        → "1234567"
 *   "1234567-OM"     → "1234567-OM"   (hyphen preserved)
 *   " 12 345 67 "    → "1234567"
 *   "cr-1234567"     → "CR-1234567"
 */
export function normalizeCR(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/\s+/g, '').trim().toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}
