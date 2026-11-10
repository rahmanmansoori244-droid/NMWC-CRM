/**
 * Code review 2026-11-10, finding 19: GPS capture took the first reading only.
 *
 * The button asked the phone once and took whatever came back — indoors, or
 * just after the GPS wakes, a rough fix of a few hundred metres — and put it
 * over the good point on file, with no way back and Submit held until a better
 * one or a typed point. Now (lib/gps-listen.ts, components/nmwc/GpsCaptureButton.tsx):
 *   - it listens for up to GPS_LISTEN_MS, keeps the best reading and stops at
 *     once at GPS_STOP_EARLY_AT_M or better;
 *   - a reading rougher than the point already there replaces it only when he
 *     says so; "Keep the saved location" puts the point on file back;
 *   - a listen that hears nothing offers "Try again outside" first, and only a
 *     second one opens the typed-coordinates panel.
 * The accuracy rule itself (lib/gps-accuracy.ts, an owner decision) is unchanged.
 *
 * The geolocation here is a fake the test drives reading by reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  GPS_LISTEN_MS,
  GPS_START_WAIT_MS,
  GPS_STOP_EARLY_AT_M,
  distanceMetres,
  distanceWords,
  listenForBestFix,
  type ListenOutcome,
  type PermissionsLike,
} from '@/lib/gps-listen';
import { GPS_TARGET_ACCURACY_M, gpsAccuracyAdvice } from '@/lib/gps-accuracy';
import { GpsCaptureButton, GPS_NO_START_MESSAGE, GPS_TRY_OUTSIDE_MESSAGE, type Gps } from '@/components/nmwc/GpsCaptureButton';

type Watch = { ok: PositionCallback; fail: PositionErrorCallback; options?: PositionOptions; cleared: boolean };
let watches: Watch[];
const fakeGeo = {
  watchPosition: (ok: PositionCallback, fail: PositionErrorCallback, options?: PositionOptions) => {
    watches.push({ ok, fail, options, cleared: false });
    return watches.length;
  },
  clearWatch: (id: number) => {
    watches[id - 1]!.cleared = true;
  },
};
const last = () => watches.at(-1)!;
const reading = (accuracy: number, lat = 23.5881, lng = 58.3829) =>
  act(() => last().ok({ coords: { latitude: lat, longitude: lng, accuracy } } as GeolocationPosition));
const failWith = (code: 1 | 2 | 3) =>
  act(() =>
    last().fail({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError)
  );
// Async: the Permissions API answers in a promise, which must settle as time passes.
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/**
 * A fake of the browser's Permissions API for 'geolocation': `set` is the
 * salesman answering the "Allow location?" question (or the phone changing it).
 */
function fakePermissions(initial: 'granted' | 'prompt' | 'denied') {
  const listeners = new Set<() => void>();
  const status = {
    state: initial as string,
    addEventListener: (_t: 'change', fn: () => void) => void listeners.add(fn),
    removeEventListener: (_t: 'change', fn: () => void) => void listeners.delete(fn),
  };
  return {
    api: { query: vi.fn(async (_d: { name: 'geolocation' }) => status) } satisfies PermissionsLike,
    listeners,
    set(state: 'granted' | 'prompt' | 'denied') {
      status.state = state;
      for (const fn of [...listeners]) fn();
    },
  };
}
let perms: ReturnType<typeof fakePermissions>;

beforeEach(() => {
  vi.useFakeTimers();
  watches = [];
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: fakeGeo });
  // Location already allowed, as on a phone that has been asked before.
  perms = fakePermissions('granted');
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: perms.api });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'geolocation');
  Reflect.deleteProperty(navigator, 'permissions');
});

