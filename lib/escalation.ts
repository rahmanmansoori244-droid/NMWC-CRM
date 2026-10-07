/**
 * SLA escalation-target plan (Phase 1 SLA increment).
 *
 * Escalation NOTIFIES, never auto-reassigns or mutates workflow state: the
 * approver of record still acts (the OLD system force-flipped breached
 * requests to an ESCALATED status — deliberately not ported, so the atomic
 * claim + separation-of-duty invariants stay untouched).
 *
 * Chain ([Open — owner to confirm], blueprint §8.1 proposal), narrowed at launch
 * (2026-10-07) to people who can OPEN the request: /approvals/[id] lets a Manager
 * in only over one of the request's regions and never lets a Steward in, so a
 * company-wide Manager or a Steward was handed the customer's name and a link that
 * 404s or leads nowhere.
 *   SUPERVISOR breached  → the MANAGER(s) of the request's regions; L2 adds GM
 *   MANAGER (reactivation) → GM
 *   ACCOUNTANT breached  → FINANCE_MANAGER + GM
 *   FINANCE_MANAGER      → GM
 *   GM breached          → the MANAGER(s) of the request's regions (visibility
 *                          only — nobody outranks GM)
 * A level-2 escalation re-sends to the same people unless a tier is added above.
 * Region-scoped roles with nobody over the request's regions fall back to the GM
 * (app/api/cron/sla-escalate/route.ts), never to every Manager in the company.
 */
import { Role } from '@prisma/client';

export type EscalationPlan = {
  /** Roles resolved region-scoped against the request's regions (fallback: the GM). */
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
      return { regionScopedRoles: [], globalRoles: [Role.GM] };
    case Role.ACCOUNTANT:
      return { regionScopedRoles: [], globalRoles: [Role.FINANCE_MANAGER, Role.GM] };
    case Role.FINANCE_MANAGER:
      return { regionScopedRoles: [], globalRoles: [Role.GM] };
    case Role.GM:
      return { regionScopedRoles: [Role.MANAGER], globalRoles: [] };
    default:
      // SALESMAN/STEWARD/VIEWER never hold a pending step; fail safe.
      return { regionScopedRoles: [], globalRoles: [Role.GM] };
  }
}
