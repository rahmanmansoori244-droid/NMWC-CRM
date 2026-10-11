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
 *                          and SALES_DIRECTOR
 *   SALES_DIRECTOR       → GM
 *   SALESMAN (the signed application, owner decisions 2026-10-11) → the
 *                          salesman himself and the MANAGER(s) of the request's
 *                          regions; L2 adds GM and SALES_DIRECTOR
 *   MANAGER (reactivation) → GM + SALES_DIRECTOR
 *   ACCOUNTANT breached  → FINANCE_MANAGER + GM + SALES_DIRECTOR
 *   FINANCE_MANAGER      → GM + SALES_DIRECTOR
 *   GM breached          → the MANAGER(s) of the request's regions (visibility
 *                          only — nobody outranks GM)
 * The Sales Director has the GM's access everywhere (owner decisions 2026-10-11),
 * so he is told wherever the GM is told of another step's lateness. Who is told
 * of a late Sales Director step, and of a late signed application, are DEFAULTS
 * the owner has not confirmed (docs/handover/04-PENDING-WORK.md).
 * A level-2 escalation re-sends to the same people unless a tier is added above.
 * Region-scoped roles with nobody over the request's regions fall back to the GM
 * and the Sales Director (app/api/cron/sla-escalate/route.ts), never to every
 * Manager in the company.
 *
 * Owner decision 6 (2026-10-07): a late request is e-mailed to the people this
 * plan tells ("the region's managers, then the GM at 2x" — the Supervisor step),
 * not only shown in-app, and e-mail goes only to people who can act. Every tier
 * above can decide the late step or chase whoever must, except the late GM
 * step's Managers: nobody outranks the GM, so that plan is `visibilityOnly`, its
 * rows stay in-app, and it is e-mailed only to someone who can decide the step
 * himself (the GM, where the sweep fell back to him). The sweep still writes
 * in-app rows only; the e-mail outbox drains them (lib/notify-policy.ts
 * EMAIL_SLA_BREACH), and the drain asks this plan again at send time
 * (lib/email/eligibility.ts escalationReaches).
 */
import { Role } from '@prisma/client';

export type EscalationPlan = {
  /** Roles resolved region-scoped against the request's regions (fallback: the GM and the Sales Director). */
  regionScopedRoles: Role[];
  /** Roles resolved org-wide (all active holders). */
  globalRoles: Role[];
  /**
   * The people named can neither decide the late step nor chase whoever must (a
   * late GM step: nobody outranks the GM). Told in-app for visibility, never
   * e-mailed for it (owner decision 6: e-mail only to people who can act).
   */
  visibilityOnly: boolean;
  /**
   * Owner decisions 2026-10-11: the submitting salesman is told too — the late
   * step is his own (the signed credit application). Never e-mailed: a salesman
   * is not on lib/notify-policy.ts EMAIL_ROLES.
   */
  includeSubmitter: boolean;
};

export function escalationPlan(pendingRole: Role | null, level: 1 | 2): EscalationPlan {
  // Deploy-gap rows (pendingRole null) are single-step Supervisor edits.
  const role = pendingRole ?? Role.SUPERVISOR;
  switch (role) {
    case Role.SUPERVISOR:
      return {
        regionScopedRoles: [Role.MANAGER],
        globalRoles: level === 2 ? [Role.GM, Role.SALES_DIRECTOR] : [],
        visibilityOnly: false,
        includeSubmitter: false,
      };
    case Role.SALES_DIRECTOR:
      return { regionScopedRoles: [], globalRoles: [Role.GM], visibilityOnly: false, includeSubmitter: false };
    case Role.SALESMAN:
      // The signed-application step: the salesman's own errand. He is told, and
      // the Managers of the region who can chase him; at 2x the org-wide pair too.
      return {
        regionScopedRoles: [Role.MANAGER],
        globalRoles: level === 2 ? [Role.GM, Role.SALES_DIRECTOR] : [],
        visibilityOnly: false,
        includeSubmitter: true,
      };
    case Role.MANAGER:
      return {
        regionScopedRoles: [],
        globalRoles: [Role.GM, Role.SALES_DIRECTOR],
        visibilityOnly: false,
        includeSubmitter: false,
      };
    case Role.ACCOUNTANT:
      return {
        regionScopedRoles: [],
        globalRoles: [Role.FINANCE_MANAGER, Role.GM, Role.SALES_DIRECTOR],
        visibilityOnly: false,
        includeSubmitter: false,
      };
    case Role.FINANCE_MANAGER:
      return {
        regionScopedRoles: [],
        globalRoles: [Role.GM, Role.SALES_DIRECTOR],
        visibilityOnly: false,
        includeSubmitter: false,
      };
    case Role.GM:
      return { regionScopedRoles: [Role.MANAGER], globalRoles: [], visibilityOnly: true, includeSubmitter: false };
    default:
      // STEWARD/VIEWER never hold a pending step; fail safe.
      return {
        regionScopedRoles: [],
        globalRoles: [Role.GM, Role.SALES_DIRECTOR],
        visibilityOnly: false,
        includeSubmitter: false,
      };
  }
}
