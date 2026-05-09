/**
 * Centralized scope checks. Every route handler / server action that exposes a
 * Customer, Branch or Attachment must call into here BEFORE returning data.
 *
 * Scope rules (from PRD §4):
 *   SALESMAN  — only customers/branches on their owned route
 *   SUPERVISOR — only customers/branches on routes owned by their direct reports
 *   MANAGER   — customers/branches in regions they manage (M:N managedRegions)
 *   STEWARD   — all (data ops role)
 *   VIEWER    — all (read-only management view, by design)
 *
 * The helpers throw NotFoundError on scope mismatch (not ForbiddenError) so
 * the UI surfaces "doesn't exist" rather than "you can't see this", denying
 * the attacker a confirmation oracle for IDs.
 */
import { Role, type User, type Customer, type Branch, type Attachment } from '@prisma/client';
import { prisma } from './db';
import { NotFoundError, ForbiddenError } from './errors';
import type { SessionUser } from './permissions';

type CustomerWithBranches = Customer & {
  branches: Pick<Branch, 'routeId' | 'regionId' | 'deletedAt'>[];
};

/**
 * Resolve the current user's scope context (route they own, routes their team
 * owns, regions they manage). Cached per-request via the closure of a server
 * action / server component — caller should call once per request.
 */
export async function loadScope(userId: string): Promise<{
  ownedRouteId: string | null;
  teamRouteIds: string[];
  managedRegionIds: string[];
}> {
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      ownedRouteId: true,
      reports: { where: { ownedRouteId: { not: null } }, select: { ownedRouteId: true } },
      managedRegions: { select: { id: true } },
    },
  });
  return {
    ownedRouteId: me.ownedRouteId,
    teamRouteIds: me.reports.map((r) => r.ownedRouteId!).filter(Boolean),
    managedRegionIds: me.managedRegions.map((r) => r.id),
  };
}

export type Scope = Awaited<ReturnType<typeof loadScope>>;

/**
 * Returns true if the user can see this customer (any of its non-deleted
 * branches falls inside the user's scope).
 */
export function canSeeCustomer(
  user: SessionUser,
  customer: Pick<CustomerWithBranches, 'branches'>,
  scope: Scope
): boolean {
  switch (user.role) {
    case Role.STEWARD:
    case Role.VIEWER:
      return true;
    case Role.SALESMAN:
      if (!scope.ownedRouteId) return false;
      return customer.branches.some(
        (b) => !b.deletedAt && b.routeId === scope.ownedRouteId
      );
    case Role.SUPERVISOR:
      return customer.branches.some(
        (b) => !b.deletedAt && scope.teamRouteIds.includes(b.routeId)
      );
    case Role.MANAGER:
      // RBAC-05-012: fail-closed. A Manager whose `managedRegions` join table
      // is empty (freshly created, region just deactivated, mid-migration row)
      // previously got "see everything" — combined with imports auto-creating
      // phantom regions (CHAIN-09) this turned an unscoped manager into a
      // global-read backdoor. Default to "see nothing until a Steward assigns
      // regions"; surface the empty-scope state in the dashboard banner.
      if (scope.managedRegionIds.length === 0) return false;
      return customer.branches.some(
        (b) => !b.deletedAt && scope.managedRegionIds.includes(b.regionId)
      );
  }
}

/**
 * RBAC-05-001 / RBAC-05-002 / RBAC-05-022: filter a customer's branches array
 * down to the subset the caller is allowed to see. Multi-branch customers
 * (Lulu, Carrefour, fuel chains) span regions, so a salesman who legitimately
 * sees the customer (one branch on his route) used to see all the *other*
 * branches' addresses, GPS, photos. Call this after `canSeeCustomer` and
 * before rendering or shipping branches to the client.
 */
export function filterBranchesByScope<
  B extends Pick<Branch, 'routeId' | 'regionId' | 'deletedAt'>,
>(user: SessionUser, branches: B[], scope: Scope): B[] {
  const live = branches.filter((b) => !b.deletedAt);
  switch (user.role) {
    case Role.STEWARD:
    case Role.VIEWER:
      return live;
    case Role.SALESMAN:
      if (!scope.ownedRouteId) return [];
      return live.filter((b) => b.routeId === scope.ownedRouteId);
    case Role.SUPERVISOR:
      return live.filter((b) => scope.teamRouteIds.includes(b.routeId));
    case Role.MANAGER:
      if (scope.managedRegionIds.length === 0) return [];
      return live.filter((b) => scope.managedRegionIds.includes(b.regionId));
  }
}

