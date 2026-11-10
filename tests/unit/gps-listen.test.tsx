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
import { GPS_LISTEN_MS, GPS_STOP_EARLY_AT_M, listenForBestFix, type ListenOutcome } from '@/lib/gps-listen';
import { GPS_TARGET_ACCURACY_M, gpsAccuracyAdvice } from '@/lib/gps-accuracy';
import { GpsCaptureButton, GPS_TRY_OUTSIDE_MESSAGE, type Gps } from '@/components/nmwc/GpsCaptureButton';

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
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  watches = [];
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: fakeGeo });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'geolocation');
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

  it('nothing heard: a timeout, by the window or by the browser', () => {
    const byWindow = vi.fn();
    listenForBestFix(fakeGeo, byWindow);
    vi.advanceTimersByTime(GPS_LISTEN_MS);
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

  it('a reading as good or better replaces it without a question; "Keep the saved location" undoes it', async () => {
    const onCapture = vi.fn();
    render(<GpsCaptureButton initial={ON_FILE} saved={ON_FILE} onCapture={onCapture} />);
    // Nothing to undo while the chip shows the saved location.
    expect(screen.queryByRole('button', { name: /Keep the saved location/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(8, 23.7, 58.5);
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText('23.700000, 58.500000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the saved location (±8 m)' }));
    expect(onCapture).toHaveBeenCalledTimes(2);
    expect(onCapture.mock.calls[1]![0]).toBe(ON_FILE);
    expect(screen.getByText('23.500000, 58.300000')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Keep the saved location/ })).toBeNull();
  });

  it('"Keep the saved location" also stops a listen in progress, and nothing it hears lands later', async () => {
    const onCapture = vi.fn();
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={ON_FILE} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recapture GPS' }));
    await reading(90);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the saved location (±8 m)' }));
    expect(last().cleared).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Keep the saved location (±8 m)' }));
    expect(onCapture).toHaveBeenCalledWith(ON_FILE);
    expect(screen.queryByText(/cannot be submitted/)).toBeNull();
  });

  it('nothing on file (a new customer): a restored rough point is held at submit, and there is nothing to go back to', () => {
    const restored: Gps = { lat: 23.9, lng: 58.9, accuracy: 150, capturedAt: new Date() };
    render(<GpsCaptureButton initial={restored} saved={null} onCapture={vi.fn()} />);
    expect(screen.getByText(gpsAccuracyAdvice(150, true)!)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Keep the saved location/ })).toBeNull();
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
});
