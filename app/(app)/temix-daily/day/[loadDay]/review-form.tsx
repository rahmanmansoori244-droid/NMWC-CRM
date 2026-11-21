'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { reviewTemixChangesAction } from '@/services/temix-daily-review';
import { REVIEW_FIELDS } from '@/lib/temix-daily-review';

/** "Reviewed" on one line of the day's ledger, or on every line of the day not marked yet. */
export function TemixDailyReviewButton({ loadDay, changeId, label }: { loadDay: string; changeId?: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    const fd = new FormData();
    fd.set(REVIEW_FIELDS.loadDay, loadDay);
    if (changeId) fd.set(REVIEW_FIELDS.changeId, changeId);
    setError(null);
    start(async () => {
      const res = await reviewTemixChangesAction(fd);
      if (!res.ok) return setError(res.fields ? Object.values(res.fields).join(' ') : res.message);
      router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {pending ? 'Marking…' : (label ?? 'Reviewed')}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
