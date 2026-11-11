'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Check, RotateCcw, AlertTriangle, PencilLine, Undo2 } from 'lucide-react';
import { gpsAccuracyAdvice, gpsAccuracyBand } from '@/lib/gps-accuracy';
import {
  GPS_LISTEN_MS,
  distanceMetres,
  distanceWords,
  listenForBestFix,
  rankedAccuracy,
  type PermissionsLike,
} from '@/lib/gps-listen';
import { typedDecimal } from '@/lib/digits';

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

/** Finding 19: the first listen that heard nothing says where a fix is likely, before the typed-coordinates panel. */
export const GPS_TRY_OUTSIDE_MESSAGE = `No GPS fix in ${Math.round(GPS_LISTEN_MS / 1000)} seconds. Step outside, away from roofs and walls, then tap “Try again outside”.`;

/**
 * Finding 19, second round: the listen never started — the phone neither said
 * location is allowed nor sent a reading — most likely because the "Allow
 * location?" question is still open. Not the sky's fault, so not "step outside".
 */
export const GPS_NO_START_MESSAGE =
  'The phone has not started looking for GPS. If it asks “Allow location?”, tap Allow, then tap the GPS button again.';

/** The browser's Permissions API, when it has one: the listening window starts once location is allowed. */
function browserPermissions(): PermissionsLike | null {
  const p = typeof navigator !== 'undefined' ? (navigator as { permissions?: unknown }).permissions : undefined;
  return p && typeof (p as PermissionsLike).query === 'function' ? (p as PermissionsLike) : null;
}

const samePoint = (a: Gps | null | undefined, b: Gps | null | undefined) =>
  !!a &&
  !!b &&
  a.lat === b.lat &&
  a.lng === b.lng &&
  (a.accuracy ?? null) === (b.accuracy ?? null) &&
  !!a.isManual === !!b.isManual;

/**
 * Finding 19: whether a captured reading is rougher than the point already on
 * the chip, so it must not replace it without asking. Against a captured point:
 * more metres, in the whole metres every screen shows. Against a typed point or
 * one of unknown accuracy (nothing to compare): only a reading over the ±100 m
 * limit counts as rougher.
 */
function isRougher(next: Gps, current: Gps | null): boolean {
  if (!current) return false;
  const was = current.isManual ? Number.POSITIVE_INFINITY : rankedAccuracy(current.accuracy);
  if (!Number.isFinite(was)) return gpsAccuracyBand(next.accuracy) === 'poor';
  return rankedAccuracy(next.accuracy) > was;
}

/** How a point is named in the undo line: "±150 m reading", or "typed-in point". */
function pointLabel(g: Gps): string {
  if (g.isManual) return 'typed-in point';
  return g.accuracy != null ? `±${Math.round(g.accuracy)} m reading` : 'reading';
}

