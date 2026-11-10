/**
 * The words the batch page uses for rows loaded with their shop NOT changed
 * (code review 2026-11-10, finding 28, second round). PURE and import-free, so
 * the "Before you promote" dialog (a client component) can use them without
 * pulling the import plan into the browser.
 */

/**
 * What the Steward is told when a row's route was NOT applied (code review
 * 2026-11-10, finding 28, second round). The first round said a route could be
 * changed by a customer-import row with temix_code left blank, or by fixing a
 * held-back row; that contradicts the owner's decision that route moves are made
 * in Temix (2026-10-11), so this states only that decision. The owner is asked to
 * approve the wording. Used in the row note (lib/import-plan.ts
 * shopNotChangedNote), the "Before you promote" line and the end-of-load notice.
 */
export const ROUTE_NOT_APPLIED =
  "The route was NOT applied; the shop stays on its current route. No screen in the CRM changes a shop's route; route moves are made in Temix.";

/**
 * What "loaded with their shop NOT changed" counts, in the words of the
 * "Before you promote" tick and the end-of-load notice. Both counts are the same
 * rows: the review's crm.linkedShops + crm.linkedNotAdded (lib/import-plan.ts)
 * and the promote's notes.shopNotChanged (services/imports.ts
 * LaneOutcome.shopNotChanged). A row with no branch_code, or naming another
 * customer's or an archived branch, is not one of them.
 */
export const SHOP_NOT_CHANGED_MEANING =
  "Each is a row that carries the customer's Temix code and names a shop of that customer (branch_code) whose details in the sheet differ from the CRM, or that the CRM does not have; such a row never changes or adds a shop.";
