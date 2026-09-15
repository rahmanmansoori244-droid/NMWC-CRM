'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CompletenessRing } from '@/components/nmwc/CompletenessRing';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';
import {
  bulkApproveEditsAction,
  bulkRejectEditsAction,
} from '@/services/edits';

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
  ageHours: number;
  changesCount: number;
  /** Working-hours SLA pill (server-computed); null for legacy rows without a deadline. */
  sla: { label: string; tone: 'ok' | 'warn' | 'overdue' } | null;
  escalationLevel: number;
  /** Phase 1: net-new customer CREATE request (no customer row yet). */
  isCreate: boolean;
  paymentTerms: 'CASH' | 'CREDIT' | null;
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

  const allOnPage = items.map((i) => i.id);
  const allSelected = allOnPage.length > 0 && allOnPage.every((id) => selected.has(id));

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
      setSelected(new Set(allOnPage));
    }
  }

  function handleBulkApprove() {
    const ids = [...selected];
    setShowApprove(false);
    setOutcome(null);
    start(async () => {
      const fd = new FormData();
      fd.set('editIds', JSON.stringify(ids));
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
        setOutcome({ successes: 0, failures: [{ editId: '_form', code: res.code, message: res.message }], notAttempted: 0 });
      }
    });
  }

  function handleBulkReject() {
    if (rejectReason.length < 5) return;
    const ids = [...selected];
    setShowReject(false);
    setOutcome(null);
    start(async () => {
      const fd = new FormData();
      fd.set('editIds', JSON.stringify(ids));
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
        setOutcome({ successes: 0, failures: [{ editId: '_form', code: res.code, message: res.message }], notAttempted: 0 });
      }
    });
  }

  return (
    <div className="pb-32">
      {outcome && (
        <div
          className={`mx-4 mb-4 rounded-md p-3 text-sm sm:mx-6 ${
            outcome.failures.length === 0 && outcome.notAttempted === 0
              ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
              : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
          }`}
        >
          <p className="font-semibold">
            {outcome.successes} processed
            {outcome.failures.length > 0 ? `, ${outcome.failures.length} failed` : ''}
            {outcome.notAttempted > 0
              ? `, ${outcome.notAttempted} not attempted — run it again to finish`
              : ''}
            .
          </p>
          {outcome.failures.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {outcome.failures.slice(0, 5).map((f) => (
                <li key={f.editId}>
                  {f.editId === '_form' ? '' : f.editId.slice(-8) + ': '}
                  {f.message}
                </li>
              ))}
              {outcome.failures.length > 5 && (
                <li>… and {outcome.failures.length - 5} more.</li>
              )}
            </ul>
          )}
        </div>
      )}

      <div className="mx-4 mb-3 flex items-center justify-between sm:mx-6">
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            aria-label="Select all on page"
          />
          {allSelected ? 'Deselect all' : 'Select all'}
        </label>
        <p className="text-xs text-slate-500">
          {selected.size} selected
        </p>
      </div>

      <ul className="grid gap-3 px-4 sm:px-6">
        {items.map((e) => {
          const checked = selected.has(e.id);
          return (
            <li
              key={e.id}
              className={`flex items-start gap-3 rounded-lg bg-white p-4 shadow-sm ring-1 transition ${
                checked ? 'ring-brand-400 bg-brand-50/30' : 'ring-slate-200 hover:shadow-md'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleOne(e.id)}
                onClick={(ev) => ev.stopPropagation()}
                className="mt-1 h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                aria-label={`Select edit for ${e.customer?.legalName ?? 'unknown'}`}
              />
              <Link
                href={`/approvals/${e.id}`}
                className="flex min-w-0 flex-1 items-start gap-3"
              >
                <CompletenessRing
                  value={e.customer?.completenessScore ?? 0}
                  size={44}
                />
                <div className="min-w-0 flex-1">
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
                  <p className="mt-1 text-xs text-slate-600">
                    Submitted by {e.submittedByFullName}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 text-right text-xs">
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
            <p className="text-sm font-medium text-slate-700">
              {selected.size} selected
            </p>
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
        <p className="mt-1 text-xs text-slate-600">
          The same category and reason will be sent to every salesman whose edit
          is rejected.
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
          Reason for the salesmen *
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => onReason(e.currentTarget.value)}
            rows={3}
            minLength={5}
            maxLength={1000}
            required
            placeholder="Be specific so the salesmen know what to fix."
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
