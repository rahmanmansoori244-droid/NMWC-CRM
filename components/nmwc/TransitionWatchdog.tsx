'use client';

import { useEffect, useReducer } from 'react';

/**
 * Launch fix (2026-10-08): a client navigation that React has finished
 * preparing, but never shows.
 *
 * WHAT HAPPENED. A tap that changes only the query string — Today's
 * "Branches with no visit day" / "Today's visits", Filter, Clear and a saved
 * view on /customers — and router.refresh() all re-render the page inside the
 * Suspense boundaries already on screen, so React keeps the old screen up until
 * every piece of the new one has arrived. Next 15.5 runs on its own copy of
 * React (19.2.0-canary-0bdb9206-20250818, unchanged in 15.5.27). In that copy,
 * when a piece of the RSC answer arrives while React has paused its render, the
 * "data is here" signal (a ping) can fire synchronously inside the render, and
 * React drops it (pingSuspendedRoot does nothing in the render phase while the
 * render is "suspended with delay"). The transition is then parked for good:
 * every lane suspended, none pinged, nothing scheduled — the URL never changes
 * and Filter reads "Filtering…" until a reload. React 19.3 records that ping
 * (`workInProgressRootPingedLanes |= pingedLanes`); Next 16.4's copy has it.
 *
 * THE FIX. React looks again at every parked transition on ANY new update
 * (markRootUpdated clears the suspended lanes). So this component, mounted once
 * in the root layout, checks React's root twice a second and, when a transition
 * has stayed parked across two checks with nothing left for React to do, makes
 * one tiny state update of its own. React then retries the transition; the
 * data it waits for is already there, so it commits. A transition that is
 * merely still waiting for the server is retried for nothing and parks again;
 * that costs one render of the waiting tree per second.
 *
 * It reads React's own root fields, which are not public: if they are not found
 * or not numbers, it does nothing. Remove it once the app runs on React >= 19.3
 * (Next 16) — tests/unit/transition-watchdog.test.tsx says when.
 */

/** React 19's transition lanes (TransitionLane1–14; react-dom's `4194048 & lanes` "only transitions" test). */
export const TRANSITION_LANES = 0x3fff00;

/** The fields of React's FiberRoot this reads. */
export type RootLanes = {
  pendingLanes: number;
  suspendedLanes: number;
  pingedLanes: number;
  callbackNode: unknown;
  cancelPendingCommit?: unknown;
  timeoutHandle?: unknown;
};

/**
 * True when React has a transition parked that only a ping can wake: a pending
 * transition lane is suspended, nothing pending is runnable, nothing is pinged,
 * no render task is scheduled and no commit is waiting (on a stylesheet, or on
 * the fallback throttle).
 */
export function transitionParked(root: RootLanes | null | undefined): boolean {
  if (!root || typeof root.pendingLanes !== 'number' || typeof root.suspendedLanes !== 'number' || typeof root.pingedLanes !== 'number') {
    return false;
  }
  const pending = root.pendingLanes;
  return (
    (pending & TRANSITION_LANES & root.suspendedLanes) !== 0 &&
    (pending & ~root.suspendedLanes) === 0 &&
    (pending & root.pingedLanes) === 0 &&
    root.callbackNode == null &&
    root.cancelPendingCommit == null &&
    (root.timeoutHandle == null || root.timeoutHandle === -1)
  );
}

const CONTAINER_KEY_PREFIX = '__reactContainer$';

/** React's root for a container hydrated or created by react-dom (the App Router hydrates `document`). */
export function findReactRoot(container: object = document): RootLanes | null {
  for (const key of Object.keys(container)) {
    if (!key.startsWith(CONTAINER_KEY_PREFIX)) continue;
    const hostRoot = (container as Record<string, { stateNode?: unknown } | null | undefined>)[key];
    const root = hostRoot?.stateNode as RootLanes | undefined;
    return root && typeof root.pendingLanes === 'number' ? root : null;
  }
  return null;
}

export const CHECK_EVERY_MS = 500;

export function TransitionWatchdog({
  getRoot = findReactRoot,
  checkEveryMs = CHECK_EVERY_MS,
}: {
  /** Tests pass a stand-in root; the app uses React's own. */
  getRoot?: () => RootLanes | null;
  checkEveryMs?: number;
}): null {
  const [, nudge] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let parkedChecks = 0;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || !transitionParked(getRoot())) {
        parkedChecks = 0;
        return;
      }
      parkedChecks += 1;
      // Two checks in a row (500–1000 ms parked), so a transition React is about
      // to wake by itself is left alone; then at most one update per second.
      if (parkedChecks >= 2) {
        parkedChecks = 0;
        nudge();
      }
    }, checkEveryMs);
    return () => window.clearInterval(id);
  }, [getRoot, checkEveryMs]);
  return null;
}
