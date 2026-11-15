/**
 * Large-customer photos, part B: one small photo queue per tab.
 *
 * /api/photos/<id> allows one person 60 photos at once, then 1 a second
 * (lib/rate-limit.ts), and an <img> cannot tell a refusal (429) from any other
 * failure. So the queue treats every failure alike: it starts photos in a
 * burst of at most MAX_IN_FLIGHT, and after the first failure it starts one at
 * a time, PACE_MS apart, doubling the pace up to PACE_MAX_MS while photos it
 * started paced keep failing. A photo is retried at the same address, as a new
 * <img>, up to MAX_FAILURES times; STOP_AFTER_CONSECUTIVE failures in a row
 * stop everything that waits ('Try again' puts it back).
 *
 * A module singleton: it lives as long as the tab, so client-side route
 * changes share it (they share the person's allowance too). No timer runs
 * once everything has settled. Nothing starts while the tab is hidden.
 *
 * components/nmwc/RoutePhoto.tsx drives it; PhotoQueueStatus.tsx reads it.
 */

export const MAX_IN_FLIGHT = 6;
export const PACE_MS = 1100;
export const PACE_MAX_MS = 8000;
export const BURST_AGAIN_AFTER_MS = 60_000;
/** Per photo, counting its first load. */
export const MAX_FAILURES = 4;
export const STOP_AFTER_CONSECUTIVE = 12;
export const SLOT_RELEASE_MS = 120_000;

export type PhotoQueueState = 'idle' | 'waiting' | 'loading' | 'loaded' | 'failed';

export type PhotoQueueSnapshot = {
  readonly total: number;
  readonly loaded: number;
  readonly pending: number;
  readonly failed: number;
  readonly paced: boolean;
};

type Entry = {
  key: number;
  onStart: (attempt: number) => void;
  onState: (state: PhotoQueueState) => void;
  state: PhotoQueueState;
  failures: number;
  attempt: number;
  /** Started while the queue was paced (M1: only such a failure doubles the pace). */
  startedPaced: boolean;
  /** Counts toward inFlight. False once loaded, failed, released after SLOT_RELEASE_MS. */
  holdsSlot: boolean;
  slotTimer: ReturnType<typeof setTimeout> | null;
};

const EMPTY: PhotoQueueSnapshot = Object.freeze({ total: 0, loaded: 0, pending: 0, failed: 0, paced: false });

let nextKey = 1;
const entries = new Map<number, Entry>();
let waiting: number[] = [];
let inFlight = 0;
let paced = false;
let pace = PACE_MS;
let consecutive = 0;
let lastStartAt: number | null = null;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: PhotoQueueSnapshot = EMPTY;
const listeners = new Set<() => void>();
let visibilityHooked = false;

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function hookVisibility() {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => pump());
}

function recompute() {
  // Back to burst when nothing waits or loads and nothing has started for
  // BURST_AGAIN_AFTER_MS: a later page in this tab must not be told its photos
  // load "one by one" because of a failure long ago.
  if (
    paced &&
    waiting.length === 0 &&
    inFlight === 0 &&
    lastStartAt !== null &&
    Date.now() - lastStartAt >= BURST_AGAIN_AFTER_MS
  ) {
    paced = false;
    pace = PACE_MS;
  }
  let loaded = 0;
  let failed = 0;
  for (const e of entries.values()) {
    if (e.state === 'loaded') loaded++;
    else if (e.state === 'failed') failed++;
  }
  const total = entries.size;
  const next = { total, loaded, failed, pending: total - loaded - failed, paced };
  if (
    next.total !== snapshot.total ||
    next.loaded !== snapshot.loaded ||
    next.failed !== snapshot.failed ||
    next.pending !== snapshot.pending ||
    next.paced !== snapshot.paced
  ) {
    snapshot = next.total === 0 && !next.paced ? EMPTY : Object.freeze(next);
    for (const l of [...listeners]) l();
  }
}

function setState(e: Entry, state: PhotoQueueState) {
  if (e.state === state) return;
  e.state = state;
  e.onState(state);
}

function freeSlot(e: Entry) {
  if (e.slotTimer) {
    clearTimeout(e.slotTimer);
    e.slotTimer = null;
  }
  if (e.holdsSlot) {
    e.holdsSlot = false;
    inFlight--;
  }
}

function enqueue(e: Entry) {
  waiting = waiting.filter((k) => k !== e.key);
  waiting.push(e.key);
  setState(e, 'waiting');
}

function failAllWaiting() {
  const keys = waiting;
  waiting = [];
  for (const k of keys) {
    const e = entries.get(k);
    if (e) setState(e, 'failed');
  }
}

function clearPumpTimer() {
  if (pumpTimer) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
}

