'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { approveReactivationAction, rejectReactivationAction } from '@/services/reactivations';

export function ReactivationDecisionForm({ editId }: { editId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function approve() {
    if (!confirm('Reactivate this shop? It goes back to ACTIVE immediately.')) return;
    setErr(null);
    const fd = new FormData();
    fd.set('editId', editId);
    start(async () => {
      try {
        // PROD-006: action returns `{ ok, code, message, fields? }` shape.
        const res = await approveReactivationAction(fd);
        if (!res.ok) {
          setErr(
            res.fields ? Object.values(res.fields).join(' ') : res.message
          );
          return;
        }
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Failed.');
      }
    });
  }

  function reject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const fd = new FormData(e.currentTarget);
    fd.set('editId', editId);
    start(async () => {
      try {
        const res = await rejectReactivationAction(fd);
        if (!res.ok) {
          setErr(
            res.fields ? Object.values(res.fields).join(' ') : res.message
          );
          return;
        }
        router.refresh();
      } catch (er) {
        setErr(er instanceof Error ? er.message : 'Failed.');
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {err && <p className="text-xs font-medium text-red-600">{err}</p>}
      {!showReject ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowReject(true)}
            disabled={pending}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Keep closed
          </button>
          <button
            type="button"
            onClick={approve}
            disabled={pending}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
          >
            {pending ? 'Working…' : '✓ Reactivate'}
          </button>
        </div>
      ) : (
        <form onSubmit={reject} className="flex flex-col items-end gap-2">
          <textarea
            name="reason"
            rows={2}
            minLength={5}
            required
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            placeholder="Why are you keeping it closed?"
            className="block w-64 rounded-md border-slate-300 px-3 py-2 text-xs shadow-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowReject(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || reason.length < 5}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:bg-slate-300"
            >
              {pending ? 'Rejecting…' : 'Keep closed'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
