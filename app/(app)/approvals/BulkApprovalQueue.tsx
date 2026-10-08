'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { CompletenessRing } from '@/components/nmwc/CompletenessRing';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';
import { bulkApproveEditsAction, bulkRejectEditsAction } from '@/services/edits';
import {
  BULK_DECISION_LIMIT,
  CREDIT_BULK_REFUSED_MESSAGE,
  TEMIX_CODE_BULK_REFUSED_MESSAGE,
} from '@/lib/bulk-run';

/**
 * B-11 (Senior-audit 2026-05-10): bulk-approval queue.
 *
 * Replaces the old per-row click-through queue with a multi-select list that
 * lets a Supervisor or Manager push 50 approvals in one round trip. Falls back
 * to the per-row click for nuanced reviews (the row link goes to the same
 * /approvals/[id] page, so this is purely additive).
 */

export type ApprovalQueueItem = {
  id: string;
  /**
   * N01: the request as this card shows it (lib/decision-token.ts). A bulk
   * decision sends each card's own token, and an item whose request has changed
   * since the page loaded fails on its own with STALE_VIEW.
   */
  decisionToken: string;
  ageHours: number;
  changesCount: number;
  /** Item 41: a branch point in this request was typed in by hand, not a GPS fix. */
  manualGps: boolean;
  /** Working-hours SLA pill (server-computed); null for legacy rows without a deadline. */
  sla: { label: string; tone: 'ok' | 'warn' | 'overdue' } | null;
  escalationLevel: number;
  /** Phase 1: net-new customer CREATE request (no customer row yet). */
  isCreate: boolean;
  /**
   * Owner decision 2026-10-08: a new-customer request at its last step (the
   * Accountant's), approved only with the Temix code typed on its own page.
   */
  needsTemixCode: boolean;
  paymentTerms: 'CASH' | 'CREDIT' | null;
  /**
   * X-APPR-1: a new CREDIT customer's requested figures, shown on the card so a
   * finance approver deciding in bulk sees what they approve; the same values
   * are in decisionToken. Null for every other request.
   */
  credit: { limit: string | null; termDays: number | null } | null;
  customer: {
    legalName: string;
    nmwcCode: string;
    completenessScore: number;
  } | null;
  submittedByFullName: string;
};

const REJECT_CATEGORIES = [
  { value: 'bad_photo', label: 'Bad photo' },
  { value: 'wrong_gps', label: 'Wrong GPS' },
  { value: 'missing_field', label: 'Missing field' },
  { value: 'wrong_info', label: 'Wrong info' },
  { value: 'other', label: 'Other' },
];

