/**
 * What the GPS capture says is read out (launch browser suite follow-up, 8 Oct).
 *
 * A capture that failed ("Location permission denied…"), a typed point that
 * was refused ("Enter valid latitude and longitude numbers."), and the advice
 * after a rough fix ("Over ±100 m: this cannot be submitted…") were plain
 * text beside the button. A salesman using a screen reader tapped Capture GPS
 * and heard nothing. Errors are alerts; the accuracy advice is a status.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { gpsAccuracyAdvice } from '@/lib/gps-accuracy';
import { GpsCaptureButton } from '@/components/nmwc/GpsCaptureButton';

const realGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
afterEach(() => {
  cleanup();
  if (realGeo) Object.defineProperty(navigator, 'geolocation', realGeo);
  else delete (navigator as unknown as Record<string, unknown>).geolocation;
});

function geolocation(getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) => void) {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
}

describe('the GPS capture, for a screen reader', () => {
  it('a refused location permission is an alert', () => {
    geolocation((_ok, fail) =>
      fail({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: '' } as GeolocationPositionError)
    );
    render(<GpsCaptureButton onCapture={() => {}} required />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS *' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Location permission denied. Tap below to enter coordinates manually.'
    );
  });

  it('a typed point it cannot read is an alert, and the boxes are found by their labels', () => {
    render(<GpsCaptureButton onCapture={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter coordinates manually' }));
    fireEvent.change(screen.getByLabelText('Latitude (16–27 in Oman)'), { target: { value: 'north' } });
    fireEvent.change(screen.getByLabelText('Longitude (51–60 in Oman)'), { target: { value: '58.38' } });
    fireEvent.change(screen.getByLabelText(/Why didn.t GPS work/), { target: { value: 'Chip broken on this phone.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual location' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter valid latitude and longitude numbers.');
  });

  it('a fix too rough to submit is said in a status', () => {
    geolocation((ok) => ok({ coords: { latitude: 23.588, longitude: 58.3829, accuracy: 150 } } as unknown as GeolocationPosition));
    render(<GpsCaptureButton onCapture={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture GPS' }));
    expect(screen.getByRole('status').textContent).toBe(gpsAccuracyAdvice(150));
  });
});
