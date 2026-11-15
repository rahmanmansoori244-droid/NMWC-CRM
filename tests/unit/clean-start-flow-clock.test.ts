// @vitest-environment node
/**
 * The clean-start flow test's pinned clock (tests/support/clean-start/flow-clock.ts,
 * the date stand-in's FAKE_UTC_OFFSET and tests/support/clean-start/clock-preload.mjs).
 *
 * The flow test (local only) gives every clock the workflow reads one test clock,
 * pinned to 16:00 UTC (20:00 Oman) of the real Oman day, or the real time if that
 * is later, and waits for midnight in Oman when a start is close to it. Here, in CI:
 * the pin and the wait swept over every 5 minutes of 30 Dec to 2 Jan and one
 * ordinary day, the stand-in's offset, and the preload. A spawned clock is
 * bracketed by real readings before and after the spawn, never held to a fixed
 * tolerance (a loaded runner can take seconds to start bash or node).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { omanDateISO, omanYear } from '@/lib/tz';
import { jobDayCompleteAt } from '../../scripts/ops/clean-start/rehearse-watch';
import { baseEnv, standinPath, BIN, type Env } from '../support/clean-start/sandbox';
import {
  FLOW_BUDGET_MS,
  clockFault,
  dayUtc,
  eveningBand,
  eveningPin,
  morningBand,
  stampOf,
  startDelayMs,
} from '../support/clean-start/flow-clock';

const MIN = 60_000;
const OFF = -36_000; // seconds: the offset the spawned clocks are tested with
const PRELOAD = resolve('tests/support/clean-start/clock-preload.mjs');

const realS = () => Math.floor(Date.now() / 1000);
/** The real clock read before and after fn, in whole seconds. */
function bracket<T>(fn: () => T): { before: number; after: number; out: T } {
  const before = realS();
  const out = fn();
  return { before, after: realS(), out };
}
const hhmm = (s: number) => new Date(s * 1000).toISOString().slice(11, 16).replace(':', '');
/** stampOf's key stamp back to an instant. */
const parseStamp = (st: string) => Date.parse(st.replace(/T(\d\d)-(\d\d)-(\d\d)Z$/, 'T$1:$2:$3Z'));

