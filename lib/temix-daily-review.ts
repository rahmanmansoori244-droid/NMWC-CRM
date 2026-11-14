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