describe('the listening rule (lib/gps-listen.ts)', () => {
  it('its numbers: about 25 seconds, stop at the ±30 m target', () => {
    expect(GPS_LISTEN_MS).toBe(25_000);
    expect(GPS_STOP_EARLY_AT_M).toBe(GPS_TARGET_ACCURACY_M);
  });

  it('keeps the best of improving readings, says each improvement, and stops early at ±30 m', () => {
    const done = vi.fn<(o: ListenOutcome) => void>();
    const best = vi.fn();
    listenForBestFix(fakeGeo, done, best);
    expect(last().options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0, timeout: GPS_LISTEN_MS });
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 420 } } as GeolocationPosition);
    last().ok({ coords: { latitude: 2, longitude: 2, accuracy: 600 } } as GeolocationPosition); // worse: ignored
    last().ok({ coords: { latitude: 3, longitude: 3, accuracy: 64 } } as GeolocationPosition);
    expect(best.mock.calls.map((c) => c[0].accuracy)).toEqual([420, 64]);
    expect(done).not.toHaveBeenCalled();
    // 30.4 m shows as ±30 m: it meets the target.
    last().ok({ coords: { latitude: 4, longitude: 4, accuracy: 30.4 } } as GeolocationPosition);
    expect(done).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 4, lng: 4, accuracy: 30.4 }, early: true });
    expect(last().cleared).toBe(true);
    vi.advanceTimersByTime(GPS_LISTEN_MS);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('at the end of the window, the best reading heard', () => {
    const done = vi.fn();
    listenForBestFix(fakeGeo, done);
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 80 } } as GeolocationPosition);
    last().ok({ coords: { latitude: 2, longitude: 2, accuracy: 45 } } as GeolocationPosition);
    vi.advanceTimersByTime(GPS_LISTEN_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 2, lng: 2, accuracy: 45 }, early: false });
    expect(last().cleared).toBe(true);
  });

  it('nothing heard: a timeout, by the window or by the browser', async () => {
    const byWindow = vi.fn();
    listenForBestFix(fakeGeo, byWindow, undefined, { permissions: fakePermissions('granted').api });
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS - 1);
    expect(byWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(byWindow).toHaveBeenCalledWith({ kind: 'timeout' });
    const byBrowser = vi.fn();
    listenForBestFix(fakeGeo, byBrowser);
    last().fail({ code: 3 } as GeolocationPositionError);
    expect(byBrowser).toHaveBeenCalledWith({ kind: 'timeout' });
  });

  it('an error after a reading ends with that reading; before one, denied and unavailable are said', () => {
    const afterOne = vi.fn();
    listenForBestFix(fakeGeo, afterOne);
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 70 } } as GeolocationPosition);
    last().fail({ code: 2 } as GeolocationPositionError);
    expect(afterOne).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 1, lng: 1, accuracy: 70 }, early: false });
    const denied = vi.fn();
    listenForBestFix(fakeGeo, denied);
    last().fail({ code: 1 } as GeolocationPositionError);
    expect(denied).toHaveBeenCalledWith({ kind: 'denied' });
    const unavailable = vi.fn();
    listenForBestFix(fakeGeo, unavailable);
    last().fail({ code: 2 } as GeolocationPositionError);
    expect(unavailable).toHaveBeenCalledWith({ kind: 'unavailable' });
  });

  it('cancelled: nothing more is said and the watch is cleared', () => {
    const done = vi.fn();
    const cancel = listenForBestFix(fakeGeo, done);
    cancel();
    expect(last().cleared).toBe(true);
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 5 } } as GeolocationPosition);
    vi.advanceTimersByTime(GPS_LISTEN_MS);
    expect(done).not.toHaveBeenCalled();
  });

  it('a phone that answers inside watchPosition itself still has its watch cleared', () => {
    const cleared: number[] = [];
    const done = vi.fn();
    listenForBestFix(
      {
        watchPosition: (ok) => {
          ok({ coords: { latitude: 1, longitude: 1, accuracy: 4 } } as GeolocationPosition);
          return 7;
        },
        clearWatch: (id) => void cleared.push(id),
      },
      done
    );
    expect(done).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 1, lng: 1, accuracy: 4 }, early: true });
    expect(cleared).toEqual([7]);
  });
});

/**
 * Second round (code review 2026-11-10, finding 19): the window started at the
 * tap, so a salesman reading the first-ever "Allow location?" question lost it,
 * was told "No GPS fix", and the watch was gone when he tapped Allow. It now
 * starts when readings can arrive; a safety limit still ends every listen.
 */
