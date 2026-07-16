/**
 * SLA escalation-target plan (Phase 1 SLA increment).
 *
 * Escalation NOTIFIES, never auto-reassigns or mutates workflow state: the
 * approver of record still acts (the OLD system force-flipped breached
 * requests to an ESCALATED status — deliberately not ported, so the atomic
 * claim + separation-of-duty invariants stay untouched).
 *
 * Chain ([Open — owner to confirm], blueprint §8.1 proposal):
 *   SUPERVISOR breached  → the MANAGER(s) of the request's regions
 *                          (fallback: all active MANAGERs), L2 adds GM
 *   MANAGER (reactivation) → GM; L2 adds STEWARD
 *   ACCOUNTANT breached  → FINANCE_MANAGER + GM; L2 adds STEWARD
 *   FINANCE_MANAGER      → GM; L2 adds STEWARD
 *   GM breached          → all MANAGERs + STEWARD (visibility only — nobody
 *                          outranks GM); L2 identical
 */
import { Role } from '@prisma/client';

export type EscalationPlan = {
  /** Roles resolved region-scoped against the request's regions (fallback: all active holders). */
  regionScopedRoles: Role[];
  /** Roles resolved org-wide (all active holders). */
  globalRoles: Role[];
};

export function escalationPlan(pendingRole: Role | null, level: 1 | 2): EscalationPlan {
  // Deploy-gap rows (pendingRole null) are single-step Supervisor edits.
  const role = pendingRole ?? Role.SUPERVISOR;
  switch (role) {
    case Role.SUPERVISOR:
      return {
        regionScopedRoles: [Role.MANAGER],
        globalRoles: level === 2 ? [Role.GM] : [],
      };
    case Role.MANAGER:
      return {
        regionScopedRoles: [],
        globalRoles: level === 2 ? [Role.GM, Role.STEWARD] : [Role.GM],
      };
    case Role.ACCOUNTANT:
      return {
        regionScopedRoles: [],
        globalRoles:
          level === 2
            ? [Role.FINANCE_MANAGER, Role.GM, Role.STEWARD]
            : [Role.FINANCE_MANAGER, Role.GM],
      };
    case Role.FINANCE_MANAGER:
      return {
        regionScopedRoles: [],
        globalRoles: level === 2 ? [Role.GM, Role.STEWARD] : [Role.GM],
      };
    case Role.GM:
      return { regionScopedRoles: [], globalRoles: [Role.MANAGER, Role.STEWARD] };
    default:
      // SALESMAN/STEWARD/VIEWER never hold a pending step; fail safe.
      return { regionScopedRoles: [], globalRoles: [Role.GM] };
  }
}