/** The parent's environment without any of the clock knobs or a preload. */
function cleanEnv(extra: Record<string, string> = {}): Env {
  const e = { ...baseEnv(), PATH: standinPath() } as Env;
  for (const k of ['FAKE_UTC_EPOCH', 'FAKE_UTC_HHMM', 'FAKE_UTC_OFFSET', 'NODE_OPTIONS']) delete e[k];
  return { ...e, ...extra } as Env;
}
const date = (args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync('bash', [join(BIN, 'date'), ...args], { env: cleanEnv(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`date ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

describe('the flow clock: the pin and the wait, swept', () => {
  const walls: number[] = [];
  const days: string[] = [];
  for (const [from, to] of [
    ['2026-12-30T00:00:00Z', '2027-01-02T00:00:00Z'],
    ['2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z'],
  ] as const) {
    for (let t = Date.parse(from); t <= Date.parse(to); t += 5 * MIN) walls.push(t);
    for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  }
  const EDGES: Array<[number, number, number]> = [
    [14, 59, 59], [15, 0, 0], [15, 0, 30], [15, 1, 0], [19, 39, 59], [19, 40, 0], [19, 59, 59], [20, 0, 0], [23, 58, 0], [0, 0, 0],
  ];
  for (const d of days) for (const [h, m, s] of EDGES) walls.push(dayUtc(d, h, m, s).getTime());

  it(`every wall clock start gives an evening pin on a stable Oman day (${walls.length} instants)`, () => {
    const bad: string[] = [];
    const check = (w: number, ok: boolean, what: string) => {
      if (!ok) bad.push(`${new Date(w).toISOString()}: ${what}`);
    };
    for (const w of walls) {
      const W = new Date(w);
      const utcMin = W.getUTCHours() * 60 + W.getUTCMinutes();
      const delay = startDelayMs(W);
      const inWait = utcMin >= 19 * 60 + 40 && utcMin < 20 * 60;
      check(w, delay > 0 === inWait, `waits ${delay} ms`);
      if (inWait) {
        check(w, w + delay === dayUtc(W.toISOString().slice(0, 10), 20, 0, 5).getTime(), 'waits until 20:00:05 UTC of that date');
        check(w, delay <= 20 * MIN + 5000, 'waits at most 20 min 5 s');
      }
      const S = w + delay;
      const { day, pinMs } = eveningPin(new Date(S));
      check(w, day === omanDateISO(new Date(S)), 'the pinned day is the Oman day at the start');
      check(w, day === omanDateISO(new Date(S + FLOW_BUDGET_MS)), 'the Oman day holds for the whole budget');
      check(w, pinMs >= S, 'the pin is never earlier than the start');
      check(w, omanDateISO(new Date(pinMs)) === day, 'the pin is on the pinned day');
      check(w, pinMs >= dayUtc(day, 16).getTime() && pinMs <= dayUtc(day, 19, 40).getTime(), 'the pin is 16:00-19:40 UTC');
      for (const t of [0, FLOW_BUDGET_MS]) check(w, clockFault(day, day, pinMs + t, eveningBand(day)) === null, `in the evening band at +${t} ms`);
      const pinH = new Date(pinMs).getUTCHours();
      check(w, pinH >= 16 && pinH < 20, `the pin's UTC hour is ${pinH}`);
      check(w, jobDayCompleteAt(new Date(pinMs), 15).getTime() <= pinMs, "night 2's job day is complete at the pin");
      check(w, parseStamp(stampOf(pinMs - 60_000)) >= dayUtc(day, 15).getTime(), 'the evening dump is after the 15:00 UTC cut');
      const m = dayUtc(day, 6).getTime();
      check(w, omanDateISO(new Date(m)) === day, 'the morning is on the pinned day');
      check(w, m + FLOW_BUDGET_MS < dayUtc(day, 15).getTime(), 'the morning ends before the 15:00 UTC cut');
      check(w, m < jobDayCompleteAt(new Date(m), 15).getTime(), "the morning is before night 2's job day is complete");
      check(w, clockFault(day, day, m + 60_000, morningBand(day)) === null, 'the morning is in its band');
      check(w, omanYear(new Date(pinMs)) === Number(day.slice(0, 4)), "the pin's Oman year is the pinned day's");
    }
    expect(bad).toEqual([]);
  });

  it('the wait and the pin at named instants', () => {
    expect(startDelayMs(new Date('2026-11-15T19:39:59Z'))).toBe(0);
    expect(startDelayMs(new Date('2026-11-15T19:40:00Z'))).toBe(20 * MIN + 5000);
    expect(startDelayMs(new Date('2026-11-15T19:59:59Z'))).toBe(6000);
    expect(startDelayMs(new Date('2026-11-15T20:00:00Z'))).toBe(0);
    expect(eveningPin(new Date('2026-11-15T15:00:30Z'))).toEqual({ day: '2026-11-15', pinMs: Date.parse('2026-11-15T16:00:00Z') });
    expect(eveningPin(new Date('2026-11-15T17:12:00Z'))).toEqual({ day: '2026-11-15', pinMs: Date.parse('2026-11-15T17:12:00Z') });
    expect(eveningPin(new Date('2026-12-31T20:00:05Z'))).toEqual({ day: '2027-01-01', pinMs: Date.parse('2027-01-01T16:00:00Z') });
    expect(stampOf(Date.parse('2026-11-15T15:59:00.750Z'))).toBe('2026-11-15T15-59-00Z');
  });
});

describe('the flow clock: clockFault', () => {
  const band = eveningBand('2026-11-15');
  it('names the day when Postgres is on another Oman day', () => {
    expect(clockFault('2026-11-15', '2026-11-16', band[0], band)).toBe("Postgres's Oman day is 2026-11-16, the pinned day is 2026-11-15");
  });
  it('names the band when the clock is below it, or at or after its end', () => {
    expect(clockFault('2026-11-15', '2026-11-15', band[0] - 1, band)).toBe(
      'the pinned clock 2026-11-15T15:29:59.999Z is outside 2026-11-15T15:30:00.000Z-2026-11-15T20:00:00.000Z'
    );
    expect(clockFault('2026-11-15', '2026-11-15', band[1], band)).toMatch(/^the pinned clock 2026-11-15T20:00:00\.000Z is outside /);
  });
  it('is null on the band start and just under its end', () => {
    expect(clockFault('2026-11-15', '2026-11-15', band[0], band)).toBeNull();
    expect(clockFault('2026-11-15', '2026-11-15', band[1] - 1, band)).toBeNull();
  });
});

