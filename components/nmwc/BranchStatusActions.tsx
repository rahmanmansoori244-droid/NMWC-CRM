'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PhotoCaptureSlot, type AttachedPhoto } from './PhotoCaptureSlot';
import {
  markBranchClosedAction,
  requestReactivationAction,
} from '@/services/reactivations';
import { ValidationError } from '@/lib/errors';

/**
 * Branch-level status actions: "Mark closed" (when ACTIVE) or
 * "Request reactivation" (when CLOSED). Both require a fresh photo + reason
 * and produce a CustomerEdit for review.
 */
export function BranchStatusActions({
  branchId,
  status,
}: {
  branchId: string;
  status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED';
}) {
  const router = useRouter();
  const [open, setOpen] = useState<'close' | 'reactivate' | null>(null);
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<AttachedPhoto | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const isClosed = status === 'CLOSED';
  const action = open;
  const ready = !!photo && reason.length >= 5;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (!photo) {
      setErr('Capture a photo first.');
      return;
    }
    const fd = new FormData();
    fd.set('branchId', branchId);
    fd.set('reason', reason);
    fd.set('attachmentId', photo.attachmentId);
    start(async () => {
      try {
        if (action === 'close') {
          await markBranchClosedAction(fd);
        } else if (action === 'reactivate') {
          await requestReactivationAction(fd);
        }
        setOpen(null);
        setReason('');
        setPhoto(null);
        router.refresh();
      } catch (e) {
        if (e instanceof ValidationError && e.fields) {
          setErr(Object.values(e.fields).join(' '));
        } else {
          setErr(e instanceof Error ? e.message : 'Failed.');
        }
      }
    });
  }

  if (open === null) {
    return (
      <div className="flex flex-wrap gap-2">
        {isClosed ? (
          <button
            type="button"
            onClick={() => setOpen('reactivate')}
            className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
          >
            Request reactivation
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen('close')}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
          >
            Mark closed
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
    >
      <h4 className="text-sm font-semibold text-slate-900">
        {action === 'close' ? 'Mark this branch closed' : 'Reactivate this branch'}
      </h4>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">
          Photo evidence (must be fresh — captured today)
        </label>
        <div className="w-40">
          <PhotoCaptureSlot
            kind="FREE"
            required
            onChange={setPhoto}
            attachTo={{ kind: 'branch', branchId, slot: 'FREE' }}
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">
          Reason (5+ chars)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          rows={2}
          minLength={5}
          required
          placeholder={
            action === 'close'
              ? 'Shop is permanently closed, signage removed.'
              : 'Shop has reopened under same owner.'
          }
          className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
        />
      </div>
      {err && <p className="text-xs font-medium text-red-600">{err}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(null);
            setReason('');
            setPhoto(null);
            setErr(null);
          }}
          disabled={pending}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !ready}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:bg-slate-300 ${
            action === 'close'
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
        >
          {pending
            ? 'Submitting…'
            : action === 'close'
              ? 'Submit closure'
              : 'Request reactivation'}
        </button>
      </div>
    </form>
  );
}
