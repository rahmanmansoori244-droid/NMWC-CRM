'use client';

import { useState, useTransition } from 'react';
import { unstable_rethrow, useRouter } from 'next/navigation';
import { approveEditAction, approveEditAndGoAction, rejectEditAndGoAction } from '@/services/edits';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';

const REJECT_CATEGORIES = [
  { value: 'bad_photo', label: 'Bad photo' },
  { value: 'wrong_gps', label: 'Wrong GPS' },
  { value: 'missing_field', label: 'Missing field' },
  { value: 'wrong_info', label: 'Wrong info' },
  { value: 'other', label: 'Other' },
];

// B-21: canned reason templates per category. Click a pill to prefill the
// textarea — supervisors can still type freely afterward.
const REJECT_TEMPLATES: Record<string, string[]> = {
  bad_photo: [
    'Shop sign not clearly visible',
    'Photo is blurry, retake',
    'Photo was taken from too far',
    'Lighting too dark — retake during daytime',
    'Wrong subject — capture the storefront',
  ],
  wrong_gps: [
    'GPS pin is far from the actual shop',
    'Coordinates fall outside Oman',
    'GPS captured from your home, not the shop',
    'Re-capture GPS while standing at the entrance',
  ],
  missing_field: [
    'Contact person name is missing',
    'Primary phone is empty',
    'CR number not entered',
    'Day of visit not selected',
    'Address is too short — add full street + landmark',
  ],
  wrong_info: [
    'Channel/sub-channel does not match the shop type',
    'Phone number format is incorrect',
    'CR number does not match the photo',
    'Legal name on CR document differs from what was entered',
  ],
  other: [
    'Please re-verify and resubmit',
    'Need to discuss in person before approving',
  ],
};

/**
 * What approving THIS step does (X-APPR-2). The modal said "Changes will go live
 * on the customer immediately" to every approver, but a mid-chain step only
 * sends the request on, and the final step of a new-customer request creates a
 * customer rather than changing one.
 */
export type ApproveOutcome =
  | { kind: 'ADVANCE'; nextRole: string }
  | { kind: 'CREATE' }
  | { kind: 'APPLY' };

const STEP_LABEL: Record<string, string> = {
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager',
  ACCOUNTANT: 'Accountant',
  FINANCE_MANAGER: 'Finance Manager',
  GM: 'GM',
};

export function approveConfirmCopy(outcome: ApproveOutcome): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  switch (outcome.kind) {
    case 'ADVANCE': {
      const next = STEP_LABEL[outcome.nextRole] ?? outcome.nextRole.replace(/_/g, ' ');
      return {
        title: `Send on to ${next}?`,
        message: `You approve this step and the request moves to the ${next} step. Nothing is written to the customer master until the final step approves it.`,
        confirmLabel: 'Approve and send on',
      };
    }
    case 'CREATE':
      return {
        title: 'Create this customer?',
        message:
          'This is the final approval: the new customer is created in the customer master now, as shown on this page. This cannot be undone.',
        confirmLabel: 'Approve and create',
      };
    case 'APPLY':
      return {
        title: 'Approve this edit?',
        message: 'Changes will go live on the customer immediately. This cannot be undone.',
        confirmLabel: 'Approve',
      };
  }
}

/**
 * Where rejecting THIS step sends the request (lib/approval-chains.ts
 * resolveRejectTarget). The form told every approver the request went back to
 * the salesman, but a rejection at a later step, the first time in a round,
 * only steps it back to the previous approver.
 */
export type RejectOutcome = { kind: 'STEP_BACK'; toRole: string } | { kind: 'TO_SALESMAN' };

export function rejectFormCopy(outcome: RejectOutcome): {
  reasonLabel: string;
  placeholder: string;
  submitLabel: string;
} {
  if (outcome.kind === 'STEP_BACK') {
    const back = STEP_LABEL[outcome.toRole] ?? outcome.toRole.replace(/_/g, ' ');
    return {
      reasonLabel: `Reason for the ${back} *`,
      placeholder: `Be specific so the ${back} knows what to re-check. It goes back to the ${back} step, not to the salesman.`,
      submitLabel: `✗ Send back to ${back}`,
    };
  }
  return {
    reasonLabel: 'Reason for the salesman *',
    placeholder: 'Be specific so the salesman knows what to fix.',
    submitLabel: '✗ Send back to salesman',
  };
}

