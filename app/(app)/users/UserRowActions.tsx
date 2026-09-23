'use client';

import { createContext, useContext, useState, useTransition } from 'react';
import { toggleUserActiveAction, resetPasswordAction } from '@/services/users';

// Go-live: a successful Disable used to confirm itself — the row stayed put, the
// badge flipped to Disabled and the button flipped to Enable, one click from undo.
// With the list defaulting to Active the row LEAVES on success: the action calls
// revalidatePath('/users'), the filter drops the row and this component unmounts,
// so a message held in the row can never be read, and a disable that silently
// failed looks exactly like one that worked. The banner therefore lives above the
// table: the provider keeps its position in the tree across the refresh, so its
// state survives the re-render that removes the row.
const AnnounceContext = createContext<(msg: string) => void>(() => {});

export function UsersFeedback({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <AnnounceContext.Provider value={setMsg}>
      {msg && (
        <div
          role="status"
          className="mx-4 mt-4 flex items-start justify-between gap-3 rounded-md bg-emerald-50 px-4 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200 sm:mx-6"
        >
          <span>{msg}</span>
          <button
            type="button"
            onClick={() => setMsg(null)}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      )}
      {children}
    </AnnounceContext.Provider>
  );
}

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
  const announce = useContext(AnnounceContext);

  function toggle() {
    // The dialog says where the row goes, because on the Active list it goes
    // away: an operator reaching for the adjacent "Reset password" and confirming
    // out of habit otherwise has nothing on screen naming what they just did.
    const question = isActive
      ? `Disable user "${username}"? They can no longer sign in, and the row leaves the Active list.`
      : `Enable user "${username}"?`;
    if (!confirm(question)) return;
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
        return;
      }
      announce(
        isActive
          ? `Disabled "${username}". It is on the Disabled tab, where Enable puts it back.`
          : `Enabled "${username}".`
      );
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
            autoComplete="new-password"
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
