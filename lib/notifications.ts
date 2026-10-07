/**
 * In-app notification writers (Phase 1). A Notification row existing ⇒ visible
 * in-app; a row with `emailedAt` NULL is also waiting in the e-mail outbox, which
 * app/api/cron/email-drain drains after commit (F1, 2026-10-05; lib/email/). The
 * e-mail is built from the row's kind and editId only, never its title or body,
 * and goes only to allowlisted roles (lib/notify-policy.ts EMAIL_ROLES).
 * A salesman's request writes its hierarchy's rows through lib/notify-hierarchy.ts.
 *
 * All writers are transaction-composable: they take the caller's
 * `Prisma.TransactionClient` so a notification is only committed when the
 * state transition that caused it commits (the approve/reject/submit paths all
 * use atomic-claim updateMany; notifying outside the tx would fire on a LOST
 * race).
 *
 * PII posture: titles/bodies carry legalName + nmwcCode + a deep link ONLY —
 * never phone numbers or CR numbers (schema comment on Notification).
 */
import { Role, type NotificationKind, type Prisma } from '@prisma/client';
import type { ApprovalStep } from './approval-chains';
import { logger } from './logger';
import { SUPERVISING_ROLES } from './notify-policy';

type Tx = Prisma.TransactionClient;

/** Active holders of `role` who manage one of `regionIds`. No region ⇒ nobody. */
async function activeHoldersOver(tx: Tx, role: Role, regionIds: readonly string[]): Promise<string[]> {
  if (regionIds.length === 0) return [];
  const users = await tx.user.findMany({
    where: {
      role,
      isActive: true,
      managedRegions: { some: { id: { in: [...regionIds] } } },
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * The submitter's supervisor, if he can act on a Supervisor-step request over
 * `regionIds`: active, and a SUPERVISOR (who acts as the submitter's supervisor)
 * or a MANAGER who manages one of the regions (canApproveSpecificEdit refuses a
 * Manager outside them, and the request's page 404s for him). `managerOnly`
 * narrows it to such a Manager: a reactivation is decided by a Manager only.
 * Read from the User table, never a cache: a just-disabled account must not be named.
 */
export async function supervisorWhoCanAct(
  tx: Tx,
  supervisorId: string | null,
  regionIds: readonly string[],
  opts: { managerOnly?: boolean } = {}
): Promise<string | null> {
  if (!supervisorId) return null;
  const sup = await tx.user.findUnique({
    where: { id: supervisorId },
    select: { id: true, role: true, isActive: true, managedRegions: { select: { id: true } } },
  });
  if (!sup || !sup.isActive || !SUPERVISING_ROLES.includes(sup.role)) return null;
  if (sup.role === Role.SUPERVISOR) return opts.managerOnly ? null : sup.id;
  // A MANAGER: only over one of the request's regions.
  if (!sup.managedRegions.some((r) => regionIds.includes(r.id))) return null;
  return sup.id;
}

/**
 * Resolve the user ids who should be told a request is now waiting on `step`.
 *
 * SUPERVISOR_OF_SUBMITTER — the submitter's direct supervisor, when he can act
 * on it (supervisorWhoCanAct). Region-Manager fallback approvers (RBAC-05-003)
 * are not notified while he can: they can act from their scoped queue, but the
 * supervisor owns the SLA. When he cannot — no supervisorId, a disabled account,
 * a role that cannot approve, a Manager of other regions — every active MANAGER
 * of the request's regions is told instead, the same fallback canActOnStep lets
 * act, and the gap is logged (launch fix 2026-10-07: before, the row went to the
 * stored supervisorId as it stood, or to nobody, and the request waited for the
 * SLA sweep).
 * REGION_OVERLAP — active holders of the step role whose managedRegions
 * overlap the request's branch regions (Accountants share the ManagerRegions
 * M:N). Fail-closed: no regions ⇒ nobody (matches canActOnStep).
 * GLOBAL — every active holder of the step role (Finance Manager / GM).
 */
export async function resolveStepAudience(
  tx: Tx,
  step: Pick<ApprovalStep, 'role' | 'scope'>,
  submitter: { supervisorId: string | null },
  regionIds: string[]
): Promise<string[]> {
  switch (step.scope) {
    case 'SUPERVISOR_OF_SUBMITTER': {
      const sup = await supervisorWhoCanAct(tx, submitter.supervisorId, regionIds);
      if (sup) return [sup];
      const managers = await activeHoldersOver(tx, Role.MANAGER, regionIds);
      // Ids and counts only: the log names no customer and no person.
      logger.warn(
        { supervisorId: submitter.supervisorId, regions: regionIds.length, managersTold: managers.length },
        'notify.supervisor_step.supervisor_cannot_act'
      );
      return managers;
    }
    case 'REGION_OVERLAP':
      return activeHoldersOver(tx, step.role, regionIds);
    case 'GLOBAL': {
      const users = await tx.user.findMany({
        where: { role: step.role, isActive: true },
        select: { id: true },
      });
      return users.map((u) => u.id);
    }
  }
}

/** Active Stewards — the Temix-upload audience for EDIT_APPROVED_FINAL. */
export async function resolveStewardAudience(tx: Tx): Promise<string[]> {
  const users = await tx.user.findMany({
    where: { role: Role.STEWARD, isActive: true },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * Write one Notification row per (deduped) user. Silently no-ops on an empty
 * audience — an unassigned supervisor or an empty region is a queue-visibility
 * problem, not a crash.
 */
export async function notifyUsers(
  tx: Tx,
  userIds: string[],
  data: {
    kind: NotificationKind;
    title: string;
    body: string;
    editId?: string;
    customerId?: string;
  }
): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return;
  await tx.notification.createMany({
    data: unique.map((userId) => ({ userId, ...data })),
  });
}
