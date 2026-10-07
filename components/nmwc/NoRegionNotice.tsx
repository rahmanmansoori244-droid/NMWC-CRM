/**
 * In place of a queue's empty state for a region-scoped approver (Manager,
 * Accountant) whose account has no region. His queue is fail-closed on no
 * managed regions (lib/permissions.ts), so it is empty for a reason, not a quiet
 * day, as the Manager is already told on /dashboard and /users.
 *
 * One sentence for /approvals and /reactivations. The launch browser suite finds
 * it with /no regions? (are |is )?assigned/i and /no (managed )?regions/i
 * (tests/unit/approvals-no-region.test.tsx, reactivations-no-region.test.tsx).
 */
export function NoRegionNotice({ requests }: { requests: string }) {
  return (
    <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
      No regions are assigned to this account, so no {requests} can reach it. Ask the Data Steward
      to assign one: the Steward does it with Edit on your row of the Users page.
    </div>
  );
}
