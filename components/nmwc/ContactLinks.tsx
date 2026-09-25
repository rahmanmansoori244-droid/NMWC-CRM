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
 */
import { MapPin, Navigation } from 'lucide-react';
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
  const directions = directionsHref(lat, lng);
  if (!pin || !directions) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={pin} target="_blank" rel="noopener noreferrer" className={CHIP}>
        <MapPin aria-hidden="true" className="h-4 w-4" />
        {pinLabel}
      </a>
      <a href={directions} target="_blank" rel="noopener noreferrer" className={CHIP}>
        <Navigation aria-hidden="true" className="h-4 w-4" />
        Directions
      </a>
    </span>
  );
}
