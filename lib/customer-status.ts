/**
 * Owner decision 7 (2026-10-07): a customer's status follows its shops.
 *
 *   - A change that closes the customer's last open (ACTIVE) live branch, by any
 *     path — an approved close-shop request, a Manager's or Steward's direct
 *     write, an import — makes the customer CLOSED; so does one that leaves
 *     every live branch CLOSED.
 *   - A change that reopens a branch (to ACTIVE from anything else, or a new
 *     ACTIVE branch, a duplicate merge's included) makes the customer ACTIVE: a
 *     customer with at least one ACTIVE branch is ACTIVE. The reactivation path
 *     used to make it ACTIVE only once EVERY branch was; it now follows this
 *     same rule.
 *   - Nothing else moves it. The rule runs only on a branch status change in the
 *     same transaction, so it never rewrites a status no change touched, and
 *     closing one of several shops leaves a SUSPENDED customer SUSPENDED while
 *     another is open. The rule itself is pure, in lib/customer-status-rule.ts.
 *   - An archived customer (deletedAt set) is never touched.
 *
 * Every change is audited in the caller's transaction (CLOSE / REACTIVATE on the
 * Customer, with the status before and after), under the customer's row lock
 * that every caller already holds (lib/locks.ts).
 *
 * The status itself is what /customers filters on ("Closed" finds a customer
 * whose every shop is closed, for reactivation); Today, the insights dashboard
 * and the Temix queue read branches or no status at all, so a CLOSED customer
 * stays on its salesman's route and findable. Customers whose status already
 * contradicted their branches before this shipped are listed, and on the
 * owner's word moved, by scripts/ops/customer-status-drift.ts.
 */
import { CustomerStatus, type AuditAction, type Prisma } from '@prisma/client';
import { writeAudit, type AuditEnvelope } from './audit';
import { customerStatusFollowing, type BranchStatusEvents } from './customer-status-rule';

export {
  NO_STATUS_EVENTS,
  branchStatusEvents,
  customerStatusFollowing,
  mergeStatusEvents,
  statusEvents,
  type BranchStatusEvents,
} from './customer-status-rule';

/** The audit action for a customer status move: CLOSE, REACTIVATE, or UPDATE (a hold). */
export function statusAuditAction(to: CustomerStatus): AuditAction {
  if (to === CustomerStatus.CLOSED) return 'CLOSE';
  if (to === CustomerStatus.ACTIVE) return 'REACTIVATE';
  return 'UPDATE';
}

/** The customer's live branches' statuses, by branch id. */
export async function liveBranchStatuses(
  tx: Prisma.TransactionClient,
  customerId: string
): Promise<Map<string, CustomerStatus>> {
  const rows = await tx.branch.findMany({
    where: { customerId, deletedAt: null },
    select: { id: true, status: true },
  });
  return new Map(rows.map((b) => [b.id, b.status]));
}

/**
 * In the caller's transaction, after its branch writes: move the customer's
 * status as its branches now say, and audit the move. Returns it, or null when
 * nothing moved (no event, an archived or missing customer, or the status
 * already right).
 *
 * `statusBefore`: the status the caller read under the lock before its own
 * writes, given by a caller that may already have written the status itself in
 * this transaction (the import's file-stated status, item 20). The audit row
 * then covers the whole move, once, from that status to the final one — written
 * even when the rule moved nothing and the caller's own write did.
 */
export async function followBranchStatus(
  tx: Prisma.TransactionClient,
  env: AuditEnvelope,
  customerId: string,
  events: BranchStatusEvents,
  opts: { actorId: string; via: string; statusBefore?: CustomerStatus }
): Promise<{ from: CustomerStatus; to: CustomerStatus } | null> {
  if (!events.closed && !events.reopened && opts.statusBefore === undefined) return null;
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: {
      status: true,
      deletedAt: true,
      branches: { where: { deletedAt: null }, select: { status: true } },
    },
  });
  if (!customer || customer.deletedAt) return null;
  const next = customerStatusFollowing(
    customer.status,
    customer.branches.map((b) => b.status),
    events
  );
  if (next !== customer.status) {
    await tx.customer.update({
      where: { id: customerId },
      // B-05: a writer that read this customer before (a versioned updateMany)
      // fails instead of writing over the new status.
      data: { status: next, lastEditedById: opts.actorId, version: { increment: 1 } },
    });
  }
  const from = opts.statusBefore ?? customer.status;
  if (next === from) return null;
  await writeAudit(tx, env, {
    action: statusAuditAction(next),
    entityType: 'Customer',
    entityId: customerId,
    before: { status: from },
    after: { status: next },
    reason: `customer status follows its branches: ${opts.via}`,
  });
  return { from, to: next };
}
