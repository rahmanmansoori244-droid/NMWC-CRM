'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { approveEditAction, rejectEditAction } from '@/services/edits';
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

export function ApproveRejectActions({ editId }: { editId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('other');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // B-14: replace window.confirm() with a modal for the Approve action.
  const [confirmingApprove, setConfirmingApprove] = useState(false);

  function approve() {
    setConfirmingApprove(false);
    setErrors({});
    const fd = new FormData();
    fd.set('editId', editId);
    start(async () => {
      // PROD-006: server actions return `{ ok, code, message, fields? }` —
      // they no longer throw AppError across the SC boundary. See
      // lib/errors.ts (runAction). Throws here are now reserved for genuine
      // 500s, which we still surface as a generic message.
      try {
        const res = await approveEditAction(fd);
        if (res.ok) {
          router.push('/approvals');
        } else if (res.fields) {
          setErrors(res.fields);
        } else {
          setErrors({ _form: res.message });
        }
      } catch (err) {
        setErrors({ _form: err instanceof Error ? err.message : 'Failed.' });
      }
    });
  }

  function reject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const fd = new FormData(e.currentTarget);
    fd.set('editId', editId);
    start(async () => {
      try {
        const res = await rejectEditAction(fd);
        if (res.ok) {
          router.push('/approvals');
        } else if (res.fields) {
          setErrors(res.fields);
        } else {
          setErrors({ _form: res.message });
        }
      } catch (err) {
        setErrors({ _form: err instanceof Error ? err.message : 'Failed.' });
      }
    });
  }

  const templates = REJECT_TEMPLATES[category] ?? [];

  return (
    <div>
      {errors._form && (
        <p className="mb-2 text-sm font-medium text-red-600">{errors._form}</p>
      )}
      {!showReject ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => setShowReject(true)}
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            ✗ Reject
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmingApprove(true)}
            className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
          >
            {pending ? 'Working…' : '✓ Approve'}
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
              Reason for the salesman *
            </label>
            <textarea
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              rows={3}
              minLength={5}
              maxLength={1000}
              required
              placeholder="Be specific so the salesman knows what to fix."
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
              {pending ? 'Rejecting…' : '✗ Send back to salesman'}
            </button>
          </div>
        </form>
      )}

      {/* B-14: replace window.confirm() with an accessible modal. */}
      <ConfirmModal
        open={confirmingApprove}
        title="Approve this edit?"
        message="Changes will go live on the customer immediately. This cannot be undone."
        confirmLabel="Approve"
        confirmTone="primary"
        onConfirm={approve}
        onCancel={() => setConfirmingApprove(false)}
      />
    </div>
  );
}
