'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PhotoCaptureSlot, type AttachedPhoto } from './PhotoCaptureSlot';
import { postForm, noticeFor, SubmissionIds, type SubmitNotice } from '@/lib/submit-client';
import type { SubmitReceipt } from '@/lib/submission';
import { SubmitNoticeBox } from './SubmitNoticeBox';

/**
 * Branch-level status actions: "Mark closed" (when ACTIVE) or
 * "Request reactivation" (when CLOSED). Both require a fresh photo + reason
 * and produce a CustomerEdit for review.
 */
export function BranchStatusActions({
  branchId,
  status,
  blocked,
}: {
  branchId: string;
  status: 'ACTIVE' | 'CLOSED' | 'SUSPENDED';
  /**
   * Why nothing can be sent from here (a switched-off route): said in place of
   * the buttons, so he does not fill the form and upload the evidence photo
   * only to be refused at Submit (launch review).
   */
  blocked?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<'close' | 'reactivate' | null>(null);
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<AttachedPhoto | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Item 22: what is known after a submit, and the ids that make a retry safe
  // (one per component, so a retry of the same request reuses its id).
  const [notice, setNotice] = useState<SubmitNotice | null>(null);
  const idsRef = useRef<SubmissionIds | null>(null);
  // After a request is in, the form closes and this says so (there was no
  // confirmation at all: the salesman saw the form vanish, nothing else).
  const [sent, setSent] = useState<string | null>(null);

  const isClosed = status === 'CLOSED';
  const action = open;
  // Trimmed, as the server counts it: five spaces enabled Submit, and the
  // server then refused "Tell us why (5+ chars)."
  const trimmedReason = reason.trim();
  const ready = !!photo && trimmedReason.length >= 5;

  function submit(e?: React.FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    setErr(null);
    // The notice stays while this try is in flight — its Try again reads
    // "Trying…" — and the outcome below replaces it.
    if (!photo) {
      setErr('Capture a photo first.');
      return;
    }
    if (action === null) return;
    const body = { branchId, reason: trimmedReason, attachmentId: photo.attachmentId };
    idsRef.current ??= new SubmissionIds();
    // The same request after no answer keeps its id, so a retry is never written twice.
    const submissionId = idsRef.current.idFor({ action, ...body });
    start(async () => {
      // Item 22: over fetch, not the server action (lib/submit-client.ts). The
      // answer is the action's `{ ok, code, message, fields? }` (PROD-006):
      // photo-evidence errors (capturedAt before lastStatusChangeAt, >24h old,
      // wrong branch) must reach the salesman so they take a fresh photo.
      const outcome = await postForm<SubmitReceipt>(
        action === 'close' ? 'branch-close' : 'branch-reactivate',
        { ...body, submissionId }
      );
      const ids = idsRef.current!;
      ids.settle(outcome);
      const said = noticeFor(outcome, { doubt: ids.doubt });
      if (outcome.kind !== 'answered' || !outcome.result.ok || said?.tone === 'failed') {
        // No answer, a refusal, or "it arrived, and was sent back since":
        // kept in view with the form.
        setNotice(said);
        if (outcome.kind === 'answered' && !outcome.result.ok && outcome.result.fields) {
          setErr(Object.values(outcome.result.fields).join(' '));
        }
        return;
      }
      setNotice(null);
      setOpen(null);
      setReason('');
      setPhoto(null);
      // A first-time success, or a retry that finds its request already in.
      setSent(
        said?.text ??
          (action === 'close'
            ? '✓ Closure sent for approval.'
            : '✓ Reactivation request sent for approval.')
      );
      router.refresh();
    });
  }

  return (
    <div>
      {/* Mounted throughout (and never display:none), so the confirmation is
          read out when it appears; empty, it takes no space. */}
      <p role="status" className={`text-sm font-medium text-emerald-700 ${sent ? 'mb-2' : ''}`}>
        {sent ?? ''}
      </p>
      {blocked ? (
        <p className="text-sm text-amber-800">{blocked}</p>
      ) : open === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {isClosed ? (
            <button
              type="button"
              onClick={() => {
                setSent(null);
                setOpen('reactivate');
              }}
              className="rounded-md border border-emerald-300 bg-white px-3 py-2.5 text-base font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              Request reactivation
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSent(null);
                setOpen('close');
              }}
              className="rounded-md border border-red-300 bg-white px-3 py-2.5 text-base font-semibold text-red-700 hover:bg-red-50"
            >
              Mark closed
            </button>
          )}
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-base"
        >
          <h4 className="text-base font-semibold text-slate-900">
            {action === 'close' ? 'Mark this branch closed' : 'Reactivate this branch'}
          </h4>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Photo evidence (must be fresh — captured today)
            </label>
            <div className="w-40">
              {/* On no slot: the photo goes onto the branch with the request,
                  in its transaction (services/reactivations.ts wireEvidence).
                  Attached at upload, it stayed on the live branch after a
                  Cancel or a refused submit. `initial`: a photo that finished
                  uploading after a Cancel is shown, since Submit would send it. */}
              <PhotoCaptureSlot kind="FREE" required initial={photo} onChange={setPhoto} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
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
              className="block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm"
            />
          </div>
          <div>
            {err && <p className="mb-3 text-sm font-medium text-red-600">{err}</p>}
            <SubmitNoticeBox notice={notice} busy={pending} onRetry={() => submit()} />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(null);
                setReason('');
                setPhoto(null);
                setErr(null);
                setNotice(null);
              }}
              disabled={pending}
              className="rounded-md border border-slate-300 px-3 py-2.5 text-base font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !ready}
              className={`rounded-md px-3 py-2.5 text-base font-semibold text-white disabled:bg-slate-300 ${
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
      )}
    </div>
  );
}
