/**
 * GPS capture that listens for a while and keeps the best reading
 * (code review 2026-11-10, finding 19).
 *
 * WHY. The capture asked the phone once (getCurrentPosition) and took whatever
 * came back. Indoors, or in the first seconds after the GPS wakes, that first
 * answer is often a rough network fix of a few hundred metres, while the
 * satellites would have given ±10 m a few seconds later. So the button now
 * watches the position for up to GPS_LISTEN_MS, keeps the most accurate reading
 * it has seen, and stops at once when one is GPS_STOP_EARLY_AT_M or better.
 *
 * What this does NOT change: the accuracy standard itself (lib/gps-accuracy.ts,
 * an owner decision) — which readings the submit gates accept, and when a typed
 * point is accepted. It only decides which reading the button offers.
 *
 * No React here, so the launch e2e can import the constants (it waits for the
 * listening window) without loading a client component.
 */
import { GPS_TARGET_ACCURACY_M } from './gps-accuracy';

/**
 * How long one tap listens for a better reading, at most. The review asked for
 * 20 to 30 seconds; 25 s is long enough for a phone's GPS to lock on from cold
 * outdoors, and short enough to stand at a shop door. Open question for the
 * owner after the pilot-phone test: lengthen or shorten.
 */
export const GPS_LISTEN_MS = 25_000;

/**
 * A reading this accurate (in whole metres, as every screen shows it) ends the
 * listening at once: it is the owner's ±30 m target (lib/gps-accuracy.ts), so
 * waiting longer cannot change the chip's colour.
 */
export const GPS_STOP_EARLY_AT_M = GPS_TARGET_ACCURACY_M;

export type GpsReading = { lat: number; lng: number; accuracy: number };

export type ListenOutcome =
  /** The best reading heard. `early`: it met GPS_STOP_EARLY_AT_M before the window ended. */
  | { kind: 'fix'; reading: GpsReading; early: boolean }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  /** The window ended without a single reading. */
  | { kind: 'timeout' };

/** Whole metres, as the chip shows them; an unknown accuracy ranks last. */
export function rankedAccuracy(accuracy: number | null | undefined): number {
  return typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0
    ? Math.round(accuracy)
    : Number.POSITIVE_INFINITY;
}

/**
 * Watches the position until a reading at GPS_STOP_EARLY_AT_M or better, an
 * error with nothing heard, or the end of the window — then calls `done` once
 * with the outcome. `onBest` is told each time the best reading improves, so the
 * button can say how good it is so far. Returns a cancel function: after it,
 * nothing is called back and the watch is cleared.
 *
 * An error after a reading has been heard ends the listening with that reading:
 * a phone that loses the sky half-way has still given a usable fix.
 */
export function listenForBestFix(
  geolocation: Pick<Geolocation, 'watchPosition' | 'clearWatch'>,
  done: (outcome: ListenOutcome) => void,
  onBest?: (best: GpsReading) => void,
  opts: { listenMs?: number; stopEarlyAtM?: number } = {}
): () => void {
  const listenMs = opts.listenMs ?? GPS_LISTEN_MS;
  const stopEarlyAtM = opts.stopEarlyAtM ?? GPS_STOP_EARLY_AT_M;
  let best: GpsReading | null = null;
  let finished = false;
  let watchId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    finished = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (watchId !== null) geolocation.clearWatch(watchId);
    watchId = null;
  };
  const finish = (outcome: ListenOutcome) => {
    if (finished) return;
    stop();
    done(outcome);
  };

  timer = setTimeout(() => finish(best ? { kind: 'fix', reading: best, early: false } : { kind: 'timeout' }), listenMs);

  const id = geolocation.watchPosition(
    (pos) => {
      if (finished) return;
      const reading: GpsReading = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      if (!Number.isFinite(reading.lat) || !Number.isFinite(reading.lng)) return;
      if (!best || rankedAccuracy(reading.accuracy) < rankedAccuracy(best.accuracy)) {
        best = reading;
        onBest?.(best);
      }
      if (rankedAccuracy(best.accuracy) <= stopEarlyAtM) finish({ kind: 'fix', reading: best, early: true });
    },
    (err) => {
      if (finished) return;
      if (best) return finish({ kind: 'fix', reading: best, early: false });
      // The spec's codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
      if (err.code === 1) return finish({ kind: 'denied' });
      if (err.code === 3) return finish({ kind: 'timeout' });
      finish({ kind: 'unavailable' });
    },
    // The browser's own timeout matches the window, so a phone that never
    // answers is told so by the browser too; maximumAge 0: no cached point.
    { enableHighAccuracy: true, timeout: listenMs, maximumAge: 0 }
  );
  // A watch that answered (and finished) inside watchPosition itself has no id
  // to clear until now.
  if (finished) geolocation.clearWatch(id);
  else watchId = id;

  return () => {
    if (!finished) stop();
  };
}
