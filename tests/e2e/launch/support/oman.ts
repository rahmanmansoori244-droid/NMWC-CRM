/**
 * Oman dates for expectations, and the clock guards.
 *
 * Expected values are computed in Asia/Muscat with the app's own lib/tz, never
 * from this PC's clock settings (this PC runs Asia/Muscat, the server runs UTC
 * like Vercel). The Oman date is fixed ONCE per run by the config
 * (E2E_OMAN_DATE), so every worker agrees on "today"; a run that crosses Oman
 * midnight (20:00 UTC) is stopped by assertOmanDayUnchanged() instead of
 * silently flipping the DUE fixtures half-way.
 */
import type { DayOfWeek } from '@prisma/client';
import { DAY_BY_INDEX, omanDateISO, omanDayOfWeek, omanYear } from '../../../../lib/tz';
import { slaDeadline, workingMinutesBetween } from '../../../../lib/working-hours';

export { omanDateISO, omanDayOfWeek, omanYear, slaDeadline, workingMinutesBetween };
export { clockGuard } from './clock';

/** The Oman calendar date the run started on (YYYY-MM-DD). */
export const RUN_OMAN_DATE: string = process.env.E2E_OMAN_DATE ?? omanDateISO();

function dayOfIso(iso: string): DayOfWeek {
  const [y, m, d] = iso.split('-').map(Number);
  return DAY_BY_INDEX[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]! as DayOfWeek;
}

/** The Oman day of the week the run started on — what /today lists as due. */
export const OMAN_TODAY: DayOfWeek = dayOfIso(RUN_OMAN_DATE);

/** A day of the week `offset` days after OMAN_TODAY (1 = tomorrow). Never a literal. */
export function omanDayAfter(offset = 1): DayOfWeek {
  const i = DAY_BY_INDEX.indexOf(OMAN_TODAY as (typeof DAY_BY_INDEX)[number]);
  return DAY_BY_INDEX[(((i + offset) % 7) + 7) % 7]! as DayOfWeek;
}

/** en-GB text of an instant in Asia/Muscat, e.g. omanFmt(d, { dateStyle: 'medium' }). */
export function omanFmt(d: Date, o: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Muscat', ...o }).format(d);
}

export function omanYearNow(): number {
  return omanYear();
}

/** The current UTC calendar date as the photo presign lays it out: YYYY/MM/DD. */
export function utcYmd(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

/**
 * True between 20:00 and 24:00 UTC, when Oman is already on the next calendar
 * day but the server (TZ=UTC, like Vercel) is not. Only then can a server date
 * formatted without a time zone (KNOWN_BUGS.utcTimes, fixed in wave 1) show the
 * wrong DAY. No spec carries a test.fail now; should a date bug be reopened with
 * the owner's word, its marker must be gated on this, or it "passes
 * unexpectedly" the other 20 hours.
 */
export function utcDateBehindOman(at: Date = new Date()): boolean {
  return omanDateISO(at) !== at.toISOString().slice(0, 10);
}

/**
 * The instant `minutes` WORKING minutes before `now` (Sun–Thu working hours,
 * lib/working-hours.ts) — for seeds such as "OVERDUE 3h", which the queue pill
 * measures in working minutes (formatSlaStatus), not wall-clock hours.
 */
export function workingMinutesAgo(minutes: number, now: Date = new Date()): Date {
  if (minutes <= 0) return now;
  // workingMinutesBetween(t, now) only grows as t moves back: binary search the
  // latest t that is `minutes` working minutes before now, to the second.
  let lo = now.getTime() - 60 * 86_400_000; // far enough back for any SLA seed
  let hi = now.getTime();
  if (workingMinutesBetween(new Date(lo), now) < minutes) throw new Error(`workingMinutesAgo(${minutes}): more than 60 days back`);
  while (hi - lo > 1_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (workingMinutesBetween(new Date(mid), now) >= minutes) lo = mid;
    else hi = mid;
  }
  return new Date(lo);
}

/** Fails loudly when the run has crossed Oman midnight since it started. */
export function assertOmanDayUnchanged(): void {
  const now = omanDateISO();
  if (now !== RUN_OMAN_DATE) {
    throw new Error(
      `The Oman date changed during the run (${RUN_OMAN_DATE} → ${now}). DUE fixtures and day-based ` +
        'expectations are no longer valid. Start the run again away from 20:00 UTC.'
    );
  }
}
