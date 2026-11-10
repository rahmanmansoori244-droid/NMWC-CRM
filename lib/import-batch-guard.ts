/**
 * Code review 2026-11-10, finding 6: the rules that keep an old staged
 * customer-import batch from being loaded over newer data.
 *
 *  - A staged batch older than STAGED_BATCH_MAX_AGE_DAYS can no longer be
 *    promoted, resumed or fixed back into a load: the sheet must be uploaded
 *    again. Exclude and Discard still work on it. The limit is on the SHEET's
 *    own rows: once a batch has been loaded and only rows fixed in the app are
 *    left to load, those follow the fix window (IMPORT_PAYLOAD_DAYS) and the
 *    newest-upload rule instead, as they did before (adversarial review of
 *    finding 6: the limit cut the 90-day fix window of every loaded batch to 7
 *    days, and told the Steward to discard a batch that cannot be discarded).
 *  - Before a promote or a resume the Steward is shown when and by whom the batch
 *    was uploaded and what it will do, and confirms it.
 *  - A customer that a NEWER customer upload has already loaded is not loaded
 *    again from this older batch: the promote is refused until the Steward
 *    confirms, in so many words, that those customers are left out; their rows
 *    are then rejected with the reason, and the rest loads.
 *  - The Data Steward can discard a batch (services/import-fixes.ts).
 *
 * PURE: no database, so the page, the review and the promote say the same thing.
 */

/**
 * How old a staged batch may be and still be promoted. A default, kept in one
 * place: the owner is asked to confirm the number (open question).
 */
export const STAGED_BATCH_MAX_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the upload (0 on the day itself). */
export function batchAgeDays(uploadedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - uploadedAt.getTime()) / DAY_MS));
}

/** "today", "1 day ago", "12 days ago". */
export function batchAgeText(uploadedAt: Date, now: Date = new Date()): string {
  const d = batchAgeDays(uploadedAt, now);
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

/** Past the age limit: it can no longer be promoted. */
export function stagedBatchExpired(uploadedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - uploadedAt.getTime() > STAGED_BATCH_MAX_AGE_DAYS * DAY_MS;
}

/**
 * What a batch has been through, read from its rows (lib/import-master-lookup.ts
 * batchLoadHistory): whether a promote has already run over it, and how many of
 * the sheet's own rows (not fixed in the app) are still waiting to load.
 */
export type BatchLoadHistory = { everLoaded: boolean; uploadedRowsWaiting: number };

/**
 * Past the age limit for what it would load now. A batch never loaded, or one
 * whose first load stopped with rows of the sheet still waiting, is a STAGED
 * batch: refused past the limit. A batch already loaded, with only rows fixed in
 * the app waiting, is not: those rows keep the fix window.
 */
export function stagedLoadExpired(
  uploadedAt: Date,
  history: BatchLoadHistory,
  now: Date = new Date()
): boolean {
  if (!stagedBatchExpired(uploadedAt, now)) return false;
  return !history.everLoaded || history.uploadedRowsWaiting > 0;
}

export function stagedBatchExpiredMessage(uploadedAt: Date, now: Date = new Date()): string {
  return `This batch was uploaded ${batchAgeText(uploadedAt, now)}, and a staged batch older than ${STAGED_BATCH_MAX_AGE_DAYS} days can no longer be promoted: what it holds may be older than what is in the CRM now. Upload the sheet again to load it, and discard this batch.`;
}

export const DISCARDED_BATCH_MESSAGE =
  'This batch was discarded, so it can no longer be promoted or fixed. Upload the sheet again to load it.';

/** A customer of this batch that a newer upload has already loaded, and from where. */
export type NewerLoad = { code: string; filename: string; rowNumber: number };

/**
 * The refusal of a promote or resume that has not confirmed leaving out the
 * customers a newer upload has loaded. Names at most three of them.
 */
export function newerLoadsRefusal(loads: NewerLoad[]): string {
  const files = [...new Set(loads.map((l) => `"${l.filename}"`))];
  const eg = loads
    .slice(0, 3)
    .map((l) => l.code)
    .join(', ');
  return `${loads.length.toLocaleString('en-US')} customer(s) in this batch (for example ${eg}) were loaded since from a newer upload (${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}). Loading this older batch would write its older values over theirs. Open Promote again and confirm that those customers are left out: their rows are then rejected, and the rest loads.`;
}

/** The note on a row left out because a newer upload loaded its customer. */
export function newerLoadRowMessage(l: NewerLoad): string {
  return `Customer ${l.code} was loaded since from a newer upload, "${l.filename}" (row ${l.rowNumber}), so this older row was not loaded over it. Exclude it.`;
}

/** The form value a promote sends once the Steward has confirmed leaving them out. */
export const SKIP_NEWER_FIELD = 'skipNewer';
