/**
 * A server action returns field-keyed errors; a form renders some of those keys
 * beside their fields. Any key WITHOUT a slot must still reach the person, or the
 * submit appears to do nothing at all — which is what a rejected branch field did
 * on the enrichment form until 2026-09-25 (a typed GPS point outside Oman, or a
 * too-short reason for one).
 */
export function surfaceUnrenderedErrors(
  fields: Record<string, string>,
  isRendered: (key: string) => boolean
): Record<string, string> {
  const orphaned = Object.entries(fields).filter(([k]) => k !== '_form' && !isRendered(k));
  if (orphaned.length === 0 || fields._form) return fields;
  return { ...fields, _form: orphaned.map(([, v]) => v).join(' · ') };
}

/** The keys the enrichment form shows in place: customer fields, and each branch's GPS. */
export function enrichmentFormRendersError(key: string): boolean {
  return key.startsWith('customer.') || /^branch\.[^.]+\.gps$/.test(key);
}
