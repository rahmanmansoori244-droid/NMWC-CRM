/**
 * Follow-up 1 (F2): whether the dashboard may compare a period with the one
 * before it.
 *
 * The go-live clean start (scripts/ops/clean-start/reset.sql) removed every
 * customer, request and log from before its moment. A comparison whose earlier
 * period starts before that moment would compare with days the reset emptied, so
 * an arrow or a percentage there would be wrong: the tiles, the "What stands out"
 * sentence and the note above the cards say instead that there is no earlier data
 * yet. The moment is read from the clean start's own AuditLog record
 * (lib/clean-start-record.ts readCleanStartAt; lib/insights/load.ts
 * loadCleanStart). On a database that never had a clean start nothing changes.
 *
 * When that record could not be read, the dashboard cannot know whether the
 * comparison is sound, so it shows none (as a failed card shows no figure).
 *
 * Pure.
 */
import type { InsightPeriod } from './period';
import type { Section } from './shape';

export type Comparison =
  /** Compare as before. */
  | { kind: 'compare' }
  /** The period before starts before the clean start: nothing to compare with yet. */
  | { kind: 'no-earlier-data'; cleanStartAt: Date }
  /** Whether there was a clean start could not be read just now. */
  | { kind: 'unchecked' };

/** The tile's words in place of an arrow and a percentage. */
export const NO_EARLIER_DATA = 'No earlier data yet to compare with';
export const NOT_COMPARED = 'Not compared just now';

export function comparisonFor(period: Pick<InsightPeriod, 'prevFrom'>, cleanStart: Section<Date | null>): Comparison {
  if (!cleanStart.ok) return { kind: 'unchecked' };
  const at = cleanStart.data;
  if (at && period.prevFrom.getTime() < at.getTime()) return { kind: 'no-earlier-data', cleanStartAt: at };
  return { kind: 'compare' };
}
