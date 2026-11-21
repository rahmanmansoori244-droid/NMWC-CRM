/**
 * Large-customer photos, part B: the tab's photo queue (components/nmwc/photo-queue.ts),
 * on fake timers. Every rule of SPEC section 3 step 2 with amendment M1: only a
 * failure of a photo started while the queue was already paced doubles the pace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BURST_AGAIN_AFTER_MS,
  MAX_FAILURES,
  MAX_IN_FLIGHT,
  PACE_MAX_MS,
  PACE_MS,
  SLOT_RELEASE_MS,
  STOP_AFTER_CONSECUTIVE,
  done,
  getSnapshot,
  photoQueueInternalsForTests,
  register,
  reportFirstLoadFailure,
  request,
  resetPhotoQueueForTests,
  retryFailed,
  subscribe,
  unregister,
  type PhotoQueueState,
} from '@/components/nmwc/photo-queue';

type Photo = { key: number; starts: number[]; states: PhotoQueueState[]; name: string };
let startLog: { name: string; at: number }[] = [];
let inFlightNow = 0;
let maxInFlight = 0;

function photo(name: string): Photo {
  const p: Photo = { key: 0, starts: [], states: [], name };
  p.key = register(
    () => {
      p.starts.push(Date.now());
      startLog.push({ name, at: Date.now() });
      inFlightNow++;
      maxInFlight = Math.max(maxInFlight, inFlightNow);
    },
    (s) => p.states.push(s)
  );
  return p;
}
function finish(p: Photo, ok: boolean) {
  inFlightNow--;
  done(p.key, ok);
}
const last = (p: Photo) => p.states[p.states.length - 1];
const gaps = (from = 0) =>
  startLog.slice(from + 1).map((s, i) => s.at - startLog[from + i]!.at);

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T08:00:00Z'));
  resetPhotoQueueForTests();
  startLog = [];
  inFlightNow = 0;
  maxInFlight = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  resetPhotoQueueForTests();
  vi.useRealTimers();
});

describe('photo queue', () => {
  it('the constants are the spec’s', () => {
    expect([MAX_IN_FLIGHT, PACE_MS, PACE_MAX_MS, BURST_AGAIN_AFTER_MS, MAX_FAILURES, STOP_AFTER_CONSECUTIVE, SLOT_RELEASE_MS]).toEqual([
      6, 1100, 8000, 60_000, 4, 12, 120_000,
    ]);
  });

  it('never has more than 6 in flight, and starts the next as one ends', () => {
    const ps = Array.from({ length: 20 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    expect(startLog).toHaveLength(6);
    expect(photoQueueInternalsForTests().inFlight).toBe(6);
    for (let i = 0; i < 20; i++) {
      const running = ps.filter((p) => last(p) === 'loading');
      if (running.length === 0) break;
      finish(running[0]!, true);
      expect(photoQueueInternalsForTests().inFlight).toBeLessThanOrEqual(6);
    }
    expect(ps.every((p) => last(p) === 'loaded')).toBe(true);
    expect(maxInFlight).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bursts until the first failure, then starts at least 1100 ms apart', () => {
    const ps = Array.from({ length: 30 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    // The burst: all 6 at the same moment.
    expect(new Set(startLog.map((s) => s.at)).size).toBe(1);
    finish(ps[0]!, false);
    expect(getSnapshot().paced).toBe(true);
    const from = startLog.length - 1;
    // Each start succeeds 300 ms after it starts.
    for (let i = 0; i < 200 && ps.some((p) => last(p) !== 'loaded'); i++) {
      vi.advanceTimersByTime(300);
      for (const p of ps) if (last(p) === 'loading' && Date.now() - p.starts.at(-1)! >= 300) finish(p, true);
    }
    expect(ps.every((p) => last(p) === 'loaded')).toBe(true);
    const after = gaps(from);
    expect(after.length).toBeGreaterThan(20);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(1100);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it('paced: the pace goes 1100, 2200, 4400, 8000 and stays there; a success sets it back to 1100', () => {
    const qs = Array.from({ length: 14 }, (_, i) => photo(`q${i}`));
    qs.forEach((p) => request(p.key));
    finish(qs[0]!, false); // a burst photo: paced at 1100, not doubled (M1)
    expect(photoQueueInternalsForTests().pace).toBe(1100);
    const burst = new Set(qs.slice(0, 6));
    const seen = new Set<Photo>();
    const paces: number[] = [];
    for (let t = 0; t < 40_000; t += 50) {
      vi.advanceTimersByTime(50);
      for (const p of qs) {
        if (!burst.has(p) && last(p) === 'loading' && !seen.has(p)) {
          seen.add(p);
          finish(p, false);
          paces.push(photoQueueInternalsForTests().pace);
        }
      }
      if (seen.size === 6) break;
    }
    expect(paces).toEqual([2200, 4400, 8000, 8000, 8000, 8000]);
    const g = gaps(5); // from the last burst start
    expect(g.slice(0, 6)).toEqual([1100, 2200, 4400, 8000, 8000, 8000]);
    // A success resets the pace to 1100.
    const running = qs.find((p) => burst.has(p) && last(p) === 'loading')!;
    finish(running, true);
    expect(photoQueueInternalsForTests().pace).toBe(1100);
  });

  it('M1: six burst photos that all fail leave the pace at 1100', () => {
    const ps = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    for (const p of ps.slice(0, 6)) finish(p, false);
    const q = photoQueueInternalsForTests();
    expect(q.paced).toBe(true);
    expect(q.pace).toBe(1100);
    expect(q.consecutive).toBe(6);
    // They still count toward MAX_FAILURES: one more try each is 2 of 4.
    expect(ps.slice(0, 6).every((p) => last(p) === 'waiting')).toBe(true);
  });

  it('a failed photo goes to the back of the waiting list', () => {
    const ps = Array.from({ length: 8 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    finish(ps[0]!, false);
    expect(photoQueueInternalsForTests().waiting).toEqual([ps[6]!.key, ps[7]!.key, ps[0]!.key]);
  });

  it('a photo that fails 4 times is failed', () => {
    const p = photo('p');
    request(p.key);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(PACE_MAX_MS);
      expect(last(p)).toBe('loading');
      finish(p, false);
    }
    expect(last(p)).toBe('failed');
    expect(p.starts).toHaveLength(4);
    vi.advanceTimersByTime(60_000);
    expect(p.starts).toHaveLength(4);
    expect(getSnapshot()).toMatchObject({ total: 1, failed: 1, pending: 0, loaded: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('12 failures in a row make every waiting photo failed', () => {
    const ps = Array.from({ length: 30 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    let fails = 0;
    for (let t = 0; t < 200_000 && fails < 12; t += 50) {
      vi.advanceTimersByTime(50);
      const running = ps.filter((p) => last(p) === 'loading');
      for (const p of running) {
        if (fails >= 12) break;
        finish(p, false);
        fails++;
      }
    }
    expect(photoQueueInternalsForTests().consecutive).toBe(12);
    expect(photoQueueInternalsForTests().waiting).toEqual([]);
    expect(ps.filter((p) => last(p) === 'waiting')).toHaveLength(0);
    const failed = ps.filter((p) => last(p) === 'failed').length;
    expect(failed).toBe(30 - ps.filter((p) => last(p) === 'loading').length);
    expect(failed).toBeGreaterThan(20);
    vi.advanceTimersByTime(60_000);
    expect(ps.filter((p) => last(p) === 'loading')).toHaveLength(0);
  });

  it('40 first-load failures (a drained allowance) do not trip the stop, and all 40 then start paced', () => {
    const ps = Array.from({ length: 40 }, (_, i) => photo(`d${i}`));
    for (const p of ps) reportFirstLoadFailure(p.key);
    expect(photoQueueInternalsForTests().consecutive).toBe(0);
    expect(ps.filter((p) => last(p) === 'failed')).toHaveLength(0);
    for (let t = 0; t < 120_000 && ps.some((p) => last(p) !== 'loaded'); t += 100) {
      vi.advanceTimersByTime(100);
      for (const p of ps) if (last(p) === 'loading') finish(p, true);
    }
    expect(ps.every((p) => last(p) === 'loaded')).toBe(true);
    expect(startLog).toHaveLength(40);
    expect(Math.min(...gaps())).toBeGreaterThanOrEqual(1100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retryFailed puts every failed photo back with its failures reset', () => {
    const a = photo('a');
    request(a.key);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(PACE_MAX_MS);
      finish(a, false);
    }
    expect(last(a)).toBe('failed');
    retryFailed();
    expect(['waiting', 'loading']).toContain(last(a));
    // Four more tries before it is failed again.
    let tries = 0;
    for (let t = 0; t < 100_000 && last(a) !== 'failed'; t += 100) {
      vi.advanceTimersByTime(100);
      if (last(a) === 'loading') {
        finish(a, false);
        tries++;
      }
    }
    expect(tries).toBe(4);
    retryFailed();
    vi.advanceTimersByTime(PACE_MAX_MS);
    finish(a, true);
    expect(last(a)).toBe('loaded');
  });

  it('unregister of a photo in flight frees its slot', () => {
    const ps = Array.from({ length: 7 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    expect(last(ps[6]!)).toBe('waiting');
    unregister(ps[0]!.key);
    expect(last(ps[6]!)).toBe('loading');
    expect(photoQueueInternalsForTests().inFlight).toBe(6);
    expect(getSnapshot().total).toBe(6);
  });

  it('a started photo with no load or error for 120 s frees its slot; a late answer still counts', () => {
    const ps = Array.from({ length: 7 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    vi.advanceTimersByTime(SLOT_RELEASE_MS - 1);
    expect(last(ps[6]!)).toBe('waiting');
    vi.advanceTimersByTime(1);
    expect(last(ps[6]!)).toBe('loading');
    expect(photoQueueInternalsForTests().inFlight).toBe(1);
    // The released photos are still loading; a late load is recorded.
    done(ps[0]!.key, true);
    expect(last(ps[0]!)).toBe('loaded');
    expect(photoQueueInternalsForTests().inFlight).toBe(1);
  });

  it('goes back to burst after 60 s with no start', () => {
    const a = photo('a');
    request(a.key);
    finish(a, false);
    expect(getSnapshot().paced).toBe(true);
    // a waits for its paced turn and then loads.
    vi.advanceTimersByTime(PACE_MS);
    finish(a, true);
    vi.advanceTimersByTime(BURST_AGAIN_AFTER_MS);
    startLog = [];
    const ps = Array.from({ length: 6 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    expect(startLog).toHaveLength(6);
    expect(new Set(startLog.map((s) => s.at)).size).toBe(1);
    expect(photoQueueInternalsForTests().paced).toBe(false);
  });

  it('paced ends once nothing waits or loads for 60 s: a later small page does not say "one by one"', () => {
    // One failed first load (a deleted photo, or one refusal) makes the tab paced.
    const a = photo('a');
    reportFirstLoadFailure(a.key);
    expect(getSnapshot().paced).toBe(true);
    finish(a, true);
    unregister(a.key);
    // Under 60 s since the last start: still paced.
    vi.advanceTimersByTime(BURST_AGAIN_AFTER_MS - 1000);
    const b = photo('b');
    expect(getSnapshot()).toMatchObject({ total: 1, pending: 1, paced: true });
    unregister(b.key);
    // An hour later the person opens a 3-photo page (direct mode: they register, idle).
    vi.advanceTimersByTime(60 * 60_000);
    const ps = Array.from({ length: 3 }, (_, i) => photo(`p${i}`));
    expect(getSnapshot()).toMatchObject({ total: 3, pending: 3, paced: false });
    expect(photoQueueInternalsForTests()).toMatchObject({ paced: false, pace: PACE_MS });
    ps.forEach((p) => done(p.key, true));
    expect(getSnapshot()).toMatchObject({ total: 3, loaded: 3, pending: 0, paced: false });
  });

  it('paced stays while a photo still loads, even after 60 s', () => {
    const a = photo('a');
    request(a.key);
    finish(a, false); // paced
    vi.advanceTimersByTime(PACE_MS); // a starts again, paced
    expect(last(a)).toBe('loading');
    vi.advanceTimersByTime(BURST_AGAIN_AFTER_MS + 1000); // a still loads (no answer yet)
    const b = photo('b');
    expect(getSnapshot()).toMatchObject({ total: 2, paced: true });
    unregister(b.key);
  });

  it('starts nothing while the tab is hidden, and pumps again when it is visible', () => {
    visibility = 'hidden';
    const ps = Array.from({ length: 3 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    vi.advanceTimersByTime(10_000);
    expect(startLog).toHaveLength(0);
    expect(getSnapshot()).toMatchObject({ total: 3, pending: 3 });
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(startLog).toHaveLength(3);
  });

  it('the snapshot counts are right, and listeners hear each change', () => {
    const heard = vi.fn();
    const off = subscribe(heard);
    const ps = Array.from({ length: 5 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    expect(getSnapshot()).toEqual({ total: 5, loaded: 0, pending: 5, failed: 0, paced: false });
    finish(ps[0]!, true);
    finish(ps[1]!, true);
    for (let i = 0; i < 4; i++) {
      if (last(ps[2]!) !== 'loading') vi.advanceTimersByTime(PACE_MAX_MS);
      finish(ps[2]!, false);
    }
    expect(getSnapshot()).toEqual({ total: 5, loaded: 2, pending: 2, failed: 1, paced: true });
    const before = getSnapshot();
    expect(getSnapshot()).toBe(before); // stable between changes (useSyncExternalStore)
    expect(heard).toHaveBeenCalled();
    // Nothing changed: nobody is told (useSyncExternalStore would re-render for nothing).
    heard.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    request(ps[3]!.key);
    expect(heard).not.toHaveBeenCalled();
    expect(getSnapshot()).toBe(before);
    off();
    unregister(ps[3]!.key);
    expect(getSnapshot().total).toBe(4);
  });

  it('once everything has settled, no timer is left', () => {
    const ps = Array.from({ length: 20 }, (_, i) => photo(`p${i}`));
    ps.forEach((p) => request(p.key));
    finish(ps[0]!, false);
    for (let t = 0; t < 200_000 && ps.some((p) => last(p) !== 'loaded' && last(p) !== 'failed'); t += 100) {
      vi.advanceTimersByTime(100);
      for (const p of ps) if (last(p) === 'loading') finish(p, true);
    }
    expect(ps.every((p) => last(p) === 'loaded')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    ps.forEach((p) => unregister(p.key));
    expect(vi.getTimerCount()).toBe(0);
    expect(getSnapshot().total).toBe(0);
  });
});
