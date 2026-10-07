/**
 * Owner decision 7 (2026-10-07): a customer's status follows its shops.
 *
 *   - A change that closes the customer's last open (ACTIVE) live branch, by any
 *     path — an approved close-shop request, a Manager's or Steward's direct
 *     write, an import — makes the customer CLOSED.
 *   - A change that reopens a branch (to ACTIVE from anything else, or a new
 *     ACTIVE branch) makes the customer ACTIVE: a customer with at least one
 *     ACTIVE branch is ACTIVE. The reactivation path used to make it ACTIVE only
 *     once EVERY branch was; it now follows this same rule.
 *   - Nothing else moves it. The rule runs only on a branch status change in the
 *     same transaction, so it never rewrites a status no change touched, and
 *     closing one of several shops leaves a SUSPENDED customer SUSPENDED (closing
 *     its last open one closes it; reopening one makes it ACTIVE, as a
 *     reactivation always did once every branch was active).
 *   - An archived customer (deletedAt set) is never touched.
 *
 * Every change is audited in the caller's transaction (CLOSE / REACTIVATE on the
 * Customer, with the status before and after), under the customer's row lock
 * that every caller already holds (lib/locks.ts).
 *
 * The status itself is what /customers filters on ("Closed" finds a customer
 * whose every shop is closed, for reactivation); Today, the insights dashboard
 * and the Temix queue read branches or no status at all, so a CLOSED customer
 * stays on its salesman's route and findable.
 */
import { CustomerStatus, type Prisma } from '@prisma/client';
import { writeAudit, type AuditEnvelope } from './audit';

/** What a change did to a customer's branch statuses. */
export type BranchStatusEvents = { closed: boolean; reopened: boolean };

export const NO_STATUS_EVENTS: BranchStatusEvents = { closed: false, reopened: false };

/** One branch's status moving from `from` (null: the branch is new) to `to`. */
export function statusEvents(from: CustomerStatus | null, to: CustomerStatus): BranchStatusEvents {
  return {
    closed: to === CustomerStatus.CLOSED && from !== CustomerStatus.CLOSED,
    reopened: to === CustomerStatus.ACTIVE && from !== CustomerStatus.ACTIVE,
  };
}

export function mergeStatusEvents(a: BranchStatusEvents, b: BranchStatusEvents): BranchStatusEvents {
  return { closed: a.closed || b.closed, reopened: a.reopened || b.reopened };
}

/** The events between two reads of a customer's live branches (id → status). */
export function branchStatusEvents(
  before: ReadonlyMap<string, CustomerStatus>,
  after: ReadonlyMap<string, CustomerStatus>
): BranchStatusEvents {
  let events = NO_STATUS_EVENTS;
  for (const [id, to] of after) {
    const from = before.get(id) ?? null;
    if (from !== to) events = mergeStatusEvents(events, statusEvents(from, to));
  }
  return events;
}

/** Pure: the customer's status once `events` happened to its live branches. */
export function customerStatusFollowing(
  current: CustomerStatus,
  liveBranchStatuses: readonly CustomerStatus[],
  events: BranchStatusEvents
): CustomerStatus {
  if (liveBranchStatuses.length === 0) return current;
  const anyActive = liveBranchStatuses.includes(CustomerStatus.ACTIVE);
  if (events.reopened && anyActive) return CustomerStatus.ACTIVE;
  if (events.closed && !anyActive) return CustomerStatus.CLOSED;
  return current;
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
 */
export async function followBranchStatus(
  tx: Prisma.TransactionClient,
  env: AuditEnvelope,
  customerId: string,
  events: BranchStatusEvents,
  opts: { actorId: string; via: string }
): Promise<{ from: CustomerStatus; to: CustomerStatus } | null> {
  if (!events.closed && !events.reopened) return null;
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
  if (next === customer.status) return null;
  await tx.customer.update({
    where: { id: customerId },
    // B-05: a writer that read this customer before (a versioned updateMany)
    // fails instead of writing over the new status.
    data: { status: next, lastEditedById: opts.actorId, version: { increment: 1 } },
  });
  await writeAudit(tx, env, {
    action: next === CustomerStatus.CLOSED ? 'CLOSE' : 'REACTIVATE',
    entityType: 'Customer',
    entityId: customerId,
    before: { status: customer.status },
    after: { status: next },
    reason: `customer status follows its branches: ${opts.via}`,
  });
  return { from: customer.status, to: next };
}
