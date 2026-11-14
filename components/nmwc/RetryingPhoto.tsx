'use client';

/**
 * A photo loaded through /api/photos that is asked for again when it fails.
 *
 * Why it retries: the photo route allows a burst of 60 photos per person, then
 * one a second (NEW-PHOTO-010, app/api/photos/[id]/route.ts). A page that asks for
 * more than that at once gets 429 for the ones past the burst, and they showed
 * as broken images. So a photo that fails is asked for again, a little later each
 * time and at a slightly different moment from its neighbours, until the limit
 * has let it through or it has failed MAX_ATTEMPTS times (then it is "failed"
 * for good: removed, or storage is down). components/print/PrintImage.tsx (the
 * printout, which must not print with a hole) has used this since the print
 * form; H8 (bug hunt round 2, F6) shares it with the customer profile and the
 * photo slots of the forms, which load lazily as well (RetryingPhoto below).
 *
 * The state is also read on mount: a photo that loaded or failed before React
 * hydrated fired its event before anyone listened.
 */
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';

export const MAX_PHOTO_ATTEMPTS = 6;

export type PhotoLoadState = 'loading' | 'loaded' | 'failed';

export function useRetryingImage(src: string) {
  const ref = useRef<HTMLImageElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PhotoLoadState>('loading');
  const timer = useRef<number | null>(null);

  const failed = () => {
    // One retry at a time: a failure seen both on mount and by a replayed event is one failure.
    if (timer.current !== null) return;
    if (attempt + 1 >= MAX_PHOTO_ATTEMPTS) {
      setState('failed');
      return;
    }
    // 1.5 s, 3 s, 6 s … plus up to 3 s of spread, so the retries do not arrive as one burst again.
    const wait = 1500 * 2 ** attempt + Math.floor(Math.random() * 3000);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setAttempt((a) => a + 1);
    }, wait);
  };

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && state === 'loading') {
      if (img.naturalWidth > 0) setState('loaded');
      else failed();
    }
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
    // Mount only: later loads and failures arrive through onLoad / onError.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A retry is a new address (the route ignores the query), so the browser asks again.
  const current =
    attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}attempt=${attempt}`;
  return { ref, src: current, state, onLoad: () => setState('loaded'), onError: failed };
}

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onLoad' | 'onError' | 'ref'> & {
  src: string;
  alt: string;
};

/**
 * H8: an on-screen photo (the customer profile, a form's photo slot). Lazy, so a
 * chain customer with dozens of photographed shops asks only for the ones on
 * screen; and retried as above, so one past the burst still arrives. Give it a
 * `key` of its src where the src can change, so a new photo starts afresh.
 */
export function RetryingPhoto({ src, alt, loading = 'lazy', decoding = 'async', ...rest }: Props) {
  const img = useRetryingImage(src);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...rest}
      ref={img.ref}
      src={img.src}
      alt={alt}
      loading={loading}
      decoding={decoding}
      onLoad={img.onLoad}
      onError={img.onError}
    />
  );
}
