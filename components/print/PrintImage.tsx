'use client';

/**
 * One photo or document page on a printout, loaded through /api/photos (scope
 * checked, the view recorded).
 *
 * Why it retries: the photo route allows a burst of 60 photos per person, then
 * one a second (NEW-PHOTO-010). A customer form for a chain of shops can hold
 * more than that, and every photo is asked for at once, so the ones past the
 * burst come back 429 — and the Print button refuses to print a form with a
 * hole in it. So a photo that fails is asked for again, a little later each time
 * and at a slightly different moment from its neighbours, until the limit has let
 * it through or it has failed MAX_ATTEMPTS times (then it is "failed" for good:
 * removed, or storage is down).
 *
 * Its state is on the element (data-print-image = loading | loaded | failed),
 * which PrintButton waits on. Read on mount too: a photo that loaded or failed
 * before React hydrated fired its event before anyone listened.
 */
import { useRetryingImage } from '@/components/nmwc/RetryingPhoto';

export function PrintImage({ id, alt, className }: { id: string; alt: string; className?: string }) {
  // The retry (above) is shared with the on-screen photos: components/nmwc/RetryingPhoto.tsx.
  const img = useRetryingImage(`/api/photos/${id}`);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={img.ref}
      src={img.src}
      alt={alt}
      loading="eager"
      data-print-image={img.state}
      className={className}
      onLoad={img.onLoad}
      onError={img.onError}
    />
  );
}
