/**
 * Timezone helpers for NMWC.
 *
 * Vercel functions run in UTC. The business runs in Oman (Asia/Muscat, UTC+4
 * year-round, no DST). When we make day-level decisions on the server (e.g.
 * "what day-of-week is it for the salesman walking the route?"), we must
 * compute it in Oman local time, not UTC. PROD-004 was caused by using
 * `new Date().getDay()` directly — between Oman 00:00 and 04:00 the server
 * still thought it was the previous day.
 */

export const DAY_BY_INDEX = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type DayOfWeekCode = (typeof DAY_BY_INDEX)[number];

const OMAN_OFFSET_MS = 4 * 60 * 60 * 1000;

/**
 * Returns Oman-local day-of-week ('SUN'..'SAT') for the given instant
 * (defaults to now). Works regardless of the server's TZ setting.
 */
export function omanDayOfWeek(at: Date = new Date()): DayOfWeekCode {
  const oman = new Date(at.getTime() + OMAN_OFFSET_MS);
  return DAY_BY_INDEX[oman.getUTCDay()];
}

/**
 * Returns an Oman-local YYYY-MM-DD string for the given instant.
 */
export function omanDateISO(at: Date = new Date()): string {
  const oman = new Date(at.getTime() + OMAN_OFFSET_MS);
  const y = oman.getUTCFullYear();
  const m = String(oman.getUTCMonth() + 1).padStart(2, '0');
  const d = String(oman.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns the Oman-local calendar year for the given instant (defaults to now).
 * Use this for the NMWC-YYYY customer-code prefix (and its CodeSequence scope) so
 * a customer minted in the Oman 00:00-03:59 window on Jan 1 is coded with the
 * current Oman year, not the prior UTC year. Same PROD-004 class as omanDateISO.
 */
export function omanYear(at: Date = new Date()): number {
  return new Date(at.getTime() + OMAN_OFFSET_MS).getUTCFullYear();
}
