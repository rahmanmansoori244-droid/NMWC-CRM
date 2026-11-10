'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { acknowledgeShopsNotChangedAction } from '@/services/import-fixes';
import { ROUTE_NOT_APPLIED, SHOP_NOT_CHANGED_MEANING } from '@/lib/import-shop-notice';

/**
 * Code review 2026-11-10, finding 28 (second round): rows a promote of this
 * batch loaded with their shop NOT changed. The notice is rendered by the
 * batch page from the batch itself (ImportBatch.shopNotChangedRows and
 * shopNotChangedAckRows), so it stays — after the refresh that ends a load, a
 * reload, or any later visit — until the Data Steward presses "I have read
 * this". That is stored and audited (acknowledgeShopsNotChangedAction).
 *
 * It used to live inside the Promote button and held the result back until it
 * was acknowledged; the refresh to PROMOTED took the button away, and with it
 * the notice and the result, unseen.
 */
export function ShopsNotChangedNotice({
  batchId,
  rows,
  total,
}: {
  batchId: string;
  /** Rows not yet acknowledged: what the notice counts. */
  rows: number;
  /** The batch's whole count, which the acknowledgement covers up to. */
  total: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function acknowledge() {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set('batchId', batchId);
      fd.set('rows', String(total));
      const res = await acknowledgeShopsNotChangedAction(fd);
      if (!res.ok) {
        setError(res.fields ? Object.values(res.fields).join(' ') : res.message);
        return;
      }
      router.refresh();
    });
  }

  // 'en-US' as everywhere on this page: rendered on the server and again in the browser.
  return (
    <div
      role="alert"
      data-testid="shops-not-changed"
      className="mx-4 mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-300 sm:mx-6"
    >
      <p className="font-semibold">
        {rows.toLocaleString('en-US')} row(s) were loaded, but their shop was NOT changed.
      </p>
      <p className="mt-1">
        {SHOP_NOT_CHANGED_MEANING} Where such a row gives a different route: {ROUTE_NOT_APPLIED}{' '}
        Each row says what was not applied, under &ldquo;Loaded with a warning&rdquo;.
      </p>
      {error && (
        <p role="status" className="mt-2 font-medium text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={acknowledge}
        className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:text-slate-400"
      >
        {pending ? 'Saving…' : 'I have read this'}
      </button>
    </div>
  );
}
