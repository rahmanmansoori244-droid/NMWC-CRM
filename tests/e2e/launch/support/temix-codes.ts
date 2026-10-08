/**
 * The Temix code at a new customer's last approval (owner decision 2026-10-08,
 * claude/temix-code-at-approval): when a new-customer request reaches the
 * Accountant, he creates the customer in Temix himself, types the code Temix
 * gave it into the box labelled "Temix code *" on /approvals/<id>, then
 * approves. Approve refuses to open its confirmation without a valid code;
 * the server refuses one a customer (live or archived) or a live branch holds,
 * naming it; the customer is created with the code (upper case), and the
 * salesman's and the Steward's messages name both codes. A new customer at the
 * Accountant's step can no longer be bulk-approved.
 *
 * The app's own words are imported from lib/ (plain TypeScript).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { World } from './types';

export {
  TEMIX_CODE_CRM_MESSAGE,
  TEMIX_CODE_REQUIRED_MESSAGE,
  normalizeTemixCode,
  temixCodeHolderMessage,
  temixCodeTakenMessage,
} from '../../../../lib/temix-code';
export { TEMIX_CODE_BULK_REFUSED_MESSAGE } from '../../../../lib/bulk-run';

/** The lock a final-step new customer shows in the queue instead of its tick box (BulkApprovalQueue.tsx). */
export const TEMIX_LOCK_LABEL = 'Enter its Temix code: open it to approve';
/** The queue's note when such a card is on the page (BulkApprovalQueue.tsx). */
export const TEMIX_LOCK_NOTE =
  'New customers at their last step are approved one at a time: open each card marked with a lock and enter its Temix code.';

const counters = new WeakMap<World, number>();

/**
 * A Temix code unique to the world and the call: TX<SFX><n>. Letters and digits
 * only, 3 to 30 characters (lib/temix-code.ts), never NMWC-…, never a fixture
 * customer's (000E2E<SFX>-NNN) or branch's (…-NN) code, so the app takes it and
 * no live customer holds it. The world's cleanup removes the customer it is
 * given to (by its name), and with it the code.
 */
export function temixCodeFor(w: World): string {
  const n = (counters.get(w) ?? 0) + 1;
  counters.set(w, n);
  return `TX${w.SFX}${n}`;
}

/** The "Temix code *" box on the approval page (shown only at a new customer's last step). */
export function temixCodeBox(page: Page): Locator {
  return page.getByRole('textbox', { name: /^Temix code/ });
}

/** Types `code` into the Temix code box (the box must be there: the last step of a new customer). */
export async function typeTemixCode(page: Page, code: string): Promise<void> {
  const box = temixCodeBox(page);
  await expect(box, 'the Temix code box (the last step of a new-customer request)').toBeEditable();
  await box.fill(code);
}
