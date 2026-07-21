/**
 * Centralized permission checks. Every service-layer mutation should call one
 * of these as its first step. Pure functions, no DB access — caller passes the
 * pre-fetched user + entity.
 */
import { Role, type User, type Customer, type Branch } from '@prisma/client';
import { ForbiddenError } from './errors';
import type { StepScope } from './approval-chains';

export type SessionUser = {
  id: string;
  role: Role;
  username: string;
};

export const ROLES = {
  SALESMAN: 'SALESMAN',
  SUPERVISOR: 'SUPERVISOR',
  ACCOUNTANT: 'ACCOUNTANT',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  GM: 'GM',
  MANAGER: 'MANAGER',
  STEWARD: 'STEWARD',
  VIEWER: 'VIEWER',
} as const;

export function isAdmin(user: SessionUser): boolean {
  return user.role === Role.MANAGER || user.role === Role.STEWARD;
}

export function canSeeAllCustomers(user: SessionUser): boolean {
  return user.role !== Role.SALESMAN;
}

export function canManageUsers(user: SessionUser): boolean {
  return user.role === Role.MANAGER;
}

export function canImport(user: SessionUser): boolean {
  return user.role === Role.STEWARD;
}

export function canExport(user: SessionUser): boolean {
  return (
    user.role === Role.MANAGER ||
    user.role === Role.STEWARD ||
    user.role === Role.VIEWER ||
    user.role === Role.SUPERVISOR
  );
}

export function canApproveEdit(user: SessionUser): boolean {
  return user.role === Role.SUPERVISOR;
}

export function canManageReactivation(user: SessionUser): boolean {
  return user.role === Role.MANAGER;
}

/**
 * Field-level locks for SALESMAN. Other roles bypass.
 *
 * Updated 2026-05-11 per owner direction:
 *   - `legalName`: ALWAYS locked for salesmen (any payment terms). The shop
 *     name is set by Steward during master import; field salesman never
 *     overrides it. Prevents accidental renames.
 *   - `nmwcCode`: ALWAYS locked. (Already not in CUSTOMER_FIELDS server-side;
 *     this entry keeps the lock-check coherent for UI.)
 *   - `crNumber` / `crNumberNorm`: locked for SALESMAN only when the customer
 *     is on CREDIT terms. CASH customers may still have a CR field-collected.
 *
 * Steward bypasses everything.
 */
export function isFieldLocked(
  field: 'legalName' | 'nmwcCode' | 'crNumber' | 'crNumberNorm',
  user: SessionUser,
  customer: Pick<Customer, 'paymentTerms'>
): boolean {
  if (user.role === Role.STEWARD) return false;
  if (user.role !== Role.SALESMAN) return false;
  if (field === 'legalName' || field === 'nmwcCode') return true;
  // crNumber / crNumberNorm
  return customer.paymentTerms === 'CREDIT';
}

/**
 * Whether a Salesman can interact with a given branch (i.e. it is on his
 * route). Other roles see by hierarchy or all.
 */
export function canSeeBranch(
  user: SessionUser,
  branch: Pick<Branch, 'routeId'>,
  context: { ownedRouteId?: string | null; managedRouteIds?: string[] } = {}
): boolean {
  if (user.role === Role.SALESMAN) {
    return context.ownedRouteId === branch.routeId;
  }
  if (user.role === Role.SUPERVISOR) {
    return (context.managedRouteIds ?? []).includes(branch.routeId);
  }
  // Manager, Steward, Viewer see all (region scoping handled at query time)
  return true;
}

export function assertRole(user: SessionUser, allowed: Role[]): void {
  if (!allowed.includes(user.role)) {
    throw new ForbiddenError(`Role ${user.role} not allowed for this action.`);
  }
}

export function assert(condition: unknown, message = 'Forbidden'): asserts condition {
  if (!condition) throw new ForbiddenError(message);
}

/**
 * Whether the calling user may approve a specific edit.
 *
 * RBAC-05-003 (Critical): Manager approve scope. Previously Manager returned
 * true unconditionally — any Manager could approve any edit anywhere. Now
 * requires region overlap with at least one branch of the edited customer.
 *
 * EL-15: block self-approval. The submitter cannot also be the approver,
 * regardless of role.
 *
 * Caller must pass `customerBranches` (the branches of the edit's customer)
 * and `actorScope.managedRegionIds` for Manager checks. Passing an empty
 * `customerBranches` for a Manager will deny — caller must supply them.
 */
export function canApproveSpecificEdit(
  user: SessionUser,
  submittedBy: Pick<User, 'id' | 'supervisorId'>,
  context: {
    customerBranches?: Pick<Branch, 'regionId' | 'deletedAt'>[];
    managedRegionIds?: string[];
  } = {}
): boolean {
  // EL-15: separation of duty — submitter can never approve their own edit.
  if (user.id === submittedBy.id) return false;
  if (user.role === Role.MANAGER) {
    const branches = (context.customerBranches ?? []).filter((b) => !b.deletedAt);
    const managed = context.managedRegionIds ?? [];
    // Fail-closed: Manager with no scope cannot approve anything.
    if (managed.length === 0) return false;
    if (branches.length === 0) return false;
    return branches.some((b) => managed.includes(b.regionId));
  }
  if (user.role === Role.SUPERVISOR) return submittedBy.supervisorId === user.id;
  return false;
}