describe('the date stand-in: FAKE_UTC_OFFSET', () => {
  const O = { FAKE_UTC_OFFSET: String(OFF) };
  it('shifts every read of the clock, in every format', () => {
    const s = bracket(() => Number(date(['-u', '+%s'], O)));
    expect(s.out).toBeGreaterThanOrEqual(s.before + OFF - 1);
    expect(s.out).toBeLessThanOrEqual(s.after + OFF + 1);
    const hm = bracket(() => date(['-u', '+%H%M'], O));
    expect([hhmm(hm.before + OFF), hhmm(hm.after + OFF)]).toContain(hm.out);
    const iso = bracket(() => Date.parse(date(['-u', '+%Y-%m-%dT%H:%M:%SZ'], O)) / 1000);
    expect(iso.out).toBeGreaterThanOrEqual(iso.before + OFF - 1);
    expect(iso.out).toBeLessThanOrEqual(iso.after + OFF + 1);
  });
  it("run.sh's nested Oman date follows the shifted now", () => {
    const n = bracket(() => {
      const r = spawnSync('bash', ['-c', 'date -u -d "@$(( $(date -u +%s) + 14400 ))" +%Y-%m-%d'], { env: cleanEnv(O), encoding: 'utf8' });
      return r.stdout.trim();
    });
    expect([omanDateISO(new Date((n.before + OFF) * 1000)), omanDateISO(new Date((n.after + OFF) * 1000))]).toContain(n.out);
  });
  it('a call given a time is the real date, unchanged', () => {
    expect(date(['-u', '-d', '@0', '+%s'], O)).toBe('0');
    expect(date(['-u', '-d', '2026-01-01 15:00:00', '+%s'], O)).toBe('1767279600');
  });
  it('FAKE_UTC_EPOCH and FAKE_UTC_HHMM keep precedence', () => {
    expect(date(['-u', '+%s'], { ...O, FAKE_UTC_EPOCH: '1000' })).toBe('1000');
    expect(date(['-u', '+%H%M'], { ...O, FAKE_UTC_HHMM: '0930' })).toBe('0930');
  });
  it('with nothing set it is the real clock', () => {
    const s = bracket(() => Number(date(['-u', '+%s'])));
    expect(s.out).toBeGreaterThanOrEqual(s.before - 1);
    expect(s.out).toBeLessThanOrEqual(s.after + 1);
  });
});

describe('the Node preload: clock-preload.mjs', () => {
  const SCRIPT =
    'process.stdout.write(JSON.stringify({ now: Date.now(), made: new Date().getTime(), zero: new Date(0).getTime(), utc: Date.UTC(2026, 0, 1), inst: new Date() instanceof Date, str: typeof Date() }))';
  const node = (imports: string[], extra: Record<string, string> = {}) =>
    bracket(() => {
      const opts = imports.map((f) => `--import=${pathToFileURL(f).href}`).join(' ');
      const r = spawnSync(process.execPath, ['-e', SCRIPT], { env: cleanEnv({ ...(opts ? { NODE_OPTIONS: opts } : {}), ...extra }), encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`node failed: ${r.stderr}`);
      return JSON.parse(r.stdout) as { now: number; made: number; zero: number; utc: number; inst: boolean; str: string };
    });
  const expectShift = (b: ReturnType<typeof node>, offS: number) => {
    for (const v of [b.out.now, b.out.made]) {
      expect(v).toBeGreaterThanOrEqual((b.before + offS - 1) * 1000);
      expect(v).toBeLessThanOrEqual((b.after + offS + 1) * 1000);
    }
  };

  it('shifts Date.now(), new Date() and Date(), and leaves a Date made from a value unchanged', () => {
    const b = node([PRELOAD], { FAKE_UTC_OFFSET: String(OFF) });
    expectShift(b, OFF);
    expect(b.out.zero).toBe(0);
    expect(b.out.utc).toBe(1767225600000);
    expect(b.out.inst).toBe(true);
    expect(b.out.str).toBe('string');
  });
  it('installs once per process: two --import flags (another path, the same bytes) shift once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nmwc-flow-clock-'));
    try {
      const copy = join(dir, 'clock-preload.mjs');
      copyFileSync(PRELOAD, copy);
      expectShift(node([PRELOAD, copy], { FAKE_UTC_OFFSET: String(OFF) }), OFF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('is a no-op with FAKE_UTC_OFFSET unset', () => {
    expectShift(node([PRELOAD]), 0);
  });
});
