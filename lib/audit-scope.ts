/**
 * Launch fix (2026-10-07): which audit rows /audit shows, and which entity types
 * its filter offers.
 *
 * A MANAGER's audit log is regional (RBAC-05-007). It used to be built as
 * region-scoped Customer and Branch rows OR every User and ImportBatch row, from
 * two IN lists holding every customer id and every branch id of his regions. So
 * his regions' request decisions (CustomerEdit: APPROVE, REJECT, STEP_APPROVE,
 * ESCALATE, FINALIZE) and their Region and Route rows were hidden from him, while
 * every user-admin and import event in the company was shown, with actor names.
 *
 * Now, for the audit row aliased `a`, a Manager sees:
 *   - Customer / Branch / Attachment rows about a customer or branch with a
 *     branch in his regions (a branch archived since still counts: the audit
 *     log is history, and an archive is exactly the event he must still see);
 *   - CustomerEdit rows about a request of his regions: a new-customer request by
 *     its draft's route's current region (the /approvals/[id] rule for a CREATE),
 *     any other by a branch of its customer in his regions;
 *   - Region rows of his regions and Route rows of routes in them;
 *   - User rows about the accounts /users shows him (his own and those he may
 *     administer: lib/permissions.ts managerCanAdministerUser), and Export rows
 *     those people wrote.
 * Nothing else: no other region's people, no imports, no Temix batches, no
 * duplicate pairs, no operator runs. Every test is an EXISTS on an indexed key,
 * so the query no longer carries one bound parameter per customer and branch.
 *
 * No database client of its own: the page passes its client in.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { managerCanAdministerUser } from './permissions';

export type ManagerAuditScope = {
  /** The regions he manages; never empty here (the page shows nothing first). */
  regionIds: string[];
  /** His own account and the accounts he may administer. */
  userIds: string[];
};

export function managerAuditScopeSql(scope: ManagerAuditScope): Prisma.Sql {
  const regions = scope.regionIds;
  const users = scope.userIds;
  const inRegions = Prisma.sql`ANY(${regions}::text[])`;
  return Prisma.sql`(
    (a."entityType" = 'Customer' AND EXISTS (
       SELECT 1 FROM "Branch" sb WHERE sb."customerId" = a."entityId" AND sb."regionId" = ${inRegions}))
    OR (a."entityType" = 'Branch' AND EXISTS (
       SELECT 1 FROM "Branch" sb WHERE sb."id" = a."entityId" AND sb."regionId" = ${inRegions}))
    OR (a."entityType" = 'CustomerEdit' AND EXISTS (
       SELECT 1 FROM "CustomerEdit" se
        WHERE se."id" = a."entityId"
          AND ((se."process" = 'CREATE' AND EXISTS (
                  SELECT 1 FROM "EditBranchDraft" sd JOIN "Route" sr ON sr."id" = sd."routeId"
                   WHERE sd."editId" = se."id" AND sr."regionId" = ${inRegions}))
            OR (se."process" <> 'CREATE' AND EXISTS (
                  SELECT 1 FROM "Branch" sb WHERE sb."customerId" = se."customerId" AND sb."regionId" = ${inRegions})))))
    OR (a."entityType" = 'Attachment' AND EXISTS (
       SELECT 1 FROM "Attachment" st
        WHERE st."id" = a."entityId"
          AND (EXISTS (SELECT 1 FROM "Branch" sb
                        WHERE sb."id" IN (st."branchId", st."branchExtraId") AND sb."regionId" = ${inRegions})
            OR EXISTS (SELECT 1 FROM "Branch" sb
                        WHERE sb."customerId" = st."customerId" AND sb."regionId" = ${inRegions}))))
    OR (a."entityType" = 'Region' AND a."entityId" = ${inRegions})
    OR (a."entityType" = 'Route' AND EXISTS (
       SELECT 1 FROM "Route" sr WHERE sr."id" = a."entityId" AND sr."regionId" = ${inRegions}))
    OR (a."entityType" = 'User' AND a."entityId" = ANY(${users}::text[]))
    OR (a."entityType" = 'Export' AND a."actorId" = ANY(${users}::text[]))
  )`;
}

/**
 * The accounts /users shows a Manager — his own and those he may administer
 * (lib/permissions.ts managerCanAdministerUser), worked out as that page does —
 * whose User rows his audit log may show.
 */
export async function managerAuditUserIds(
  db: Pick<PrismaClient, 'user'>,
  meId: string,
  managedRegionIds: string[]
): Promise<string[]> {
  const users = await db.user.findMany({
    select: {
      id: true,
      role: true,
      supervisorId: true,
      ownedRoute: { select: { regionId: true } },
      reports: { select: { ownedRoute: { select: { regionId: true } } } },
      managedRegions: { select: { id: true } },
    },
  });
  return users
    .filter(
      (u) =>
        u.id === meId ||
        managerCanAdministerUser(
          managedRegionIds,
          {
            id: u.id,
            role: u.role,
            supervisorId: u.supervisorId,
            ownedRouteRegionId: u.ownedRoute?.regionId ?? null,
            teamRegionIds: [
              ...new Set(u.reports.map((r) => r.ownedRoute?.regionId).filter((r): r is string => !!r)),
            ],
            managedRegionIds: u.managedRegions.map((r) => r.id),
          },
          meId
        ).ok
    )
    .map((u) => u.id);
}

/**
 * Every entity type written to the audit log, for the Steward's filter. The
 * filter used to offer seven, so Region, Route, the Temix batches, duplicate
 * pairs, import rows and the operator runs could not be picked.
 * tests/unit/audit-scope.test.ts fails when a writer in app, services, lib,
 * scripts or prisma names a type this list lacks.
 */
export const AUDIT_ENTITY_TYPES = [
  'Customer',
  'Branch',
  'CustomerEdit',
  'Attachment',
  'User',
  'Region',
  'Route',
  'Export',
  'ImportBatch',
  'ImportRow',
  'TemixSyncBatch',
  'TemixRequeue',
  'CustomerPair',
  'VisitDaysFromSheets',
  'QuarantinedVisitDays',
  'CreditLimitZeroing',
  'CrNormRecompute',
  'CompletenessRescore',
  'CustomerMaster',
  'CredentialBulkReset',
  'System',
  'SyntheticData',
  'SyntheticTestData',
] as const;

/** The types managerAuditScopeSql can show a Manager: his filter offers these only. */
export const MANAGER_AUDIT_ENTITY_TYPES = [
  'Customer',
  'Branch',
  'CustomerEdit',
  'Attachment',
  'User',
  'Region',
  'Route',
  'Export',
] as const;
