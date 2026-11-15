// @vitest-environment node
/**
 * Go-live clean start: the watch rehearsal (scripts/ops/clean-start/rehearse-watch.ts)
 * gives the right answer at EVERY hour of the day (review 2026-11-15).
 *
 * Until then night 2 was "the coming 02:30 UTC". For a rehearsal between 20:00
 * and 02:30 UTC (00:00-06:30 in Oman) that is the SAME Oman day as night 1: the
 * real watch then writes no second seal ("already", still a pass) and checks
 * no day of job runs, and the rehearsal said "as expected: yes" having proved
 * neither. A dry run or a Neon rehearsal that slips past midnight in Oman, or
 * an apply started late, would have been a false green.
 *
 * Every clock here is INJECTED: nothing below depends on when the suite runs
 * (one test even moves the machine's clock to prove it). The real watch on a
 * real reset database is driven through the same hours by
 * tests/integration/clean-start.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daysBetween } from '@/lib/integrity/classify';
import { omanDateISO } from '@/lib/tz';
import {
  jobDayCompleteAt,
  loadExpected,
  nextOmanMorning,
  rehearseWatch,
  reportLines,
  sealResultOf,
  type WatchFn,
} from '../../scripts/ops/clean-start/rehearse-watch';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const EXPECTED = loadExpected();
const JOBS = 'scheduled-jobs-on-time';
const JOBS_HOUR = EXPECTED.night2NotAssertedBeforeUtcHour[JOBS] as number;

const iso = (d: Date) => d.toISOString();
/** The calendar date after a YYYY-MM-DD one. */
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
/** The rule this replaces: the coming 02:30 UTC, strictly after `now`. */
const comingMorning = (now: Date) => {
  const same = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30);
  return new Date(same > now.getTime() ? same : same + DAY);
};
/** 20:00-02:30 UTC: after midnight in Oman, before that Oman day's 06:30 watch. */
const sameOmanDayByTheOldRule = (now: Date) => {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= 20 * 60 || m < 2 * 60 + 30;
};

/** Every half hour of a day, and the instants either side of each boundary of the rules. */
function instantsOf(day: string): Date[] {
  const t0 = Date.parse(`${day}T00:00:00Z`);
  const out: number[] = [];
  for (let m = 0; m < 24 * 60; m += 30) out.push(t0 + m * MIN);
  for (const [h, m] of [
    [2, 30],
    [15, 0],
    [15, 30],
    [20, 0],
  ] as const) {
    const edge = t0 + h * HOUR + m * MIN;
    out.push(edge - 1, edge, edge + 1, edge - MIN, edge + MIN);
  }
  out.push(t0 + 1, t0 + DAY - 1);
  return [...new Set(out)].sort((a, b) => a - b).map((t) => new Date(t));
}
/** An ordinary day, a month end, a year end and a leap day. */
const DAYS = ['2026-11-18', '2026-11-30', '2026-12-31', '2028-02-28', '2028-02-29'];
const ALL = DAYS.flatMap(instantsOf);

