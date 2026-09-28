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

/**
 * The customer fields the enrichment form shows an error beside — exactly these.
 * Phase 2: this was every `customer.` key, and the form has no slot for contact
 * role, notes, the channel selects, status, the CR photo or payment terms, so an
 * error on any of those was claimed and then shown nowhere: the submit did
 * nothing, without a word. Those now surface at the top.
 */
const ENRICHMENT_CUSTOMER_SLOTS: ReadonlySet<string> = new Set([
  'customer.legalName',
  'customer.crNumber',
  'customer.primaryPhone',
  'customer.altPhone',
  'customer.contactPerson',
]);

const BRANCH_KEY = /^branch\.([^.]+)(?:\.|$)/;

/**
 * The keys the enrichment form shows in place: the customer fields above, and
 * each branch's GPS — for a branch the page shows. `shownBranchIds` omitted:
 * any branch.
 */
export function enrichmentFormRendersError(key: string, shownBranchIds?: ReadonlySet<string>): boolean {
  if (ENRICHMENT_CUSTOMER_SLOTS.has(key)) return true;
  const gps = /^branch\.([^.]+)\.gps$/.exec(key);
  return !!gps && (!shownBranchIds || shownBranchIds.has(gps[1]!));
}

export const RELOAD_FOR_BRANCH_HINT = 'Reload the page to see this branch.';

/**
 * Ruling 11 (phase 2): the server checks a salesman's submit on the branches
 * of his route as they are NOW, never on ids the page sends — so a branch put
 * on his route after the page opened can be named in an error ("Branch
 * MCT-0012: shop photo is required.") that this page cannot show. Such an error
 * says to reload; it surfaces at the top, having no slot here.
 */
export function withReloadHintForUnshownBranches(
  fields: Record<string, string>,
  shownBranchIds: ReadonlySet<string>
): Record<string, string> {
  let out = fields;
  for (const [key, message] of Object.entries(fields)) {
    const m = BRANCH_KEY.exec(key);
    if (!m || shownBranchIds.has(m[1]!)) continue;
    if (out === fields) out = { ...fields };
    out[key] = `${message} ${RELOAD_FOR_BRANCH_HINT}`;
  }
  return out;
}
