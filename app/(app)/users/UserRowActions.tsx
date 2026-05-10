'use client';

import { useState, useTransition } from 'react';
import { toggleUserActiveAction, resetPasswordAction } from '@/services/users';

export function UserRowActions({
  userId,
  username,
  isActive,
}: {
  userId: string;
  username: string;
  isActive: boolean;
}) {
  const [pending, start] = useTransition();
  const [showReset, setShowReset] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  function toggle() {
    if (!confirm(`${isActive ? 'Disable' : 'Enable'} user "${username}"?`)) return;
    const fd = new FormData();
    fd.set('userId', userId);
    start(async () => {
      // PROD-006: action returns `{ ok, code, message, fields? }` shape —
      // last-Manager-lockout and peer-Manager guards must surface to the UI.
      const res = await toggleUserActiveAction(fd);
      if (!res.ok) {
        setResetMsg(
          res.fields ? Object.values(res.fields).join(' ') : res.message
        );
      }
    });
  }

  async function reset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set('userId', userId);
    start(async () => {
      try {
        const res = await resetPasswordAction(fd);
        if (!res.ok) {
          setResetMsg(
            res.fields ? Object.values(res.fields).join(' ') : res.message
          );
          return;
        }
        setResetMsg('Password updated.');
        (e.target as HTMLFormElement).reset();
        setTimeout(() => setShowReset(false), 1200);
      } catch (err) {
        setResetMsg(err instanceof Error ? err.message : 'Failed.');
      }
    });
  }

  return (
    <div className="flex justify-end gap-2 text-xs">
      <button
        type="button"
        disabled={pending}
        onClick={toggle}
        className="rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        {isActive ? 'Disable' : 'Enable'}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setShowReset((s) => !s)}
        className="rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        Reset password
      </button>
      {showReset && (
        <form
          onSubmit={reset}
          className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1"
        >
          <input
            type="password"
            name="password"
            placeholder="New password (12+ chars)"
            minLength={12}
            required
            className="rounded-md border-slate-200 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-brand-600 px-2 py-1 text-xs font-semibold text-white hover:bg-brand-700"
          >
            Save
          </button>
        </form>
      )}
      {resetMsg && <span className="self-center text-emerald-600">{resetMsg}</span>}
    </div>
  );
}