export function GpsCaptureButton({
  initial,
  saved,
  onCapture,
  required,
  disabled = false,
  enforceAccuracy = true,
}: {
  initial?: Gps | null;
  /**
   * Finding 19: the location on file, which "Keep the saved location" goes back
   * to; null when nothing is on file (a new customer), so every point on the
   * chip is a new one the submit gate judges. Omitted: not known here.
   */
  saved?: Gps | null;
  onCapture: (g: Gps) => void;
  required?: boolean;
  disabled?: boolean;
  /** Whether the submit gate holds this user to the ±100 m rule (a salesman). */
  enforceAccuracy?: boolean;
}) {
  const [gps, setGps] = useState<Gps | null>(initial ?? null);
  // A reading taken on this page, as opposed to the point loaded from file:
  // only a fresh capture is held to the ±100 m rule at submit.
  const [fresh, setFresh] = useState(false);
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
  // A fix asked for by a button that has since unmounted is dropped. The edit
  // form remounts a branch's button when "Use this value" takes the saved point
  // into that branch: a capture still in flight then landed in the form over
  // the point he had just chosen, while the new chip kept showing the saved one
  // (post-merge review of phase 2, finding 1). On the new-customer form the
  // button unmounts only with its branch, and that fix has nowhere to go.
  const mountedRef = useRef(true);
  const captureGenerationRef = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The point on the chip now, for the device callbacks: they run after the
  // render that started them.
  const gpsRef = useRef(gps);
  gpsRef.current = gps;
  const cancelListenRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelListenRef.current?.(), []);
  // Finding 19: the best accuracy heard so far while listening, a rougher
  // reading waiting for his answer, and how many listens in a row heard nothing.
  const [bestSoFar, setBestSoFar] = useState<number | null>(null);
  const [rougher, setRougher] = useState<Gps | null>(null);
  const [offerOutside, setOfferOutside] = useState(false);
  const silentListensRef = useRef(0);
  // Finding 19, second round: the point "Go back to the saved location" took off
  // the chip, so a tap by mistake can be undone; cleared by any newer choice.
  const [replaced, setReplaced] = useState<{ gps: Gps; fresh: boolean } | null>(null);
  // Finding 19, third round: the question opened by the quiet "Wrong place?" link
  // under a point as good as or better than the one on file.
  const [askBack, setAskBack] = useState(false);

  function take(next: Gps) {
    setGps(next);
    setFresh(true);
    onCapture(next);
    setShowManual(false);
    setRougher(null);
    setReplaced(null);
    setAskBack(false);
    setError(null);
  }

  function capture() {
    if (disabledRef.current) return;
    const generation = ++captureGenerationRef.current;
    cancelListenRef.current?.();
    cancelListenRef.current = null;
    setRougher(null);
    setReplaced(null);
    setAskBack(false);
    setOfferOutside(false);
    if (!('geolocation' in navigator)) {
      setError('GPS not available in this browser. Use manual entry below.');
      setShowManual(true);
      return;
    }
    setPending(true);
    setBestSoFar(null);
    setError(null);
    const current = () => mountedRef.current && generation === captureGenerationRef.current;
    cancelListenRef.current = listenForBestFix(
      navigator.geolocation,
      (outcome) => {
        if (!current()) return;
        cancelListenRef.current = null;
        setPending(false);
        setBestSoFar(null);
        if (disabledRef.current) {
          setError('Location not updated — capture again');
          return;
        }
        if (outcome.kind === 'fix') {
          silentListensRef.current = 0;
          const next: Gps = { ...outcome.reading, capturedAt: new Date() };
          // Never put a rougher reading over the point already here without asking.
          if (isRougher(next, gpsRef.current)) {
            setRougher(next);
            return;
          }
          take(next);
          return;
        }
        if (outcome.kind === 'no-start') {
          // Not a silent listen: nothing was listened to. The typed way stays one tap away.
          setError(GPS_NO_START_MESSAGE);
          return;
        }
        if (outcome.kind === 'timeout') {
          silentListensRef.current += 1;
          // Finding 19: the first time, the way out that usually works — the
          // open sky — before the typed-coordinates panel.
          if (silentListensRef.current === 1) {
            setError(GPS_TRY_OUTSIDE_MESSAGE);
            setOfferOutside(true);
            return;
          }
        }
        // B-07: denied / unavailable, or a second silent listen, opens the manual fallback.
        setError(
          outcome.kind === 'denied'
            ? 'Location permission denied. Tap below to enter coordinates manually.'
            : outcome.kind === 'timeout'
              ? 'Location took too long. Tap below to enter coordinates manually.'
              : 'Location unavailable. Tap below to enter coordinates manually.'
        );
        setShowManual(true);
      },
      (best) => {
        if (current()) setBestSoFar(best.accuracy);
      },
      { permissions: browserPermissions() }
    );
  }

  /**
   * Finding 19: back to the location on file, from a rougher point on the chip.
   * Second round: the point it replaces is kept, so a tap by mistake is undone
   * with one more ("Use the ±N m reading again").
   */
  function keepSaved() {
    if (disabledRef.current || !saved) return;
    if (gps && !samePoint(gps, saved)) setReplaced({ gps, fresh });
    captureGenerationRef.current += 1;
    cancelListenRef.current?.();
    cancelListenRef.current = null;
    setPending(false);
    setBestSoFar(null);
    setRougher(null);
    setAskBack(false);
    setOfferOutside(false);
    setError(null);
    setShowManual(false);
    setGps(saved);
    setFresh(false);
    onCapture(saved);
  }

  /** Finding 19, second round: undo "Go back to the saved location". */
  function restoreReplaced() {
    if (disabledRef.current || !replaced) return;
    captureGenerationRef.current += 1;
    cancelListenRef.current?.();
    cancelListenRef.current = null;
    setPending(false);
    setBestSoFar(null);
    setRougher(null);
    setError(null);
    setGps(replaced.gps);
    setFresh(replaced.fresh);
    onCapture(replaced.gps);
    setReplaced(null);
  }

  function applyManual() {
    if (disabledRef.current) return;
    setManualErr(null);
    // A comma reads as the decimal point, so phones with locale-comma keypads
    // (typical in MENA) don't silently NaN; Arabic-Indic digits, the Arabic
    // decimal mark and the Arabic comma too. The whole box must be the number:
    // parseFloat dropped what followed a character it did not read, and saved
    // '٢٣،٥٨٧' as 23 (lib/digits.ts typedDecimal).
    const latNum = typedDecimal(manualLat);
    const lngNum = typedDecimal(manualLng);
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
    // An explicit valid choice supersedes every older device callback.
    captureGenerationRef.current += 1;
    cancelListenRef.current?.();
    cancelListenRef.current = null;
    setPending(false);
    setBestSoFar(null);
    setRougher(null);
    setReplaced(null);
    setAskBack(false);
    setOfferOutside(false);
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

  // The owner's accuracy standard (lib/gps-accuracy.ts): green at ±30 m or
  // better, amber up to ±100 m, red beyond, which the submit gates refuse.
  // A typed point has no accuracy and keeps its own amber "Manual" look.
  const band = gps && !gps.isManual ? gpsAccuracyBand(gps.accuracy) : 'unknown';
  // A point the submit gate will judge: captured on this page, or (when the
  // location on file is known) any point that is not that one — a rough point
  // put back after a reload is held at submit, so it is said the same way.
  const isNewPoint = fresh || (saved !== undefined && !!gps && !samePoint(gps, saved));
  const advice = gps && !gps.isManual ? gpsAccuracyAdvice(gps.accuracy, enforceAccuracy && isNewPoint) : null;
  // Finding 19, second round: offered only when the chip holds a point rougher
  // than the one on file (the case it was built for: a rough reading taken
  // anyway, or one put back from the phone copy). After a fresh, better capture
  // it was one easy mis-tap from throwing that capture away. Also while
  // listening: it stops the listen (keepSaved).
  const canKeepSaved = !!saved && !!gps && !samePoint(gps, saved) && isRougher(gps, saved);
  // Third round: a point as good or better can still be in the wrong place (a
  // customer with several shops: Recapture pressed at the other shop). The way
  // back is then a quiet link that only opens a question — "Keep the new
  // location" leads — so one mis-tap cannot throw a good capture away, and going
  // back can itself be undone.
  const canGoBackFromBetter = !!saved && !!gps && !samePoint(gps, saved) && !isRougher(gps, saved);
  const savedLabel = (s: Gps) =>
    `the saved location${s.isManual ? ' (typed in)' : s.accuracy != null ? ` (±${Math.round(s.accuracy)} m)` : ''}`;
  const currentLabel = gps && saved && samePoint(gps, saved) ? 'the saved location' : 'the location already here';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={capture}
        disabled={pending || disabled}
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
            gps.isManual || band === 'fair'
              ? 'bg-amber-50 text-amber-800 ring-amber-200'
              : band === 'poor'
                ? 'bg-red-50 text-red-800 ring-red-200'
                : 'bg-emerald-50 text-emerald-800 ring-emerald-200'
          }`}
          data-accuracy-band={gps.isManual ? 'manual' : band}
        >
          {gps.isManual ? (
            // B-07: pin-with-warning so supervisors immediately see manual entry.
            <span className="relative inline-flex">
              <MapPin className="h-3.5 w-3.5" />
              <AlertTriangle className="absolute -right-1 -top-1 h-2.5 w-2.5 text-amber-700" />
            </span>
          ) : band === 'fair' || band === 'poor' ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          <span className="font-mono">
            {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
          </span>
          {gps.accuracy != null && <span>±{Math.round(gps.accuracy)}m</span>}
          {gps.isManual && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
              Manual
            </span>
          )}
        </div>
      )}
      {/* Read out when they appear: a capture that failed or came back too
          rough was said only in text a screen reader never reached. */}
      {advice && (
        <p role="status" className={`text-sm font-medium ${band === 'poor' ? 'text-red-700' : 'text-amber-800'}`}>
          {advice}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm text-slate-600">
          {bestSoFar === null
            ? `Looking for GPS… this can take up to ${Math.round(GPS_LISTEN_MS / 1000)} seconds.`
            : `Looking for a better fix… best so far ±${Math.round(bestSoFar)} m.`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-red-600">
          {error}
        </p>
      )}
      {offerOutside && !pending && (
        <button
          type="button"
          disabled={disabled}
          onClick={capture}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-brand-600 bg-white px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-60"
        >
          <MapPin className="h-4 w-4" />
          Try again outside
        </button>
      )}
      {/* Finding 19: a rougher reading never replaces the point here unasked. */}
      {rougher && gps && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900">
          <p className="font-medium">
            {`The new reading is ±${Math.round(rougher.accuracy ?? 0)} m, rougher than ${currentLabel}${
              gps.isManual ? ' (typed in)' : gps.accuracy != null ? ` (±${Math.round(gps.accuracy)} m)` : ''
            }.`}
          </p>
          {/* Second round: how far apart, so a shop that moved (far) can be told
              from a weak signal (close). Which button leads is unchanged: an
              owner question (see CHANGELOG). */}
          <p className="mt-1" data-testid="gps-rougher-distance">
            {`It is ${distanceWords(distanceMetres(rougher, gps))} from ${currentLabel}.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setRougher(null);
                setError(null);
              }}
              className="min-h-11 rounded-md bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {currentLabel === 'the saved location' ? 'Keep the saved location' : 'Keep the location already here'}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => !disabledRef.current && take(rougher)}
              className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
            >
              {`Use the new reading (±${Math.round(rougher.accuracy ?? 0)} m)`}
            </button>
          </div>
        </div>
      )}
      {canKeepSaved && !rougher && saved && (
        <button
          type="button"
          disabled={disabled}
          onClick={keepSaved}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <Undo2 className="h-4 w-4" />
          {`Go back to the saved location${saved.isManual ? ' (typed in)' : saved.accuracy != null ? ` (±${Math.round(saved.accuracy)} m)` : ''}`}
        </button>
      )}
      {canGoBackFromBetter && !rougher && !pending && saved && gps && !askBack && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabledRef.current && setAskBack(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-700"
        >
          <Undo2 className="h-3 w-3" />
          Wrong place? Go back to the saved location…
        </button>
      )}
      {canGoBackFromBetter && askBack && !rougher && !pending && saved && gps && (
        <div role="alert" className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
          <p className="font-medium" data-testid="gps-back-distance">
            {`The location on the chip is ${distanceWords(distanceMetres(gps, saved))} from ${savedLabel(saved)}. Go back to the saved location?`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setAskBack(false)}
              className="min-h-11 rounded-md bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              Keep the new location
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={keepSaved}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
            >
              {`Go back to ${savedLabel(saved)}`}
            </button>
          </div>
        </div>
      )}
      {/* Finding 19, second round: going back is undone with one more tap. */}
      {replaced && !rougher && !pending && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span>{`The saved location is back. The ${pointLabel(replaced.gps)} you had is not used.`}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={restoreReplaced}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <RotateCcw className="h-4 w-4" />
            {`Undo: use the ${pointLabel(replaced.gps)} again`}
          </button>
        </div>
      )}

      {/* B-07: manual fallback UI. Tertiary trigger always available so a user
          who knows the GPS chip is broken can skip the wait. */}
      {!showManual && (
        <button
          type="button"
          disabled={disabled}
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
          {manualErr && (
            <p role="alert" className="mt-1 text-sm font-medium text-red-600">
              {manualErr}
            </p>
          )}
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
