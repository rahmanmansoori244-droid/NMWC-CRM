'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';
import {
  generateTemixBatchAction,
  downloadTemixBatchAction,
  markTemixBatchLoadedAction,
  type TemixBatchResult,
} from '@/services/temix';

/** Decode the action's base64 payload into a browser download (same pattern as the filtered customer export). */
function triggerDownload(result: TemixBatchResult) {
  const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function GenerateBatchButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function generate() {
    setConfirming(false);
    setError(null);
    start(async () => {
      const res = await generateTemixBatchAction();
      if (!res.ok) {
        setError(res.message);
        return;
      }
      triggerDownload(res.data);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => setConfirming(true)}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        title={disabled ? 'Nothing is pending for Temix upload' : ''}
      >
        {pending ? 'Generating…' : '⬇ Generate upload file'}
      </button>
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
      <ConfirmModal
        open={confirming}
        title="Generate Temix upload batch?"
        message="Every queued customer (pending upload + pending deactivation) is snapshotted into a new batch and flips to “uploaded”. You can re-download the sheet from the batch history at any time."
        confirmLabel="Generate & download"
        confirmTone="primary"
        onConfirm={generate}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

export function BatchRowActions({ batchId, loaded }: { batchId: string; loaded: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function download() {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set('batchId', batchId);
      const res = await downloadTemixBatchAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      triggerDownload(res.data);
    });
  }

  function markLoaded() {
    setConfirming(false);
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set('batchId', batchId);
      const res = await markTemixBatchLoadedAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-xs font-medium text-red-600">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={download}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        Download
      </button>
      {!loaded && (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          Mark loaded
        </button>
      )}
      <ConfirmModal
        open={confirming}
        title="Confirm this batch is loaded into Temix?"
        message="Records the confirmation and settles this batch's deactivation rows. Live customers stay “uploaded” until the next Temix master refresh returns their codes."
        confirmLabel="Yes, it is loaded"
        confirmTone="primary"
        onConfirm={markLoaded}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
