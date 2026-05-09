/**
 * Commercial Registration (CR) number normalization.
 * Strips spaces, hyphens, casing — produces a canonical form for dedupe.
 * Examples:
 *   "1234567"        → "1234567"
 *   "1234567-OM"     → "1234567OM"
 *   " 12 345 67 "    → "1234567"
 *   "cr-1234567"     → "CR1234567"
 */
export function normalizeCR(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s\-_/.]+/g, '').trim().toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}
