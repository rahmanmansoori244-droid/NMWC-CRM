/**
 * Benchmark item 41: a GPS point the salesman TYPED IN, because the phone could
 * not get a fix, used to be indistinguishable from a device fix by the time an
 * approver saw it. GpsCaptureButton collected the flag and a reason; both forms
 * dropped them, zod would have stripped them, and nothing stored them.
 *
 * Owner decision (2026-09-25), option A: keep the flag INSIDE the change request
 * (CustomerEdit.fieldChanges), with no migration. Accepted consequences: the
 * salesman's reason is copied into the APPROVE audit row (AuditLog.after), and
 * once the change is approved the live Branch does not say its point was typed.
 *
 * One definition, used by the services that write it and the pages that read it:
 *
 *   UPDATE — the branch's EXISTING gps entries (`branch.<id>.gpsLat` etc.) carry
 *   `gpsSource: 'MANUAL'` and the reason. No new element: every reader of
 *   fieldChanges reads only field/before/after, so no count moves and nothing
 *   that applies or reports the changes has to learn a new key.
 *
 *   CREATE — fieldChanges is otherwise empty, so each typed branch gets one
 *   element `draft.<index>.gps` holding its point. It is matched back to its
 *   draft by COORDINATES, not by id or index: drafts are deleted and recreated on
 *   every save, so ids change, and the readers do not agree on draft order.
 *
 * Anything without the marker means "not known to be typed" — older rows were
 * never marked, so absence is not proof of a device fix.
 */
import { z } from 'zod';

export const GPS_SOURCE_MANUAL = 'MANUAL' as const;
const CREATE_MARKER = /^draft\.\d+\.gps$/;
const GPS_FIELD = /^branch\.[^.]+\.(gpsLat|gpsLng|gpsAccuracy|gpsCapturedAt)$/;

export type FieldChange = {
  field: string;
  before: unknown;
  after: unknown;
  gpsSource?: typeof GPS_SOURCE_MANUAL;
  gpsManualReason?: string;
};

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').trim();

/**
 * The reason, as it will be stored — and copied into an audit row that is never
 * erased. HTML stripped before the length check, so '<b></b>' is not 7 characters.
 */
export const gpsManualReasonSchema = z
  .string()
  .max(2000)
  .transform(stripHtml)
  .pipe(
    z
      .string()
      .min(5, 'Say why GPS did not work (at least 5 characters).')
      .max(500, 'Keep the reason under 500 characters.')
  );

/**
 * UPDATE, before the diff: takes the reason off a branch payload (it is not a
 * Branch column) and returns it ONLY when the typed point actually moves — either
 * coordinate. Then the payload's accuracy is cleared: a typed point has none, and
 * the previous fix's ±N m must not stay beside coordinates it never described.
 * A reason with an unmoved point returns null and changes nothing else.
 */
export function takeManualGpsReason(
  live: { gpsLat: number | null; gpsLng: number | null },
  payload: Record<string, unknown>
): string | null {
  const reason = typeof payload.gpsManualReason === 'string' ? payload.gpsManualReason : null;
  delete payload.gpsManualReason;
  const moves =
    (payload.gpsLat !== undefined && payload.gpsLat !== live.gpsLat) ||
    (payload.gpsLng !== undefined && payload.gpsLng !== live.gpsLng);
  if (!reason || !moves) return null;
  payload.gpsAccuracy = null;
  return reason;
}

/** UPDATE: mark this branch's gps entries (already built by diffFields) as typed. */
export function markManualGps(branchChanges: FieldChange[], reason: string): void {
  for (const c of branchChanges) {
    if (GPS_FIELD.test(c.field)) {
      c.gpsSource = GPS_SOURCE_MANUAL;
      c.gpsManualReason = reason;
    }
  }
}

/** CREATE: the marker element for draft branch `index`. */
export function manualGpsMarker(index: number, lat: number, lng: number, reason: string): FieldChange {
  return {
    field: `draft.${index}.gps`,
    before: null,
    after: { lat, lng },
    gpsSource: GPS_SOURCE_MANUAL,
    gpsManualReason: reason,
  };
}

// Read side: fieldChanges is unvalidated JSON, so every read is defensive.
const entrySchema = z.object({
  field: z.string(),
  after: z.unknown(),
  gpsSource: z.literal(GPS_SOURCE_MANUAL),
  gpsManualReason: z.string(),
});
const pointSchema = z.object({ lat: z.number(), lng: z.number() });

function manualEntries(changes: unknown) {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((c) => {
    const e = entrySchema.safeParse(c);
    return e.success ? [e.data] : [];
  });
}

/** UPDATE: the reason, when this branch's proposed point was typed in. */
export function manualGpsReasonForBranch(changes: unknown, branchId: string): string | null {
  const hit = manualEntries(changes).find(
    (e) => e.field === `branch.${branchId}.gpsLat` || e.field === `branch.${branchId}.gpsLng`
  );
  return hit?.gpsManualReason ?? null;
}

/** CREATE: the reason, when a draft branch at exactly this point was typed in. */
export function manualGpsReasonForPoint(
  changes: unknown,
  lat: number | null | undefined,
  lng: number | null | undefined
): string | null {
  if (lat == null || lng == null) return null;
  const hit = manualEntries(changes).find((e) => {
    if (!CREATE_MARKER.test(e.field)) return false;
    const p = pointSchema.safeParse(e.after);
    return p.success && p.data.lat === lat && p.data.lng === lng;
  });
  return hit?.gpsManualReason ?? null;
}

/** Does the request contain any typed point? (queue pill) */
export function hasManualGps(changes: unknown): boolean {
  return manualEntries(changes).length > 0;
}

/** Entries that are real field changes — what "N change(s)" should count. */
export function countFieldChanges(changes: unknown): number {
  if (!Array.isArray(changes)) return 0;
  return changes.filter(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as { field?: unknown }).field === 'string' &&
      /^(customer|branch)\./.test((c as { field: string }).field)
  ).length;
}
