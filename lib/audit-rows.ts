/**
 * /audit's read of the Data Steward's list (no customer filter): the filters
 * as a Prisma `where`, then one page of rows and their count. The page
 * (app/(app)/audit/page.tsx) calls it with the shared client; the clean-start
 * integration suite calls it with its own, to see what the page gets for the
 * clean start's record (lib/clean-start-record.ts).
 *
 * A Manager's list and the Steward's customer filter are read as SQL on the page
 * (lib/audit-scope.ts) and only fetch their rows with AUDIT_ROW_INCLUDE.
 */
import type { AuditAction, Prisma, PrismaClient } from '@prisma/client';
import { STEWARD_HIDDEN_BY_DEFAULT } from './audit-scope';

export const AUDIT_PAGE_SIZE = 50;

/** Every column of the row (its `after` included) and the actor's names. */
export const AUDIT_ROW_INCLUDE = { actor: { select: { fullName: true, username: true } } } as const;
export type AuditRow = Prisma.AuditLogGetPayload<{ include: typeof AUDIT_ROW_INCLUDE }>;

export type AuditListFilters = {
  actor?: string;
  action: AuditAction | null;
  entityType?: string;
  q: string | null;
};

/**
 * Owner decisions 2026-10-11: photo views are left out of the Steward's list and
 * its count unless he picks that action.
 */
function auditListWhere(f: AuditListFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (f.actor) where.actorId = f.actor;
  where.action = f.action ?? { notIn: [...STEWARD_HIDDEN_BY_DEFAULT] };
  if (f.entityType) where.entityType = f.entityType;
  if (f.q) where.entityId = { contains: f.q };
  return where;
}

/**
 * One page of the list, newest first, and how many rows match. It takes the
 * filters, never a `where`, and builds the `where` itself through
 * auditListWhere: no caller can list photo views the Steward did not ask for
 * (review of follow-up 1; tests/unit/photo-view-visibility.test.ts).
 */
export async function listAuditRows(
  db: PrismaClient,
  filters: AuditListFilters,
  page: number
): Promise<{ total: number; logs: AuditRow[] }> {
  const where = auditListWhere(filters);
  const [total, logs] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: { at: 'desc' },
      skip: (page - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
      include: AUDIT_ROW_INCLUDE,
    }),
  ]);
  return { total, logs };
}
