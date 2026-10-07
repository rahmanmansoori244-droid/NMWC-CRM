/**
 * F1 fixer review (2026-10-05): what the bell counts.
 *
 * The bell (components/nmwc/TopBar.tsx) is the only in-app alert, and its red
 * count has always meant "something waits on you": before F1 an Accountant's
 * rows were must-act rows and SLA rows. F1 writes him a REQUEST_FYI row for
 * every salesman request in his region (lib/notify-policy.ts FYI_POLICY), which
 * in the red count would hold it at "9+" all day; and the only way to clear it,
 * "Mark all read", would also mark his unread must-act rows read, and a read row
 * is never e-mailed (lib/email/eligibility.ts SKIPPED_READ). So the kinds in
 * BELL_INFORMATION_KINDS are counted apart, as a muted second count, and
 * /notifications can mark them read on their own.
 *
 * Pure: the layout reads one grouped count per page render and this splits it.
 *
 * By role (launch fix 2026-10-07): a salesman's progress pings ("advanced",
 * "approved") were red although they need nothing of him, while the same kinds
 * ask an approver to act (lib/notify-policy.ts bellInformationKinds).
 */
import type { Role } from '@prisma/client';
import { bellInformationKinds } from './notify-policy';

export type BellCounts = {
  /** Unread rows that may ask him to act: the red badge. */
  action: number;
  /** Unread rows that only inform: the muted count. */
  information: number;
};

export function splitBellCounts(
  byKind: ReadonlyArray<{ kind: string; count: number }>,
  role: Role
): BellCounts {
  const info = bellInformationKinds(role) as readonly string[];
  let action = 0;
  let information = 0;
  for (const { kind, count } of byKind) {
    if (info.includes(kind)) information += count;
    else action += count;
  }
  return { action, information };
}

/** The bell's accessible name: both counts, in words. */
export function bellLabel({ action, information }: BellCounts): string {
  const parts = [
    ...(action > 0 ? [`${action} unread`] : []),
    ...(information > 0 ? [`${information} for information`] : []),
  ];
  return parts.length > 0 ? `Notifications (${parts.join(', ')})` : 'Notifications';
}