export function assertCanSeeCustomer(
  user: SessionUser,
  customer: Pick<CustomerWithBranches, 'branches'>,
  scope: Scope
): void {
  if (!canSeeCustomer(user, customer, scope)) throw new NotFoundError('Customer not found.');
}

/**
 * Edit access is stricter: SALESMAN must own the route; SUPERVISOR cannot edit
 * directly (they approve), so their access is "see only".
 */
export function canEditCustomer(
  user: SessionUser,
  customer: Pick<CustomerWithBranches, 'branches'>,
  scope: Scope
): boolean {
  switch (user.role) {
    case Role.STEWARD:
    case Role.MANAGER:
      return canSeeCustomer(user, customer, scope);
    case Role.SALESMAN:
      if (!scope.ownedRouteId) return false;
      return customer.branches.some(
        (b) => !b.deletedAt && b.routeId === scope.ownedRouteId
      );
    case Role.SUPERVISOR:
    case Role.VIEWER:
      return false;
  }
}

export function assertCanEditCustomer(
  user: SessionUser,
  customer: Pick<CustomerWithBranches, 'branches'>,
  scope: Scope
): void {
  if (!canEditCustomer(user, customer, scope)) throw new ForbiddenError('Edit not allowed.');
}

/**
 * Resolve an Attachment to its owning customer/branch and check scope.
 *
 * The Attachment table carries denormalized customerId/branchId/branchExtraId,
 * but those can be null when the photo was just finalized and not yet wired to
 * a slot. In that case fall back to capturedById ownership.
 */
export async function assertCanAccessAttachment(
  user: SessionUser,
  attachment: Pick<Attachment, 'id' | 'capturedById' | 'customerId' | 'branchId' | 'branchExtraId'>,
  scope: Scope
): Promise<void> {
  if (user.role === Role.STEWARD || user.role === Role.VIEWER) return;

  // RBAC-05-014: only allow the uploader bypass when the attachment is
  // genuinely orphan — not yet wired to any customer/branch slot. If it has
  // already been wired, route the access check through the customer's scope
  // so a route-reassigned salesman cannot keep pulling photos he uploaded
  // months ago against customers he no longer covers.
  const isOrphan =
    !attachment.customerId && !attachment.branchId && !attachment.branchExtraId;
  if (isOrphan && attachment.capturedById === user.id) return;

  // Resolve to a customer
  let customerId: string | null = attachment.customerId ?? null;
  if (!customerId && attachment.branchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: attachment.branchId },
      select: { customerId: true },
    });
    customerId = branch?.customerId ?? null;
  }
  if (!customerId && attachment.branchExtraId) {
    const branch = await prisma.branch.findUnique({
      where: { id: attachment.branchExtraId },
      select: { customerId: true },
    });
    customerId = branch?.customerId ?? null;
  }
  if (!customerId) {
    // Orphan attachment owned by another user — no access
    throw new NotFoundError('Attachment not found.');
  }
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    select: {
      branches: { select: { routeId: true, regionId: true, deletedAt: true } },
    },
  });
  if (!customer) throw new NotFoundError('Attachment not found.');
  assertCanSeeCustomer(user, customer, scope);
}

/**
 * Pure-function variant when the caller has already loaded a customer for
 * something else and wants to gate writes on the attachment based on the
 * customer's branch scope. Used during attachPhoto.
 *
 * RBAC-05-011: SUPERVISOR and VIEWER must never call attach. STEWARD and
 * MANAGER retain the bypass for legitimate "rewire an orphan upload" cases
 * but the call site is expected to log a FORCE_OVERRIDE audit row.
 */
export function userOwnsCapture(user: SessionUser, attachment: Pick<Attachment, 'capturedById'>): boolean {
  if (user.role === Role.SUPERVISOR || user.role === Role.VIEWER) return false;
  return attachment.capturedById === user.id || user.role === Role.STEWARD || user.role === Role.MANAGER;
}

/** Force `User`-typed signature for documentation; actual checks use SessionUser. */
export type _AccessUser = User;
