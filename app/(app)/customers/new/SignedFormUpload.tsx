'use client';

/**
 * Owner decisions 2026-10-11 — the salesman's signed-application step: after the
 * Sales Director approves a credit request, his supervisor (or anyone allowed to
 * print) prints the credit application, he has the customer sign it and stamp it
 * with the company stamp, and uploads a photo of every page here. "Send signed
 * application" moves the request on to the Finance Manager
 * (services/signed-form.ts).
 *
 * Its own component, above the read-only request, so the new-customer form is
 * untouched. It submits over postForm like every field form (item 22): a lost
 * answer is retried with the same pages and the same decision token, and the
 * server answers a retry whose first try landed as landed — the token is its
 * replay key. The pages are new uploads of kind CREDIT_FORM, on no record until
 * he sends them, so a wrong one is simply taken off the list; pages kept from an
 * upload the Finance Manager sent back are shown, and one he takes off is
 * released when he sends.
 */
import { useRef, useState, useTransition } from 'react';
import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';
import { SubmitNoticeBox } from '@/components/nmwc/SubmitNoticeBox';
import { noticeFor, postForm, type SubmitNotice } from '@/lib/submit-client';
import { hardReplace } from '@/lib/navigate';
import { MAX_SIGNED_FORM_PAGES } from '@/lib/credit-documents';

export function SignedFormUpload({
  editId,
  decisionToken,
  keptPageIds,
  dueText,
  overdue,
  sentBackReason,
}: {
  editId: string;
  /** N01: the request as this page rendered it (lib/decision-token.ts). */
  decisionToken: string;
  /** Pages of an earlier upload still on file (after a Finance Manager send-back). */
  keptPageIds: string[];
  /** The due time, Oman clock, as the server formatted it. */
  dueText: string | null;
  overdue: boolean;
  /** The Finance Manager's reason, when he sent the signed application back. */
  sentBackReason: string | null;
}) {
  const [pending, start] = useTransition();
  // The pages, and the key of the empty slot for the next one: a fresh slot only
  // when a new page is in (the guarantee list's pattern, CreateCustomerForm).
  const [pages, setPages] = useState(() => ({ ids: keptPageIds, emptySlot: 0 }));
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<SubmitNotice | null>(null);
  const [sent, setSent] = useState(false);
  const busyRef = useRef(false);
  const onPhotoBusy = (b: boolean) => setUploading((n) => Math.max(0, n + (b ? 1 : -1)));

  const locked = pending || sent;
  const canSend = pages.ids.length > 0 && uploading === 0 && !locked;

  function send() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setNotice(null);
    const body = { editId, attachmentIds: pages.ids, decisionToken };
    start(async () => {
      try {
        const outcome = await postForm<{ editId: string; pages: number; replayed: boolean }>('credit-form', body);
        if (outcome.kind === 'answered' && outcome.result.ok) {
          setSent(true);
          // A document load: Work must not show it from the router cache.
          hardReplace('/work');
          return;
        }
        if (outcome.kind === 'answered' && !outcome.result.ok) {
          const r = outcome.result;
          setError(r.fields?.signedForm ?? r.fields?._form ?? r.message);
          return;
        }
        // No answer, offline, signed out: the same pages and token are safe to send again.
        setNotice(noticeFor(outcome));
      } finally {
        busyRef.current = false;
      }
    });
  }

  return (
    <section
      aria-labelledby="signed-form-title"
      className="mx-4 mt-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-amber-300 sm:mx-6 sm:mt-6"
    >
      <h2 id="signed-form-title" className="text-base font-semibold text-slate-900">
        Signed credit application needed
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        The Sales Director approved this credit request. Your supervisor prints the credit
        application. Have the customer sign it and stamp it with the company stamp, then take a clear
        photo of every page and send it here.
      </p>
      {dueText && (
        <p className={`mt-2 text-sm font-medium ${overdue ? 'text-red-700' : 'text-slate-800'}`}>
          {overdue ? 'Overdue — it was due ' : 'Upload it by '}
          {dueText}.
        </p>
      )}
      {sentBackReason && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          <strong className="font-semibold">Sent back by the Finance Manager:</strong> {sentBackReason}
        </p>
      )}

      <div className="mt-3">
        <p className="mb-1 text-sm font-medium text-slate-700">
          Pages of the signed application * (up to {MAX_SIGNED_FORM_PAGES})
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {pages.ids.map((pid) => (
            <PhotoCaptureSlot
              key={pid}
              kind="CREDIT_FORM"
              disabled={locked}
              initial={{ attachmentId: pid, remoteUrl: `/api/photos/${pid}` }}
              onChange={(p) => {
                const next = p?.attachmentId;
                // A retake replaces the page in place; a removal takes it off the list.
                setPages((g) =>
                  !next
                    ? { ...g, ids: g.ids.filter((x) => x !== pid) }
                    : next === pid
                      ? g
                      : {
                          ...g,
                          ids: g.ids.map((x) => (x === pid ? next : x)).filter((x, i, all) => all.indexOf(x) === i),
                        }
                );
              }}
              onBusyChange={onPhotoBusy}
            />
          ))}
          {!locked && pages.ids.length < MAX_SIGNED_FORM_PAGES && (
            <PhotoCaptureSlot
              key={`empty-${pages.emptySlot}`}
              kind="CREDIT_FORM"
              required={pages.ids.length === 0}
              onChange={(p) => {
                const id = p?.attachmentId;
                if (id) {
                  setPages((g) => (g.ids.includes(id) ? g : { ids: [...g.ids, id], emptySlot: g.emptySlot + 1 }));
                }
              }}
              onBusyChange={onPhotoBusy}
            />
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3">
        <SubmitNoticeBox notice={notice} onRetry={send} busy={pending} />
      </div>
      <button
        type="button"
        onClick={send}
        disabled={!canSend}
        className="mt-1 min-h-11 rounded-md bg-brand-600 px-5 text-base font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {sent ? 'Sent — loading…' : pending ? 'Sending…' : uploading > 0 ? 'Uploading…' : 'Send signed application'}
      </button>
      <p className="mt-1 text-xs text-slate-500">It then goes to the Finance Manager.</p>
    </section>
  );
}
