'use client';

import { useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useDialogFocus } from '@/components/nmwc/useDialogFocus';
import { discardImportBatchAction } from '@/services/import-fixes';

/**
 * Code review 2026-11-10, finding 6: "Discard batch", for the Data Steward only
 * (the page shows it to him alone, and the action refuses everyone else). A
 * staged batch, or one whose promote stopped part-way, is thrown away so it can
 * never be promoted or resumed and leaves the Work list. It asks first, in a
 * dialog that says what happens, and needs a reason (audited).
 */
const MIN_REASON = 5;

export function DiscardBatch({
  batchId,
  waiting,
  loaded,
}: {
  batchId: string;
  /** Rows still waiting to load (CLEAN). */
  waiting: number;
  /** Rows a stopped promote already loaded. */
  loaded: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const titleId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    setReason('');
    setError(null);
  }

  function discard() {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set('batchId', batchId);
      fd.set('reason', reason.trim());
      const res = await discardImportBatchAction(fd);
      if (!res.ok) {
        setError(res.fields ? Object.values(res.fields).join(' ') : res.message);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
      >
        Discard batch
      </button>
      {open && (
        <DiscardDialog
          dialogRef={dialogRef}
          cancelRef={cancelRef}
          onClose={close}
          titleId={titleId}
        >
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Discard this batch?
          </h2>
          <p className="mt-2 text-sm text-slate-700">
            It can then never be promoted or resumed, and it leaves your Work list. Nothing is deleted:{' '}
            {waiting.toLocaleString('en-US')} row(s) still waiting are simply not loaded
            {loaded > 0
              ? `, and the ${loaded.toLocaleString('en-US')} row(s) an earlier promote already loaded stay loaded`
              : ''}
            . To load this sheet later, upload it again.
          </p>
          <label htmlFor={reasonId} className="mt-3 block text-xs font-medium text-slate-700">
            Why is it discarded? ({MIN_REASON}+ characters)
          </label>
          <input
            id={reasonId}
            type="text"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          {error && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-700">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={close}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || reason.trim().length < MIN_REASON}
              onClick={discard}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-slate-300"
            >
              {pending ? 'Discarding…' : 'Discard this batch'}
            </button>
          </div>
        </DiscardDialog>
      )}
    </>
  );
}

function DiscardDialog({
  dialogRef,
  cancelRef,
  onClose,
  titleId,
  children,
}: {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  cancelRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  titleId: string;
  children: React.ReactNode;
}) {
  useDialogFocus(dialogRef, { onClose, initialFocus: cancelRef });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-t-lg bg-white p-5 text-left shadow-xl sm:rounded-lg"
      >
        {children}
      </div>
    </div>
  );
}
