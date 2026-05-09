/**
 * Centralized permission checks. Every service-layer mutation should call one
 * of these as its first step. Pure functions, no DB access — caller passes the
 * pre-fetched user + entity.
 */
import { Role, type User, type Customer, type Branch } from '@prisma/client';
import { ForbiddenError } from './errors';

export type SessionUser = {
  id: string;
  role: Role;
  username: string;
};

export const ROLES = {
  SALESMAN: 'SALESMAN',
  SUPERVISOR: 'SUPERVISOR',
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
 * Field-level lock: a Salesman cannot edit Customer.legalName or crNumber on
 * Credit customers. Cash customers are fully editable. Stewards bypass the lock.
 */
export function isFieldLocked(
  _field: 'legalName' | 'crNumber' | 'crNumberNorm',
  user: SessionUser,
  customer: Pick<Customer, 'paymentTerms'>
): boolean {
  if (user.role === Role.STEWARD) return false;
  if (user.role !== Role.SALESMAN) return false;
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
 * Convenience: ensure the calling user is the supervisor of `submittedById` or
 * a manager. Used in approval flows.
 */
export function canApproveSpecificEdit(
  user: SessionUser,
  submittedBy: Pick<User, 'supervisorId'>
): boolean {
  if (user.role === Role.MANAGER) return true;
  if (user.role === Role.SUPERVISOR) return submittedBy.supervisorId === user.id;
  return false;
}

export type { Role };
