'use client';

/**
 * Owner-confirmed soft-delete (Blueprint C8): archive tombstones the customer
 * and queues the Temix deactivation. Steward + region-scoped Manager only —
 * the server action re-checks both.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive } from 'lucide-react';
import { archiveCustomerAction } from '@/services/customers';

export function ArchiveCustomerButton({
  customerId,
  legalName,
}: {
  customerId: string;
  legalName: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function archive() {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set('customerId', customerId);
      fd.set('reason', reason);
      const res = await archiveCustomerAction(fd);
      if (!res.ok) {
        setError(res.fields ? Object.values(res.fields).join(' ') : res.message);
        return;
      }
      router.replace('/customers');
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50"
      >
        <Archive className="h-4 w-4" />
        Archive
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200">
            <h3 className="text-base font-semibold text-slate-900">
              Archive {legalName}?
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              The customer disappears from all lists and, if Temix knows it, is queued for ERP
              deactivation in the next Temix batch. This can only be undone by a database
              administrator.
            </p>
            <label className="mt-4 block text-xs font-medium text-slate-700">
              Reason (kept in the audit log) *
              <textarea
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
                rows={3}
                minLength={5}
                maxLength={1000}
                required
                placeholder="e.g. Shop permanently closed — confirmed by the route supervisor."
                className="mt-1 block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
              />
            </label>
            {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending || reason.trim().length < 5}
                onClick={archive}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-slate-300"
              >
                {pending ? 'Archiving…' : 'Archive customer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
