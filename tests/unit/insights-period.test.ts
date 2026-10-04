/**
 * F2: the dashboard's window and buckets in Oman calendar days
 * (lib/insights/period.ts).
 *
 * Every clock value is derived ONCE, here, and the expectations are computed from
 * it (CLAUDE.md: a fixture that reads the clock is never asserted against a
 * literal). The fixed instants below are chosen on the Oman-day edges; the one
 * case that reads the real clock asserts only what follows from that reading.
 */
import { describe, it, expect } from 'vitest';
import { omanDateISO } from '@/lib/tz';
import {
  addDays,
  bucketKeys,
  bucketLabel,
  bucketOf,
  bucketStart,
  daysInclusive,
  grainFor,
  isPartialBucket,
  omanMidnightUtc,
  parseDay,
  parsePeriod,
} from '@/lib/insights/period';
import { DAY_MAX_DAYS, DEFAULT_PRESET, EARLIEST_DAY, MAX_WINDOW_DAYS, PERIOD_PRESETS, WEEK_MAX_DAYS } from '@/lib/insights/policy';

// 20:30 UTC on Monday 5 October 2026 is 00:30 on Tuesday 6 October in Oman.
const EVENING_UTC = new Date('2026-10-05T20:30:00Z');
const TODAY_IN_OMAN = omanDateISO(EVENING_UTC);

describe('Oman days', () => {
  it('20:30 UTC already belongs to the next Oman day', () => {
    expect(TODAY_IN_OMAN).toBe('2026-10-06');
    expect(bucketOf(EVENING_UTC, 'day')).toBe(TODAY_IN_OMAN);
  });

  it('an Oman day starts at 20:00 UTC the day before', () => {
    expect(omanMidnightUtc('2026-10-06').toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(omanMidnightUtc('2027-01-01').toISOString()).toBe('2026-12-31T20:00:00.000Z');
  });

  it('reads only real calendar days', () => {
    expect(parseDay('2026-02-28')).toBe('2026-02-28');
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('2026-2-3')).toBeNull();
    expect(parseDay(' 2026-10-06 ')).toBe('2026-10-06');
    expect(parseDay(undefined)).toBeNull();
  });

  it('counts days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(daysInclusive('2026-10-01', '2026-10-01')).toBe(1);
    expect(daysInclusive('2026-01-01', '2026-12-31')).toBe(365);
  });
});

describe('buckets', () => {
  it('a week starts on Monday, as Postgres date_trunc("week") starts it', () => {
    // 4 Oct 2026 is a Sunday, 5 Oct a Monday, 10 Oct a Saturday.
    expect(new Date('2026-10-04T00:00:00Z').getUTCDay()).toBe(0);
    expect(bucketStart('2026-10-04', 'week')).toBe('2026-09-28');
    expect(bucketStart('2026-10-05', 'week')).toBe('2026-10-05');
    expect(bucketStart('2026-10-10', 'week')).toBe('2026-10-05');
  });

  it('the week turns at Oman midnight between Sunday and Monday, i.e. 20:00 UTC on Sunday', () => {
    expect(bucketOf(new Date('2026-10-04T19:59:59Z'), 'week')).toBe('2026-09-28');
    expect(bucketOf(new Date('2026-10-04T20:00:00Z'), 'week')).toBe('2026-10-05');
  });

  it('a month turns at Oman midnight on the last day, a year likewise', () => {
    expect(bucketOf(new Date('2026-09-30T19:59:59Z'), 'month')).toBe('2026-09-01');
    expect(bucketOf(new Date('2026-09-30T20:00:00Z'), 'month')).toBe('2026-10-01');
    expect(bucketOf(new Date('2026-12-31T20:00:00Z'), 'day')).toBe('2027-01-01');
  });

  it.each(['day', 'week', 'month'] as const)('%s: the gap-fill holds the bucket of every day in the window, once each, in order', (grain) => {
    const from = '2026-07-15';
    const to = '2026-10-06';
    const keys = bucketKeys(from, to, grain);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (let d = from; d <= to; d = addDays(d, 1)) expect(keys).toContain(bucketStart(d, grain));
    for (const k of keys) expect(bucketStart(k, grain)).toBe(k);
  });

  it('a first or last week or month cut by the window is marked partial', () => {
    const period = { fromDay: '2026-09-10', toDay: '2026-10-06', grain: 'week' as const };
    expect(isPartialBucket('2026-09-07', period)).toBe(true);
    expect(isPartialBucket('2026-09-14', period)).toBe(false);
    expect(isPartialBucket('2026-10-05', period)).toBe(true);
    expect(isPartialBucket('2026-10-05', { ...period, grain: 'day' })).toBe(false);
  });

  it('the bucket holding today is partial while today is under way, at every grain, and only then', () => {
    const running = parsePeriod({ period: '7d' }, EVENING_UTC);
    expect(running.running).toBe(true);
    expect(isPartialBucket(TODAY_IN_OMAN, running)).toBe(true);
    expect(isPartialBucket(addDays(TODAY_IN_OMAN, -1), running)).toBe(false);
    const weeks = parsePeriod({ period: '90d' }, EVENING_UTC);
    expect(isPartialBucket(bucketStart(TODAY_IN_OMAN, 'week'), weeks)).toBe(true);
    const months = parsePeriod({ period: '12m' }, EVENING_UTC);
    expect(isPartialBucket(bucketStart(TODAY_IN_OMAN, 'month'), months)).toBe(true);
    // A week that ends today (a Sunday) is not cut by the window, but today is not over.
    const sundayNoon = new Date('2026-10-11T08:00:00Z');
    expect(new Date(`${omanDateISO(sundayNoon)}T00:00:00Z`).getUTCDay()).toBe(0);
    const sundayWeeks = parsePeriod({ period: '90d' }, sundayNoon);
    const lastWeek = bucketStart(sundayWeeks.toDay, 'week');
    expect(isPartialBucket(lastWeek, { ...sundayWeeks, running: false })).toBe(false);
    expect(isPartialBucket(lastWeek, sundayWeeks)).toBe(true);
    // A window that has ended has no running bucket.
    const ended = parsePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-30' }, EVENING_UTC);
    expect(ended.running).toBe(false);
    expect(isPartialBucket('2026-09-30', ended)).toBe(false);
  });

  it('labels: a day or a week by its first day, a month by name', () => {
    expect(bucketLabel('2026-10-05', 'week')).toBe('5 Oct');
    expect(bucketLabel('2026-10-01', 'month')).toBe('Oct 2026');
  });

  it('day bars up to a month, weeks up to four months, months beyond', () => {
    expect(grainFor(DAY_MAX_DAYS)).toBe('day');
    expect(grainFor(DAY_MAX_DAYS + 1)).toBe('week');
    expect(grainFor(WEEK_MAX_DAYS)).toBe('week');
    expect(grainFor(WEEK_MAX_DAYS + 1)).toBe('month');
  });
});