function start(e: Entry, now: number) {
  waiting = waiting.filter((k) => k !== e.key);
  e.attempt++;
  e.startedPaced = paced;
  e.holdsSlot = true;
  inFlight++;
  lastStartAt = now;
  e.slotTimer = setTimeout(() => {
    // No load or error for SLOT_RELEASE_MS: the slot goes to the next photo.
    // The <img> and its src are left alone; a late load or error still counts.
    e.slotTimer = null;
    if (e.holdsSlot) {
      e.holdsSlot = false;
      inFlight--;
      pump();
    }
  }, SLOT_RELEASE_MS);
  setState(e, 'loading');
  e.onStart(e.attempt);
}

function pump() {
  clearPumpTimer();
  if (hidden()) {
    recompute();
    return;
  }
  while (inFlight < MAX_IN_FLIGHT && waiting.length > 0) {
    const now = Date.now();
    if (paced && lastStartAt !== null && now - lastStartAt >= BURST_AGAIN_AFTER_MS) {
      paced = false;
      pace = PACE_MS;
    }
    if (paced && lastStartAt !== null) {
      const due = lastStartAt + pace - now;
      if (due > 0) {
        pumpTimer = setTimeout(() => {
          pumpTimer = null;
          pump();
        }, due);
        break;
      }
    }
    const e = entries.get(waiting[0]!);
    if (!e) {
      waiting.shift();
      continue;
    }
    start(e, now);
    if (paced) continue; // the loop's next turn waits for the pace
  }
  recompute();
}

function goPaced() {
  if (!paced) {
    paced = true;
    pace = PACE_MS;
  }
}

/** A photo on the page. onStart: mount a new <img> (attempt 1, 2, …). onState: the photo's state changed. */
export function register(onStart: (attempt: number) => void, onState: (state: PhotoQueueState) => void): number {
  hookVisibility();
  const key = nextKey++;
  entries.set(key, {
    key,
    onStart,
    onState,
    state: 'idle',
    failures: 0,
    attempt: 0,
    startedPaced: false,
    holdsSlot: false,
    slotTimer: null,
  });
  recompute();
  return key;
}

/** A queued photo asks for its turn. */
export function request(key: number): void {
  const e = entries.get(key);
  if (!e || e.state !== 'idle') return;
  enqueue(e);
  pump();
}

/**
 * A direct photo's first load (the server-rendered <img>) failed. It counts
 * toward the photo's MAX_FAILURES and makes the queue paced, but not toward
 * STOP_AFTER_CONSECUTIVE: 40 photos refused at once by a drained allowance
 * must not stop the page.
 */
export function reportFirstLoadFailure(key: number): void {
  const e = entries.get(key);
  if (!e || e.state !== 'idle') return;
  e.failures++;
  goPaced();
  enqueue(e);
  pump();
}

/** The photo's <img> loaded (ok) or failed. */
export function done(key: number, ok: boolean): void {
  const e = entries.get(key);
  if (!e) return;
  if (e.state === 'idle') {
    // A direct photo's first load: nothing was started, so the pace is untouched.
    if (ok) {
      setState(e, 'loaded');
      recompute();
    }
    return;
  }
  if (e.state !== 'loading') return;
  freeSlot(e);
  if (ok) {
    consecutive = 0;
    pace = PACE_MS;
    setState(e, 'loaded');
  } else {
    e.failures++;
    consecutive++;
    // M1: a photo started in the burst switches the queue to paced at PACE_MS;
    // only one started while already paced doubles the pace.
    if (paced && e.startedPaced) pace = Math.min(pace * 2, PACE_MAX_MS);
    goPaced();
    if (e.failures >= MAX_FAILURES) setState(e, 'failed');
    else enqueue(e);
    if (consecutive >= STOP_AFTER_CONSECUTIVE) failAllWaiting();
  }
  pump();
}

/** The photo left the page. */
export function unregister(key: number): void {
  const e = entries.get(key);
  if (!e) return;
  freeSlot(e);
  entries.delete(key);
  waiting = waiting.filter((k) => k !== key);
  pump();
}

/** 'Try again': every failed photo waits again, its failures reset. */
export function retryFailed(): void {
  let any = false;
  for (const e of entries.values()) {
    if (e.state !== 'failed') continue;
    e.failures = 0;
    enqueue(e);
    any = true;
  }
  if (!any) return;
  consecutive = 0;
  pace = PACE_MS;
  pump();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): PhotoQueueSnapshot {
  return snapshot;
}

/** The server render (and hydration) knows of no photo. */
export function getServerSnapshot(): PhotoQueueSnapshot {
  return EMPTY;
}

/** Tests only: forget every photo and timer. */
export function resetPhotoQueueForTests(): void {
  for (const e of entries.values()) if (e.slotTimer) clearTimeout(e.slotTimer);
  clearPumpTimer();
  entries.clear();
  waiting = [];
  inFlight = 0;
  paced = false;
  pace = PACE_MS;
  consecutive = 0;
  lastStartAt = null;
  snapshot = EMPTY;
  listeners.clear();
}

/** Tests only: the numbers behind the rules. */
export function photoQueueInternalsForTests() {
  return { inFlight, paced, pace, consecutive, waiting: [...waiting] };
}
