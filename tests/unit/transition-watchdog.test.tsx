/**
 * Launch fix (2026-10-08): components/nmwc/TransitionWatchdog.tsx.
 *
 * A tap that changes only the query string of /today or /customers (and
 * router.refresh()) could leave the page on the old screen for good: Next
 * 15.5's own copy of React (19.2 canary) drops a ping that fires during its
 * render, and the transition stays parked with nothing scheduled. The watchdog
 * spots that state on React's root and makes one state update, which makes
 * React retry every parked transition.
 *
 * Here: the parked-state test against stand-in roots (the exact state the
 * browser showed: pending = suspended = three transition lanes, pinged 0, no
 * callback), the root lookup against a real react-dom root, the nudge cadence
 * and its back-off with fake timers, and when the workaround can go.
 *
 * Which React each part runs on: the root-lookup test (findReactRoot) renders
 * with @testing-library/react, so it runs on node_modules' react-dom (19.3, which
 * has the fix), NOT on the copy Next serves the browser (its vendored 19.2
 * canary, next/dist/compiled/react-dom). That the watchdog finds that copy's
 * root and wakes a parked tap is covered by the e2e probe: the query-string taps
 * on /today and /customers in the launch browser suite
 * (tests/e2e/launch/salesman-phone.spec.ts), run against a production build.
 * The removal tripwire at the bottom reads the vendored copy itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import { Profiler, createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHECK_EVERY_MS,
  MAX_NUDGES,
  TRANSITION_LANES,
  TransitionWatchdog,
  findReactRoot,
  transitionParked,
  type RootLanes,
} from '@/components/nmwc/TransitionWatchdog';

/** The root of the hung Today tap (browser, 8 Oct): TransitionLane4–6 all suspended. */
const PARKED: RootLanes = {
  pendingLanes: 14336,
  suspendedLanes: 14336,
  pingedLanes: 0,
  callbackNode: null,
  cancelPendingCommit: null,
  timeoutHandle: -1,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('transitionParked', () => {
  it('is the hung state: a suspended transition, nothing runnable, nothing pinged, nothing scheduled', () => {
    expect(14336 & TRANSITION_LANES).toBe(14336);
    expect(transitionParked(PARKED)).toBe(true);
  });

  it('is not a transition React is working on, has been pinged for, or will commit', () => {
    expect(transitionParked({ ...PARKED, callbackNode: {} }), 'a render task is scheduled').toBe(false);
    expect(transitionParked({ ...PARKED, pingedLanes: 2048 }), 'its data arrived and React was told').toBe(false);
    expect(transitionParked({ ...PARKED, suspendedLanes: 2048 }), 'other lanes are still runnable').toBe(false);
    expect(transitionParked({ ...PARKED, pendingLanes: 14336 | 32, suspendedLanes: 14336 }), 'a default-lane update is runnable').toBe(false);
    expect(transitionParked({ ...PARKED, cancelPendingCommit: () => undefined }), 'a commit waits for a stylesheet').toBe(false);
    expect(transitionParked({ ...PARKED, timeoutHandle: 7 }), 'a throttled commit is due').toBe(false);
  });

  it('is not a suspended non-transition lane (a Suspense fallback waiting for its content)', () => {
    const retry = 0x400000; // RetryLane1
    expect(transitionParked({ ...PARKED, pendingLanes: retry, suspendedLanes: retry })).toBe(false);
  });

  it('is false for anything that is not a root', () => {
    expect(transitionParked(null)).toBe(false);
    expect(transitionParked(undefined)).toBe(false);
    expect(transitionParked({ pendingLanes: 'x' } as unknown as RootLanes)).toBe(false);
  });
});

describe('findReactRoot', () => {
  it("finds react-dom's root on the container it rendered into", () => {
    const { container } = render(createElement('p', null, 'hello'));
    const root = findReactRoot(container);
    expect(root).not.toBeNull();
    expect(typeof root!.pendingLanes).toBe('number');
    expect(typeof root!.suspendedLanes).toBe('number');
    expect(typeof root!.pingedLanes).toBe('number');
    expect('callbackNode' in root!).toBe(true);
  });

  it('its committed tree (current) changes on a commit: how the watchdog sees other work', () => {
    const { container, rerender } = render(createElement('p', null, 'hello'));
    const root = findReactRoot(container)!;
    const before = root.current;
    expect(before).toBeTruthy();
    rerender(createElement('p', null, 'again'));
    expect(root.current).not.toBe(before);
  });

  it('is null where React rendered nothing', () => {
    expect(findReactRoot(document.createElement('div'))).toBeNull();
  });
});

describe('TransitionWatchdog', () => {
  function mount(getRoot: () => RootLanes | null) {
    const commits = vi.fn();
    render(createElement(Profiler, { id: 'watchdog', onRender: commits }, createElement(TransitionWatchdog, { getRoot })));
    commits.mockClear();
    return commits;
  }

  /**
   * Runs `checks` checks, one per act() (act batches the updates it wraps into
   * one render), and returns the checks (1-based) after which the watchdog
   * updated. `before` runs ahead of each check, told whether the last one updated.
   */
  function run(
    commits: ReturnType<typeof vi.fn>,
    checks: number,
    before?: (nudgedLast: boolean) => void
  ) {
    const at: number[] = [];
    for (let i = 1; i <= checks; i++) {
      before?.(at.at(-1) === i - 1);
      const n = commits.mock.calls.length;
      act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
      if (commits.mock.calls.length > n) at.push(i);
    }
    return at;
  }
  /** The checks that fall at these seconds. */
  const checksAt = (seconds: number[]) => seconds.map((t) => (t * 1000) / CHECK_EVERY_MS);

  it('updates once a transition has stayed parked across two checks', () => {
    vi.useFakeTimers();
    const commits = mount(() => PARKED);
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits, 'one check is not enough').not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits).toHaveBeenCalledTimes(1);
  });

  // A transition that never ends must not be re-rendered forever: the same parked
  // lanes are nudged 1, 2, 4, 8 s apart, then every 10 s, MAX_NUDGES times in all.
  it('backs off for the same parked lanes, then leaves them alone', () => {
    vi.useFakeTimers();
    const commits = mount(() => PARKED);
    const expected = checksAt([1, 2, 4, 8, 16, 26, 36, 46, 56, 66, 76, 86, 96, 106, 116]);
    expect(expected).toHaveLength(MAX_NUDGES);
    expect(run(commits, checksAt([300])[0]!)).toEqual(expected);
  });

  it("keeps backing off when each nudge's render un-parks the same lanes for a moment", () => {
    vi.useFakeTimers();
    let rendering = false;
    const commits = mount(() => (rendering ? { ...PARKED, callbackNode: {} } : PARKED));
    // After each nudge one check sees React rendering, then the lanes park again.
    const at = run(commits, 19, (nudgedLast) => (rendering = nudgedLast));
    // 2 parked checks, then 2 (1 s), 4 (2 s), 8 (4 s): not every 2 again.
    expect(at).toEqual([2, 5, 10, 19]);
  });

  it('other lanes, or the same lanes after they cleared, start over at the first nudge', () => {
    vi.useFakeTimers();
    let root: RootLanes = PARKED;
    const commits = mount(() => root);
    run(commits, checksAt([300])[0]!);
    expect(commits).toHaveBeenCalledTimes(MAX_NUDGES);

    const lane7 = 0x4000; // TransitionLane7: a new tap, parked too
    root = { ...PARKED, pendingLanes: lane7, suspendedLanes: lane7 };
    expect(run(commits, 2)).toEqual([2]);

    root = { ...PARKED, pendingLanes: 0, suspendedLanes: 0 }; // it landed
    run(commits, 1);
    root = PARKED; // a later tap that happens to park on the same lanes
    expect(run(commits, 2)).toEqual([2]);
  });

  // Every transition started inside one async action shares the action's lane:
  // the promote loop (PromoteButton) keeps it parked for minutes while each slice
  // commits its progress, then calls router.refresh() on that same lane. A commit
  // the watchdog did not cause starts the back-off over; its own nudges' do not.
  const ACTION = 0x100; // TransitionLane1, as a probe of a long async action read it

  it('a commit it did not cause starts the same parked lanes over, even after the cap', () => {
    vi.useFakeTimers();
    let root: RootLanes = { ...PARKED, pendingLanes: ACTION, suspendedLanes: ACTION, current: {} };
    const commits = mount(() => root);
    const commit = () => (root = { ...root, current: {} });
    // Each nudge's own render commits before the next check: still the back-off.
    expect(run(commits, checksAt([300])[0]!, (nudgedLast) => nudgedLast && commit())).toEqual(
      checksAt([1, 2, 4, 8, 16, 26, 36, 46, 56, 66, 76, 86, 96, 106, 116])
    );
    // Other work commits; React retries the lane, which parks again: woken again.
    root = { ...root, callbackNode: {}, current: {} };
    run(commits, 1);
    root = { ...root, callbackNode: null };
    expect(run(commits, 2)).toEqual([2]);
  });

  it('a promote that commits a slice every 7 s is woken 1, 2 and 4 s after each, for as long as it runs', () => {
    vi.useFakeTimers();
    let root: RootLanes = { ...PARKED, pendingLanes: ACTION, suspendedLanes: ACTION, current: {} };
    const commits = mount(() => root);
    const commit = () => (root = { ...root, current: {} });
    // 40 slices: about five minutes, far past MAX_NUDGES. The last window is the
    // final router.refresh() parked after the last slice: still woken in a second.
    for (let slice = 0; slice < 40; slice++) {
      commit(); // the slice's setLive
      const at = run(commits, checksAt([7])[0]!, (nudgedLast) => nudgedLast && commit());
      expect(at, `slice ${slice + 1}`).toEqual(checksAt([1, 2, 4]));
    }
  });

  it('leaves React alone while nothing is parked, or the tab is hidden', () => {
    vi.useFakeTimers();
    let root: RootLanes = { ...PARKED, callbackNode: {} };
    const commits = mount(() => root);
    act(() => vi.advanceTimersByTime(10 * CHECK_EVERY_MS));
    expect(commits).not.toHaveBeenCalled();

    root = PARKED;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      act(() => vi.advanceTimersByTime(10 * CHECK_EVERY_MS));
      expect(commits).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    act(() => vi.advanceTimersByTime(2 * CHECK_EVERY_MS));
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('starts over when the transition un-parks between checks', () => {
    vi.useFakeTimers();
    let root: RootLanes = PARKED;
    const commits = mount(() => root);
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    root = { ...PARKED, pingedLanes: 2048 };
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    root = PARKED;
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('is mounted once, in the root layout', () => {
    const layout = fs.readFileSync(path.join(process.cwd(), 'app', 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/import \{ TransitionWatchdog \} from '@\/components\/nmwc\/TransitionWatchdog';/);
    expect(layout.match(/<TransitionWatchdog \/>/g)).toHaveLength(1);
  });
});

/**
 * Whether a react-dom build still needs the watchdog, from its pingSuspendedRoot
 * and its version. In the render-phase branch (a render "suspended with delay"
 * pinged from inside the render):
 *   - BUGGY (Next 15.5's 19.2 canary) does nothing there:
 *       `? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)`
 *   - FIXED (React 19.3) records the ping there:
 *       `? 0 === (executionContext & 2) ? prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes) : …`
 * Removable on the fixed form, or on a version >= 19.3.0 (semver: a 19.3 canary
 * is below it, so it is judged by its code). Neither form: unknown — the code
 * changed in a way this does not recognise, which proves no fix.
 */
type Verdict = { verdict: 'needed' | 'removable' | 'unknown'; why: string };
const BUGGY_PING =
  /\?\s*0 === \(executionContext & 2\) && prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;
const FIXED_PING =
  /0 === \(executionContext & 2\)\s*\?\s*prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;

function watchdogVerdict(src: string, version: string): Verdict {
  const v = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  const [major, minor] = v ? [Number(v[1]), Number(v[2])] : [0, 0];
  const atLeast193 = !!v && (major > 19 || (major === 19 && (minor > 3 || (minor === 3 && !v[4]))));
  if (atLeast193) return { verdict: 'removable', why: `is version ${version} (>= 19.3)` };
  const start = src.indexOf('function pingSuspendedRoot(');
  if (start < 0) return { verdict: 'unknown', why: 'has no pingSuspendedRoot' };
  const end = src.indexOf('\nfunction ', start + 1);
  const ping = src.slice(start, end < 0 ? undefined : end);
  if (FIXED_PING.test(ping)) {
    return {
      verdict: 'removable',
      why: 'records a render-phase ping (workInProgressRootPingedLanes |= pingedLanes)',
    };
  }
  if (BUGGY_PING.test(ping)) return { verdict: 'needed', why: 'drops a render-phase ping' };
  return {
    verdict: 'unknown',
    why: 'has a pingSuspendedRoot of neither the buggy nor the fixed form',
  };
}

/**
 * A react-dom package's client build and version. The version is the one the
 * build itself carries (`reconcilerVersion: "…"`): Next's vendored copy has a
 * package.json with no version field. package.json is the fallback.
 */
function reactDom(...dir: string[]) {
  const at = path.join(process.cwd(), 'node_modules', ...dir);
  const src = fs.readFileSync(path.join(at, 'cjs', 'react-dom-client.production.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(at, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return { src, version: /reconcilerVersion:\s*"([^"]+)"/.exec(src)?.[1] ?? pkg.version ?? '' };
}

describe('when the workaround can go', () => {
  it("is still needed: Next's vendored React drops a ping that fires during the render phase", () => {
    // When this fails saying it can be removed, Next ships the fix: delete
    // TransitionWatchdog (and this file) and take it out of app/layout.tsx.
    const { src, version } = reactDom('next', 'dist', 'compiled', 'react-dom');
    // Without a version the ">= 19.3" half of the verdict could never fire.
    expect(version, "Next's vendored react-dom: no version found").toMatch(/^\d+\.\d+\.\d+/);
    const { verdict, why } = watchdogVerdict(src, version);
    if (verdict === 'unknown') {
      throw new Error(
        `unknown shape - investigate before removing: Next's vendored react-dom ${version} ${why}`
      );
    }
    expect(
      verdict,
      `Next's vendored react-dom ${version} ${why}: TransitionWatchdog can be removed`
    ).toBe('needed');
  });

  describe('the verdict', () => {
    // node_modules' own react-dom is 19.3 (the jsdom tests above run on it).
    const fixed = reactDom('react-dom');
    const buggy = reactDom('next', 'dist', 'compiled', 'react-dom');
    const CANARY = '19.2.0-canary-0bdb9206-20250818';

    it("reads each build's own version: the vendored package.json has none", () => {
      expect(buggy.version).toBe(CANARY);
      expect(fixed.version).toBe('19.3.0');
    });

    it('a build that records the render-phase ping is removable, whatever its version says', () => {
      expect(fixed.version).toBe('19.3.0');
      expect(watchdogVerdict(fixed.src, fixed.version).verdict).toBe('removable');
      expect(watchdogVerdict(fixed.src, CANARY)).toEqual({
        verdict: 'removable',
        why: 'records a render-phase ping (workInProgressRootPingedLanes |= pingedLanes)',
      });
    });

    it('the buggy form below 19.3 is needed; from 19.3.0 it is removable; a 19.3 canary is judged by its code', () => {
      expect(watchdogVerdict(buggy.src, CANARY).verdict).toBe('needed');
      expect(watchdogVerdict(buggy.src, '19.3.0').verdict).toBe('removable');
      expect(watchdogVerdict(buggy.src, '20.0.0').verdict).toBe('removable');
      expect(watchdogVerdict(buggy.src, '19.3.0-canary-1234abcd-20260101').verdict).toBe('needed');
    });

    it('neither form, or no pingSuspendedRoot at all, is unknown: not removable', () => {
      const reshaped = buggy.src.replace(
        /prepareFreshStack\(root, 0\)/g,
        'prepareFreshStack(root, NoLanes)'
      );
      expect(watchdogVerdict(reshaped, CANARY).verdict).toBe('unknown');
      expect(watchdogVerdict('function somethingElse() {}', CANARY).verdict).toBe('unknown');
    });
  });
});
