'use client';

/**
 * Large-customer photos, part B: one photo from /api/photos/<id>, loaded
 * through the tab's photo queue (./photo-queue.ts) when it has to be.
 *
 * mode 'direct' (a page with 40 photos or fewer, lib/photo-pacing.ts): the
 * server renders exactly the <img src alt className> the page always had, so
 * its HTML is unchanged. Only if that first load fails (seen at mount, for a
 * failure before hydration, or by onError) does the photo join the queue.
 *
 * mode 'queued' (more than 40): the server renders a placeholder; at mount the
 * photo asks the queue for its turn.
 *
 * Each turn mounts a NEW <img> at the same address: no query string, never
 * loading="lazy", and the src of an <img> is never changed while it loads.
 */
import { useEffect, useRef, useState } from 'react';
import {
  done,
  register,
  reportFirstLoadFailure,
  request,
  unregister,
  type PhotoQueueState,
} from './photo-queue';
import type { PhotoMode } from '@/lib/photo-pacing';

type Phase = 'first' | 'waiting' | 'loading' | 'loaded' | 'failed';

export function RoutePhoto({
  id,
  alt,
  className,
  mode,
  onFailedChange,
}: {
  id: string;
  alt: string;
  className: string;
  mode: PhotoMode;
  /** Told true when the photo is given up ('Not loaded'), false when it waits or loads again. */
  onFailedChange?: (failed: boolean) => void;
}) {
  const src = `/api/photos/${id}`;
  // Fixed for the photo's life: a page that recounts must not swap a loading <img>.
  const [startMode] = useState(mode);
  const [phase, setPhase] = useState<Phase>(startMode === 'direct' ? 'first' : 'waiting');
  const [attempt, setAttempt] = useState(0);
  const keyRef = useRef<number | null>(null);
  const firstImg = useRef<HTMLImageElement>(null);
  const firstSettled = useRef(false);

  useEffect(() => {
    const key = register(
      (n) => {
        setAttempt(n);
        setPhase('loading');
      },
      (s: PhotoQueueState) => {
        if (s === 'waiting' || s === 'failed' || s === 'loaded') setPhase(s);
      }
    );
    keyRef.current = key;
    if (startMode === 'queued') {
      request(key);
    } else {
      // A server-rendered <img> may have loaded or failed before React was
      // there to hear it: an error event fired before hydration is not replayed.
      const img = firstImg.current;
      if (img && !firstSettled.current && img.getAttribute('src') && img.complete) {
        firstSettled.current = true;
        if (img.naturalWidth === 0) reportFirstLoadFailure(key);
        else done(key, true);
      }
    }
    return () => {
      keyRef.current = null;
      unregister(key);
    };
  }, [startMode]);

  const failedRef = useRef(false);
  const onFailedRef = useRef(onFailedChange);
  useEffect(() => {
    onFailedRef.current = onFailedChange;
  });
  useEffect(() => {
    const failed = phase === 'failed';
    if (failed === failedRef.current) return;
    failedRef.current = failed;
    onFailedRef.current?.(failed);
  }, [phase]);

  if (phase === 'first' || (phase === 'loaded' && attempt === 0)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key="first"
        ref={firstImg}
        src={src}
        alt={alt}
        className={className}
        onLoad={() => {
          const key = keyRef.current;
          if (key === null || firstSettled.current) return;
          firstSettled.current = true;
          done(key, true);
        }}
        onError={() => {
          const key = keyRef.current;
          if (key === null || firstSettled.current) return;
          firstSettled.current = true;
          reportFirstLoadFailure(key);
        }}
      />
    );
  }
  if (phase === 'loading' || phase === 'loaded') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={attempt}
        src={src}
        alt={alt}
        className={className}
        loading="eager"
        decoding="async"
        data-photo-state={phase}
        onLoad={() => {
          const key = keyRef.current;
          if (key !== null) done(key, true);
        }}
        onError={() => {
          const key = keyRef.current;
          if (key !== null) done(key, false);
        }}
      />
    );
  }
  if (phase === 'failed') {
    return (
      <span
        role="img"
        aria-label={`${alt}: not loaded`}
        data-photo-state="failed"
        className={`${className} inline-flex items-center justify-center bg-slate-200 text-center`}
      >
        <span className="text-xs text-slate-600">Not loaded</span>
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={`${alt}: loading`}
      data-photo-state="waiting"
      className={`${className} inline-block bg-slate-200 motion-safe:animate-pulse`}
    />
  );
}