describe('night 2 is 02:30 UTC of the Oman day after night 1, at every hour', () => {
  it('there is a sweep: every half hour of five days and every boundary', () => {
    // 48 half hours; four instants around each of the four boundaries; the day's first and last ms
    expect(instantsOf('2026-11-18')).toHaveLength(48 + 4 * 4 + 2);
    expect(ALL).toHaveLength(DAYS.length * 66);
    const hours = new Set(instantsOf('2026-11-18').map((d) => d.getUTCHours()));
    expect([...hours].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, h) => h));
  });

  it('always 02:30:00.000 UTC, always the next Oman date, never the same Oman day', () => {
    for (const night1 of ALL) {
      const night2 = nextOmanMorning(night1);
      expect(iso(night2).slice(11), iso(night1)).toBe('02:30:00.000Z');
      expect(omanDateISO(night2), iso(night1)).toBe(dayAfter(omanDateISO(night1)));
      // 06:30 Oman on the next Oman date: more than 6.5 h and at most 30.5 h ahead.
      const ahead = night2.getTime() - night1.getTime();
      expect(ahead, iso(night1)).toBeGreaterThan(6.5 * HOUR);
      expect(ahead, iso(night1)).toBeLessThanOrEqual(30.5 * HOUR);
    }
  });

  it('from 02:30 to 20:00 UTC nothing changed: it is the coming 02:30 UTC, minute by minute', () => {
    const t0 = Date.parse('2026-11-18T00:00:00Z');
    let unchanged = 0;
    let moved = 0;
    for (let m = 0; m < 24 * 60; m++) {
      const now = new Date(t0 + m * MIN);
      const was = comingMorning(now).getTime();
      const is = nextOmanMorning(now).getTime();
      if (sameOmanDayByTheOldRule(now)) {
        // the old answer was night 1's own Oman day: now one day further
        expect(omanDateISO(new Date(was)), iso(now)).toBe(omanDateISO(now));
        expect(is, iso(now)).toBe(was + DAY);
        moved++;
      } else {
        expect(is, iso(now)).toBe(was);
        unchanged++;
      }
    }
    // 02:30-20:00 UTC is 17.5 hours; the other 6.5 are 00:00-06:30 in Oman.
    expect([unchanged, moved]).toEqual([17.5 * 60, 6.5 * 60]);
  });

  it('the instants the owner may meet, written out', () => {
    const at = (s: string) => iso(nextOmanMorning(new Date(s)));
    // the planned evening (19:30-23:59 Oman): the next morning
    expect(at('2026-11-18T15:30:00Z')).toBe('2026-11-19T02:30:00.000Z');
    expect(at('2026-11-18T19:59:59Z')).toBe('2026-11-19T02:30:00.000Z');
    // a run that slipped past midnight in Oman: the morning after ITS Oman day (the 19th)
    expect(at('2026-11-18T20:00:00Z')).toBe('2026-11-20T02:30:00.000Z');
    expect(at('2026-11-18T23:59:00Z')).toBe('2026-11-20T02:30:00.000Z');
    expect(at('2026-11-19T01:59:00Z')).toBe('2026-11-20T02:30:00.000Z');
    expect(at('2026-11-19T02:29:59Z')).toBe('2026-11-20T02:30:00.000Z');
    // from that morning's own watch on, as before
    expect(at('2026-11-19T02:30:00Z')).toBe('2026-11-20T02:30:00.000Z');
    expect(at('2026-11-19T12:00:00Z')).toBe('2026-11-20T02:30:00.000Z');
    // month end and year end
    expect(at('2026-11-30T19:59:00Z')).toBe('2026-12-01T02:30:00.000Z');
    expect(at('2026-11-30T21:00:00Z')).toBe('2026-12-02T02:30:00.000Z');
    expect(at('2026-12-31T20:00:00Z')).toBe('2027-01-02T02:30:00.000Z');
  });
});

describe('scheduled-jobs-on-time on night 2 is asserted only when the copy can hold the day it reads', () => {
  it('the day is complete at 15:00 UTC on the calendar date of night 1\'s Oman day', () => {
    expect(JOBS_HOUR).toBe(15);
    for (const night1 of ALL)
      expect(iso(jobDayCompleteAt(night1, JOBS_HOUR)), iso(night1)).toBe(`${omanDateISO(night1)}T15:00:00.000Z`);
  });

  it('asserted from 15:00 to 20:00 UTC, reported only at every other hour; unchanged from 02:30 to 20:00', () => {
    for (const night1 of ALL) {
      const asserted = night1.getTime() >= jobDayCompleteAt(night1, JOBS_HOUR).getTime();
      const h = night1.getUTCHours();
      expect(asserted, iso(night1)).toBe(h >= 15 && h < 20);
      // the old rule looked at the hour alone: the same answer except after 20:00 UTC
      if (h < 20) expect(asserted, iso(night1)).toBe(!(h < JOBS_HOUR));
    }
  });
});

type Call = { at: string; seal: string; jobDays: string[]; jobs: string };

/**
 * A stand-in for the nightly watch that keeps the two things of it that depend
 * on the hour, by the watch's own rules:
 *   - one seal per Oman day (lib/seal/seal.ts): the genesis, then "sealed", and
 *     "already" — still a pass (lib/integrity/run.ts) — for a second run that day;
 *   - scheduled-jobs-on-time (lib/integrity/checks.ts): the Oman days after the
 *     last one checked up to yesterday, by the real daysBetween; a day's runs
 *     are all in the copy only if the copy was taken at or after 15:00 UTC on
 *     that date.
 * Every other check answers the first status its table allows.
 */
function modelWatch(copyTakenAt: Date) {
  const calls: Call[] = [];
  let lastSealDay: string | null = null;
  let checkedThrough: string | undefined;
  const fn: WatchFn<null> = async (_db, deps) => {
    const now = deps.now;
    const day = omanDateISO(now);
    const seal = lastSealDay === day ? 'already' : lastSealDay === null ? 'genesis' : 'sealed';
    lastSealDay = day;
    const yesterday = omanDateISO(new Date(now.getTime() - DAY));
    const after = checkedThrough ?? omanDateISO(new Date(now.getTime() - 2 * DAY));
    const jobDays = daysBetween(after, yesterday);
    checkedThrough = yesterday;
    const held = jobDays.every((d) => copyTakenAt.getTime() >= Date.parse(`${d}T${JOBS_HOUR}:00:00Z`));
    const jobs = held ? 'pass' : 'fail';
    const table = calls.length === 0 ? EXPECTED.night1 : EXPECTED.night2;
    calls.push({ at: iso(now), seal, jobDays, jobs });
    return {
      results: Object.entries(table).map(([checkId, allowed]) => {
        if (checkId === 'seal-written')
          return { checkId, status: seal === 'genesis' ? 'info' : 'pass', detail: { result: seal } };
        if (checkId === JOBS) return { checkId, status: jobs, detail: { days: jobDays } };
        return { checkId, status: allowed[0]!, detail: null };
      }),
    };
  };
  return { fn, calls };
}

