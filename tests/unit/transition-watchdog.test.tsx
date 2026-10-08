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
 * with fake timers, and when the workaround can go.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import { Profiler, createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHECK_EVERY_MS,
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

  it('updates once a transition has stayed parked across two checks, then at most once a second', () => {
    vi.useFakeTimers();
    const commits = mount(() => PARKED);
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits, 'one check is not enough').not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits).toHaveBeenCalledTimes(1);
    // One check per act(): act batches the updates it wraps into one render.
    for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(CHECK_EVERY_MS));
    expect(commits).toHaveBeenCalledTimes(3);
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

describe('when the workaround can go', () => {
  it("is still needed: Next's vendored React drops a ping that fires during the render phase", () => {
    // React 19.3 (and Next 16's copy) records it: `: (workInProgressRootPingedLanes |= pingedLanes)`
    // in the render-phase branch. When this fails, Next ships the fix: delete TransitionWatchdog
    // (and this file) and take it out of app/layout.tsx.
    const file = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'react-dom', 'cjs', 'react-dom-client.production.js');
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/\?\s*0 === \(executionContext & 2\) && prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/);
  });
});
