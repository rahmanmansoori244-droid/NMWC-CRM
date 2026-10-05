/**
 * The owner's GPS accuracy standard (decided 2026-10-05): capture within ±30 m,
 * approve within ±100 m (lib/gps-accuracy.ts).
 *
 * Pinned here: the bands, the rule the two submit gates share, the capture chip
 * a salesman sees, and the label a manager sees on the review page. The submit
 * gates themselves are tested where they live: tests/unit/edit-service.test.ts
 * (an update) and tests/unit/create-flow.test.ts (a new customer).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  GPS_MAX_ACCURACY_M,
  GPS_TARGET_ACCURACY_M,
  gpsAccuracyAdvice,
  gpsAccuracyBand,
  gpsTooInaccurateMessage,
  isGpsTooInaccurate,
} from '@/lib/gps-accuracy';
import { GpsCaptureButton } from '@/components/nmwc/GpsCaptureButton';
import { GpsAccuracyBadge } from '@/components/nmwc/GpsAccuracyBadge';

afterEach(cleanup);

describe('the bands', () => {
  it('are the owner’s numbers: 30 m target, 100 m limit', () => {
    expect(GPS_TARGET_ACCURACY_M).toBe(30);
    expect(GPS_MAX_ACCURACY_M).toBe(100);
  });

  it('good up to 30 m, fair up to 100 m, poor beyond, judged on the whole metres shown; anything unreadable is unknown', () => {
    expect([0, 12, 30, 30.4].map(gpsAccuracyBand)).toEqual(['good', 'good', 'good', 'good']);
    expect([30.5, 31, 100, 100.4].map(gpsAccuracyBand)).toEqual(['fair', 'fair', 'fair', 'fair']);
    expect([100.5, 150, 5000].map(gpsAccuracyBand)).toEqual(['poor', 'poor', 'poor']);
    expect([null, undefined, NaN, -1, Infinity].map((v) => gpsAccuracyBand(v as number))).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });
});

describe('the submit rule', () => {
  it('refuses a captured point over 100 m', () => {
    expect(isGpsTooInaccurate(150, undefined)).toBe(true);
    expect(isGpsTooInaccurate(100.5, '')).toBe(true);
  });

  it('accepts 100 m and better, a point with no accuracy, and any point typed in with a reason', () => {
    expect(isGpsTooInaccurate(100, undefined)).toBe(false);
    expect(isGpsTooInaccurate(null, undefined)).toBe(false);
    expect(isGpsTooInaccurate(undefined, undefined)).toBe(false);
    expect(isGpsTooInaccurate(150, 'GPS not working inside the mall')).toBe(false);
  });

  it('says what the reading was and what to do', () => {
    expect(gpsTooInaccurateMessage('Branch 1', 149.6)).toBe(
      'Branch 1: the GPS reading is ±150 m, over the 100 m limit. Step outside and recapture, or enter the location by hand with a reason.'
    );
  });
});

describe('the capture chip the salesman sees', () => {
  const at = (accuracy?: number, typed = false) => ({
    lat: 23.588,
    lng: 58.3829,
    accuracy,
    capturedAt: new Date('2026-10-05T08:00:00Z'),
    ...(typed ? { isManual: true, manualReason: 'GPS not working' } : {}),
  });
  const chip = () => document.querySelector('[data-accuracy-band]') as HTMLElement;

  it('±12 m: green, no advice', () => {
    render(<GpsCaptureButton initial={at(12)} onCapture={() => {}} />);
    expect(chip().dataset.accuracyBand).toBe('good');
    expect(chip().className).toContain('bg-emerald-50');
    expect(chip().textContent).toContain('±12m');
    expect(screen.queryByText(/Aim for|cannot be submitted/)).toBeNull();
  });

  it('±60 m: amber, and asks for another try outdoors', () => {
    render(<GpsCaptureButton initial={at(60)} onCapture={() => {}} />);
    expect(chip().dataset.accuracyBand).toBe('fair');
    expect(chip().className).toContain('bg-amber-50');
    expect(screen.getByText(gpsAccuracyAdvice(60)!)).toBeTruthy();
  });

  it('±150 m loaded from file: red, with advice but no refusal (nothing checks an unchanged point)', () => {
    render(<GpsCaptureButton initial={at(150)} onCapture={() => {}} />);
    expect(chip().dataset.accuracyBand).toBe('poor');
    expect(chip().className).toContain('bg-red-50');
    expect(screen.queryByText(/cannot be submitted/)).toBeNull();
    expect(screen.getByText(gpsAccuracyAdvice(150, false)!)).toBeTruthy();
  });

  describe('a fresh capture', () => {
    const realGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    const fixAt = (accuracy: number) =>
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (ok: PositionCallback) =>
            ok({ coords: { latitude: 23.588, longitude: 58.3829, accuracy } } as unknown as GeolocationPosition),
        },
      });
    afterEach(() => {
      if (realGeo) Object.defineProperty(navigator, 'geolocation', realGeo);
      else delete (navigator as unknown as Record<string, unknown>).geolocation;
    });

    it('±150 m for a salesman: says it cannot be submitted and what to do', () => {
      fixAt(150);
      render(<GpsCaptureButton onCapture={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /Capture GPS/ }));
      expect(chip().dataset.accuracyBand).toBe('poor');
      expect(screen.getByText(/cannot be submitted/).textContent).toBe(gpsAccuracyAdvice(150));
    });

    it('±150 m for a Manager (not held to the rule): advice, no refusal', () => {
      fixAt(150);
      render(<GpsCaptureButton onCapture={() => {}} enforceAccuracy={false} />);
      fireEvent.click(screen.getByRole('button', { name: /Capture GPS/ }));
      expect(screen.queryByText(/cannot be submitted/)).toBeNull();
      expect(screen.getByText(gpsAccuracyAdvice(150, false)!)).toBeTruthy();
    });
  });

  it('a typed point keeps its own amber Manual look and no accuracy advice', () => {
    render(<GpsCaptureButton initial={at(undefined, true)} onCapture={() => {}} />);
    expect(chip().dataset.accuracyBand).toBe('manual');
    expect(chip().textContent).toContain('Manual');
    expect(screen.queryByText(/Aim for|cannot be submitted/)).toBeNull();
  });
});

describe('the label the manager sees on the review page', () => {
  it('names the band against the standard', () => {
    const { container, rerender } = render(<GpsAccuracyBadge accuracy={8} />);
    expect(container.textContent).toBe('±8 m: within the 30 m target');
    rerender(<GpsAccuracyBadge accuracy={64} />);
    expect(container.textContent).toBe('±64 m: acceptable, above the 30 m target');
    rerender(<GpsAccuracyBadge accuracy={240} />);
    expect(container.textContent).toBe('±240 m: over the 100 m limit. Reject unless the reason explains it.');
  });

  it('on the point already on file: the band, and no reject instruction', () => {
    const { container } = render(<GpsAccuracyBadge accuracy={240} onFile />);
    expect(container.textContent).toBe('±240 m: over the 100 m limit (the point on file; a recapture at the shop fixes it)');
    expect(container.textContent).not.toMatch(/Reject/);
  });

  it('shows nothing for a point with no reported accuracy', () => {
    const { container } = render(<GpsAccuracyBadge accuracy={null} />);
    expect(container.textContent).toBe('');
  });
});
