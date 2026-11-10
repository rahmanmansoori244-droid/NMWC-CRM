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

/**
 * The longest a tap waits for the listening window to START — for the phone to
 * say location may be used, or to send a first reading — before it gives up
 * (code review 2026-11-10, finding 19, second round). Not one of the owner's
 * numbers: only a safety limit so the button can never hang on a permission
 * question left open or a browser that never answers. Two minutes is ample to
 * read a first-ever "Allow location?" question.
 */
export const GPS_START_WAIT_MS = 120_000;

export type GpsReading = { lat: number; lng: number; accuracy: number };

export type ListenOutcome =
  /** The best reading heard. `early`: it met GPS_STOP_EARLY_AT_M before the window ended. */
  | { kind: 'fix'; reading: GpsReading; early: boolean }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  /** The window ended without a single reading. */
  | { kind: 'timeout' }
  /**
   * The window never started: no "allowed" from the phone and no reading within
   * GPS_START_WAIT_MS — most likely the "Allow location?" question is still
   * open. Not a sign that the sky is the problem.
   */
  | { kind: 'no-start' };

/** The part of navigator.permissions this uses. */
export type PermissionsLike = { query: (d: { name: 'geolocation' }) => Promise<PermissionStatusLike> };
export type PermissionStatusLike = {
  state: string;
  addEventListener?: (type: 'change', fn: () => void) => void;
  removeEventListener?: (type: 'change', fn: () => void) => void;
};

/**
 * Great-circle distance in metres between two points (haversine, mean Earth
 * radius). Second round of finding 19: the "rougher reading" question says how
 * far the new reading is from the point already there, so a shop that moved
 * (far apart) can be told from a weak signal (close together). Over the few
 * kilometres that matter here the error is well under a metre.
 */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "about 40 m", "about 2,140 m (2.1 km)": whole metres, with kilometres added from 1 km. */
export function distanceWords(metres: number): string {
  const m = Math.round(metres);
  const shown = `about ${m.toLocaleString('en-GB')} m`;
  return m >= 1000 ? `${shown} (${(m / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} km)` : shown;
}

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
 * WHEN THE WINDOW STARTS (code review 2026-11-10, finding 19, second round).
 * The window used to start at the tap, so the first-ever "Allow location?"
 * question ate into it: a salesman who took a while to tap Allow was told "No
 * GPS fix" and the watch was already gone. Now the `listenMs` window starts only
 * when readings can arrive — when the phone says location is allowed
 * (`permissions`, the browser's Permissions API: "granted" at once, or later) or
 * at the first reading, whichever comes first. Before that:
 *   - nothing heard while location is allowed is told by the browser's own
 *     TIMEOUT error, whose timer (`timeout` below) the standard starts only once
 *     permission is given — so a browser without the Permissions API still ends
 *     a silent listen after `listenMs`;
 *   - that TIMEOUT is believed even while the Permissions API still says
 *     'prompt' (third round). Its timer runs only after permission is given,
 *     so the TIMEOUT itself proves he answered "Allow". Some phones keep
 *     saying 'prompt' after a one-time "Allow" and send no change event
 *     (iPhone Safari on "Ask", Firefox "allow this time"); ignoring the
 *     TIMEOUT there made a silent tap indoors wait GPS_START_WAIT_MS and end
 *     as 'no-start', so "Try again outside" and the typed-coordinates panel
 *     never came. It now ends as an ordinary 'timeout', `listenMs` after
 *     "Allow", like on any other phone;
 *   - GPS_START_WAIT_MS from the tap is the safety limit: the listen then ends
 *     with 'no-start', so the button can never hang.
 *
 * An error after a reading has been heard ends the listening with that reading:
 * a phone that loses the sky half-way has still given a usable fix.
 */
export function listenForBestFix(
  geolocation: Pick<Geolocation, 'watchPosition' | 'clearWatch'>,
  done: (outcome: ListenOutcome) => void,
  onBest?: (best: GpsReading) => void,
  opts: { listenMs?: number; stopEarlyAtM?: number; startWaitMs?: number; permissions?: PermissionsLike | null } = {}
): () => void {
  const listenMs = opts.listenMs ?? GPS_LISTEN_MS;
  const stopEarlyAtM = opts.stopEarlyAtM ?? GPS_STOP_EARLY_AT_M;
  const startWaitMs = opts.startWaitMs ?? GPS_START_WAIT_MS;
  let best: GpsReading | null = null;
  let finished = false;
  let watchId: number | null = null;
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  // What the Permissions API last said ('granted', 'prompt', 'denied'); null: not known.
  let permission: string | null = null;
  let status: PermissionStatusLike | null = null;

  const stop = () => {
    finished = true;
    if (windowTimer !== null) clearTimeout(windowTimer);
    if (startTimer !== null) clearTimeout(startTimer);
    windowTimer = null;
    startTimer = null;
    if (watchId !== null) geolocation.clearWatch(watchId);
    watchId = null;
    status?.removeEventListener?.('change', onPermission);
    status = null;
  };
  const finish = (outcome: ListenOutcome) => {
    if (finished) return;
    stop();
    done(outcome);
  };
  const startWindow = () => {
    if (finished || windowTimer !== null) return;
    if (startTimer !== null) clearTimeout(startTimer);
    startTimer = null;
    windowTimer = setTimeout(
      () => finish(best ? { kind: 'fix', reading: best, early: false } : { kind: 'timeout' }),
      listenMs
    );
  };
  function onPermission() {
    if (finished || !status) return;
    permission = status.state;
    if (permission === 'granted') startWindow();
  }

  // The safety limit, until the window starts.
  startTimer = setTimeout(
    () => finish(best ? { kind: 'fix', reading: best, early: false } : { kind: 'no-start' }),
    startWaitMs
  );

  if (opts.permissions) {
    try {
      opts.permissions.query({ name: 'geolocation' }).then(
        (s) => {
          if (finished) return;
          status = s;
          s.addEventListener?.('change', onPermission);
          onPermission();
        },
        () => undefined // No answer: the first reading starts the window.
      );
    } catch {
      // An older browser that throws for 'geolocation': the same.
    }
  }

  const id = geolocation.watchPosition(
    (pos) => {
      if (finished) return;
      const reading: GpsReading = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      if (!Number.isFinite(reading.lat) || !Number.isFinite(reading.lng)) return;
      startWindow();
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
      // A TIMEOUT is believed whatever the Permissions API says: by the
      // standard its timer starts only once location is allowed (third round).
      if (err.code === 3) return finish({ kind: 'timeout' });
      finish({ kind: 'unavailable' });
    },
    // The browser's own timeout matches the window and, by the standard, runs
    // only once location is allowed; maximumAge 0: no cached point.
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
