/**
 * The clean-start flow test's pinned clock (tests/integration/clean-start-flow.test.ts),
 * as pure arithmetic: no I/O, no clock read. Every instant is passed in.
 *
 * The flow pins one offset clock (FAKE_UTC_OFFSET: bash `date` through the date
 * stand-in, Node through clock-preload.mjs) to 16:00 UTC (20:00 Oman) of the real
 * Oman day, or the real time if that is later. Postgres keeps the real clock, so
 * the pin moves the hour, never the Oman day: a start that the budget would carry
 * past 20:00 UTC (midnight in Oman) first waits until that midnight has passed.
 * Pinned by tests/unit/clean-start-flow-clock.test.ts.
 */
import { omanDateISO } from '@/lib/tz';

/** The whole suite's budget on the pinned clock: measured 537 s plus about 50 s new, about x2. */
export const FLOW_BUDGET_MS = 20 * 60_000;
/** 20:00 Oman: inside the window 15:30-23:30 UTC, after the 15:00 UTC cut and night 2's 15:00. */
export const PIN_UTC = { h: 16, m: 0 };
/** 20:00 UTC minus the budget: a start from here waits for midnight in Oman. */
export const WAIT_FROM_UTC = { h: 19, m: 40 };
/** 10:00 Oman, the morning sub-flow's clock. */
export const MORNING_UTC_H = 6;

/** h:m:s UTC on the calendar date `day` (YYYY-MM-DD). */
export const dayUtc = (day: string, h: number, m = 0, s = 0) =>
  new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m, s));

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** > 0 only for a wall clock in [19:40, 20:00) UTC: until 20:00:05 UTC of that date. */
export function startDelayMs(wall: Date): number {
  const day = utcDay(wall);
  const from = dayUtc(day, WAIT_FROM_UTC.h, WAIT_FROM_UTC.m).getTime();
  const midnightOman = dayUtc(day, 20).getTime();
  const t = wall.getTime();
  return t >= from && t < midnightOman ? dayUtc(day, 20, 0, 5).getTime() - t : 0;
}

/** day = omanDateISO(wall); pinMs = max(wall, PIN_UTC of day). Never earlier than wall. */
export function eveningPin(wall: Date): { day: string; pinMs: number } {
  const day = omanDateISO(wall);
  return { day, pinMs: Math.max(wall.getTime(), dayUtc(day, PIN_UTC.h, PIN_UTC.m).getTime()) };
}

/** The evening band of the pinned clock: [15:30, 20:00) UTC of day. */
export const eveningBand = (day: string): [number, number] => [dayUtc(day, 15, 30).getTime(), dayUtc(day, 20).getTime()];
/** The morning sub-flow's band: [06:00, 07:00) UTC of day. */
export const morningBand = (day: string): [number, number] => [dayUtc(day, MORNING_UTC_H).getTime(), dayUtc(day, MORNING_UTC_H + 1).getTime()];

/** The key stamp db/<stamp>.sql.gz.age for a dump "taken" at ms (whole seconds). */
export const stampOf = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';

/** null while Postgres's Oman day is the pinned day and the pinned clock is inside [lo, hi); else the reason, in words. */
export function clockFault(day: string, pgDay: string, fakeNowMs: number, [lo, hi]: [number, number]): string | null {
  if (pgDay !== day) return `Postgres's Oman day is ${pgDay}, the pinned day is ${day}`;
  if (!(fakeNowMs >= lo && fakeNowMs < hi))
    return `the pinned clock ${new Date(fakeNowMs).toISOString()} is outside ${new Date(lo).toISOString()}-${new Date(hi).toISOString()}`;
  return null;
}