describe('the window', () => {
  it('defaults to the last 30 Oman days, today included, and its previous 30', () => {
    const p = parsePeriod({}, EVENING_UTC);
    expect(p.key).toBe('30d');
    expect(p.toDay).toBe(TODAY_IN_OMAN);
    expect(p.fromDay).toBe(addDays(TODAY_IN_OMAN, -29));
    expect(p.days).toBe(30);
    expect(p.from.getTime()).toBe(omanMidnightUtc(p.fromDay).getTime());
    expect(p.to.getTime()).toBe(omanMidnightUtc(addDays(TODAY_IN_OMAN, 1)).getTime());
    expect(EVENING_UTC.getTime()).toBeLessThan(p.to.getTime());
    expect(p.prevToDay).toBe(addDays(p.fromDay, -1));
    expect(p.prevFromDay).toBe(addDays(p.fromDay, -30));
    expect(p.prevFrom.getTime()).toBe(omanMidnightUtc(p.prevFromDay).getTime());
    expect(p.grain).toBe('day');
    expect(p.buckets).toHaveLength(30);
    expect(p.note).toBeNull();
  });

  it('the presets', () => {
    expect(parsePeriod({ period: '7d' }, EVENING_UTC)).toMatchObject({ days: 7, grain: 'day' });
    const q = parsePeriod({ period: '90d' }, EVENING_UTC);
    expect(q).toMatchObject({ days: 90, grain: 'week' });
    expect(q.buckets[0]).toBe(bucketStart(q.fromDay, 'week'));
    const y = parsePeriod({ period: '12m' }, EVENING_UTC);
    expect(y).toMatchObject({ days: 365, grain: 'month' });
    expect(y.buckets[y.buckets.length - 1]).toBe(`${TODAY_IN_OMAN.slice(0, 7)}-01`);
  });

  it('a key given twice (Next hands it over as an array) reads its first value instead of failing', () => {
    expect(parsePeriod({ period: ['7d', '30d'] }, EVENING_UTC)).toMatchObject({ key: '7d', days: 7 });
    expect(
      parsePeriod({ period: ['custom'], from: ['2026-09-01', 'x'], to: ['2026-09-30'] }, EVENING_UTC)
    ).toMatchObject({ key: 'custom', fromDay: '2026-09-01', toDay: '2026-09-30' });
  });

  it('an unknown preset falls back to the default and says so', () => {
    const p = parsePeriod({ period: '5y' }, EVENING_UTC);
    expect(p.key).toBe('30d');
    expect(p.note).toMatch(/Unknown period/);
  });

  // Every object inherits these keys; `key in PERIOD_PRESETS` took them for presets
  // with no length, and the page printed "NaN" and failed every dated card.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'an inherited key (%s) is an unknown preset, never a window of undefined days',
    (key) => {
      const p = parsePeriod({ period: key }, EVENING_UTC);
      expect(p.key).toBe(DEFAULT_PRESET);
      expect(p.days).toBe(PERIOD_PRESETS[DEFAULT_PRESET].days);
      expect(p.note).toMatch(/Unknown period/);
      expect(Number.isNaN(p.from.getTime())).toBe(false);
      expect(p.fromDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.buckets).toHaveLength(p.days);
    }
  );

  it('a custom window is read as Oman days, both ends included', () => {
    const p = parsePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-30' }, EVENING_UTC);
    expect(p).toMatchObject({ key: 'custom', fromDay: '2026-09-01', toDay: '2026-09-30', days: 30, note: null });
    expect(p.from.toISOString()).toBe('2026-08-31T20:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-09-30T20:00:00.000Z');
  });

  it('reversed ends are swapped; a window into the future ends today', () => {
    expect(parsePeriod({ period: 'custom', from: '2026-09-30', to: '2026-09-01' }, EVENING_UTC)).toMatchObject({
      fromDay: '2026-09-01',
      toDay: '2026-09-30',
    });
    const f = parsePeriod({ period: 'custom', from: '2026-10-01', to: addDays(TODAY_IN_OMAN, 30) }, EVENING_UTC);
    expect(f.toDay).toBe(TODAY_IN_OMAN);
    expect(f.note).toMatch(/ends today/);
  });

  it(`a custom window longer than ${MAX_WINDOW_DAYS} days keeps its last ${MAX_WINDOW_DAYS}`, () => {
    const p = parsePeriod({ period: 'custom', from: '2024-01-01', to: '2026-09-30' }, EVENING_UTC);
    expect(p.days).toBe(MAX_WINDOW_DAYS);
    expect(p.toDay).toBe('2026-09-30');
    expect(p.note).toMatch(/limited to 366 days/);
  });

  it(`a custom window wholly before ${EARLIEST_DAY} falls back to the default and says so — never a reversed window`, () => {
    const p = parsePeriod({ period: 'custom', from: '2019-01-01', to: '2019-02-01' }, EVENING_UTC);
    expect(p.key).toBe(DEFAULT_PRESET);
    expect(p.fromDay <= p.toDay).toBe(true);
    expect(p.days).toBeGreaterThan(0);
    expect(p.note).toMatch(/ends before 1 Jan 2020/);
    // One that only starts before it is clamped, as before.
    const q = parsePeriod({ period: 'custom', from: '2019-12-01', to: '2020-01-10' }, EVENING_UTC);
    expect(q).toMatchObject({ key: 'custom', fromDay: EARLIEST_DAY, toDay: '2020-01-10', days: 10 });
  });

  it('unreadable dates fall back to the default and say so', () => {
    const p = parsePeriod({ period: 'custom', from: '2026-02-30', to: 'yesterday' }, EVENING_UTC);
    expect(p.key).toBe('30d');
    expect(p.note).toMatch(/could not be read/);
  });

  it('the comparison runs exactly as long as the window has: like for like, at 08:00 Oman on a weekday', () => {
    // 04:00 UTC is 08:00 in Oman. Read once; every expectation derives from it.
    const morning = new Date('2026-10-05T04:00:00Z');
    for (const key of ['7d', '30d', '90d', '12m']) {
      const p = parsePeriod({ period: key }, morning);
      expect(p.running, key).toBe(true);
      expect(p.prevTo.getTime() - p.prevFrom.getTime(), key).toBe(morning.getTime() - p.from.getTime());
      // It ends inside the comparison window's last day, at the same time of day.
      expect(p.prevTo.getTime(), key).toBeLessThan(p.from.getTime());
      expect(p.from.getTime() - p.prevTo.getTime(), key).toBe(p.to.getTime() - morning.getTime());
    }
  });

  it('a window that has ended is compared with all of the days before it', () => {
    const p = parsePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-30' }, EVENING_UTC);
    expect(p.running).toBe(false);
    expect(p.prevTo.getTime()).toBe(p.from.getTime());
    expect(p.prevTo.getTime() - p.prevFrom.getTime()).toBe(p.to.getTime() - p.from.getTime());
  });

  it('with the real clock, read once: the window ends on today in Oman', () => {
    const now = new Date();
    const today = omanDateISO(now);
    const p = parsePeriod({ period: '7d' }, now);
    expect(p.toDay).toBe(today);
    expect(p.fromDay).toBe(addDays(today, -6));
    expect(p.from.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(p.to.getTime()).toBeGreaterThan(now.getTime());
    expect(p.prevTo.getTime() - p.prevFrom.getTime()).toBe(now.getTime() - p.from.getTime());
  });
});
