'use client';

import { useState } from 'react';
import { MapPin, Check, RotateCcw, AlertTriangle, PencilLine } from 'lucide-react';

export type Gps = {
  lat: number;
  lng: number;
  accuracy?: number;
  capturedAt: Date;
  /** B-07: a point typed in by hand, and why. Both forms send the reason as
   *  `gpsManualReason`, and the change request keeps it as a marker the approver
   *  sees (item 41, lib/gps-manual.ts). */
  isManual?: boolean;
  manualReason?: string;
};

// B-07: sensible Oman bounds. We allow override (the bounds only display a
// warning), since coastal / border shops can sit a hair outside.
const OMAN_LAT_MIN = 16;
const OMAN_LAT_MAX = 27;
const OMAN_LNG_MIN = 51;
const OMAN_LNG_MAX = 60;

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
  // B-07: manual-entry fallback state. Surfaced after timeout / denied /
  // unavailable, plus a tertiary button if the user wants to bypass GPS up-front.
  const [showManual, setShowManual] = useState(false);
  const [manualLat, setManualLat] = useState<string>(
    initial?.isManual && initial?.lat != null ? String(initial.lat) : ''
  );
  const [manualLng, setManualLng] = useState<string>(
    initial?.isManual && initial?.lng != null ? String(initial.lng) : ''
  );
  const [manualReason, setManualReason] = useState<string>(initial?.manualReason ?? '');
  const [manualErr, setManualErr] = useState<string | null>(null);

  function capture() {
    if (!('geolocation' in navigator)) {
      setError('GPS not available in this browser. Use manual entry below.');
      setShowManual(true);
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
        setShowManual(false);
      },
      (err) => {
        // B-07: any of timeout / denied / unavailable opens the manual fallback.
        const reason =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Tap below to enter coordinates manually.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'Location unavailable. Tap below to enter coordinates manually.'
              : err.code === err.TIMEOUT
                ? "Location took too long. Tap below to enter coordinates manually."
                : err.message || 'Could not get GPS. Tap below to enter coordinates manually.';
        setError(reason);
        setPending(false);
        setShowManual(true);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }

  function applyManual() {
    setManualErr(null);
    // Replace comma decimals with periods so phones with locale-comma keypads
    // (typical in MENA) don't silently NaN.
    const latNum = Number.parseFloat(manualLat.replace(',', '.'));
    const lngNum = Number.parseFloat(manualLng.replace(',', '.'));
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      setManualErr('Enter valid latitude and longitude numbers.');
      return;
    }
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      setManualErr('Coordinates out of range.');
      return;
    }
    if (manualReason.trim().length < 5) {
      setManualErr('Tell us why GPS did not work (5+ characters).');
      return;
    }
    const outside =
      latNum < OMAN_LAT_MIN ||
      latNum > OMAN_LAT_MAX ||
      lngNum < OMAN_LNG_MIN ||
      lngNum > OMAN_LNG_MAX;
    const next: Gps = {
      lat: latNum,
      lng: lngNum,
      capturedAt: new Date(),
      isManual: true,
      manualReason: manualReason.trim(),
    };
    setGps(next);
    onCapture(next);
    setShowManual(false);
    if (outside) {
      setError('Saved, but the coordinates fall outside Oman. Double-check before submitting.');
    } else {
      setError(null);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={capture}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {gps ? <RotateCcw className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
        {pending
          ? 'Capturing…'
          : gps
            ? 'Recapture GPS'
            : `Capture GPS${required ? ' *' : ''}`}
      </button>
      {gps && (
        <div
          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ring-1 ${
            gps.isManual
              ? 'bg-amber-50 text-amber-800 ring-amber-200'
              : 'bg-emerald-50 text-emerald-800 ring-emerald-200'
          }`}
        >
          {gps.isManual ? (
            // B-07: pin-with-warning so supervisors immediately see manual entry.
            <span className="relative inline-flex">
              <MapPin className="h-3.5 w-3.5" />
              <AlertTriangle className="absolute -right-1 -top-1 h-2.5 w-2.5 text-amber-700" />
            </span>
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          <span className="font-mono">
            {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
          </span>
          {gps.accuracy != null && (
            <span className="text-emerald-700">±{Math.round(gps.accuracy)}m</span>
          )}
          {gps.isManual && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
              Manual
            </span>
          )}
        </div>
      )}
      {error && <p className="text-sm font-medium text-red-600">{error}</p>}

      {/* B-07: manual fallback UI. Tertiary trigger always available so a user
          who knows the GPS chip is broken can skip the wait. */}
      {!showManual && (
        <button
          type="button"
          onClick={() => setShowManual(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          <PencilLine className="h-3 w-3" />
          Enter coordinates manually
        </button>
      )}
      {showManual && (
        <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3">
          <p className="mb-2 text-sm font-medium text-amber-900">
            Location unavailable. Tap below to enter coordinates manually.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Latitude (16–27 in Oman)
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={manualLat}
                onChange={(e) => setManualLat(e.currentTarget.value)}
                placeholder="e.g. 23.5880"
                className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Longitude (51–60 in Oman)
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={manualLng}
                onChange={(e) => setManualLng(e.currentTarget.value)}
                placeholder="e.g. 58.3829"
                className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
              />
            </label>
          </div>
          <label className="mt-2 block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Why didn&apos;t GPS work? *
            </span>
            <textarea
              value={manualReason}
              onChange={(e) => setManualReason(e.currentTarget.value)}
              rows={2}
              minLength={5}
              maxLength={500}
              placeholder="e.g. Phone GPS chip broken; coordinates from Google Maps."
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
            />
          </label>
          {manualErr && <p className="mt-1 text-sm font-medium text-red-600">{manualErr}</p>}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowManual(false);
                setManualErr(null);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={applyManual}
              className="rounded-md bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-700"
            >
              Save manual location
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
