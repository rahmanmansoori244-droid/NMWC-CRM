'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
// X-AUTH-1: a module holding this ONE action. Next gives this page every action
// of each 'use server' module it imports, and a session that must change its
// password can reach this page — so never import a multi-action module here.
import { changeOwnPasswordAction } from '@/services/password';
import { hardReplace } from '@/lib/navigate';

const OWN_PATH = '/profile/change-password';

// The forced first-sign-in change took the new password once, masked. A typo on
// a phone keyboard was saved as typed, the action revoked the session (AUTH-12)
// and sent the user to /login with a password nobody knows: an account only a
// Manager reset recovers. So the new password is typed twice and can be shown.
// services/password.ts refuses the same mismatch with the same words.
const MISMATCH = 'The two new passwords do not match.';

// Shown as text, a phone keyboard treats the password as prose: it capitalises
// the first letter, autocorrects words, and a cloud spell-checker is sent it.
// Masked, browsers do none of that, so these matter only once Show is on.
const AS_TYPED = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

export function ChangePasswordForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Where the page goes once the password has changed (services/password.ts
  // renewOwnSession): home on the renewed session, or sign in again.
  const [done, setDone] = useState<'home' | 'signIn' | null>(null);
  const [showNew, setShowNew] = useState(false);
  // UAT-07, as LabeledField does: with two new-password boxes on the page, a
  // label not tied to its field leaves a screen reader three unnamed passwords.
  const id = useId();

  // AUTH-09 hardening (go-live walk, 2026-09-10): when the middleware forces
  // this page onto a must-change user during a CLIENT navigation (they tapped
  // Today / Customers in the nav), the router renders this page but keeps the
  // original URL. A server action then POSTs to that URL, the middleware
  // redirects the POST, and the form fails with "unexpected response". Put the
  // address bar right before the user can submit.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.pathname !== OWN_PATH) {
      router.replace(OWN_PATH);
    }
  }, [router]);

  return (
    <form
      // The mismatch is refused here, not in `action`: React resets every
      // uncontrolled field after a form action runs, so refusing inside it would
      // wipe what the user typed, the current password too, and leave nothing for
      // Show to reveal. A prevented submit never reaches the action.
      onSubmit={(e) => {
        const fd = new FormData(e.currentTarget);
        if (fd.get('newPassword') !== fd.get('confirmNewPassword')) {
          e.preventDefault();
          setErrors({ confirmNewPassword: MISMATCH });
        }
      }}
      action={(fd) => {
        setErrors({});
        start(async () => {
          try {
            // PROD-006: server actions return `{ ok, code, message, fields? }`
            // shape — see lib/errors.ts (runAction).
            const res = await changeOwnPasswordAction(fd);
            if (!res.ok) {
              if (res.fields) setErrors(res.fields);
              else setErrors({ _form: res.message });
              return;
            }
            // AUTH-12: the action bumps sessionsRevokedAt and has given this
            // browser a new session, made with the new password
            // (services/password.ts renewOwnSession). It went to /login, which
            // made the user sign in again, and the old cookie, still flagged,
            // sent any tap back to this page. `/` is the role's home. When the
            // action had to sign this browser out instead, the page says so and
            // goes to /login, with time to read it. A document load, so nothing
            // on screen is from before the change.
            const renewed = res.data.renewed;
            setDone(renewed ? 'home' : 'signIn');
            setTimeout(() => hardReplace(renewed ? '/' : '/login'), renewed ? 1500 : 4000);
          } catch (err) {
            setErrors({ _form: err instanceof Error ? err.message : 'Failed.' });
          }
        });
      }}
      // The fields inherit this text-sm (preflight), and iOS Safari zooms the
      // page into any field under 16 px, so each one is text-base below sm.
      className="grid gap-3 text-sm"
    >
      {done ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-700 ring-1 ring-emerald-200">
          {done === 'home'
            ? 'Password changed. Taking you to your home page…'
            : 'Password changed. Please sign in again with your new password. Taking you to the sign-in page…'}
        </div>
      ) : (
        <>
          {errors._form && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-red-700 ring-1 ring-red-200">
              {errors._form}
            </div>
          )}
          <div>
            <label
              htmlFor={`${id}-current`}
              className="mb-1 block text-xs font-medium text-slate-700"
            >
              Current password
            </label>
            <input
              id={`${id}-current`}
              type="password"
              name="currentPassword"
              required
              autoComplete="current-password"
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-base sm:text-sm"
            />
            {errors.currentPassword && (
              <p className="mt-0.5 text-xs text-red-600">{errors.currentPassword}</p>
            )}
          </div>
          <div>
            <label htmlFor={`${id}-new`} className="mb-1 block text-xs font-medium text-slate-700">
              New password (min 12 chars)
            </label>
            <input
              id={`${id}-new`}
              type={showNew ? 'text' : 'password'}
              name="newPassword"
              required
              minLength={12}
              autoComplete="new-password"
              {...AS_TYPED}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-base sm:text-sm"
            />
            {errors.newPassword && (
              <p className="mt-0.5 text-xs text-red-600">{errors.newPassword}</p>
            )}
          </div>
          <div>
            <label
              htmlFor={`${id}-confirm`}
              className="mb-1 block text-xs font-medium text-slate-700"
            >
              Confirm new password
            </label>
            <input
              id={`${id}-confirm`}
              type={showNew ? 'text' : 'password'}
              name="confirmNewPassword"
              required
              autoComplete="new-password"
              {...AS_TYPED}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-base sm:text-sm"
            />
            {errors.confirmNewPassword && (
              <p role="alert" className="mt-0.5 text-xs text-red-600">
                {errors.confirmNewPassword}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-pressed={showNew}
            onClick={() => setShowNew((s) => !s)}
            className="justify-self-start rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 aria-pressed:bg-slate-100"
          >
            Show new password
          </button>
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
