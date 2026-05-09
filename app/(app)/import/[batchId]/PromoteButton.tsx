'use client';

import { useState, useTransition } from 'react';
import { promoteCustomerBatchAction } from '@/services/imports';

export function PromoteButton({ batchId, cleanCount }: { batchId: string; cleanCount: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onClick() {
    if (
      !confirm(
        `Promote ${cleanCount} clean rows to live customer master? This creates customer + branch records.`
      )
    )
      return;
    const fd = new FormData();
    fd.set('batchId', batchId);
    start(async () => {
      try {
        const res = await promoteCustomerBatchAction(fd);
        setMsg(`✓ Promoted ${(res as { promoted: number }).promoted} rows.`);
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Failed.');
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      {msg && <span className="text-xs font-medium text-emerald-700">{msg}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Promoting…' : `Promote ${cleanCount} clean rows`}
      </button>
    </div>
  );
}
