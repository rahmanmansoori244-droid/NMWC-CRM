'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { mergeCustomersAction, dismissDuplicateAction } from '@/services/duplicates';

export function MergeForm({
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
  const [msg, setMsg] = useState<string | null>(null);

  function merge(winnerId: string, loserId: string) {
    if (
      !confirm(
        `Merge: keep "${winnerId === aId ? aLabel : bLabel}" and absorb "${winnerId === aId ? bLabel : aLabel}". The loser will be soft-deleted and its branches reassigned.`
      )
    )
      return;
    setMsg(null);
    const fd = new FormData();
    fd.set('winnerId', winnerId);
    fd.set('loserId', loserId);
    start(async () => {
      try {
        // PROD-006: action returns `{ ok, code, message, fields? }` shape.
        // Cross-region merge prompts (ValidationError on `_form` / `reason`)
        // must surface verbatim — they tell the steward exactly what's
        // wrong (confirmCrossRegion missing, reason too short).
        const res = await mergeCustomersAction(fd);
        if (!res.ok) {
          setMsg(
            res.fields
              ? Object.values(res.fields).join(' ')
              : res.message
          );
          return;
        }
        setMsg('✓ Merged.');
        router.refresh();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed.');
      }
    });
  }

  function dismiss() {
    setMsg(null);
    const fd = new FormData();
    fd.set('aId', aId);
    fd.set('bId', bId);
    start(async () => {
      try {
        const res = await dismissDuplicateAction(fd);
        if (!res.ok) {
          setMsg(
            res.fields
              ? Object.values(res.fields).join(' ')
              : res.message
          );
          return;
        }
        setMsg('Marked as distinct.');
        router.refresh();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed.');
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      {msg && <span className="text-emerald-700">{msg}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={dismiss}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Mark distinct
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => merge(aId, bId)}
        className="rounded-md bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
      >
        Keep ← {aLabel.split(' (')[0].slice(0, 24)}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => merge(bId, aId)}
        className="rounded-md bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
      >
        Keep → {bLabel.split(' (')[0].slice(0, 24)}
      </button>
    </div>
  );
}