export function BulkApprovalQueue({ items }: { items: ApprovalQueueItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectCategory, setRejectCategory] = useState('other');
  const [rejectReason, setRejectReason] = useState('');
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<{
    successes: number;
    failures: Array<{ editId: string; code: string; message: string }>;
    // REL-04: selected but never started, because the batch ran out of time.
    // Distinct from a failure: nothing was attempted, so running it again is safe.
    notAttempted: number;
  } | null>(null);

  // Owner decision 2026-10-05 (X-APPR-1(a): no): a credit application is never
  // ticked into a bulk action; it is opened and approved on its own page. The
  // server refuses one inside a bulk approve too (CREDIT_BULK_REFUSED_MESSAGE).
  const isCreditCard = (i: ApprovalQueueItem) => i.isCreate && i.paymentTerms === 'CREDIT';
  // Owner decision 2026-10-08: the same for any new customer at its last step,
  // which needs its Temix code (TEMIX_CODE_BULK_REFUSED_MESSAGE). A credit card
  // there keeps the credit lock: it is both, and either is reason enough.
  const isTemixCard = (i: ApprovalQueueItem) => i.needsTemixCode && !isCreditCard(i);
  const allOnPage = items.filter((i) => !isCreditCard(i) && !isTemixCard(i)).map((i) => i.id);
  const hasCredit = items.some(isCreditCard);
  const hasTemix = items.some(isTemixCard);
  // Select all stops at the bulk limit, taking cards in the order shown (most
  // overdue first). It used to take every card on the page — up to 200 — and the
  // server refuses a list over the limit whole, so on a region-wide queue past
  // the limit Select all → Approve could only ever fail.
  const selectAllIds = allOnPage.slice(0, BULK_DECISION_LIMIT);
  const allSelected = selectAllIds.length > 0 && selectAllIds.every((id) => selected.has(id));
  // Exactly the first BULK_DECISION_LIMIT of a longer queue: said, not silent,
  // or the approver reads "Select all" as all of it.
  const selectAllCapped =
    allOnPage.length > BULK_DECISION_LIMIT && allSelected && selected.size === BULK_DECISION_LIMIT;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectAllIds));
    }
  }

  // N01: each selected card's own view of its request. Built from the cards on
  // screen, so a selection whose card has gone is not decided.
  function selectedDecisions() {
    return items
      .filter((i) => selected.has(i.id))
      .map((i) => ({ editId: i.id, decisionToken: i.decisionToken }));
  }

  function handleBulkApprove() {
    const decisions = selectedDecisions();
    setShowApprove(false);
    setOutcome(null);
    start(async () => {
      const fd = new FormData();
      fd.set('decisions', JSON.stringify(decisions));
      const res = await bulkApproveEditsAction(fd);
      if (res.ok) {
        setOutcome({
          successes: res.data.successes.length,
          failures: res.data.failures,
          notAttempted: res.data.notAttempted.length,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setOutcome({
          successes: 0,
          failures: [{ editId: '_form', code: res.code, message: res.message }],
          notAttempted: 0,
        });
      }
    });
  }

  function handleBulkReject() {
    if (rejectReason.length < 5) return;
    const decisions = selectedDecisions();
    setShowReject(false);
    setOutcome(null);
    start(async () => {
      const fd = new FormData();
      fd.set('decisions', JSON.stringify(decisions));
      fd.set('reason', rejectReason);
      fd.set('category', rejectCategory);
      const res = await bulkRejectEditsAction(fd);
      if (res.ok) {
        setOutcome({
          successes: res.data.successes.length,
          failures: res.data.failures,
          notAttempted: res.data.notAttempted.length,
        });
        setSelected(new Set());
        setRejectReason('');
        router.refresh();
      } else {
        setOutcome({
          successes: 0,
          failures: [{ editId: '_form', code: res.code, message: res.message }],
          notAttempted: 0,
        });
      }
    });
  }

  return (
    <div className="pb-32">
      {outcome && (
        <div
          // Read out when it lands: what a bulk decision did was text a screen
          // reader never reached. Anything failed or not attempted is an alert.
          role={outcome.failures.length === 0 && outcome.notAttempted === 0 ? 'status' : 'alert'}
          className={`mx-4 mb-4 rounded-md p-3 text-sm sm:mx-6 ${
            outcome.failures.length === 0 && outcome.notAttempted === 0
              ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
              : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
          }`}
        >
          {/* A refusal of the whole action (`_form`, e.g. over the bulk limit)
              decided nothing, so it is not "0 processed, 1 failed"; its message,
              below, says what to do. */}
          <p className="font-semibold">
            {outcome.failures[0]?.editId === '_form' ? (
              'Nothing was processed.'
            ) : (
              <>
                {outcome.successes} processed
                {outcome.failures.length > 0 ? `, ${outcome.failures.length} failed` : ''}
                {outcome.notAttempted > 0
                  ? `, ${outcome.notAttempted} not attempted — run it again to finish`
                  : ''}
                .
              </>
            )}
          </p>
          {outcome.failures.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {outcome.failures.slice(0, 5).map((f) => (
                <li key={f.editId}>
                  {f.editId === '_form' ? '' : f.editId.slice(-8) + ': '}
                  {f.message}
                </li>
              ))}
              {outcome.failures.length > 5 && <li>… and {outcome.failures.length - 5} more.</li>}
            </ul>
          )}
        </div>
      )}

      {hasCredit && (
        <p className="mx-4 mb-3 text-xs font-medium text-slate-600 sm:mx-6">
          Credit applications are approved one at a time: open each card marked with a lock.
        </p>
      )}
      {hasTemix && (
        <p className="mx-4 mb-3 text-xs font-medium text-slate-600 sm:mx-6">
          New customers at their last step are approved one at a time: open each card marked with a
          lock and enter its Temix code.
        </p>
      )}
      {allOnPage.length > 0 && (
        <div className="mx-4 mb-3 flex items-center justify-between sm:mx-6">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              aria-label="Select up to 50 on this page"
            />
            {allSelected ? 'Deselect all' : 'Select all'}
          </label>
          <p className="text-xs text-slate-500">{selected.size} selected</p>
        </div>
      )}
      {selectAllCapped && (
        <p role="status" className="mx-4 mb-3 text-xs font-medium text-amber-800 sm:mx-6">
          {`Selected the first ${BULK_DECISION_LIMIT} — the limit per action.`}
        </p>
      )}

      <ul className="grid grid-cols-1 gap-3 px-4 sm:px-6">
        {items.map((e) => {
          const checked = selected.has(e.id);
          return (
            <li
              key={e.id}
              className={`flex items-start gap-3 rounded-lg bg-white p-4 shadow-sm ring-1 transition ${
                checked ? 'ring-brand-400 bg-brand-50/30' : 'ring-slate-200 hover:shadow-md'
              }`}
            >
              {isCreditCard(e) ? (
                <span
                  className="mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-400"
                  title={CREDIT_BULK_REFUSED_MESSAGE}
                  aria-label="Credit application: open it to decide"
                  role="img"
                >
                  <Lock className="h-4 w-4" aria-hidden="true" />
                </span>
              ) : isTemixCard(e) ? (
                <span
                  className="mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-400"
                  title={TEMIX_CODE_BULK_REFUSED_MESSAGE}
                  aria-label="Enter its Temix code: open it to approve"
                  role="img"
                >
                  <Lock className="h-4 w-4" aria-hidden="true" />
                </span>
              ) : (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleOne(e.id)}
                  onClick={(ev) => ev.stopPropagation()}
                  className="mt-1 h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  aria-label={`Select edit for ${e.customer?.legalName ?? 'unknown'}`}
                />
              )}
              <Link
                href={`/approvals/${e.id}`}
                className="flex min-w-0 flex-1 flex-wrap items-start gap-3 sm:flex-nowrap"
              >
                <CompletenessRing value={e.customer?.completenessScore ?? 0} size={44} />
                {/* 56px = the 44px CompletenessRing + gap-3: the text takes the rest of
                    the first line on a phone, and the pills wrap below it. */}
                <div className="min-w-0 flex-1 basis-[calc(100%-56px)] sm:basis-0">
                  <h3 className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-900">
                    {e.isCreate && (
                      <span className="inline-flex shrink-0 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">
                        New
                      </span>
                    )}
                    <span className="truncate">{e.customer?.legalName ?? '—'}</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    {e.isCreate
                      ? `New ${e.paymentTerms ?? ''} customer request`.replace('  ', ' ')
                      : `${e.customer?.nmwcCode} · ${e.changesCount} change${e.changesCount === 1 ? '' : 's'}`}
                  </p>
                  {/* X-APPR-1: the figures a credit approval approves, on the card
                      itself — Select all then Approve used to decide them unseen. */}
                  {e.credit && (
                    <p className="mt-0.5 text-xs font-semibold text-slate-800">
                      Requested credit:{' '}
                      {e.credit.limit != null ? `OMR ${e.credit.limit}` : 'no limit given'} ·{' '}
                      {e.credit.termDays != null ? `${e.credit.termDays} days` : 'no term given'}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-slate-600">
                    Submitted by {e.submittedByFullName}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1 pl-14 text-xs sm:flex-col sm:flex-nowrap sm:items-end sm:pl-0 sm:text-right">
                  {/* Working-hours SLA pill (nights/Fridays don't count against the reviewer). */}
                  {e.sla && (
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 font-semibold ${
                        e.sla.tone === 'overdue'
                          ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                          : e.sla.tone === 'warn'
                            ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                            : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                      }`}
                    >
                      {e.escalationLevel > 0 ? '⚠ ' : ''}
                      {e.sla.label}
                    </span>
                  )}
                  {/* Item 41: seen BEFORE a bulk approve, not only on the detail page. */}
                  {e.manualGps && (
                    <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800 ring-1 ring-amber-200">
                      Typed GPS
                    </span>
                  )}
                  <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                    {e.ageHours < 1
                      ? 'just now'
                      : e.ageHours < 24
                        ? `${e.ageHours}h ago`
                        : `${Math.round(e.ageHours / 24)}d ago`}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur sm:px-6">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <p className="text-sm font-medium text-slate-700">{selected.size} selected</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setShowReject(true)}
                className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
              >
                ✗ Reject {selected.size}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setShowApprove(true)}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
              >
                {pending ? 'Working…' : `✓ Approve ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={showApprove}
        title={`Approve ${selected.size} edit${selected.size === 1 ? '' : 's'}?`}
        message={`Final-step approvals go live on the customer master immediately; mid-chain approvals advance the request to the next approver. Failed edits (concurrent updates, missing fields, etc.) will be reported back without blocking the rest.`}
        confirmLabel={`Approve ${selected.size}`}
        confirmTone="primary"
        onConfirm={handleBulkApprove}
        onCancel={() => setShowApprove(false)}
      />

      {showReject && (
        <RejectModal
          count={selected.size}
          category={rejectCategory}
          reason={rejectReason}
          onCategory={setRejectCategory}
          onReason={setRejectReason}
          onConfirm={handleBulkReject}
          onCancel={() => setShowReject(false)}
          disabled={pending}
        />
      )}
    </div>
  );
}

function RejectModal({
  count,
  category,
  reason,
  onCategory,
  onReason,
  onConfirm,
  onCancel,
  disabled,
}: {
  count: number;
  category: string;
  reason: string;
  onCategory: (s: string) => void;
  onReason: (s: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  // UAT-07: ConfirmModal has a focus trap, focus restore and Escape; this dialog
  // had none of the three, so a keyboard approver could open it and then neither
  // leave it nor stay inside it. It gets its own rather than reusing ConfirmModal:
  // that component binds Enter to confirm globally, which here would fire a bulk
  // REJECTION from inside the required free-text reason box.
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Mount-only: this component is conditionally rendered, so mounting is the
    // moment the dialog opens.
    const previous = document.activeElement as HTMLElement | null;
    reasonRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      // Re-queried on every keypress, not cached: the Confirm button toggles
      // disabled as the reason is typed, so a cached list would send focus to a
      // control that is no longer focusable.
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href]'
        ),
      ].filter((el) => el.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      // Clicking the heading, the explanatory paragraph or the card's padding
      // leaves activeElement on <body>, which is inside neither branch below — so
      // without this the very next Tab walked straight out of the dialog and into
      // the approvals list behind it. Anything outside the card is pulled back in.
      if (!active || !dialogRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {/* The backdrop above stays a plain div — it owns click-to-cancel. The card
          is the dialog. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-modal-title"
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200"
      >
        <h3 id="reject-modal-title" className="text-base font-semibold text-slate-900">
          Reject {count} edit{count === 1 ? '' : 's'}?
        </h3>
        {/* Both rules resolveRejectTarget applies (rejectEditCore): the step
            back, and the loop guard — a step's second rejection in one round
            goes to the salesman. The detail page names the one for its request. */}
        <p className="mt-1 text-xs text-slate-600">
          The same category and reason go with every request rejected. Each one goes back to the
          previous approver, except that it goes to the salesman when it is at the first step, or
          when this step has already rejected it once since the salesman last sent it. A
          request&apos;s own page says which.
        </p>
        <label className="mt-4 block text-xs font-medium text-slate-700">
          Category
          <select
            value={category}
            onChange={(e) => onCategory(e.currentTarget.value)}
            className="mt-1 block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          >
            {REJECT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-xs font-medium text-slate-700">
          Reason *
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => onReason(e.currentTarget.value)}
            rows={3}
            minLength={5}
            maxLength={1000}
            required
            placeholder="Be specific so whoever gets it back knows what to fix or re-check."
            className="mt-1 block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
          />
        </label>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={disabled || reason.length < 5}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-slate-300"
          >
            {disabled ? 'Rejecting…' : `Reject ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
