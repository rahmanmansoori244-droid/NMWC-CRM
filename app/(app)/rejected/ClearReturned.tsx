'use client';

/**
 * Launch fix: "Nothing to send again" on a request sent back to him. A
 * sent-back update leaves Needs correction only when he sends a later one, and a
 * submit with no change is refused, so one he should NOT send again ("the
 * number on file is right") stayed there for good. Clearing it changes nothing
 * on the request; services/edits.ts clearReturnedEditAction says more.
 *
 * Its own component, as the edit form never imports a server action
 * (tests/unit/submit-wiring-guard.test.ts). A lost answer is retried by tapping
 * again: one already cleared answers ok.
 */
import { useState, useTransition } from 'react';
import { clearReturnedEditAction } from '@/services/edits';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';
import { hardReplace } from '@/lib/navigate';

export function ClearReturned({ editId, then }: { editId: string; then: string }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clear() {
    setConfirming(false);
    setError(null);
    start(async () => {
      try {
        const res = await clearReturnedEditAction({ editId });
        if (!res.ok) {
          setError(res.message);
          return;
        }
        // A document load: Today, Work and this list must not come from the router cache.
        hardReplace(then);
      } catch {
        setError('No answer — we cannot tell if it was cleared. Tap again when you have signal.');
      }
    });
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-1 text-sm font-medium text-red-600">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(true)}
        className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? 'Clearing…' : 'Nothing to send again — clear this'}
      </button>
      <ConfirmModal
        open={confirming}
        title="Clear this from Needs correction?"
        message="Do this when nothing needs sending again, for example when the value on file is already right. Nothing is sent and the customer is not changed. The request stays on record as sent back."
        confirmLabel="Clear it"
        onConfirm={clear}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