describe('how far apart two points are (second round)', () => {
  it('one degree of latitude is about 111.2 km; a few metres are a few metres', () => {
    expect(distanceMetres({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, 0);
    expect(distanceMetres({ lat: 23.5, lng: 58.3 }, { lat: 23.5003, lng: 58.3 })).toBeCloseTo(33.36, 1);
    expect(distanceMetres({ lat: 23.5, lng: 58.3 }, { lat: 23.5, lng: 58.3 })).toBe(0);
    // Symmetric.
    expect(distanceMetres({ lat: 23.7, lng: 58.5 }, { lat: 23.5, lng: 58.3 })).toBeCloseTo(
      distanceMetres({ lat: 23.5, lng: 58.3 }, { lat: 23.7, lng: 58.5 }),
      6
    );
  });

  it('said in whole metres, with kilometres added from 1 km', () => {
    expect(distanceWords(33.36)).toBe('about 33 m');
    expect(distanceWords(999.4)).toBe('about 999 m');
    expect(distanceWords(999.6)).toBe('about 1,000 m (1 km)');
    expect(distanceWords(2140)).toBe('about 2,140 m (2.1 km)');
  });
});

describe('the window starts when readings can arrive, not at the tap', () => {
  it('its safety limit: two minutes to start, longer than the window it guards', () => {
    expect(GPS_START_WAIT_MS).toBe(120_000);
    expect(GPS_START_WAIT_MS).toBeGreaterThan(GPS_LISTEN_MS);
  });

  it('the question open for 40 s does not use up the window; "Allow" starts the full 25 s, and the watch was never dropped', async () => {
    const p = fakePermissions('prompt');
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    expect(p.api.query).toHaveBeenCalledWith({ name: 'geolocation' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(done).not.toHaveBeenCalled();
    expect(last().cleared).toBe(false);
    p.set('granted');
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS - 1);
    expect(done).not.toHaveBeenCalled();
    // A reading heard late in the full window is still kept.
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 60 } } as GeolocationPosition);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 1, lng: 1, accuracy: 60 }, early: false });
    expect(last().cleared).toBe(true);
    expect(p.listeners.size, 'the permission listener is removed').toBe(0);
  });

  it('a phone that never says "granted" (no change event): the first reading starts the window', async () => {
    const p = fakePermissions('prompt');
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    await vi.advanceTimersByTimeAsync(50_000);
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 80 } } as GeolocationPosition);
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS - 1);
    expect(done).not.toHaveBeenCalled();
    last().ok({ coords: { latitude: 2, longitude: 2, accuracy: 45 } } as GeolocationPosition);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 2, lng: 2, accuracy: 45 }, early: false });
  });

  it('third round: permission stays "prompt", no change event, browser TIMEOUT, no reading: an ordinary timeout', async () => {
    // iPhone Safari on "Ask", Firefox "allow this time": "Allow" is tapped but the
    // Permissions API keeps saying 'prompt' and sends no change event. The
    // browser's TIMEOUT runs only after "Allow", so it proves he answered.
    const p = fakePermissions('prompt');
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    await vi.advanceTimersByTimeAsync(5_000); // he reads the question, taps Allow
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS); // the browser's timer, from "Allow"
    expect(done).not.toHaveBeenCalled();
    last().fail({ code: 3 } as GeolocationPositionError);
    expect(done).toHaveBeenCalledWith({ kind: 'timeout' });
    expect(done).toHaveBeenCalledOnce();
    expect(last().cleared).toBe(true);
    expect(p.listeners.size, 'the permission listener is removed').toBe(0);
    // Not the two-minute safety limit's 'no-start' later on.
    await vi.advanceTimersByTimeAsync(GPS_START_WAIT_MS);
    expect(done).toHaveBeenCalledOnce();
  });

  it('third round: a reading while the state still says "prompt" starts the window and is kept; a later TIMEOUT ends with it', async () => {
    const p = fakePermissions('prompt');
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    await vi.advanceTimersByTimeAsync(3_000);
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 70 } } as GeolocationPosition);
    expect(done).not.toHaveBeenCalled();
    last().fail({ code: 3 } as GeolocationPositionError);
    expect(done).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 1, lng: 1, accuracy: 70 }, early: false });

    // And a good one while still 'prompt' stops at once.
    const early = vi.fn();
    listenForBestFix(fakeGeo, early, undefined, { permissions: fakePermissions('prompt').api });
    await vi.advanceTimersByTimeAsync(0);
    last().ok({ coords: { latitude: 2, longitude: 2, accuracy: 9 } } as GeolocationPosition);
    expect(early).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 2, lng: 2, accuracy: 9 }, early: true });
  });

  it('"Block" on the question: denied at once, as before', async () => {
    const p = fakePermissions('prompt');
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    await vi.advanceTimersByTimeAsync(10_000);
    p.set('denied');
    last().fail({ code: 1 } as GeolocationPositionError);
    expect(done).toHaveBeenCalledWith({ kind: 'denied' });
  });

  it('no Permissions API: silence is told by the browser’s own timeout (which starts after "Allow"); the app’s window starts at the first reading', async () => {
    const silent = vi.fn();
    listenForBestFix(fakeGeo, silent);
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS + 10_000);
    expect(silent, 'the app does not time out on its own before anything can arrive').not.toHaveBeenCalled();
    last().fail({ code: 3 } as GeolocationPositionError);
    expect(silent).toHaveBeenCalledWith({ kind: 'timeout' });

    const late = vi.fn();
    listenForBestFix(fakeGeo, late);
    await vi.advanceTimersByTimeAsync(30_000);
    last().ok({ coords: { latitude: 1, longitude: 1, accuracy: 90 } } as GeolocationPosition);
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS - 1);
    expect(late).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(late).toHaveBeenCalledWith({ kind: 'fix', reading: { lat: 1, lng: 1, accuracy: 90 }, early: false });
  });

  it.each([
    ['the question left open', () => fakePermissions('prompt').api],
    ['a Permissions API that never answers', () => ({ query: () => new Promise<never>(() => undefined) })],
    ['one that refuses', () => ({ query: () => Promise.reject(new Error('not supported')) })],
    [
      'one that throws',
      () => ({
        query: () => {
          throw new TypeError('geolocation is not a valid permission name');
        },
      }),
    ],
    ['none at all', () => null],
  ])('the safety limit — %s — ends the listen with "no-start" and clears the watch: the button never hangs', async (_label, make) => {
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: make() as PermissionsLike | null });
    await vi.advanceTimersByTimeAsync(GPS_START_WAIT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith({ kind: 'no-start' });
    expect(done).toHaveBeenCalledOnce();
    expect(last().cleared).toBe(true);
  });

  it('once the window has started, the safety limit no longer cuts it short', async () => {
    const p = fakePermissions('prompt');
    const done = vi.fn();
    listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    await vi.advanceTimersByTimeAsync(GPS_START_WAIT_MS - 5_000);
    p.set('granted');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GPS_LISTEN_MS - 10_000);
    expect(done).toHaveBeenCalledWith({ kind: 'timeout' });
  });

  it('cancelled while the question is open: the watch is cleared, the listener removed, nothing said', async () => {
    const p = fakePermissions('prompt');
    const done = vi.fn();
    const cancel = listenForBestFix(fakeGeo, done, undefined, { permissions: p.api });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.listeners.size).toBe(1);
    cancel();
    expect(last().cleared).toBe(true);
    expect(p.listeners.size).toBe(0);
    p.set('granted');
    await vi.advanceTimersByTimeAsync(GPS_START_WAIT_MS + GPS_LISTEN_MS);
    expect(done).not.toHaveBeenCalled();
  });
});

