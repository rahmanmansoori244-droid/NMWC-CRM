'use client';

import type { SubmitNotice } from '@/lib/submit-client';

/**
 * Benchmark item 22: what happened to a submit, said beside the button the
 * salesman's thumb is on — not in a bar at the top of a long form. A failure is
 * an alert with Try again when retrying can help; an "Already received" or a
 * "Submitted" is a status, in green, because it is the good news.
 *
 * Both live regions stay mounted and only their text changes: a region that
 * appears already filled in is often not read out (VoiceOver especially). The
 * text is small and short — it sits in the sticky bar on a 320 px phone.
 */
export function SubmitNoticeBox({
  notice,
  onRetry,
  busy,
}: {
  notice: SubmitNotice | null;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const failed = notice?.tone === 'failed' ? notice : null;
  const received = notice?.tone === 'received' ? notice : null;
  // One wrapper, no gap of its own: empty, it takes no space in a flex column;
  // filled, the notice brings its own margin below.
  return (
    <div>
      <div role="alert">
        {failed && (
          <div className="mb-3 flex flex-col gap-2 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800 ring-1 ring-red-200 sm:flex-row sm:items-center sm:justify-between">
            <p>{failed.text}</p>
            {failed.retry && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="min-h-11 shrink-0 rounded-md bg-red-700 px-4 py-2 text-base font-semibold text-white hover:bg-red-800 disabled:bg-slate-400"
              >
                {busy ? 'Trying…' : 'Try again'}
              </button>
            )}
          </div>
        )}
      </div>
      <div role="status">
        {received && (
          <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
            {received.text}
          </p>
        )}
      </div>
    </div>
  );
}
