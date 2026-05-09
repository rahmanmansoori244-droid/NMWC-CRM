'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { changeOwnPasswordAction } from '@/services/users';
import { ValidationError } from '@/lib/errors';

export function ChangePasswordForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  return (
    <form
      action={(fd) => {
        setErrors({});
        start(async () => {
          try {
            await changeOwnPasswordAction(fd);
            setDone(true);
            // AUTH-12: the action bumps sessionsRevokedAt which kills the
            // current JWT at the next freshness check. Force a hard reload
            // to /login so the user re-authenticates with the new password.
            setTimeout(() => router.replace('/login'), 1500);
          } catch (err) {
            if (err instanceof ValidationError && err.fields) setErrors(err.fields);
            else setErrors({ _form: err instanceof Error ? err.message : 'Failed.' });
          }
        });
      }}
      className="grid gap-3 text-sm"
    >
      {done ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-700 ring-1 ring-emerald-200">
          Password changed. Redirecting to sign in…
        </div>
      ) : (
        <>
          {errors._form && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-red-700 ring-1 ring-red-200">
              {errors._form}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Current password
            </label>
            <input
              type="password"
              name="currentPassword"
              required
              autoComplete="current-password"
              className="block w-full rounded-md border-slate-300 px-3 py-2"
            />
            {errors.currentPassword && (
              <p className="mt-0.5 text-xs text-red-600">{errors.currentPassword}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              New password (min 12 chars)
            </label>
            <input
              type="password"
              name="newPassword"
              required
              minLength={12}
              autoComplete="new-password"
              className="block w-full rounded-md border-slate-300 px-3 py-2"
            />
            {errors.newPassword && (
              <p className="mt-0.5 text-xs text-red-600">{errors.newPassword}</p>
            )}
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
          >
            {pending ? 'Changing…' : 'Change password'}
          </button>
        </>
      )}
    </form>
  );
}
