'use client';

import { logoutAction } from '@/app/actions/auth';
import { clearDeviceDrafts, countDeviceDrafts } from '@/lib/device-drafts';

/** Asked only when there is something to lose. */
export function signOutDraftsQuestion(n: number): string {
  const [what, it] = n === 1 ? ['1 unsent form is', 'it'] : [`${n} unsent forms are`, 'them'];
  return `${what} saved on this phone. Signing out deletes ${it}, so the next person to use this phone cannot read ${it}. Sign out?`;
}

/**
 * Sign out (TopBar, /profile): logoutAction, after this user's form copies are
 * deleted from the browser (lib/device-drafts.ts). In onSubmit, which runs
 * before the form's action; a prevented submit never reaches it. A tap before
 * hydration posts the form natively and signs out without deleting them.
 */
export function SignOutButton({ userId, className }: { userId: string; className: string }) {
  return (
    <form
      action={logoutAction}
      onSubmit={(e) => {
        const n = countDeviceDrafts(userId);
        if (n > 0 && !window.confirm(signOutDraftsQuestion(n))) {
          e.preventDefault();
          return;
        }
        clearDeviceDrafts(userId);
      }}
    >
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
