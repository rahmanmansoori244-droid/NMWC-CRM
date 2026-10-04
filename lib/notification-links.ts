/**
 * Where a notification in the inbox (app/(app)/notifications/page.tsx) links to.
 *
 * Its own module so the rule can be tested and so the e-mail digest
 * (lib/email/digest.ts) can follow the same rule: a Next page file may export
 * only what Next expects of a page.
 */
import type { Route } from 'next';
import { Role } from '@prisma/client';

/** Roles allowed onto /approvals/[id] — mirror of the detail page's gate. */
export const APPROVER_ROLES: readonly Role[] = [
  Role.SUPERVISOR,
  Role.MANAGER,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
  Role.GM,
];

/** Kinds about a request someone is to review, or to know of (F1: REQUEST_FYI). */
export const REVIEW_KINDS: readonly string[] = [
  'EDIT_SUBMITTED',
  'EDIT_STAGE_ADVANCED',
  'SLA_BREACH',
  'REQUEST_FYI',
  'REACTIVATION_REQUESTED',
];

/**
 * Deep link per notification, kind- and role-aware:
 *  - a REACTIVATION goes to /reactivations for a Manager, because that is the
 *    only page that decides one (services/edits.ts refuses it on /approvals with
 *    WRONG_LANE). Before F1 a reactivation's SLA breach sent its Manager to
 *    /approvals/[id], a dead end; the inbox now reads edit.isReactivation;
 *  - review-request kinds route APPROVERS to the edit's review page (the
 *    customer profile has a DIFFERENT scope gate and may 404 on a reviewer
 *    who legitimately received the ping — adversarial-review fix). A viewer
 *    who cannot decide the current step (an FYI Accountant, a GM opening a
 *    reactivation) reads it there under a banner saying so (lib/decision-lane.ts);
 *  - everything else lands on the customer profile / the recipient's queue.
 *
 * The return type is checked against the app's routes: any static page, or one
 * of the two dynamic pages named here.
 */
export function hrefFor(
  n: {
    editId: string | null;
    customerId: string | null;
    kind: string;
    edit?: { isReactivation: boolean } | null;
  },
  role: Role
): Route<`/approvals/${string}` | `/customers/${string}`> {
  if (n.kind === 'TEMIX_UPLOAD_READY') return '/temix';
  const isReactivation = n.kind === 'REACTIVATION_REQUESTED' || n.edit?.isReactivation === true;
  if (REVIEW_KINDS.includes(n.kind) && isReactivation && role === Role.MANAGER) {
    return '/reactivations';
  }
  if (n.editId && REVIEW_KINDS.includes(n.kind) && APPROVER_ROLES.includes(role)) {
    return `/approvals/${n.editId}`;
  }
  if (n.customerId) return `/customers/${n.customerId}`;
  return '/work';
}