describe('the rehearsal, hour by hour, against a watch that seals once per Oman day', () => {
  it('the stand-in reproduces what was reported: with the old night 2, 20:00-02:30 UTC seals nothing and checks no day', async () => {
    for (const night1 of instantsOf('2026-11-18')) {
      const w = modelWatch(night1);
      const deps = { store: {} as never, inAppAlerts: false, alert: async () => true, audience: async () => [] };
      await w.fn(null, { ...deps, now: night1 });
      await w.fn(null, { ...deps, now: comingMorning(night1) });
      const same = sameOmanDayByTheOldRule(night1);
      expect(w.calls[1]!.seal, iso(night1)).toBe(same ? 'already' : 'sealed');
      expect(w.calls[1]!.jobDays.length, iso(night1)).toBe(same ? 0 : 1);
    }
  });

  it('at every hour: a first seal, then a chained one; night 2 reads night 1\'s Oman day; green', async () => {
    for (const night1 of ALL) {
      // The copy is taken when the rehearsal runs (a Neon branch; a dump no older than 4 hours
      // that an evening run requires to be from the evening).
      const w = modelWatch(night1);
      const r = await rehearseWatch(null, w.fn, { now: night1, expected: EXPECTED });
      const at = iso(night1);
      const d1 = omanDateISO(night1);
      expect(r.mismatches, at).toEqual([]);
      expect(r.ok, at).toBe(true);
      expect(reportLines(r).at(-1), at).toBe('first integrity checks as expected: yes');
      expect(w.calls.map((c) => c.seal), at).toEqual(['genesis', 'sealed']);
      expect(w.calls[0]!.jobDays, at).toEqual([dayBefore(d1)]);
      expect(w.calls[1]!.jobDays, at).toEqual([d1]);
      expect(r.nights.map((n) => n.at), at).toEqual([at, `${dayAfter(d1)}T02:30:00.000Z`]);
      // Asserted exactly when the copy holds the day: the skip never hides a day that should be there.
      const asserted = !r.nights[1]!.notAsserted.includes(JOBS);
      expect(asserted, at).toBe(w.calls[1]!.jobs === 'pass');
      expect(r.nights[0]!.notAsserted, at).toEqual([]);
      expect(r.nights[1]!.notAsserted, at).toEqual(asserted ? [] : [JOBS]);
    }
  });

  it('an evening copy that lacks the day\'s last job runs is NOT hidden (a dump from before 15:00 UTC)', async () => {
    const night1 = new Date('2026-11-18T16:00:00Z');
    const w = modelWatch(new Date('2026-11-18T14:00:00Z'));
    const r = await rehearseWatch(null, w.fn, { now: night1, expected: EXPECTED });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([{ night: 2, checkId: JOBS, got: 'fail', expected: ['pass', 'info'] }]);
    // ...and night 1 is asserted at every hour: a copy without yesterday's runs fails there.
    const stale = modelWatch(new Date('2026-11-17T10:00:00Z'));
    const r1 = await rehearseWatch(null, stale.fn, { now: new Date('2026-11-18T22:00:00Z'), expected: EXPECTED });
    expect(r1.mismatches.filter((m) => m.night === 1)).toEqual([
      { night: 1, checkId: JOBS, got: 'fail', expected: ['pass', 'info'] },
    ]);
  });
});

