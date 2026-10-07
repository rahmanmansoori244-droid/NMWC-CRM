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

/*
 * Showing a time to a user. Every date and time on screen is Oman time, whether
 * the page is rendered on Vercel (UTC) or in the browser, and the text is built
 * here from the shifted clock, never by toLocaleString: a client component is
 * rendered twice (server, then the phone), and ICU differs between Node and each
 * browser (en-GB September is "Sept" in one and "Sep" in another), so the two
 * renders disagreed and React threw #418. Fixed names, fixed separators, no
 * locale and no time zone database — the same string on every machine.
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The Oman wall clock of an instant, read with getUTC*. Accepts what a prop or a JSON diff carries. */
function omanClock(at: Date | string | number): Date {
  return new Date(new Date(at).getTime() + OMAN_OFFSET_MS);
}
const two = (n: number) => String(n).padStart(2, '0');

/** "07/10/2026": the en-GB short date, on the Oman calendar. */
export function omanDate(at: Date | string | number): string {
  const o = omanClock(at);
  return `${two(o.getUTCDate())}/${two(o.getUTCMonth() + 1)}/${o.getUTCFullYear()}`;
}

/** "07/10/2026, 14:05:33": the en-GB date and time, on the Oman clock. */
export function omanDateTime(at: Date | string | number): string {
  const o = omanClock(at);
  return `${omanDate(at)}, ${two(o.getUTCHours())}:${two(o.getUTCMinutes())}:${two(o.getUTCSeconds())}`;
}

/** "07 Oct, 14:05": a short list stamp (the notification list), on the Oman clock. */
export function omanDayTime(at: Date | string | number): string {
  const o = omanClock(at);
  return `${two(o.getUTCDate())} ${MONTH_SHORT[o.getUTCMonth()]}, ${two(o.getUTCHours())}:${two(o.getUTCMinutes())}`;
}

/** "Wednesday, 7 October 2026": the Today header — the Oman day, not the server's. */
export function omanLongDate(at: Date | string | number = new Date()): string {
  const o = omanClock(at);
  return `${WEEKDAY_LONG[o.getUTCDay()]}, ${o.getUTCDate()} ${MONTH_LONG[o.getUTCMonth()]} ${o.getUTCFullYear()}`;
}

/**
 * "2026-10-07 14:05": Oman wall clock for a spreadsheet cell, unambiguous and
 * sortable as text. Both exports (the master and the field-update report) use it,
 * so a row's day is the same Oman day in each. Empty for no time.
 */
export function omanStamp(at: Date | null | undefined): string {
  if (!at) return '';
  const o = omanClock(at);
  return `${omanDateISO(at)} ${two(o.getUTCHours())}:${two(o.getUTCMinutes())}`;
}

/**
 * Day filters. A date picker sends "2026-09-13", which parses as UTC midnight —
 * 04:00 in Oman. `from`/`updatedSince` mean the start of that Oman day and `until`
 * the whole of it (inclusive). Oman is UTC+4 with no DST: the day runs from 20:00
 * UTC the evening before.
 */
export function startOfOmanDay(d: Date): Date {
  const local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  return new Date(local - OMAN_OFFSET_MS);
}
export function endOfOmanDay(d: Date): Date {
  return new Date(startOfOmanDay(d).getTime() + 24 * 3600_000 - 1);
}
