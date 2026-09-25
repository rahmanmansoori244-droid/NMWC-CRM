/**
 * The one comparison key for a customer's legal name, shared by the duplicate
 * detector (lib/duplicate-pairing.ts) and the new-customer duplicate block
 * (lib/create-guards.ts: the advisory lock key and the EXACT_TRIPLE check).
 *
 * Benchmark item 16 (owner decision 2026-09-25): two names that differ only in
 * whitespace are the same name. Before this, "Al Noor  Shop" (a doubled space)
 * and "Al Noor Shop" were two shops to both checks, and so was a name holding
 * the no-break space that Excel and WhatsApp paste in. Every run of whitespace
 * collapses to one space — JavaScript's \s covers U+00A0 and the other Unicode
 * spaces — the ends are trimmed, and case is folded.
 *
 * It lives in exactly one place because the two callers disagreeing is itself a
 * defect: the create block used to compare names in Postgres (case-insensitive,
 * nothing else) while the detector trimmed in JavaScript, so a shop the create
 * block let through could be flagged by the detector the next morning, and the
 * lock key was computed a third way. Anything that compares legal names for
 * duplicate purposes must call this.
 */
export function nameKey(legalName: string): string {
  return legalName.replace(/\s+/g, ' ').trim().toLowerCase();
}
