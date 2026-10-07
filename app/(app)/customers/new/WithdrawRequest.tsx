'use client';

/**
 * Launch fix: the salesman withdraws his own new-customer request — a draft he
 * abandoned, or one sent back to him that he will not correct. An open request
 * blocks its CR number and its shop for every salesman, and nothing could end
 * one (services/creates.ts withdrawCreateAction says more).
 *
 * Its own component, beside the form rather than in it: CreateCustomerForm
 * submits over postForm and never imports a server action
 * (tests/unit/submit-wiring-guard.test.ts). This is a one-off decision, not a
 * field submit: a lost answer is retried by tapping again, and a request
 * already withdrawn answers ok.
 */
import { useState, useTransition } from 'react';
import { withdrawCreateAction } from '@/services/creates';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';
import { hardReplace } from '@/lib/navigate';

export function WithdrawRequest({ editId, isDraft }: { editId: string; isDraft: boolean }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function withdraw() {
    setConfirming(false);
    setError(null);
    start(async () => {
      try {
        const res = await withdrawCreateAction({ editId });
        if (!res.ok) {
          setError(res.message);
          return;
        }
        // A document load: Work must not show it from the router cache.
        hardReplace('/work');
      } catch {
        setError('No answer — we cannot tell if it was withdrawn. Tap again when you have signal.');
      }
    });
  }

  return (
    <div className="px-4 pb-6 sm:px-6">
      {error && <p className="mb-2 text-sm font-medium text-red-600">{error}</p>}
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(true)}
        className="min-h-11 rounded-md border border-red-300 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
      >
        {pending ? 'Withdrawing…' : isDraft ? 'Discard this draft' : 'Withdraw this request'}
      </button>
      <p className="mt-1 text-xs text-slate-500">
        For a shop you will not add after all. It frees the CR number and the shop for anyone to add.
      </p>
      <ConfirmModal
        open={confirming}
        title={isDraft ? 'Discard this draft?' : 'Withdraw this request?'}
        message="It is closed for good and cannot be sent again. Its CR number and shop are free for a new request."
        confirmLabel={isDraft ? 'Discard draft' : 'Withdraw request'}
        confirmTone="danger"
        onConfirm={withdraw}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
