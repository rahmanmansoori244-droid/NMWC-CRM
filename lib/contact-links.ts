/**
 * The URLs behind tap-to-call and the map links (benchmark item 40).
 *
 * Built in one place so no page hand-writes a google.com/maps string again: the
 * app had two hand-built copies of the pin link, and no Directions link or tel:
 * link anywhere, though docs/UX-SPEC.md asks for tap-to-call wherever a phone is
 * shown.
 *
 * No JSX and no classes here: components/nmwc/ContactLinks.tsx renders these.
 */
import { normalizePhone } from '@/lib/phone';

/**
 * tel: link for a stored phone, normalised to E.164 so the dialer always gets
 * +968XXXXXXXX. A value that is not one valid Oman number gives null, and the
 * caller shows it as plain text rather than dialling something wrong.
 */
export function telHref(raw: string | null | undefined): string | null {
  const e164 = normalizePhone(raw);
  return e164 ? `tel:${e164}` : null;
}

function isPoint(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return (
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/** A pin on the map: what every "Open in Maps" link has always opened. */
export function mapPinHref(lat: number | null | undefined, lng: number | null | undefined): string | null {
  return isPoint(lat, lng) ? `https://www.google.com/maps?q=${lat!.toFixed(6)},${lng!.toFixed(6)}` : null;
}

/**
 * Turn-by-turn from wherever the phone is now (Google Maps URLs API; no key).
 * On Android it opens the Maps app straight into navigation.
 */
export function directionsHref(lat: number | null | undefined, lng: number | null | undefined): string | null {
  return isPoint(lat, lng)
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat!.toFixed(6)},${lng!.toFixed(6)}`
    : null;
}
