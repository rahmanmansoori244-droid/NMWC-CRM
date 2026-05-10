'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { approveEditAction, rejectEditAction } from '@/services/edits';

const REJECT_CATEGORIES = [
  { value: 'bad_photo', label: 'Bad photo' },
  { value: 'wrong_gps', label: 'Wrong GPS' },
  { value: 'missing_field', label: 'Missing field' },
  { value: 'wrong_info', label: 'Wrong info' },
  { value: 'other', label: 'Other' },
];

export function ApproveRejectActions({ editId }: { editId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('other');
  const [errors, setErrors] = useState<Record<string, string>>({});

  function approve() {
    if (!confirm('Approve this edit? Changes will go live on the customer immediately.')) return;
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
            onClick={approve}
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
    </div>
  );
}
