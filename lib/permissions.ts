/**
 * Centralized permission checks. Every service-layer mutation should call one
 * of these as its first step. Pure functions, no DB access — caller passes the
 * pre-fetched user + entity.
 */
import { Role, AttachmentKind, type User, type Customer, type Branch } from '@prisma/client';
import { ForbiddenError } from './errors';
import type { StepScope } from './approval-chains';
import { parseFieldPath } from './edit-values';

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
 * The roles that attach and remove a photo (services/photos.ts) — the same
 * three that edit a customer (owner decision 2026-09-27) — and so the only
 * roles that may upload one (app/api/photos/presign and finalize, ENH-3). Any
 * other role's upload could never reach a slot: it only filled storage, which
 * nothing sweeps for a photo that was never attached.
 */
export const PHOTO_WRITER_ROLES: readonly Role[] = [Role.SALESMAN, Role.STEWARD, Role.MANAGER];

/**
 * Whether this role may upload a photo, and — once the kind is known — one of
 * this kind. A GUARANTEE document belongs only to a new-customer (CREATE)
 * request, which only a salesman starts (services/creates.ts).
 */
export function canUploadPhoto(role: Role, kind?: AttachmentKind): boolean {
  if (!PHOTO_WRITER_ROLES.includes(role)) return false;
  return kind !== AttachmentKind.GUARANTEE || role === Role.SALESMAN;
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
 *   - `crPhoto` (owner decision 2, 2026-10-07): the CR document follows the CR
 *     number. A photo goes live the moment it is attached (services/photos.ts)
 *     and an update request cannot carry one for approval, so on a CREDIT
 *     customer a salesman can neither attach nor remove it; a Manager or the
 *     Steward changes it.
 *
 * Steward bypasses everything.
 */
export function isFieldLocked(
  field: 'legalName' | 'nmwcCode' | 'crNumber' | 'crNumberNorm' | 'crPhoto',
  user: SessionUser,
  customer: Pick<Customer, 'paymentTerms'>
): boolean {
  if (user.role === Role.STEWARD) return false;
  if (user.role !== Role.SALESMAN) return false;
  if (field === 'legalName' || field === 'nmwcCode') return true;
  // crNumber / crNumberNorm / crPhoto
  return customer.paymentTerms === 'CREDIT';
}

/** Owner decision 2 (2026-10-07): the refusal, and the locked slot's words. */
export const CR_DOCUMENT_LOCKED_MESSAGE =
  'The CR document of a credit customer is changed by your manager or the Data Steward.';

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
 * Owner decision 3 (2026-10-07): the branches a request is ABOUT — the scope a
 * Manager must cover to see it in his queue and to decide it. Not every branch
 * of the customer: on a customer with branches in several regions, the Manager
 * of one region decided changes to another region's branches (any-branch overlap).
 *
 *   - every live branch the request changes (a `branch.<id>.…` change, or a
 *     close request's own branch);
 *   - and, when it changes customer-level fields (name, phone, CR…) or names no
 *     live branch, its HOME: ONE branch — the first, by id, of the submitter's
 *     own branches of this customer frozen at submit (CustomerEdit.submitGate);
 *     else of the live branches on his route now; else of the live branches in
 *     his route's region now (a salesman moved since, on a request without a
 *     usable record); else of all live branches — he has no route, or works in
 *     a region with no branch of this customer, so where the change was made
 *     cannot be read, and the request must still be decidable. One branch, so
 *     a customer-level change never needs two regions' Managers.
 *
 * A salesman changes only branches on his route, and a route is in one region,
 * so his request's scope is that region: the Managers who share it (the four of
 * MCT) all see and decide it, and no other region's Manager does. A branch
 * deleted or moved since submit is not live here: approval drops its changes.
 */
