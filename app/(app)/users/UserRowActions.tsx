'use client';

import { createContext, useContext, useState, useTransition } from 'react';
import Link from 'next/link';
import { toggleUserActiveAction, resetPasswordAction, updateUserEmailAction } from '@/services/users';

// Go-live: a successful Disable used to confirm itself — the row stayed put, the
// badge flipped to Disabled and the button flipped to Enable, one click from undo.
// With the list defaulting to Active the row LEAVES on success: the action calls
// revalidatePath('/users'), the filter drops the row and this component unmounts,
// so a message held in the row can never be read, and a disable that silently
// failed looks exactly like one that worked. The banner therefore lives above the
// table: the provider keeps its position in the tree across the refresh, so its
// state survives the re-render that removes the row.
const AnnounceContext = createContext<(msg: string) => void>(() => {});

// Reset password took the new password once, masked: a Manager's typo handed the
// salesman a password nobody knew, and only another reset recovered the account.
// So it is typed twice, compared here before anything is sent, and can be shown.
// resetPasswordAction checks only the length; the comparison is this form's.
const MISMATCH = 'The two new passwords do not match.';

// Shown as text, a keyboard treats the password as prose: it capitalises the
// first letter, autocorrects words, and a cloud spell-checker is sent it. Masked,
// browsers do none of that, so these matter only once Show is on.
const AS_TYPED = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

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

/** A refusal's words: the field messages when there are any (a ValidationError's
 * message is only "Validation failed"), else the message. */
function refusalText(res: { message: string; fields?: Record<string, string> }): string {
  return res.fields ? Object.values(res.fields).join(' ') : res.message;
}

export function UserRowActions({
  userId,
  username,
  isActive,
  canEditEmail = false,
  hasEmail = false,
  isSelf = false,
}: {
  userId: string;
  username: string;
  isActive: boolean;
  /** F1: the Steward's e-mail edit (services/users.ts updateUserEmailAction). */
  canEditEmail?: boolean;
  /** Whether an address is on file. The address itself never reaches the browser. */
  hasEmail?: boolean;
  /**
   * The viewer's own row. Disable and Reset password always refuse one's own
   * account (lib/permissions.ts canMutateUser), so they are not offered; the
   * row points at the self-service page instead.
   */
  isSelf?: boolean;
}) {
  const [pending, start] = useTransition();
  const [showEmail, setShowEmail] = useState(false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  // Launch fix: every refusal (own account, last active Manager, a reused
  // password, an account outside the Manager's regions) used to land here and
  // render in the same green as "Password updated.", so a refused helpdesk reset
  // read as done. `ok` decides the colour and the role.
  const [resetMsg, setResetMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [resetMismatch, setResetMismatch] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
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
        setResetMsg({ text: refusalText(res), ok: false });
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
    if (fd.get('password') !== fd.get('confirmPassword')) {
      // A "Password updated." left from an earlier reset must not sit beside it.
      setResetMsg(null);
      setResetMismatch(true);
      return;
    }
    setResetMismatch(false);
    fd.set('userId', userId);
    start(async () => {
      try {
        const res = await resetPasswordAction(fd);
        if (!res.ok) {
          setResetMsg({ text: refusalText(res), ok: false });
          return;
        }
        setResetMsg({ text: 'Password updated.', ok: true });
        (e.target as HTMLFormElement).reset();
        setTimeout(() => setShowReset(false), 1200);
      } catch (err) {
        setResetMsg({ text: err instanceof Error ? err.message : 'Failed.', ok: false });
      }
    });
  }

  // F1: set or clear the address work e-mails go to. The box starts empty, and the
  // stored value is never sent here (RBAC-05-023): typing replaces it, an empty
  // box clears it, which the button's words say before anything is sent.
  async function saveEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const typed = String(fd.get('contactAddress') ?? '').trim();
    if (typed === '' && !hasEmail) {
      setEmailMsg('Type the address to add.');
      return;
    }
    if (typed === '' && !confirm(`Clear the e-mail address of "${username}"? Work e-mails stop reaching them.`)) {
      return;
    }
    fd.set('userId', userId);
    start(async () => {
      const res = await updateUserEmailAction(fd);
      if (!res.ok) {
        setEmailMsg(refusalText(res));
        return;
      }
      setEmailMsg(null);
      setShowEmail(false);
      announce(typed === '' ? `Cleared the e-mail of "${username}".` : `Saved the e-mail of "${username}".`);
    });
  }

  if (isSelf) {
    return (
      <div className="flex flex-wrap justify-end gap-2 text-xs">
        <Link
          href="/profile/change-password"
          className="rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100"
        >
          Change my password
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-2 text-xs">
      {canEditEmail && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setShowEmail((s) => !s);
            setEmailMsg(null);
          }}
          className="rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {hasEmail ? 'Change e-mail' : 'Add e-mail'}
        </button>
      )}
      {canEditEmail && showEmail && (
        <form
          onSubmit={saveEmail}
          autoComplete="off"
          className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1"
        >
          <input
            type="text"
            name="contactAddress"
            inputMode="email"
            autoComplete="off"
            maxLength={200}
            aria-label={`New e-mail for ${username}`}
            placeholder={hasEmail ? 'New address (empty clears it)' : 'name@company.com'}
            {...AS_TYPED}
            className="w-56 rounded-md border-slate-200 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-brand-600 px-2 py-1 text-xs font-semibold text-white hover:bg-brand-700"
          >
            Save
          </button>
          {emailMsg && (
            <span role="alert" className="text-left text-red-600">
              {emailMsg}
            </span>
          )}
        </form>
      )}
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
        onClick={() => {
          // Reopened, the box starts masked and without the last attempt's error.
          setShowReset((s) => !s);
          setResetMismatch(false);
          setShowResetPassword(false);
        }}
        className="rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        Reset password
      </button>
      {showReset && (
        <form
          onSubmit={reset}
          className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1"
        >
          <div className="grid gap-1">
            <input
              type={showResetPassword ? 'text' : 'password'}
              name="password"
              autoComplete="new-password"
              placeholder="New password (12+ chars)"
              minLength={12}
              required
              {...AS_TYPED}
              className="rounded-md border-slate-200 px-2 py-1 text-xs"
            />
            <input
              type={showResetPassword ? 'text' : 'password'}
              name="confirmPassword"
              autoComplete="new-password"
              placeholder="Confirm new password"
              required
              {...AS_TYPED}
              className="rounded-md border-slate-200 px-2 py-1 text-xs"
            />
            {resetMismatch && (
              <span role="alert" className="text-left text-red-600">
                {MISMATCH}
              </span>
            )}
          </div>
          <button
            type="button"
            aria-pressed={showResetPassword}
            aria-label="Show new password"
            onClick={() => setShowResetPassword((s) => !s)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 aria-pressed:bg-slate-100"
          >
            Show
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-brand-600 px-2 py-1 text-xs font-semibold text-white hover:bg-brand-700"
          >
            Save
          </button>
        </form>
      )}
      {resetMsg && (
        <span
          role={resetMsg.ok ? 'status' : 'alert'}
          className={`self-center ${resetMsg.ok ? 'text-emerald-600' : 'font-medium text-red-600'}`}
        >
          {resetMsg.text}
        </span>
      )}
    </div>
  );
}
