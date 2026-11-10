'use client';

/**
 * Owner decisions 2026-10-11 — the salesman's signed-application step: after the
 * Sales Director approves a credit request, his supervisor (or anyone allowed to
 * print) prints the credit application, he has the customer sign it and stamp it
 * with the company stamp, and uploads a photo of each page up to the signed and
 * stamped one here. "Send signed application" moves the request on to the
 * Finance Manager (services/signed-form.ts).
 *
 * Not "every page" (review, 2026-10-11): the printout ends with a "Photos &
 * documents" annex on pages of its own (one for every document and shop photo,
 * no limit), so a multi-branch customer's copy can run past
 * MAX_SIGNED_FORM_PAGES. The annex repeats what the CRM already holds; the
 * details, the declaration and the boxes come before it. Whether the signed copy
 * should carry the annex at all is the owner's (04-PENDING A8).
 *
 * Its own component, above the read-only request, so the new-customer form is
 * untouched. It submits over postForm like every field form (item 22): a lost
 * answer is retried with the same pages and the same decision token, and the
 * server answers a retry whose first try landed as landed — the token is its
 * replay key. The pages are new uploads of kind CREDIT_FORM, on no record until
 * he sends them, so a wrong one is simply taken off the list; pages kept from an
 * upload the Finance Manager sent back are shown, and one he takes off is
 * released when he sends.
 *
 * Code review 2026-11-10, finding 4: the pages lived only in this page's memory.
 * A reload before Send — Android dropping the tab behind the camera, a pull down
 * at the top of the page — showed an empty list, with up to six pages already
 * uploaded and the customer's paper perhaps handed back. This step has no Save
 * draft, so the list is kept on the phone (lib/create-draft.ts
 * parseSignedPagesCopy): the ids only — the pages are on the server, and Send
 * checks every one again (services/signed-form.ts). It is put back only on the
 * same visit of the step (the same decision token), kept seven days, and removed
 * once the pages are sent, the request is withdrawn, or he signs out. Leaving
 * with unsent pages asks first (lib/leave-guard.ts).
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';
import { SubmitNoticeBox } from '@/components/nmwc/SubmitNoticeBox';
import { noticeFor, postForm, type SubmitNotice } from '@/lib/submit-client';
import { hardReplace } from '@/lib/navigate';
import { MAX_SIGNED_FORM_PAGES } from '@/lib/credit-documents';
import { parseSignedPagesCopy } from '@/lib/create-draft';
import {
  DEVICE_DRAFT_MAX_AGE_DAYS,
  deviceDraftExpired,
  draftAgeText,
  onRequestClosed,
  onSignOut,
  signedFormDraftKey,
} from '@/lib/device-drafts';
import {
  LEAVE_FORM_LOST_QUESTION,
  LEAVE_FORM_QUESTION,
  useLeaveGuard,
  useNoPullToRefresh,
} from '@/lib/leave-guard';

export function SignedFormUpload({
  editId,
  sessionUserId,
  decisionToken,
  keptPageIds,
  dueText,
  overdue,
  sentBackReason,
}: {
  editId: string;
  /** Whose phone copy of the pages this is (lib/device-drafts.ts): never another salesman's. */
  sessionUserId: string;
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

  // ── The list on the phone (finding 4). ──
  const draftKey = signedFormDraftKey(sessionUserId, editId);
  // The list as one string: what is on file when the page loads, and now.
  const keptKey = keptPageIds.join(',');
  const idsKey = pages.ids.join(',');
  // Unsent work: a page added, retaken or taken off since the page loaded.
  const differs = idsKey !== keptKey;
  // Nothing is written before the restore has run and its pages are in.
  const [hydrated, setHydrated] = useState(false);
  const [restoredNote, setRestoredNote] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  // Sent, withdrawn or signing out: the copy is gone, and nothing writes it back.
  const goneRef = useRef(false);
  // The list as last written or restored, with its save time: its age runs from
  // the last change to it.
  const stampRef = useRef<{ content: string; savedAt: number } | null>(null);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(draftKey);
    } catch {
      raw = null;
    }
    const drop = () => {
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    };
    const copy = parseSignedPagesCopy(raw, MAX_SIGNED_FORM_PAGES);
    if (copy) {
      const age = draftAgeText(copy.savedAt);
      const content = copy.ids.join(',');
      if (content === keptKey) {
        // Nothing the page does not already show.
        drop();
      } else if (deviceDraftExpired(copy.savedAt)) {
        drop();
        setRestoredNote(
          `Pages added on this phone ${age ?? 'earlier'} were removed: unsent work is kept on the phone for ${DEVICE_DRAFT_MAX_AGE_DAYS} days. Take them again.`
        );
      } else if (copy.token !== decisionToken) {
        // Another visit of the step: sent back since, or its documents changed.
        // The pages on file now are the truth.
        drop();
        setRestoredNote(
          'The pages you had added on this phone were not restored, because this request changed since. Take them again.'
        );
      } else {
        const added = copy.ids.filter((id) => !keptPageIds.includes(id)).length;
        // A fresh empty slot, as after any page that came in.
        setPages({ ids: copy.ids, emptySlot: 1 });
        if (typeof copy.savedAt === 'number' && Number.isFinite(copy.savedAt)) {
          stampRef.current = { content, savedAt: copy.savedAt };
        }
        const when = age ? ` (saved ${age})` : '';
        setRestoredNote(
          added > 0
            ? `Restored ${added} page${added === 1 ? '' : 's'} you had added on this phone${when}. Check them, then send.`
            : `Restored the pages as you left them on this phone${when}. Check them, then send.`
        );
      }
    }
    setHydrated(true);
    // Once, on mount (the ref above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Written with every change of the list — a page comes in one at a time, and
  // the next thing he does is open the camera again — and removed when the list
  // is back to what is on file.
  useEffect(() => {
    if (!hydrated || sent || goneRef.current) return;
    try {
      if (!differs) {
        stampRef.current = null;
        window.localStorage.removeItem(draftKey);
      } else {
        const savedAt = stampRef.current?.content === idsKey ? stampRef.current.savedAt : Date.now();
        window.localStorage.setItem(
          draftKey,
          JSON.stringify({ v: 1, savedAt, token: decisionToken, ids: pages.ids })
        );
        stampRef.current = { content: idsKey, savedAt };
      }
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [hydrated, sent, differs, idsKey, pages.ids, draftKey, decisionToken]);

  // Sign out deletes the copy (lib/device-drafts.ts); a withdrawn request has no
  // use for it. Neither is written back while the page is still on screen.
  useEffect(() => {
    const stop = () => {
      goneRef.current = true;
    };
    const offSignOut = onSignOut(stop);
    const offClosed = onRequestClosed(editId, () => {
      stop();
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    });
    return () => {
      offSignOut();
      offClosed();
    };
  }, [editId, draftKey]);

  useLeaveGuard(
    !sent && (differs || uploading > 0),
    storageFailed ? LEAVE_FORM_LOST_QUESTION : LEAVE_FORM_QUESTION
  );
  useNoPullToRefresh(!sent);

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
          // They are on the request now: the phone's list goes, before the page does.
          goneRef.current = true;
          try {
            window.localStorage.removeItem(draftKey);
          } catch {
            /* ignore */
          }
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
        photo of each page up to and including the page with the signature and stamp, and send them
        here. The &ldquo;Photos &amp; documents&rdquo; pages after it are already in the CRM: leave them out.
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
      {restoredNote && !sent && (
        <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
          {restoredNote}
        </p>
      )}
      {storageFailed && !sent && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 ring-1 ring-amber-200">
          This phone could not keep a list of these pages. Keep this page open until you have sent them.
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