export function requestScopeBranches<B extends Pick<Branch, 'id' | 'regionId' | 'routeId' | 'deletedAt'>>(input: {
  /** The customer's branches; deleted ones are ignored. */
  branches: readonly B[];
  fieldChanges: unknown;
  /** A close request's branch (CustomerEdit.branchId). */
  branchId?: string | null;
  /** The submitter's own branches at submit (lib/edit-scope.ts parseSubmitGate). */
  homeBranchIds?: readonly string[] | null;
  /** The submitter's route now: the home of a request without a usable record. */
  submitterRouteId?: string | null;
  /** That route's region now: the home when no branch of the customer is on his route. */
  submitterRegionId?: string | null;
}): B[] {
  const live = input.branches.filter((b) => !b.deletedAt);
  const named = new Set<string>(input.branchId ? [input.branchId] : []);
  let customerLevel = false;
  for (const c of Array.isArray(input.fieldChanges) ? input.fieldChanges : []) {
    const field = (c as { field?: unknown } | null)?.field;
    const p = typeof field === 'string' ? parseFieldPath(field) : null;
    if (p?.scope === 'customer') customerLevel = true;
    else if (p?.scope === 'branch') named.add(p.branchId);
  }
  const changed = live.filter((b) => named.has(b.id));
  if (!customerLevel && changed.length > 0) return changed;
  const homeIds = new Set(input.homeBranchIds ?? []);
  const candidates = [
    live.filter((b) => homeIds.has(b.id)),
    input.submitterRouteId ? live.filter((b) => b.routeId === input.submitterRouteId) : [],
    input.submitterRegionId ? live.filter((b) => b.regionId === input.submitterRegionId) : [],
    live,
  ].find((set) => set.length > 0);
  const home = candidates?.reduce((first, b) => (b.id < first.id ? b : first));
  return home && !changed.includes(home) ? [...changed, home] : changed;
}

/**
 * Whether the calling user may approve a specific edit.
 *
 * RBAC-05-003 (Critical): Manager approve scope. Previously Manager returned
 * true unconditionally — any Manager could approve any edit anywhere.
 *
 * Owner decision 3 (2026-10-07): a Manager must manage the region of EVERY
 * branch in `customerBranches`, which callers fill with the request's scope —
 * requestScopeBranches for an update or close request, the draft branches for
 * a new customer — so he never approves a change to a branch outside his
 * regions. (It was any one branch of the customer.)
 *
 * EL-15: block self-approval. The submitter cannot also be the approver,
 * regardless of role.
 *
 * Caller must pass `customerBranches` and `actorScope.managedRegionIds` for
 * Manager checks. Passing an empty `customerBranches` for a Manager will deny —
 * caller must supply them.
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
    return managesEveryBranch(context.managedRegionIds ?? [], context.customerBranches ?? []);
  }
  if (user.role === Role.SUPERVISOR) return submittedBy.supervisorId === user.id;
  return false;
}

/**
 * Owner decision 3: a Manager covers a request's scope when he manages the
 * region of every live branch in it. Fail-closed: no regions, or no live
 * branch, is no.
 */
export function managesEveryBranch(
  managedRegionIds: readonly string[],
  branches: ReadonlyArray<Pick<Branch, 'regionId' | 'deletedAt'>>
): boolean {
  const live = branches.filter((b) => !b.deletedAt);
  if (managedRegionIds.length === 0 || live.length === 0) return false;
  return live.every((b) => managedRegionIds.includes(b.regionId));
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
 *     SUPERVISOR_OF_SUBMITTER — the submitter's supervisor OR a Manager of every
 *                               region of the request's scope (RBAC-05-003
 *                               fallback; owner decision 3), via canApproveSpecificEdit
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
 *
 * SECURITY (enterprise assessment B2 / SEC-02, 2026-09-14): VIEWER is an
 * ORG-WIDE read + export role (lib/access.ts, lib/export-scope.ts). Letting a
 * region-scoped Manager mint one was a two-click escalation out of their own
 * region — export the whole master, read every CR/GUARANTEE document. VIEWER is
 * Steward-provisioned now; a Manager administers only the roles whose data
 * scope is itself regional (route / team).
 */
export const MANAGER_ADMINISTRABLE_ROLES: Role[] = [Role.SALESMAN, Role.SUPERVISOR];

/**
 * B2 / SEC-02: the regions a user's data access is anchored to, for delegated
 * administration. A SALESMAN is anchored to their route's region, a SUPERVISOR
 * to the regions of the routes their reports own, a MANAGER/ACCOUNTANT to the
 * regions they manage. Org-wide roles (STEWARD/VIEWER/FM/GM) have no regional
 * anchor and are never Manager-administrable anyway.
 */
export type UserRegionFootprint = {
  id: string;
  role: Role;
  ownedRouteRegionId: string | null;
  teamRegionIds: string[];
  managedRegionIds: string[];
  /** Who the user reports to — the only anchor an account has before it owns a route or a team. */
  supervisorId?: string | null;
};

