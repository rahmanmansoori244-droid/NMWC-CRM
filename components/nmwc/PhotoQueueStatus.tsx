'use client';

/**
 * Large-customer photos, part B: what the tab's photo queue (./photo-queue.ts)
 * has to say on this page. It renders nothing on the server and nothing until
 * there is something to say, so it can sit on every page that shows photos and
 * leave a small page's HTML unchanged.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getServerSnapshot, getSnapshot, retryFailed, subscribe } from './photo-queue';

export function photosNotLoadedText(n: number): string {
  return n === 1 ? '1 photo did not load.' : `${n} photos did not load.`;
}

export function photosPacedText(loaded: number, total: number): string {
  return `Showing ${loaded} of ${total} photos. The rest load one by one, about one a second.`;
}

export function PhotoQueueStatus() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // The live region exists only in the browser, after hydration, so the
  // server HTML carries nothing of this component.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const showPaced = s.paced && s.pending > 0;
  const showFailed = s.failed > 0 && s.pending === 0;

  // What the live region says: only these three, each once when it becomes true.
  const said = useRef<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const message = showFailed
    ? photosNotLoadedText(s.failed)
    : showPaced
      ? 'Photos are loading one by one.'
      : s.total > 0 && s.pending === 0 && s.failed === 0 && said.current !== null
        ? 'All photos are shown.'
        : null;
  useEffect(() => {
    if (message === null || message === said.current) return;
    said.current = message;
    setAnnounce(message);
  }, [message]);

  if (!mounted) return null;
  const live = (
    <span className="sr-only" aria-live="polite">
      {announce}
    </span>
  );
  return (
    <>
      {live}
      {(showPaced || showFailed) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200 lg:col-span-2">
          {showPaced && <p>{photosPacedText(s.loaded, s.total)}</p>}
          {showFailed && <p>{photosNotLoadedText(s.failed)}</p>}
          {showFailed && (
            <button
              type="button"
              onClick={() => retryFailed()}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </>
  );
}
