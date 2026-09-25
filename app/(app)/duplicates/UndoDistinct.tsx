'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { undoDismissDuplicateAction } from '@/services/duplicates';

/**
 * The Undo button on a "Marked distinct" row of /duplicates (owner decision
 * 2026-09-25: a dismissal can be undone). It asks first, naming both customers,
 * like "Mark distinct" does; a refusal reads in red, a success in green.
 */
export function UndoDistinct({
  aId,
  bId,
  aLabel,
  bLabel,
}: {
  aId: string;
  bId: string;
  aLabel: string;
  bLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  function undo() {
    if (
      !confirm(
        `Undo "Mark distinct" for "${aLabel}" and "${bLabel}"? The pair goes back on the list of suspected duplicates.`
      )
    )
      return;
    setMsg(null);
    const fd = new FormData();
    fd.set('aId', aId);
    fd.set('bId', bId);
    start(async () => {
      try {
        const res = await undoDismissDuplicateAction(fd);
        if (!res.ok) {
          setMsg({
            text: (res.fields ? Object.values(res.fields).join(' ') : res.message) ?? 'Failed.',
            tone: 'error',
          });
          return;
        }
        setMsg({ text: 'Back on the list.', tone: 'ok' });
        router.refresh();
      } catch (err) {
        setMsg({ text: err instanceof Error ? err.message : 'Failed.', tone: 'error' });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      {msg && (
        <span
          role={msg.tone === 'error' ? 'alert' : 'status'}
          className={msg.tone === 'error' ? 'text-red-700' : 'text-emerald-700'}
        >
          {msg.text}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={undo}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Undo
      </button>
    </div>
  );
}
