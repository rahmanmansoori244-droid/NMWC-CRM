/**
 * Pure: no Prisma, so the Temix page's client buttons can read it too.
 */
/**
 * The most customers one Temix batch takes (services/temix.ts Generate). Code
 * review 2026-11-10, finding 11: a longer queue is no longer refused — Generate
 * takes the customers waiting longest up to this number and says how many are
 * left, and the Steward generates again for the rest.
 */
export const TEMIX_BATCH_ROW_CAP = 5000;

/** What Generate says when customers are still queued after its batch. */
export function temixMoreQueuedMessage(left: number, cap = TEMIX_BATCH_ROW_CAP): string {
  const n = left.toLocaleString('en-US');
  return `${n} more customer${left === 1 ? ' is' : 's are'} still waiting for Temix: one file holds at most ${cap.toLocaleString('en-US')}, and this one took the ones waiting longest. Press Generate again for a file with the rest.`;
}