export function ApproveRejectActions({
  editId,
  decisionToken,
  outcome,
  rejectOutcome,
}: {
  editId: string;
  /** N01: the request as this page rendered it (lib/decision-token.ts). Sent with every decision. */
  decisionToken: string;
  outcome: ApproveOutcome;
  rejectOutcome: RejectOutcome;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('other');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // B-14: replace window.confirm() with a modal for the Approve action.
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  // Launch fix (review): the customer is created and this page is refreshing.
  // The transition ends when the action answers, before the refresh lands, and
  // a second tap in between told the Accountant it was "already APPROVED".
  const [created, setCreated] = useState(false);
  const busy = pending || created;

  function approve() {
    setConfirmingApprove(false);
    setErrors({});
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', decisionToken);
    start(async () => {
      // PROD-006: server actions return `{ ok, code, message, fields? }` —
      // they no longer throw AppError across the SC boundary. See
      // lib/errors.ts (runAction). Throws here are now reserved for genuine
      // 500s, which we still surface as a generic message.
      try {
        // Launch fix: the last step of a new-customer request stays here, and
        // the page then shows the customer code it created. Sent back to
        // /approvals, the Accountant never saw the code anywhere.
        if (outcome.kind === 'CREATE') {
          const res = await approveEditAction(fd);
          if (!res.ok) setErrors({ _form: res.message });
          else {
            setCreated(true);
            router.refresh();
          }
          return;
        }
        // perf audit #31: on success the action redirect()s server-side, so the
        // response already carries the fresh /approvals payload — ONE round trip.
        // The promise then resolves with no value; only error results return.
        const res = await approveEditAndGoAction(fd);
        // Approve has no input to put a field error beside (a missing decision
        // token is one): the message goes at the top. STALE_VIEW lands there too.
        if (res && !res.ok) setErrors({ _form: res.message });
      } catch (err) {
        // Launch fix: on success the action's redirect('/approvals') reaches
        // here as a rejected promise carrying Next's NEXT_REDIRECT error, which
        // printed "NEXT_REDIRECT" in red until the queue loaded. Next's own
        // errors go back to Next, which completes the navigation.
        unstable_rethrow(err);
        setErrors({ _form: err instanceof Error ? err.message : 'Failed.' });
      }
    });
  }

  function reject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const fd = new FormData(e.currentTarget);
    fd.set('editId', editId);
    fd.set('decisionToken', decisionToken);
    start(async () => {
      try {
        const res = await rejectEditAndGoAction(fd);
        if (res && !res.ok) {
          // The reason is the only field this form shows; any other field error
          // (the decision token) must still be seen, so it goes at the top.
          if (res.fields?.reason) setErrors(res.fields);
          else setErrors({ _form: res.message });
        }
      } catch (err) {
        unstable_rethrow(err); // the success redirect, as in approve()
        setErrors({ _form: err instanceof Error ? err.message : 'Failed.' });
      }
    });
  }

  const templates = REJECT_TEMPLATES[category] ?? [];
  const confirm = approveConfirmCopy(outcome);
  const rejectCopy = rejectFormCopy(rejectOutcome);

  return (
    <div>
      {errors._form && (
        <p className="mb-2 text-sm font-medium text-red-600">{errors._form}</p>
      )}
      {!showReject ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowReject(true)}
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            ✗ Reject
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingApprove(true)}
            className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
          >
            {created ? 'Created — loading…' : pending ? 'Working…' : '✓ Approve'}
          </button>
        </div>
      ) : (
        <form onSubmit={reject} className="grid gap-3">
          <h3 className="text-sm font-semibold text-slate-900">Reject this submission</h3>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Category</label>
            <select
              name="category"
              value={category}
              onChange={(e) => setCategory(e.currentTarget.value)}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            >
              {REJECT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {/* B-21: canned templates per category. Click a pill to prefill the
              textarea; user can still edit afterward. */}
          {templates.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Quick reasons
              </p>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setReason(t)}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              {rejectCopy.reasonLabel}
            </label>
            <textarea
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              rows={3}
              minLength={5}
              maxLength={1000}
              required
              placeholder={rejectCopy.placeholder}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
            />
            {errors.reason && <p className="mt-0.5 text-xs text-red-600">{errors.reason}</p>}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowReject(false)}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || reason.length < 5}
              className="rounded-md bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-slate-300"
            >
              {pending ? 'Rejecting…' : rejectCopy.submitLabel}
            </button>
          </div>
        </form>
      )}

      {/* B-14: replace window.confirm() with an accessible modal. X-APPR-2: its
          words say what approving this step actually does. */}
      <ConfirmModal
        open={confirmingApprove}
        title={confirm.title}
        message={confirm.message}
        confirmLabel={confirm.confirmLabel}
        confirmTone="primary"
        onConfirm={approve}
        onCancel={() => setConfirmingApprove(false)}
      />
    </div>
  );
}
