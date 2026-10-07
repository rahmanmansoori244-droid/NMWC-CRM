/**
 * F1 (2026-10-05): who in the salesman's hierarchy is told of his request, and
 * the one writer for those rows.
 *
 * Alongside lib/notifications.ts, not inside it: resolveStepAudience drives every
 * existing step, step-back and create-submit audience and is pinned by
 * tests/unit/create-flow.test.ts, so its meaning does not change here. The policy
 * (who, for which event) is lib/notify-policy.ts; this module only reads the
 * hierarchy and writes rows through notifyUsers, on the client it is given — the
 * caller's transaction wherever there is one, so a row commits only with the
 * request that caused it and a lost race or a refused insert leaves none.
 *
 * Every lookup reads the User table directly: the reference-data cache of the
 * hierarchy (lib/reference-data.ts getAllHierarchyUsers) can be minutes stale and
 * would name a just-disabled account. Every role filter is an allowlist and every
 * region filter fails closed (no region ⇒ nobody), so a GM, a Steward, a Viewer or
 * another salesman can never be selected here.
 *
 * PII posture as lib/notifications.ts: a title and a body with the customer's
 * legal name, its code and nothing else. The salesman's free-text reason
 * (CustomerEdit.decisionReason on a close or reactivation request) is never
 * copied into a notification.
 */
import { Role, type NotificationKind, type Prisma } from '@prisma/client';
import { logger } from './logger';
import { notifyUsers, supervisorWhoCanAct } from './notifications';
import { FYI_POLICY, type SalesmanRequestEvent } from './notify-policy';

type Db = Prisma.TransactionClient;

