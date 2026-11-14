/**
 * The daily Temix import, stage 6: the drill-down's "Reviewed" marks
 * (services/temix-daily-review.ts writes them). The form's field names and
 * the one note a mark carries (TemixChangeReview_note_check: a code word).
 *
 * PURE: no imports.
 */
export const REVIEW_FIELDS = { loadDay: 'loadDay', changeId: 'changeId' } as const;

/** The note of a mark made from the drill-down. */
export const REVIEW_NOTE = 'REVIEWED';

/** At most this many lines are marked by one press of "mark all" (the page says so and the Steward presses again). */
export const MARK_ALL_MAX = 5000;

/**
 * The lines a day's page lists and "mark all" marks: those of the day's LOADED
 * files. A file still applying lists nothing yet (its moves come with it once
 * it is loaded), so the count on the button is the count of what one can see.
 */
export const LOADED_FILE_LINES = { file: { state: 'LOADED' } } as const;

/** The words on "mark all": one press marks at most MARK_ALL_MAX. */
export function markAllLabel(unreviewed: number): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return unreviewed > MARK_ALL_MAX
    ? `Mark the next ${n(MARK_ALL_MAX)} of ${n(unreviewed)} not yet reviewed`
    : `Mark all ${n(unreviewed)} not yet reviewed`;
}
