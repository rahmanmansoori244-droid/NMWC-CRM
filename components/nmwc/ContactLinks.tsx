/**
 * Tap-to-call and map links, the same everywhere they appear (benchmark item 40).
 *
 * No 'use client': server pages render these, and so can client components.
 * Plain <a>, not next/link — typed routes would reject tel: and external hrefs.
 *
 * Two rules the go-live browser walk depends on (tests/e2e/golive-update-flow):
 *   - PhoneLink shows the stored value EXACTLY as its text, with nothing added,
 *     so `getByText('+968…')` still finds it.
 *   - The pin link keeps whatever label the page passes ("Open in Maps",
 *     "View proposed location on map"), and the second link is named only
 *     "Directions", so strict name locators on the old labels stay unique.
 *
 * No customer name in any link's name: Sentry's click breadcrumbs record the
 * clicked element's aria-label, and the scrubber removes phones, not names.
 */
import { MapPin, Navigation, Phone } from 'lucide-react';
import { directionsHref, mapPinHref, telHref } from '@/lib/contact-links';

const PHONE = 'font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800';

/** 44px tall: salesmen tap these one-handed (docs/UX-SPEC.md, 44×44 minimum). */
const CHIP =
  'inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 font-sans text-sm font-medium text-brand-700 hover:bg-brand-50';

export function PhoneLink({ phone }: { phone: string }) {
  const href = telHref(phone);
  if (!href) return <>{phone}</>;
  // No target: target=_blank can leave an empty tab behind on Android.
  return (
    <a href={href} className={PHONE}>
      {phone}
    </a>
  );
}

export function LocationLinks({
  lat,
  lng,
  pinLabel = 'Open in Maps',
}: {
  lat: number | null | undefined;
  lng: number | null | undefined;
  pinLabel?: string;
}) {
  const pin = mapPinHref(lat, lng);
  if (!pin) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={pin} target="_blank" rel="noopener noreferrer" className={CHIP}>
        <MapPin aria-hidden="true" className="h-4 w-4" />
        {pinLabel}
      </a>
      <DirectionsChip lat={lat} lng={lng} />
    </span>
  );
}

/** Turn-by-turn to a point, as a 44px chip. Nothing when the point is not a real one. */
export function DirectionsChip({ lat, lng }: { lat: number | null | undefined; lng: number | null | undefined }) {
  const href = directionsHref(lat, lng);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={CHIP}>
      <Navigation aria-hidden="true" className="h-4 w-4" />
      Directions
    </a>
  );
}

/**
 * Tap-to-call as a 44px chip, for a list row where an inline PhoneLink would be
 * too small a target. Nothing at all when the value cannot be dialled: a row of
 * cards is no place for an unusable number shown as text.
 */
export function CallChip({ phone }: { phone: string | null | undefined }) {
  const href = telHref(phone);
  if (!href) return null;
  return (
    <a href={href} className={CHIP}>
      <Phone aria-hidden="true" className="h-4 w-4" />
      {phone}
    </a>
  );
}
