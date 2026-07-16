/**
 * In-app notification writers (Phase 1). A Notification row existing ⇒ visible
 * in-app; `emailedAt` marks the (future) email batch-drain queue — no drainer
 * exists yet, so rows are in-app only for now.
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

type Tx = Prisma.TransactionClient;

/**
 * Resolve the user ids who should be told a request is now waiting on `step`.
 *
 * SUPERVISOR_OF_SUBMITTER — the submitter's direct supervisor. Region-Manager
 * fallback approvers (RBAC-05-003) are deliberately NOT notified: they can act
 * from their scoped queue, but the supervisor owns the SLA.
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
    case 'SUPERVISOR_OF_SUBMITTER':
      return submitter.supervisorId ? [submitter.supervisorId] : [];
    case 'REGION_OVERLAP': {
      if (regionIds.length === 0) return [];
      const users = await tx.user.findMany({
        where: {
          role: step.role,
          isActive: true,
          managedRegions: { some: { id: { in: regionIds } } },
        },
        select: { id: true },
      });
      return users.map((u) => u.id);
    }
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