/** Active holders of `role` who manage `regionId`. No region ⇒ nobody. */
async function regionRoleHolders(db: Db, role: Role, regionId: string | null): Promise<string[]> {
  if (!regionId) return [];
  const users = await db.user.findMany({
    where: { role, isActive: true, managedRegions: { some: { id: regionId } } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** The region's active Managers. */
export function regionManagers(db: Db, regionId: string | null): Promise<string[]> {
  return regionRoleHolders(db, Role.MANAGER, regionId);
}

/** The region's active Accountants (one per region in this organisation). */
export function regionAccountants(db: Db, regionId: string | null): Promise<string[]> {
  return regionRoleHolders(db, Role.ACCOUNTANT, regionId);
}

/**
 * The salesman's supervisor, if he can act on a Supervisor-step request in
 * `regionId`: active, and a SUPERVISOR (who acts as the submitter's supervisor)
 * or a MANAGER who manages the region (canApproveSpecificEdit refuses a Manager
 * outside it, and the request's page 404s for him). `managerOnly` narrows it to a
 * Manager over the region: a reactivation is decided by a Manager only. One rule
 * with the UPDATE and CREATE Supervisor step (lib/notifications.ts supervisorWhoCanAct).
 */
export function eligibleSupervisor(
  db: Db,
  supervisorId: string | null,
  regionId: string | null,
  opts: { managerOnly?: boolean } = {}
): Promise<string | null> {
  return supervisorWhoCanAct(db, supervisorId, regionId ? [regionId] : [], opts);
}

export type RequestAudience = {
  /** Who must act and is told so here (CLOSE and REACTIVATION; the caller tells UPDATE/CREATE's). */
  mustAct: string[];
  /** Who is told for information (REQUEST_FYI). */
  fyi: string[];
};

/**
 * Who is told of one salesman request. Pure of writes, so tests can ask it.
 *
 * `alreadyTold` is the must-act audience the caller has already notified (the
 * existing EDIT_SUBMITTED of UPDATE and CREATE), so nobody gets both an action
 * row and an FYI row for one request.
 */
export async function resolveRequestAudience(
  db: Db,
  input: {
    event: SalesmanRequestEvent;
    submitter: { id: string; supervisorId: string | null };
    regionId: string | null;
    alreadyTold?: string[];
  }
): Promise<RequestAudience> {
  const { event, submitter, regionId } = input;
  let mustAct: string[] = [];
  if (event === 'CLOSE' || event === 'REACTIVATION') {
    const sup = await eligibleSupervisor(db, submitter.supervisorId, regionId, {
      managerOnly: event === 'REACTIVATION',
    });
    mustAct = sup ? [sup] : await regionManagers(db, regionId);
    // The gap is worth knowing even when the fallback covers it (ids and counts
    // only). A Supervisor cannot decide a reactivation by design, so for one his
    // being a Supervisor is not a gap; a missing or unusable supervisor is.
    if (
      !sup &&
      (event === 'CLOSE' || !(await eligibleSupervisor(db, submitter.supervisorId, regionId)))
    ) {
      logger.warn(
        { event, supervisorId: submitter.supervisorId, managersTold: mustAct.length },
        'notify.request.supervisor_cannot_act'
      );
    }
  }
  // Separation of duty: a submitter is never asked to act on his own request
  // (a Manager who also holds a salesman account is two accounts, but never one).
  mustAct = [...new Set(mustAct)].filter((id) => id !== submitter.id);

  const exclude = new Set([...mustAct, ...(input.alreadyTold ?? []), submitter.id]);
  const fyiIds: string[] = [];
  if (FYI_POLICY.accountants[event]) fyiIds.push(...(await regionAccountants(db, regionId)));
  if (FYI_POLICY.regionManagers) fyiIds.push(...(await regionManagers(db, regionId)));
  const fyi = [...new Set(fyiIds)].filter((id) => !exclude.has(id));
  return { mustAct, fyi };
}

/** What the in-app rows say: the customer's legal name and code, never more. */
export type RequestSubject = {
  legalName: string;
  /** Null for a new-customer request: the code is minted at finalize. */
  nmwcCode: string | null;
};

const WHAT: Record<SalesmanRequestEvent, string> = {
  UPDATE: 'changes submitted for approval',
  CREATE: 'new customer request submitted',
  CLOSE: 'close-shop request submitted',
  REACTIVATION: 'reactivation request submitted',
};

function named(subject: RequestSubject): string {
  return subject.nmwcCode ? `${subject.legalName} (${subject.nmwcCode})` : subject.legalName;
}

/**
 * Write the rows for one salesman request: the must-act rows of a close or a
 * reactivation, and the FYI rows of every request. Returns who was told.
 *
 * Runs on the caller's client. CREATE, CLOSE and REACTIVATION pass their
 * transaction, so the rows commit with the request and a throw here fails the
 * submit (as the CREATE notification always has). UPDATE passes the pooled
 * client inside its existing best-effort try/catch (services/edits.ts), because
 * its insert autocommits before any notification.
 */
export async function notifySalesmanRequest(
  db: Db,
  input: {
    event: SalesmanRequestEvent;
    submitter: { id: string; supervisorId: string | null };
    regionId: string | null;
    editId: string;
    customerId?: string | null;
    subject: RequestSubject;
    alreadyTold?: string[];
  }
): Promise<RequestAudience> {
  const audience = await resolveRequestAudience(db, input);
  const customerId = input.customerId ?? undefined;
  if (audience.mustAct.length > 0) {
    const reactivation = input.event === 'REACTIVATION';
    const kind: NotificationKind = reactivation ? 'REACTIVATION_REQUESTED' : 'EDIT_SUBMITTED';
    await notifyUsers(db, audience.mustAct, {
      kind,
      title: reactivation ? 'Reactivation awaiting your decision' : 'Close-shop request awaiting your review',
      body: `${named(input.subject)} — ${reactivation ? 'a salesman asked to reopen a closed branch' : 'a salesman asked to close a branch'}.`,
      editId: input.editId,
      customerId,
    });
  }
  if (audience.fyi.length > 0) {
    await notifyUsers(db, audience.fyi, {
      kind: 'REQUEST_FYI',
      title: 'For your information: a salesman request',
      body: `${named(input.subject)} — ${WHAT[input.event]}.`,
      editId: input.editId,
      customerId,
    });
  }
  return audience;
}