/**
 * Phase 1b: whether `user` may act (approve / reject) on the CURRENT step of a
 * multi-step edit. Generalizes canApproveSpecificEdit to the chain model.
 *
 * - Separation of duty (generalizes EL-15): the submitter can never act on any
 *   step; and no user may act on two DIFFERENT steps of the same edit. Re-deciding
 *   your OWN step after a step-back cascade IS allowed — the caller must exclude
 *   the current step's own prior actors from `priorStepActorIds`.
 * - Scope per step:
 *     SUPERVISOR_OF_SUBMITTER — the submitter's supervisor OR a region-overlapping
 *                               Manager (RBAC-05-003 fallback), via canApproveSpecificEdit
 *     REGION_OVERLAP          — the step's role (Accountant), region-scoped,
 *                               fail-closed on empty managedRegions
 *     GLOBAL                  — any holder of the step's role (Finance Manager / GM)
 */
export function canActOnStep(
  user: SessionUser,
  step: { role: Role; scope: StepScope },
  submittedBy: Pick<User, 'id' | 'supervisorId'>,
  context: {
    customerBranches?: Pick<Branch, 'regionId' | 'deletedAt'>[];
    managedRegionIds?: string[];
    priorStepActorIds?: string[];
  } = {}
): boolean {
  // Separation of duty (every step/scope): the submitter can never act on their
  // own request; and no user may act on two DIFFERENT steps of the same request
  // (re-deciding your OWN step after a step-back cascade IS allowed — the caller
  // excludes the current step's actors from priorStepActorIds).
  if (user.id === submittedBy.id) return false;
  if ((context.priorStepActorIds ?? []).includes(user.id)) return false;

  switch (step.scope) {
    case 'SUPERVISOR_OF_SUBMITTER':
      // The submitter's direct Supervisor OR a region-overlapping Manager
      // (RBAC-05-003: the deliberate fallback so an edit isn't stranded when the
      // one specific supervisor is unavailable). Delegated to
      // canApproveSpecificEdit so the "supervisor-or-region-manager" rule has a
      // single home and the two never drift.
      return canApproveSpecificEdit(user, submittedBy, {
        customerBranches: context.customerBranches,
        managedRegionIds: context.managedRegionIds,
      });
    case 'REGION_OVERLAP': {
      // Region-scoped finance approver (Accountant): only that role, fail-closed
      // on empty managedRegions, requires overlap with a live customer branch.
      if (user.role !== step.role) return false;
      const managed = context.managedRegionIds ?? [];
      if (managed.length === 0) return false;
      const branches = (context.customerBranches ?? []).filter((b) => !b.deletedAt);
      if (branches.length === 0) return false;
      return branches.some((b) => managed.includes(b.regionId));
    }
    case 'GLOBAL':
      // Org-wide approver (Finance Manager / GM): any holder of the step's role.
      return user.role === step.role;
  }
}

/**
 * The ONLY roles a MANAGER may administer (create / disable / reset password /
 * assign) — the field force. Everything else is Steward-provisioned out-of-band:
 * peer MANAGER/STEWARD, AND the org-wide/region credit approvers that make up
 * the SUP→FM→GM→ACC chain (FINANCE_MANAGER, GM, ACCOUNTANT). This is an
 * ALLOWLIST on purpose — a newly added Role is protected by default, so no
 * future approver tier can be minted or taken over by a regional Manager.
 *
 * SECURITY (SR-USR-01, P1): the previous blocklist only shielded MANAGER/STEWARD,
 * so a Manager could create/reset/disable Finance Manager, GM and Accountant
 * accounts — seizing the entire credit-approval chain (separation-of-duty
 * bypass) or disabling it (DoS). Approver provisioning is Steward-only now.
 */
export const MANAGER_ADMINISTRABLE_ROLES: Role[] = [
  Role.SALESMAN,
  Role.SUPERVISOR,
  Role.VIEWER,
];

/**
 * The roles a given viewer may CREATE/assign — the single source of truth shared
 * by the server guard (services/users.ts) and the /users role dropdown, so the UI
 * can never offer a role the server would reject (final-hunt #29). A MANAGER is
 * capped at the field force; a STEWARD (org data-admin) may provision any role.
 */
export function administrableRolesFor(viewerRole: Role): Role[] {
  if (viewerRole === Role.MANAGER) return MANAGER_ADMINISTRABLE_ROLES;
  if (viewerRole === Role.STEWARD) return Object.values(Role);
  return [];
}

/**
 * RBAC-05-006 / AUTH-07 / AUTH-08 / SR-USR-01: peer, approver and last-Manager
 * protections. `canMutateUser` decides whether `actor` may toggle isActive /
 * reset password / change role on `target`. Used by services/users.ts.
 */
export function canMutateUser(
  actor: SessionUser,
  target: Pick<User, 'id' | 'role'>
): { ok: true } | { ok: false; reason: string } {
  if (actor.role !== Role.MANAGER && actor.role !== Role.STEWARD) {
    return { ok: false, reason: 'Only Manager or Steward can mutate users.' };
  }
  // No self-mutation through these flows. Self-service goes through /profile.
  if (actor.id === target.id) {
    return { ok: false, reason: 'Use /profile to change your own account.' };
  }
  // A MANAGER may only administer the field force. Peer admins (MANAGER/STEWARD)
  // and every credit approver (FINANCE_MANAGER/GM/ACCOUNTANT) are Steward-only.
  if (actor.role === Role.MANAGER && !MANAGER_ADMINISTRABLE_ROLES.includes(target.role)) {
    return {
      ok: false,
      reason: 'A Manager can only manage Salesman/Supervisor/Viewer accounts — approver and admin roles are Steward-provisioned.',
    };
  }
  return { ok: true };
}

export type { Role };
