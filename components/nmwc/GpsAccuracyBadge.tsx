import { GPS_MAX_ACCURACY_M, GPS_TARGET_ACCURACY_M, gpsAccuracyBand } from '@/lib/gps-accuracy';

/**
 * The owner's GPS standard on the approval page (lib/gps-accuracy.ts): within
 * ±30 m is the target, up to ±100 m is acceptable, beyond that the approver
 * rejects unless the salesman's reason explains it. A reading with no accuracy
 * (typed in, or imported) shows nothing here; a typed point has its own note.
 */
export function GpsAccuracyBadge({
  accuracy,
  onFile = false,
}: {
  accuracy: number | null | undefined;
  /**
   * The point already on the customer, not one this request proposes: it states
   * the band and gives no reject instruction, because the request may not touch
   * the location at all, or may be the recapture that fixes it.
   */
  onFile?: boolean;
}) {
  const band = gpsAccuracyBand(accuracy);
  if (band === 'unknown') return null;
  const m = Math.round(accuracy as number);
  const text =
    band === 'good'
      ? `±${m} m: within the ${GPS_TARGET_ACCURACY_M} m target`
      : band === 'fair'
        ? `±${m} m: acceptable, above the ${GPS_TARGET_ACCURACY_M} m target`
        : onFile
          ? `±${m} m: over the ${GPS_MAX_ACCURACY_M} m limit (the point on file; a recapture at the shop fixes it)`
          : `±${m} m: over the ${GPS_MAX_ACCURACY_M} m limit. Reject unless the reason explains it.`;
  const tone =
    band === 'good'
      ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
      : band === 'fair'
        ? 'bg-amber-50 text-amber-800 ring-amber-200'
        : 'bg-red-50 text-red-800 ring-red-200';
  return (
    <span
      data-accuracy-band={band}
      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${tone}`}
    >
      {text}
    </span>
  );
}
