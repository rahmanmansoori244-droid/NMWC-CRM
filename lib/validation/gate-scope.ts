/**
 * Owner decision 4 (2026-10-07): what a salesman's update is held complete on.
 * Shared by the submit gate and its approval re-check (services/edits.ts
 * collectMissingMandatory) and the form's missing list (EnrichmentForm), so the
 * form and the server agree.
 *
 * It was every live branch of the customer on his route: a phone-number fix, or
 * a visit day set on one branch, waited until every other shop of his had an
 * address, GPS and a shop photo (A1.5 in docs/handover/04-PENDING-WORK.md). Now
 * a request is held complete on:
 *   - each branch it changes (address, GPS, shop photo — and, under the FULL
 *     gate, visit day and signboard), and
 *   - the customer-level fields (channel, phone, contact person — and, under
 *     FULL, sub-channel and CR) only when it changes a customer-level field.
 * The ±100 m rule for a newly captured point is unchanged: a moved point is a
 * change of its branch, so its branch is in scope.
 */
import { parseFieldPath } from '../edit-values';

export type GateScope = {
  /** The request changes a customer-level field. */
  customer: boolean;
  /** The branches it changes. */
  branchIds: ReadonlySet<string>;
};

/** From the paths a request changes ('customer.primaryPhone', 'branch.<id>.dayOfVisit'). */
export function gateScopeOf(paths: Iterable<string>): GateScope {
  let customer = false;
  const branchIds = new Set<string>();
  for (const path of paths) {
    const p = parseFieldPath(path);
    if (p?.scope === 'customer') customer = true;
    else if (p?.scope === 'branch') branchIds.add(p.branchId);
  }
  return { customer, branchIds };
}