describe('a night that sealed nothing is a mismatch, whatever its status says', () => {
  const fixed = (seals: Array<Record<string, unknown> | null>, statuses: [string, string] = ['info', 'pass']): WatchFn<null> => {
    let n = 0;
    return async () => {
      const night = n++;
      const table = night === 0 ? EXPECTED.night1 : EXPECTED.night2;
      return {
        results: Object.entries(table).map(([checkId, allowed]) =>
          checkId === 'seal-written'
            ? { checkId, status: statuses[night]!, detail: seals[night]! }
            : { checkId, status: allowed[0]!, detail: null }
        ),
      };
    };
  };
  const opts = { now: new Date('2026-11-18T16:00:00Z'), expected: EXPECTED, assertJobsOnNight2: true };

  it('expected-watch.json asks for genesis, then sealed', () => {
    expect(EXPECTED.sealWrittenResult).toMatchObject({ night1: 'genesis', night2: 'sealed' });
    expect(EXPECTED.night1['seal-written']).toEqual(['info']);
    expect(EXPECTED.night2['seal-written']).toEqual(['pass']);
  });

  it('genesis then sealed is as expected', async () => {
    const r = await rehearseWatch(null, fixed([{ result: 'genesis' }, { result: 'sealed' }]), opts);
    expect(r.mismatches).toEqual([]);
  });

  it('"already" on night 2 (a pass in the status table) is the false green, and it is named in the log', async () => {
    const r = await rehearseWatch(null, fixed([{ result: 'genesis' }, { result: 'already' }]), opts);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([{ night: 2, checkId: 'seal-written', got: 'already', expected: ['sealed'] }]);
    const lines = reportLines(r);
    expect(lines).toContain('  MISMATCH night 2 seal-written: already, expected sealed');
    expect(lines.at(-1)).toBe('first integrity checks as expected: no');
    // the shape run.sh watch-lines and the public log rule let through
    for (const l of lines.filter((x) => x.includes('MISMATCH')))
      expect(l).toMatch(/^ *MISMATCH night [12] [a-z0-9-]+: [a-z]+, expected [a-z|]+( listed)?$/);
  });

  it('a result that is missing, or not one of the watch\'s words, is "unknown": never free text', async () => {
    expect(sealResultOf(null)).toBe('unknown');
    expect(sealResultOf({})).toBe('unknown');
    expect(sealResultOf({ result: 'Sealed 12 rows of Customer' })).toBe('unknown');
    expect(sealResultOf({ result: 7 })).toBe('unknown');
    expect(sealResultOf({ result: 'sealed' })).toBe('sealed');
    const r = await rehearseWatch(null, fixed([{ result: 'genesis' }, null]), opts);
    expect(r.mismatches).toEqual([{ night: 2, checkId: 'seal-written', got: 'unknown', expected: ['sealed'] }]);
    const first = await rehearseWatch(null, fixed([{ seq: 0 }, { result: 'sealed' }]), opts);
    expect(first.mismatches).toEqual([{ night: 1, checkId: 'seal-written', got: 'unknown', expected: ['genesis'] }]);
  });

  it('a seal that was deferred already fails by its status: one line, not two', async () => {
    const r = await rehearseWatch(null, fixed([{ result: 'genesis' }, { result: 'deferred' }], ['info', 'fail']), opts);
    expect(r.mismatches).toEqual([{ night: 2, checkId: 'seal-written', got: 'fail', expected: ['pass'] }]);
  });
});

describe('the result does not depend on the machine\'s clock', () => {
  afterEach(() => vi.useRealTimers());

  it('the 15:00 UTC rule follows night 1\'s time unless the caller names another clock', async () => {
    const run = async (now: string, clock?: string) => {
      const w = modelWatch(new Date(now));
      const r = await rehearseWatch(null, w.fn, { now: new Date(now), expected: EXPECTED, ...(clock ? { clock: new Date(clock) } : {}) });
      return r.nights[1]!.notAsserted;
    };
    for (const machine of ['2026-11-18T03:00:00Z', '2026-11-18T16:00:00Z', '2026-11-18T21:00:00Z', '2031-01-01T00:00:00Z']) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(machine));
      expect(await run('2026-11-18T16:00:00Z'), machine).toEqual([]);
      expect(await run('2026-11-18T10:00:00Z'), machine).toEqual([JOBS]);
      expect(await run('2026-11-18T21:00:00Z'), machine).toEqual([JOBS]);
      vi.useRealTimers();
    }
    // A caller that knows the copy is older than the run says so.
    expect(await run('2026-11-18T16:00:00Z', '2026-11-18T14:59:59Z')).toEqual([JOBS]);
    expect(await run('2026-11-18T14:00:00Z', '2026-11-18T15:00:00Z')).toEqual([]);
  });

  it('with no time given it reads the clock once, for both nights', async () => {
    vi.useFakeTimers();
    for (const machine of ['2026-11-18T19:59:59Z', '2026-11-18T20:00:00Z', '2026-11-19T02:29:00Z']) {
      vi.setSystemTime(new Date(machine));
      const w = modelWatch(new Date(machine));
      const r = await rehearseWatch(null, w.fn, { expected: EXPECTED });
      expect(r.ok, machine).toBe(true);
      expect(r.nights[0]!.at, machine).toBe(iso(new Date(machine)));
      expect(w.calls.map((c) => c.seal), machine).toEqual(['genesis', 'sealed']);
    }
  });
});