export function userRegionIds(f: UserRegionFootprint): string[] {
  return [
    ...new Set([
      ...(f.ownedRouteRegionId ? [f.ownedRouteRegionId] : []),
      ...f.teamRegionIds,
      ...f.managedRegionIds,
    ]),
  ];
}

/**
 * May MANAGER `managerId` with `managedRegionIds` administer (disable / reset /
 * re-role) `target`? Fail-closed: a Manager with no regions administers nobody;
 * every region the target is anchored to must be one the Manager manages (a
 * supervisor covering two regions is not "yours" if you manage one of them).
 * A field-force user with no regional anchor yet (a supervisor without reports,
 * a salesman between routes) is administrable ONLY by the Manager they report
 * to — otherwise any Manager could reset such an account's password and log
 * in as them (review finding on the first cut of this rule).
 */
export function managerCanAdministerUser(
  managedRegionIds: string[],
  target: UserRegionFootprint,
  managerId?: string
): { ok: true } | { ok: false; reason: string } {
  if (!MANAGER_ADMINISTRABLE_ROLES.includes(target.role)) {
    return {
      ok: false,
      reason:
        'A Manager can only manage Salesman/Supervisor accounts — Viewer, approver and admin roles are Steward-provisioned.',
    };
  }
  if (managedRegionIds.length === 0) {
    return { ok: false, reason: 'You have no managed regions assigned — ask a Steward.' };
  }
  const regions = userRegionIds(target);
  if (regions.length === 0) {
    if (managerId && target.supervisorId === managerId) return { ok: true };
    return {
      ok: false,
      reason:
        'That account is not anchored to any region yet and does not report to you — a Steward can administer it.',
    };
  }
  const outside = regions.filter((r) => !managedRegionIds.includes(r));
  if (outside.length > 0) {
    return { ok: false, reason: 'That account belongs to a region you do not manage.' };
  }
  return { ok: true };
}

/** May a MANAGER assign a salesman to the route in `routeRegionId`? */
export function managerCanAssignRoute(managedRegionIds: string[], routeRegionId: string): boolean {
  return managedRegionIds.length > 0 && managedRegionIds.includes(routeRegionId);
}

/**
 * May a MANAGER (`meId`, `managedRegionIds`) set `supervisor` as someone's
 * supervisor? Themself always; a peer MANAGER only with a shared region (a
 * salesman must not be routed to an approver outside the region); a SUPERVISOR
 * only when every region they already cover is one the Manager manages.
 */
export function managerCanAssignSupervisor(
  meId: string,
  managedRegionIds: string[],
  supervisor: UserRegionFootprint
): boolean {
  if (supervisor.id === meId) return true;
  if (managedRegionIds.length === 0) return false;
  if (supervisor.role === Role.MANAGER) {
    return supervisor.managedRegionIds.some((r) => managedRegionIds.includes(r));
  }
  if (supervisor.role === Role.SUPERVISOR) {
    return userRegionIds(supervisor).every((r) => managedRegionIds.includes(r));
  }
  return false;
}

/**
 * Owner decision 5 (2026-10-07): only the Data Steward switches a REGION off or
 * on. A region is shared — the four Muscat Managers all manage MCT, and the two
 * fallback approvers cover most of the others — so any one of them could switch
 * it off for the rest (services/routes.ts used to let every Manager of the region).
 */
export function canToggleRegion(role: Role): boolean {
  return role === Role.STEWARD;
}

/**
 * Owner decision 5, applied to routes because they have the same problem: a
 * route belongs to its region, so in a region several active Managers manage,
 * any of them could switch off a route worked by another Manager's salesman — and
 * a salesman whose route is off can no longer add a customer (services/creates.ts).
 * There only the Steward switches it. A Manager who is the region's ONLY active
 * Manager keeps the control he had: nobody else's route is at stake.
 *
 * `regionManagerIds` — the ids of the region's ACTIVE Managers.
 */
export function canToggleRoute(
  actor: { id: string; role: Role },
  regionManagerIds: readonly string[]
): boolean {
  if (actor.role === Role.STEWARD) return true;
  if (actor.role !== Role.MANAGER) return false;
  return regionManagerIds.length === 1 && regionManagerIds[0] === actor.id;
}

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
      reason:
        'A Manager can only manage Salesman/Supervisor accounts — Viewer, approver and admin roles are Steward-provisioned.',
    };
  }
  return { ok: true };
}

export type { Role };
