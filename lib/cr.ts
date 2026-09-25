/**
 * Commercial Registration (CR) number normalization.
 *
 * UXI-014: PRD §8 says "auto-normalized (uppercase, strip spaces)". The
 * previous implementation also stripped hyphens, slashes, dots, underscores —
 * which collapsed `1234567/2024` and `12345672024` to the same value and
 * caused false-positive dedupe matches. Strip whitespace + uppercase only.
 *
 * Benchmark item 16 (owner decision 2026-09-25): two more folds, because both
 * made the same CR look like two different ones — to the duplicate detector and
 * to the create-time CR block, which both compare this function's output:
 *   - Arabic-Indic (U+0660–U+0669) and Extended Arabic-Indic / Persian
 *     (U+06F0–U+06F9) digits become ASCII. A CR typed on an Arabic keyboard
 *     never matched the same CR typed on a Latin one. lib/phone.ts has folded
 *     Arabic-Indic digits in phones since UXI-006; CRs were left behind.
 *   - Invisible format characters are removed: zero-width spaces and joiners,
 *     the bidi marks, embeddings and isolates that Arabic text carries when it
 *     is copied, the word joiner and invisible operators, the byte-order mark
 *     and the soft hyphen. None of them can be seen on screen, so a CR pasted
 *     with one inside was a different value that looked identical to its twin.
 * Punctuation, letters and leading zeros are still kept, for the reason above.
 *
 * Changing this changes what is stored in crNumberNorm, so rows written before
 * the change are corrected by scripts/ops/recompute-cr-norm.ts.
 *
 * Examples:
 *   "1234567"        → "1234567"
 *   "1234567-OM"     → "1234567-OM"   (hyphen preserved)
 *   " 12 345 67 "    → "1234567"
 *   "cr-1234567"     → "CR-1234567"
 *   "\u0661\u0662\u0663\u0664\u0665\u0666\u0667" → "1234567"   (Arabic-Indic digits)
 */

// Each range is written as escapes, not as the characters themselves: they are
// invisible, and a reviewer could not tell a correct class from an empty one.
const ARABIC_INDIC_DIGIT = /[\u0660-\u0669]/g;
const PERSIAN_DIGIT = /[\u06F0-\u06F9]/g;
const INVISIBLE_FORMAT =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

export function normalizeCR(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input
    .replace(ARABIC_INDIC_DIGIT, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGIT, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(INVISIBLE_FORMAT, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}
