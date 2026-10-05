/**
 * The owner's GPS accuracy standard (decided 2026-10-05, launch-readiness review):
 * capture within ±30 m, approve within ±100 m.
 *
 * - ±30 m or better is the target: the chip is green.
 * - Over 30 m and up to 100 m is acceptable but worth another try outdoors:
 *   the chip is amber and says so.
 * - Over 100 m is refused at submit for a CAPTURED point (the salesman recaptures,
 *   or types the location in with a reason, which the manager sees flagged).
 *   A typed point carries no accuracy and is judged by the manager instead.
 *
 * Only the submit gates enforce it (services/edits.ts for an update,
 * lib/validation/create.ts collectMissingForCreate for a new customer): a draft
 * may hold a poor fix, and an approval is never refused on it. The approval page
 * shows the band so the manager applies the ±100 m rule to anything older.
 */
export const GPS_TARGET_ACCURACY_M = 30;
export const GPS_MAX_ACCURACY_M = 100;

export type GpsAccuracyBand = 'good' | 'fair' | 'poor' | 'unknown';

export function gpsAccuracyBand(accuracy: number | null | undefined): GpsAccuracyBand {
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0) return 'unknown';
  // Judged on the whole metres every screen shows, so a ±100.3 m reading that
  // reads "±100 m" is not called "over 100 m".
  const m = Math.round(accuracy);
  if (m <= GPS_TARGET_ACCURACY_M) return 'good';
  if (m <= GPS_MAX_ACCURACY_M) return 'fair';
  return 'poor';
}

/** Whether a submitted point breaks the ±100 m rule: captured (not typed) and over the limit. */
export function isGpsTooInaccurate(accuracy: unknown, typedReason: unknown): boolean {
  const typed = typeof typedReason === 'string' && typedReason.trim().length > 0;
  return !typed && typeof accuracy === 'number' && gpsAccuracyBand(accuracy) === 'poor';
}

export function gpsTooInaccurateMessage(tag: string, accuracy: number): string {
  return `${tag}: the GPS reading is ±${Math.round(accuracy)} m, over the ${GPS_MAX_ACCURACY_M} m limit. Step outside and recapture, or enter the location by hand with a reason.`;
}

/**
 * The chip's advice under the reading, or null when there is nothing to say.
 * `gated`: the reading was just captured by someone the submit gate holds to
 * the rule (a salesman). Only then is a poor reading called unsubmittable; a
 * point loaded from file, or a Manager's capture, gets advice, not a refusal.
 */
export function gpsAccuracyAdvice(accuracy: number | null | undefined, gated = true): string | null {
  switch (gpsAccuracyBand(accuracy)) {
    case 'fair':
      return `Aim for ±${GPS_TARGET_ACCURACY_M} m or better: step outside and recapture if you can.`;
    case 'poor':
      return gated
        ? `Over ±${GPS_MAX_ACCURACY_M} m: this cannot be submitted. Step outside and recapture, or enter the location by hand with a reason.`
        : `Over ±${GPS_MAX_ACCURACY_M} m, the standard's limit. Recapture it outdoors at the shop if you can.`;
    default:
      return null;
  }
}
