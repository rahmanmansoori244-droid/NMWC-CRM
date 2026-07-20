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
  // When the action reports a cross-region merge, we remember which direction was
  // chosen and reveal a reason input so the steward can confirm — without this the
  // cross-region merge was a permanent dead-end (SR-UI-01).
  const [crossRegion, setCrossRegion] = useState<{ winnerId: string; loserId: string } | null>(null);
  const [reason, setReason] = useState('');

  function merge(winnerId: string, loserId: string, opts?: { confirmCrossRegion: boolean; reason: string }) {
    if (
      !opts &&
      !confirm(
        `Merge: keep "${winnerId === aId ? aLabel : bLabel}" and absorb "${winnerId === aId ? bLabel : aLabel}". The loser will be soft-deleted and its branches reassigned.`
      )
    )
      return;
    setMsg(null);
    const fd = new FormData();
    fd.set('winnerId', winnerId);
    fd.set('loserId', loserId);
    if (opts?.confirmCrossRegion) {
      fd.set('confirmCrossRegion', 'yes');
      fd.set('reason', opts.reason);
    }
    start(async () => {
      try {
        const res = await mergeCustomersAction(fd);
        if (!res.ok) {
          const text = res.fields ? Object.values(res.fields).join(' ') : res.message;
          // A cross-region merge needs an explicit confirmation + reason — reveal
          // the reason input and remember the chosen direction instead of leaving
          // the steward stuck on an un-actionable error naming a raw parameter.
          if (!opts && /cross-region/i.test(text ?? '')) {
            setCrossRegion({ winnerId, loserId });
            setMsg('This is a cross-region merge. Enter a reason and confirm below.');
          } else {
            setMsg(text);
          }
          return;
        }
        setCrossRegion(null);
        setReason('');
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
      {msg && <span className={crossRegion ? 'text-amber-700' : 'text-emerald-700'}>{msg}</span>}
      {crossRegion && (
        <div className="flex w-full flex-wrap items-center justify-end gap-2 rounded-md bg-amber-50 p-2 ring-1 ring-amber-200">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for cross-region merge (5+ chars)"
            className="min-w-[220px] flex-1 rounded-md border border-amber-300 px-2 py-1.5 text-slate-800"
          />
          <button
            type="button"
            disabled={pending || reason.trim().length < 5}
            onClick={() => merge(crossRegion.winnerId, crossRegion.loserId, { confirmCrossRegion: true, reason: reason.trim() })}
            className="rounded-md bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700 disabled:bg-slate-300"
          >
            Confirm cross-region merge
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => { setCrossRegion(null); setReason(''); setMsg(null); }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      )}
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
