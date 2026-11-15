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
import { useEffect, useRef, useState } from 'react';

const MAX_ATTEMPTS = 6;

type LoadState = 'loading' | 'loaded' | 'failed';

export function PrintImage({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const timer = useRef<number | null>(null);

  const failed = () => {
    // One retry at a time: a failure seen both on mount and by a replayed event is one failure.
    if (timer.current !== null) return;
    if (attempt + 1 >= MAX_ATTEMPTS) {
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
  const src = attempt === 0 ? `/api/photos/${id}` : `/api/photos/${id}?attempt=${attempt}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading="eager"
      data-print-image={state}
      className={className}
      onLoad={() => setState('loaded')}
      onError={failed}
    />
  );
}
