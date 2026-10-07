import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { endOfOmanDay, omanDateISO, omanDayOfWeek, omanStamp, startOfOmanDay } from '@/lib/tz';

describe('lib/tz — omanDayOfWeek', () => {
  it('uses Oman local time, not UTC, for day-of-week', () => {
    // 2026-05-09 22:30 UTC == 2026-05-10 02:30 Oman (UTC+4) → Sunday
    // Without the offset, getDay() on UTC says Saturday.
    const utcLateNight = new Date('2026-05-09T22:30:00.000Z');
    expect(omanDayOfWeek(utcLateNight)).toBe('SUN');
  });

  it('returns SAT at noon UTC on a Saturday', () => {
    const utcMidday = new Date('2026-05-09T12:00:00.000Z'); // Saturday
    expect(omanDayOfWeek(utcMidday)).toBe('SAT');
  });

  it('returns FRI just after Oman midnight on a Friday', () => {
    // 2026-05-08 20:30 UTC → 2026-05-09 00:30 Oman (Saturday)? Let's pick Thursday→Friday
    // 2026-05-07 20:30 UTC == 2026-05-08 00:30 Oman → Friday
    const utc = new Date('2026-05-07T20:30:00.000Z');
    expect(omanDayOfWeek(utc)).toBe('FRI');
  });
});

describe('lib/tz — omanDateISO', () => {
  it('rolls over the date at Oman midnight, not UTC midnight', () => {
    // 2026-05-09 22:00 UTC → 2026-05-10 02:00 Oman
    expect(omanDateISO(new Date('2026-05-09T22:00:00.000Z'))).toBe('2026-05-10');
    // 2026-05-09 12:00 UTC → 2026-05-09 16:00 Oman
    expect(omanDateISO(new Date('2026-05-09T12:00:00.000Z'))).toBe('2026-05-09');
  });
});

/*
 * Launch fix: the exports read and write Oman days. Vercel runs in UTC and this PC
 * runs in Asia/Muscat, so a test run here proved nothing: these run with the
 * process in UTC, as production is, and check that it is.
 */
describe('lib/tz — export stamps and day filters (process in UTC, as on Vercel)', () => {
  beforeAll(() => {
    vi.stubEnv('TZ', 'UTC');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('stamps an export cell on the Oman clock: 21:30 UTC on the 7th is 01:30 on the 8th', () => {
    expect(new Date('2026-10-07T21:30:05.000Z').getHours()).toBe(21); // the process really is in UTC
    expect(omanStamp(new Date('2026-10-07T21:30:05.000Z'))).toBe('2026-10-08 01:30');
    expect(omanStamp(new Date('2026-09-13T10:05:00.000Z'))).toBe('2026-09-13 14:05');
  });

  it('leaves an empty export cell for no time', () => {
    expect(omanStamp(null)).toBe('');
    expect(omanStamp(undefined)).toBe('');
  });

  it('starts a picked day at Oman midnight, 20:00 UTC the evening before', () => {
    // What z.coerce.date() makes of "2026-09-30": UTC midnight, 04:00 in Oman.
    const picked = new Date('2026-09-30');
    expect(startOfOmanDay(picked).toISOString()).toBe('2026-09-29T20:00:00.000Z');
    expect(endOfOmanDay(picked).toISOString()).toBe('2026-09-30T19:59:59.999Z');
  });

  it('puts 01:30 Oman on the 8th inside the 8th, and outside the 7th', () => {
    const at = new Date('2026-10-07T21:30:00.000Z').getTime();
    const day8 = new Date('2026-10-08');
    const day7 = new Date('2026-10-07');
    expect(at >= startOfOmanDay(day8).getTime() && at <= endOfOmanDay(day8).getTime()).toBe(true);
    expect(at <= endOfOmanDay(day7).getTime()).toBe(false);
  });
});
