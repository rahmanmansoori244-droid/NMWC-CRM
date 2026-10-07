/**
 * Owner decision 7 (2026-10-07): the rule by which a customer's status follows
 * its shops — pure, no database and no audit (lib/customer-status.ts applies it
 * in the caller's transaction).
 *
 *   - The last open (ACTIVE) live branch closed makes the customer CLOSED, and so
 *     does a closure that leaves every live branch CLOSED. Closing a SUSPENDED
 *     shop while another stays SUSPENDED closes no open shop and leaves the last
 *     one standing: nothing moves (fixer review).
 *   - A branch reopened (to ACTIVE from anything else, or a new ACTIVE branch)
 *     makes the customer ACTIVE: a customer with at least one ACTIVE branch is
 *     ACTIVE.
 *   - Nothing else moves it: a status no change touched is never rewritten, and
 *     closing one of several shops leaves a SUSPENDED customer SUSPENDED while
 *     another shop is open (a hold a person set is not lifted by a closure).
 */
import { CustomerStatus } from '@prisma/client';

/** What a change did to a customer's branch statuses. */
export type BranchStatusEvents = {
  /** A branch moved to CLOSED, or a new branch is CLOSED. */
  closed: boolean;
  /** Of those, an open (ACTIVE) branch moved to CLOSED: an open shop closed. */
  closedOpen: boolean;
  /** A branch moved to ACTIVE, or a new branch is ACTIVE. */
  reopened: boolean;
};

export const NO_STATUS_EVENTS: BranchStatusEvents = { closed: false, closedOpen: false, reopened: false };

/** One branch's status moving from `from` (null: the branch is new) to `to`. */
export function statusEvents(from: CustomerStatus | null, to: CustomerStatus): BranchStatusEvents {
  return {
    closed: to === CustomerStatus.CLOSED && from !== CustomerStatus.CLOSED,
    closedOpen: to === CustomerStatus.CLOSED && from === CustomerStatus.ACTIVE,
    reopened: to === CustomerStatus.ACTIVE && from !== CustomerStatus.ACTIVE,
  };
}

export function mergeStatusEvents(a: BranchStatusEvents, b: BranchStatusEvents): BranchStatusEvents {
  return {
    closed: a.closed || b.closed,
    closedOpen: a.closedOpen || b.closedOpen,
    reopened: a.reopened || b.reopened,
  };
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

/** The customer's status once `events` happened to its live branches. */
export function customerStatusFollowing(
  current: CustomerStatus,
  liveBranchStatuses: readonly CustomerStatus[],
  events: BranchStatusEvents
): CustomerStatus {
  if (liveBranchStatuses.length === 0) return current;
  const anyActive = liveBranchStatuses.includes(CustomerStatus.ACTIVE);
  if (events.reopened && anyActive) return CustomerStatus.ACTIVE;
  const allClosed = liveBranchStatuses.every((s) => s === CustomerStatus.CLOSED);
  if (!anyActive && (events.closedOpen || (events.closed && allClosed))) return CustomerStatus.CLOSED;
  return current;
}
