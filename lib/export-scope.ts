/**
 * Role scope for the xlsx exports (customer master + field-update report).
 *
 * Shared so the two exports can never disagree about who sees which rows:
 *   SUPERVISOR — routes owned by their direct reports (fail-closed when none)
 *   MANAGER    — regions they manage (fail-closed when none, RBAC-05-012)
 *   STEWARD / VIEWER — org-wide
 *   everyone else — cannot export at all
 *
 * F-01 posture: a caller's region/route filter is INTERSECTED with the role
 * scope, never allowed to replace it.
 */
import { Role, type Prisma } from '@prisma/client';
import { prisma } from './db';
import { auth } from './auth';
import { ForbiddenError } from './errors';

export const EXPORT_ROLES: Role[] = [Role.MANAGER, Role.STEWARD, Role.VIEWER, Role.SUPERVISOR];

export async function requireExportUser() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (!EXPORT_ROLES.includes(session.user.role)) {
    throw new ForbiddenError('Your role cannot export.');
  }
  return session.user;
}

export type ExportScope = {
  /** null = unrestricted */
  allowedRouteIds: string[] | null;
  allowedRegionIds: string[] | null;
};

export async function resolveExportScope(me: { id: string; role: Role }): Promise<ExportScope> {
  let allowedRouteIds: string[] | null = null;
  let allowedRegionIds: string[] | null = null;
  if (me.role === Role.SUPERVISOR) {
    const reports = await prisma.user.findMany({
      where: { supervisorId: me.id, ownedRouteId: { not: null } },
      select: { ownedRouteId: true },
    });
    allowedRouteIds = reports.map((r) => r.ownedRouteId!).filter(Boolean);
    if (allowedRouteIds.length === 0) allowedRouteIds = ['__none__'];
  } else if (me.role === Role.MANAGER) {
    const managed = await prisma.region.findMany({
      where: { managers: { some: { id: me.id } } },
      select: { id: true },
    });
    allowedRegionIds = managed.map((r) => r.id);
    if (allowedRegionIds.length === 0) allowedRegionIds = ['__none__'];
  }
  return { allowedRouteIds, allowedRegionIds };
}

/** Branch predicate = role scope ∩ caller's region/route filters (live branches only). */
export function scopedBranchWhere(
  scope: ExportScope,
  filters: { regionIds?: string[]; routeIds?: string[] }
): Prisma.BranchWhereInput {
  const where: Prisma.BranchWhereInput = { deletedAt: null };
  if (filters.regionIds?.length) {
    const intersected = scope.allowedRegionIds
      ? filters.regionIds.filter((id) => scope.allowedRegionIds!.includes(id))
      : filters.regionIds;
    where.regionId = { in: intersected.length > 0 ? intersected : ['__none__'] };
  } else if (scope.allowedRegionIds) {
    where.regionId = { in: scope.allowedRegionIds };
  }
  if (filters.routeIds?.length) {
    const intersected = scope.allowedRouteIds
      ? filters.routeIds.filter((id) => scope.allowedRouteIds!.includes(id))
      : filters.routeIds;
    where.routeId = { in: intersected.length > 0 ? intersected : ['__none__'] };
  } else if (scope.allowedRouteIds) {
    where.routeId = { in: scope.allowedRouteIds };
  }
  return where;
}
