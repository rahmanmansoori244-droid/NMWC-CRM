import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  endOfOmanDay,
  omanDate,
  omanDateISO,
  omanDateTime,
  omanDayOfWeek,
  omanDayTime,
  omanISO,
  omanLongDate,
  omanStamp,
  startOfOmanDay,
} from '@/lib/tz';

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
 * Launch fix: every time a user reads is Oman time. Vercel runs in UTC and this
 * PC runs in Asia/Muscat, so a test run here proved nothing: these run with the
 * process in UTC, as production is, and the first assertion checks that it is.
 * 2026-10-07 21:30:05 UTC is 01:30:05 on Thursday 8 October in Oman.
 */
describe('lib/tz — showing a time (process in UTC, as on Vercel)', () => {
  const LATE = new Date('2026-10-07T21:30:05.000Z');

  beforeAll(() => {
    vi.stubEnv('TZ', 'UTC');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('runs where the old toLocaleString printed the UTC day', () => {
    expect(LATE.getHours()).toBe(21);
    expect(LATE.toLocaleDateString('en-GB')).toBe('07/10/2026');
  });

  it('prints the Oman date and time, past Oman midnight', () => {
    expect(omanDate(LATE)).toBe('08/10/2026');
    expect(omanDateTime(LATE)).toBe('08/10/2026, 01:30:05');
    expect(omanDayTime(LATE)).toBe('08 Oct, 01:30');
    expect(omanLongDate(LATE)).toBe('Thursday, 8 October 2026');
  });

  it('reads what a prop or a stored diff carries: a Date, an ISO string or epoch ms', () => {
    expect(omanDateTime('2026-10-07T21:30:05.000Z')).toBe('08/10/2026, 01:30:05');
    expect(omanDayTime(LATE.getTime())).toBe('08 Oct, 01:30');
  });

  it('defaults the long date to now, on the Oman day', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(LATE);
      expect(omanLongDate()).toBe('Thursday, 8 October 2026');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses fixed month names, so the server and every browser print the same text', () => {
    // en-GB September is "Sept" in current ICU and "Sep" in older ones: a client
    // component formatted with Intl rendered differently on the server and the phone.
    const sept = new Date('2026-09-14T08:05:00.000Z');
    expect(omanDayTime(sept)).toBe('14 Sep, 12:05');
    expect(omanLongDate(sept)).toBe('Monday, 14 September 2026');
  });

  it('agrees with Intl in Asia/Muscat on every field, across a year of instants', () => {
    // The arithmetic relies on Oman being UTC+4 with no DST; Intl's zone data is
    // the independent check.
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Muscat',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    for (let t = Date.UTC(2026, 0, 1, 0, 7, 11); t < Date.UTC(2027, 0, 1); t += 7 * 3600_000 + 13 * 60_000) {
      expect(omanDateTime(new Date(t))).toBe(fmt.format(new Date(t)));
    }
  });
});

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
    expect(omanISO(null)).toBe('');
    expect(omanISO(undefined)).toBe('');
  });

  it('writes a data column as ISO-8601 on the Oman clock: the same instant, to the millisecond', () => {
    const late = new Date('2026-10-07T21:30:45.123Z');
    expect(omanISO(late)).toBe('2026-10-08T01:30:45.123+04:00');
    // The date in front is the day omanStamp gives the same row in the field-update report.
    expect(omanISO(late).slice(0, 10)).toBe(omanStamp(late).slice(0, 10));
    for (let t = Date.UTC(2026, 0, 1, 0, 7, 11, 9); t < Date.UTC(2027, 0, 1); t += 7 * 3600_000 + 13 * 60_017) {
      expect(new Date(omanISO(new Date(t))).getTime()).toBe(t);
    }
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
