'use client';

import { logoutAction } from '@/app/actions/auth';
import { announceSignOut, clearDeviceDrafts, countDeviceDrafts } from '@/lib/device-drafts';

/**
 * Asked only when there is something to lose. "Device", not "phone": Managers
 * and Stewards keep copies too, mostly on a desktop browser.
 */
export function signOutDraftsQuestion(n: number): string {
  const [what, it] = n === 1 ? ['1 unsent form is', 'it'] : [`${n} unsent forms are`, 'them'];
  return `${what} saved on this device. Signing out deletes ${it}, so the next person to use this device cannot read ${it}. Sign out?`;
}

/**
 * Sign out (TopBar, /profile): logoutAction, after this user's form copies are
 * deleted from the browser (lib/device-drafts.ts). In onSubmit, which runs
 * before the form's action; a prevented submit never reaches it. The forms on
 * screen are told first, so none writes its copy back while logoutAction is on
 * its way. A tap before hydration posts the form natively and signs out without
 * deleting them.
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
        announceSignOut();
        clearDeviceDrafts(userId);
      }}
    >
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
