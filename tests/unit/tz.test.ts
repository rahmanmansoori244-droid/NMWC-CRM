import { describe, it, expect } from 'vitest';
import { omanDayOfWeek, omanDateISO } from '@/lib/tz';

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
