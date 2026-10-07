/**
 * The run's clock guard — pure, so playwright.launch.config.ts can import it
 * before it sets the run-wide environment.
 */

/**
 * Minutes after Oman midnight (20:00 UTC) in which a run may not start: until
 * 24:00 UTC, the server's UTC date is still a day behind Oman's
 * (utcDateBehindOman), so "today" differs between the two for the whole run.
 */
export const AFTER_OMAN_MIDNIGHT_MIN = 240;

/**
 * Why the run must not start now, or null. A run occupies [now, now + budget]:
 *  - it must not contain Oman midnight (20:00 UTC) — with the default budget of
 *    120 minutes that refuses a start from 18:00 UTC — nor start within
 *    `afterMinutes` (4 h) after it, i.e. before 24:00 UTC, while the server's
 *    UTC date still says yesterday and the "captured today" / "yesterday"
 *    fixtures sit on the edge (default: no start from 18:00 to 24:00 UTC);
 *  - it must not touch Neon's compute-update window, Thursday 23:00–24:00 UTC.
 */
export function clockGuard(now: Date, budgetMinutes: number, afterMinutes = AFTER_OMAN_MIDNIGHT_MIN): string | null {
  const minute = 60_000;
  const end = new Date(now.getTime() + budgetMinutes * minute);
  // Oman midnight = 20:00 UTC on each UTC day the run touches.
  for (let day = -1; day <= Math.ceil(budgetMinutes / 1440) + 1; day++) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, 20, 0, 0);
    const startsJustAfter = now.getTime() >= midnight && now.getTime() < midnight + afterMinutes * minute;
    const crosses = now.getTime() < midnight && end.getTime() >= midnight;
    if (crosses || startsJustAfter) {
      return (
        `the run (budget ${budgetMinutes} min, E2E_RUN_BUDGET_MIN) would start within ${afterMinutes} min after, or cross, ` +
        `Oman midnight at ${new Date(midnight).toISOString()} — DUE fixtures and the server's dates would flip mid-run`
      );
    }
  }
  // Neon compute updates: Thursday 23:00–24:00 UTC.
  for (let day = -1; day <= Math.ceil(budgetMinutes / 1440) + 1; day++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day));
    if (d.getUTCDay() !== 4) continue;
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 0, 0);
    const to = from + 60 * minute;
    if (now.getTime() < to && end.getTime() > from) {
      return `the run would overlap Neon's compute-update window (Thursday 23:00–24:00 UTC, ${new Date(from).toISOString()})`;
    }
  }
  return null;
}
