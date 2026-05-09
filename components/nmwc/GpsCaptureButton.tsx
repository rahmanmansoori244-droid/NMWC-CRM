'use client';

import { useState } from 'react';
import { MapPin, Check, RotateCcw } from 'lucide-react';

export type Gps = {
  lat: number;
  lng: number;
  accuracy?: number;
  capturedAt: Date;
};

export function GpsCaptureButton({
  initial,
  onCapture,
  required,
}: {
  initial?: Gps | null;
  onCapture: (g: Gps) => void;
  required?: boolean;
}) {
  const [gps, setGps] = useState<Gps | null>(initial ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function capture() {
    if (!('geolocation' in navigator)) {
      setError('GPS not available in this browser.');
      return;
    }
    setPending(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next: Gps = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          capturedAt: new Date(),
        };
        setGps(next);
        onCapture(next);
        setPending(false);
      },
      (err) => {
        setError(err.message || 'Could not get GPS.');
        setPending(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={capture}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {gps ? <RotateCcw className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
        {pending
          ? 'Capturing…'
          : gps
            ? 'Recapture GPS'
            : `Capture GPS${required ? ' *' : ''}`}
      </button>
      {gps && (
        <div className="inline-flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
          <Check className="h-3.5 w-3.5" />
          <span className="font-mono">
            {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
          </span>
          {gps.accuracy != null && (
            <span className="text-emerald-700">±{Math.round(gps.accuracy)}m</span>
          )}
        </div>
      )}
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