const ON_FILE: Gps = { lat: 23.5, lng: 58.3, accuracy: 8, capturedAt: new Date('2026-10-01T08:00:00Z') };
const chip = () => document.querySelector('[data-accuracy-band]') as HTMLElement;

describe('the GPS button', () => {
  it('listens and says the best so far; the chip changes only when it stops — at once at ±30 m', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton onCapture={onCapture} required />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS *' }));
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeDisabled();
    expect(screen.getByRole('status').textContent).toBe('Looking for GPS… this can take up to 25 seconds.');
    await reading(350);
    expect(screen.getByRole('status').textContent).toBe('Looking for a better fix… best so far ±350 m.');
    await reading(90);
    expect(screen.getByRole('status').textContent).toBe('Looking for a better fix… best so far ±90 m.');
    expect(onCapture).not.toHaveBeenCalled();
    expect(chip()).toBeNull();
    await reading(12, 23.6, 58.4);
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.6, lng: 58.4, accuracy: 12 });
    expect(chip().dataset.accuracyBand).toBe('good');
    expect(last().cleared).toBe(true);
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeEnabled();
  });

  it('no reading meets ±30 m: the best one, when the window ends', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await reading(140);
    await reading(55, 23.61, 58.41);
    await reading(75);
    await wait(GPS_LISTEN_MS);
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.61, lng: 58.41, accuracy: 55 });
    expect(chip().dataset.accuracyBand).toBe('fair');
  });

  it('nothing heard: "Try again outside" first; a second silent listen opens the typed-coordinates panel', async () => {
    render(<GpsCaptureButton onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await wait(GPS_LISTEN_MS);
    expect(screen.getByRole('alert').textContent).toBe(GPS_TRY_OUTSIDE_MESSAGE);
    expect(GPS_TRY_OUTSIDE_MESSAGE).toBe(
      'No GPS fix in 25 seconds. Step outside, away from roofs and walls, then tap “Try again outside”.'
    );
    expect(screen.queryByRole('button', { name: 'Save manual location' })).toBeNull();
    // The typed way stays one tap away, as before.
    expect(screen.getByRole('button', { name: 'Enter coordinates manually' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again outside' }));
    expect(watches).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Try again outside' })).toBeNull();
    await failWith(3);
    expect(screen.getByRole('alert').textContent).toBe('Location took too long. Tap below to enter coordinates manually.');
    expect(screen.getByRole('button', { name: 'Save manual location' })).toBeTruthy();
  });

  it('a listen that hears something resets the count: the next silent one offers the open sky again', async () => {
    render(<GpsCaptureButton onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await wait(GPS_LISTEN_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Try again outside' }));
    await reading(9);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await wait(GPS_LISTEN_MS);
    expect(screen.getByRole('alert').textContent).toBe(GPS_TRY_OUTSIDE_MESSAGE);
  });

  it('a reading rougher than the saved location is not put over it: he is asked, and "Keep the saved location" keeps it', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} required />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(180, 23.7, 58.5);
    await wait(GPS_LISTEN_MS);
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'The new reading is ±180 m, rougher than the saved location (±8 m).'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep the saved location' }));
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
  });

  it('second round: the question says how far apart the two points are, so a moved shop can be told from a weak signal', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} />);
    // A weak signal over the same shop: ±150 m, 33 m from the point on file.
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(150, 23.5003, 58.3);
    await wait(GPS_LISTEN_MS);
    expect(screen.getByRole('alert').textContent).toContain('The new reading is ±150 m, rougher than the saved location (±8 m).');
    expect(screen.getByTestId('gps-rougher-distance').textContent).toBe('It is about 33 m from the saved location.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the saved location' }));
    // A shop that moved: ±40 m, 30 km away.
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(40, 23.7, 58.5);
    await wait(GPS_LISTEN_MS);
    expect(screen.getByTestId('gps-rougher-distance').textContent).toBe('It is about 30,164 m (30.2 km) from the saved location.');
    // Which button leads is unchanged (an owner question): Keep stays the filled one.
    expect(screen.getByRole('button', { name: 'Keep the saved location' }).className).toContain('bg-brand-600');
    expect(screen.getByRole('button', { name: 'Use the new reading (±40 m)' }).className).not.toContain('bg-brand-600');
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('second round: against a typed point the distance is said too', async () => {
    const typed: Gps = { lat: 23.5, lng: 58.3, capturedAt: new Date(), isManual: true, manualReason: 'From the map' };
    render(<GpsCaptureButton initial={typed} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(160, 23.5, 58.3);
    await wait(GPS_LISTEN_MS);
    expect(screen.getByTestId('gps-rougher-distance').textContent).toBe('It is about 0 m from the location already here.');
  });

  it('…or "Use the new reading", when the shop really is somewhere else', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(40, 23.7, 58.5);
    await wait(GPS_LISTEN_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Use the new reading (±40 m)' }));
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.7, lng: 58.5, accuracy: 40 });
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
  });

  it('a reading as good or better replaces it without a question, and no one tap throws it away (second round; third round: a quiet link asks first)', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} />);
    // Nothing to go back to while the chip shows the saved location.
    expect(screen.queryByRole('button', { name: /saved location/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(8, 23.7, 58.5);
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
    // Finding 19, second round: the better capture is not one mis-tap from being
    // lost — no button that goes straight back.
    expect(screen.queryByRole('button', { name: /^Go back to the saved location/ })).toBeNull();
    // Third round: only a quiet link, which opens a question and changes nothing.
    const link = screen.getByRole('button', { name: 'Wrong place? Go back to the saved location…' });
    expect(link.className).not.toContain('bg-brand-600');
    fireEvent.click(link);
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
    // The question leads with keeping the new location.
    expect(screen.getByRole('button', { name: 'Keep the new location' }).className).toContain('bg-brand-600');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the new location' }));
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
    // A sharper one too.
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(4, 23.71, 58.51);
    expect(screen.queryByRole('button', { name: /^Go back to the saved location/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Wrong place? Go back to the saved location…' })).toBeTruthy();
  });

  it('third round: a better reading taken at the wrong shop — the link, the distance, going back, and the undo', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    // ±5 m, about 1.1 km away: the customer's other shop.
    await reading(5, 23.51, 58.3);
    expect(onCapture.mock.calls.at(-1)![0]).toMatchObject({ lat: 23.51, lng: 58.3, accuracy: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Wrong place? Go back to the saved location…' }));
    expect(screen.getByTestId('gps-back-distance').textContent).toBe(
      'The location on the chip is about 1,112 m (1.1 km) from the saved location (±8 m). Go back to the saved location?'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' }));
    expect(onCapture.mock.calls.at(-1)![0]).toBe(ON_FILE);
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Wrong place/ })).toBeNull();
    // Going back can itself be undone.
    expect(screen.getByRole('status').textContent).toContain('The saved location is back. The ±5 m reading you had is not used.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo: use the ±5 m reading again' }));
    expect(onCapture.mock.calls.at(-1)![0]).toMatchObject({ lat: 23.51, lng: 58.3, accuracy: 5 });
    expect(screen.getByText('23.510000, 58.300000')).toBeTruthy();
  });

  it('third round: a new capture closes the question, and there is no link with nothing on file', async () => {
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(6, 23.7, 58.5);
    fireEvent.click(screen.getByRole('button', { name: 'Wrong place? Go back to the saved location…' }));
    expect(screen.getByRole('button', { name: 'Keep the new location' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    expect(screen.queryByRole('button', { name: 'Keep the new location' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Wrong place/ }), 'not while listening').toBeNull();
    await reading(7, 23.71, 58.51);
    expect(screen.queryByRole('button', { name: 'Keep the new location' })).toBeNull();
    cleanup();
    render(<GpsCaptureButton saved={null} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await reading(6, 23.7, 58.5);
    expect(screen.queryByRole('button', { name: /saved location/ })).toBeNull();
  });

  it('second round: going back to the saved location is offered for a rougher point taken anyway, and a tap by mistake is undone', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(60, 23.7, 58.5);
    await wait(GPS_LISTEN_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Use the new reading (±60 m)' }));
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' }));
    expect(onCapture.mock.calls.at(-1)![0]).toBe(ON_FILE);
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('The saved location is back. The ±60 m reading you had is not used.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo: use the ±60 m reading again' }));
    expect(onCapture.mock.calls.at(-1)![0]).toMatchObject({ lat: 23.7, lng: 58.5, accuracy: 60 });
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    // Still a fresh capture: held to the rule at submit, as before the mis-tap.
    expect(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' })).toBeTruthy();
  });

  it('second round: a newer capture or typed point clears the undo', async () => {
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={ON_FILE} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' }));
    expect(screen.getByRole('button', { name: 'Undo: use the ±150 m reading again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    await reading(6, 23.51, 58.31);
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('second round: the undo puts back a point restored from the phone copy exactly as it was, still said as held at submit', () => {
    const onCapture = vi.fn();
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={ON_FILE} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo: use the ±150 m reading again' }));
    expect(onCapture.mock.calls.at(-1)![0]).toBe(restored);
    expect(screen.getByText(gpsAccuracyAdvice(150, true)!)).toBeTruthy();
  });

  it('"Go back to the saved location" also stops a listen in progress, and nothing it hears lands later', async () => {
    const onCapture = vi.fn();
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={ON_FILE} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(90);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' }));
    expect(last().cleared).toBe(true);
    expect(screen.queryByText(/Looking for/)).toBeNull();
    await reading(3, 25, 60);
    await wait(GPS_LISTEN_MS);
    expect(onCapture.mock.calls).toEqual([[ON_FILE]]);
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeEnabled();
  });

  it('against a typed point, only a reading over the ±100 m limit asks first', async () => {
    const typed: Gps = { lat: 23.5, lng: 58.3, capturedAt: new Date(), isManual: true, manualReason: 'From the map' };
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={typed} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(160);
    await wait(GPS_LISTEN_MS);
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('rougher than the location already here (typed in)');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the location already here' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(70);
    await wait(GPS_LISTEN_MS);
    expect(onCapture).toHaveBeenCalledOnce();
  });

  it('restored from the phone copy: a rough point put back is said as held at submit, and the saved location is one tap away', () => {
    const onCapture = vi.fn();
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={ON_FILE} onCapture={onCapture} />);
    // Not "if you can": Submit is held for it (the skeptic's note on finding 19).
    expect(screen.getByText(gpsAccuracyAdvice(150, true)!)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the saved location (±8 m)' }));
    expect(onCapture).toHaveBeenCalledWith(ON_FILE);
    expect(screen.queryByText(/cannot be submitted/)).toBeNull();
  });

  it('nothing on file (a new customer): a restored rough point is held at submit, and there is nothing to go back to', () => {
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={null} onCapture={vi.fn()} />);
    expect(screen.getByText(gpsAccuracyAdvice(150, true)!)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Go back to the saved location/ })).toBeNull();
  });

  it('a point loaded with no "saved" given keeps the softer advice it always had', () => {
    render(<GpsCaptureButton initial={{ ...ON_FILE, accuracy: 150 }} onCapture={vi.fn()} />);
    expect(screen.getByText(gpsAccuracyAdvice(150, false)!)).toBeTruthy();
  });

  it('a button that unmounts while listening stops listening', () => {
    const view = render(<GpsCaptureButton onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    view.unmount();
    expect(last().cleared).toBe(true);
  });

  it('second round: the first-ever "Allow location?" read slowly — he is not told "No GPS fix", and the fix after "Allow" lands', async () => {
    perms = fakePermissions('prompt');
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: perms.api });
    const onCapture = vi.fn();
    render(<GpsCaptureButton onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await wait(GPS_LISTEN_MS + 15_000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeDisabled();
    await act(async () => perms.set('granted'));
    await wait(20_000);
    await reading(40, 23.6, 58.4);
    await wait(GPS_LISTEN_MS - 20_000);
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.6, lng: 58.4, accuracy: 40 });
    expect(watches).toHaveLength(1);
  });

  it('third round: a phone that keeps saying "prompt" after Allow — a silent tap indoors gets "Try again outside", then the typed-coordinates panel', async () => {
    perms = fakePermissions('prompt');
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: perms.api });
    render(<GpsCaptureButton onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await wait(GPS_LISTEN_MS);
    await failWith(3);
    expect(screen.getByRole('alert').textContent).toBe(GPS_TRY_OUTSIDE_MESSAGE);
    expect(screen.queryByText(GPS_NO_START_MESSAGE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again outside' }));
    expect(watches).toHaveLength(2);
    await wait(GPS_LISTEN_MS);
    await failWith(3);
    expect(screen.getByRole('alert').textContent).toBe('Location took too long. Tap below to enter coordinates manually.');
    expect(screen.getByRole('button', { name: 'Save manual location' })).toBeTruthy();
  });

  it('second round: the question never answered — after the safety limit he is told to tap Allow, not to step outside', async () => {
    perms = fakePermissions('prompt');
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: perms.api });
    render(<GpsCaptureButton onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await wait(GPS_START_WAIT_MS);
    expect(screen.getByRole('alert').textContent).toBe(GPS_NO_START_MESSAGE);
    expect(last().cleared).toBe(true);
    expect(screen.getByRole('button', { name: 'Capture GPS' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Try again outside' })).toBeNull();
    // The typed way stays one tap away.
    expect(screen.getByRole('button', { name: 'Enter coordinates manually' })).toBeEnabled();
    // Not counted as a silent listen: the next silent one still offers the open sky first.
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    await act(async () => perms.set('granted'));
    await wait(GPS_LISTEN_MS);
    expect(screen.getByRole('alert').textContent).toBe(GPS_TRY_OUTSIDE_MESSAGE);
  });
});
