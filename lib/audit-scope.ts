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
 * And never a STEWARD_ONLY_AUDIT_ACTIONS row (PHOTO_VIEW), even about a photo of
 * his regions — owner decision 2026-10-11.
 *
 * The Data Steward's log is global, but photo views are left out of his default
 * list (STEWARD_HIDDEN_BY_DEFAULT) and he can ask for the views of one customer's
 * documents (auditCustomersByCode, customerDocumentIds, photoViewsOfDocumentsSql)
 * — owner decisions 2026-10-11 — and, with them, the prints of that customer's
 * printouts (customerRequestIds, printsOfCustomersSql; the credit flow's part C,
 * a default for the owner to confirm). customerFilterSql puts the two together as
 * the page asks them.
 *
 * PRINT rows (owner decisions 2026-10-11, part C: services/prints.ts) are ordinary
 * audit rows, not STEWARD_ONLY_AUDIT_ACTIONS: the Steward sees them in his default
 * list, and a Manager sees those about his regions' customers (entity Customer,
 * the customer form) and requests (entity CustomerEdit, the credit application)
 * through managerAuditScopeSql, like any other row about them.
 *
 * No database client of its own: the page passes its client in.
 */
import { AuditAction, Prisma, type PrismaClient } from '@prisma/client';
import { managerCanAdministerUser } from './permissions';
import { normalizeTemixCode } from './temix-code';

/**
 * Gap 2 (data audit 2026-10-10): who opened which photo or document is recorded as
 * PHOTO_VIEW. Owner decision 2026-10-11: only the Data Steward may read those rows.
 * Every reader of the audit log for any other role leaves them out — today that is
 * a Manager's /audit, through managerAuditScopeSql and the action filter he is
 * offered (MANAGER_AUDIT_ACTIONS).
 */
export const STEWARD_ONLY_AUDIT_ACTIONS: readonly AuditAction[] = [AuditAction.PHOTO_VIEW];

/** The actions a Manager's /audit action filter offers. */
export const MANAGER_AUDIT_ACTIONS: readonly AuditAction[] = Object.values(AuditAction).filter(
  (a) => !STEWARD_ONLY_AUDIT_ACTIONS.includes(a)
);

/**
 * Owner decisions 2026-10-11: the Data Steward's /audit leaves photo views out of
 * its default list and out of its count. He sees them when he picks that action
 * in the action filter ("Photo views", PHOTO_VIEW), or when he looks up one
 * customer's documents (photoViewsOfDocumentsSql). Any other action he picks
 * cannot match them anyway.
 */
export const STEWARD_HIDDEN_BY_DEFAULT: readonly AuditAction[] = [AuditAction.PHOTO_VIEW];

/** A customer the Steward's customer filter matched, by NMWC code or Temix code. */
export type AuditCustomer = { id: string; nmwcCode: string; temixCode: string | null; archived: boolean };

/** How many customers one typed code may match: a Temix code is not unique (H-01). */
export const AUDIT_CUSTOMER_MATCH_LIMIT = 20;

/**
 * Owner decisions 2026-10-11: the customer filter. The customers whose NMWC code or
 * Temix code is the typed code, archived ones included (the audit log is history),
 * at most AUDIT_CUSTOMER_MATCH_LIMIT + 1 of them so the page can say there were
 * more. The code is folded as lib/temix-code.ts folds a typed code (digits, hidden
 * characters, ends, case) and compared without regard to case, as temixCodeHolder
 * compares it: an older row may hold a code as its sheet spelled it. That reads the
 * Customer table — one row per customer — never the ledger.
 */
export async function auditCustomersByCode(
  db: Pick<PrismaClient, '$queryRaw'>,
  typed: string
): Promise<AuditCustomer[]> {
  const code = normalizeTemixCode(typed);
  if (!code) return [];
  return db.$queryRaw<AuditCustomer[]>`
    SELECT c."id", c."nmwcCode", c."temixCode", c."deletedAt" IS NOT NULL AS "archived"
      FROM "Customer" c
     WHERE UPPER(c."nmwcCode") = ${code} OR UPPER(c."temixCode") = ${code}
     ORDER BY (c."deletedAt" IS NOT NULL), c."nmwcCode"
     LIMIT ${AUDIT_CUSTOMER_MATCH_LIMIT + 1}`;
}

/**
 * Owner decisions 2026-10-11: "who viewed this customer's documents". The ids of
 * every photo and document of these customers, by where each one is wired now:
 *   - the CR and guarantee documents on the customer (Attachment.customerId);
 *   - the shop, signboard and extra photos of its branches (branchId,
 *     branchExtraId) — the PHOTO_VIEW row of one of these has a null
 *     after.customerId, because the photo route copies the photo's own wiring
 *     into `after` (app/api/photos/[id]/route.ts);
 *   - the photos of its requests (editId). A new-customer request's photos are
 *     viewed while only their editId is set; the final approval binds them to the
 *     customer and its branches, keeps the editId and names the new customer on
 *     the request (lib/create-finalize.ts), so a view from before the approval is
 *     found here too.
 * Removed and replaced photos count: a view of one is still a view of this
 * customer's document.
 *
 * Why the wiring and not the view row's `after`: a photo's wiring only ever goes
 * from nothing to one slot and stays there (services/photos.ts, services/creates.ts,
 * services/reactivations.ts, lib/create-finalize.ts). The one move is a merge
 * (services/duplicates.ts): it takes the losing customer's live documents, branches
 * and requests to the winner and archives the loser. So for a live customer, every
 * view whose after.customerId names him is the view of a document still wired to
 * him, and these ids find the views that after.customerId cannot. An archived
 * customer is read through after.customerId as well (photoViewsOfDocumentsSql).
 *
 * Every arm is an indexed lookup: Attachment(customerId), Branch(customerId) then
 * Attachment(branchId) / Attachment(branchExtraId), CustomerEdit(customerId, state)
 * then Attachment(editId).
 */
export async function customerDocumentIds(
  db: Pick<PrismaClient, '$queryRaw'>,
  customerIds: string[]
): Promise<string[]> {
  if (customerIds.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT t."id" FROM "Attachment" t WHERE t."customerId" = ANY(${customerIds}::text[])
    UNION
    SELECT t."id" FROM "Attachment" t JOIN "Branch" b ON b."id" = t."branchId"
     WHERE b."customerId" = ANY(${customerIds}::text[])
    UNION
    SELECT t."id" FROM "Attachment" t JOIN "Branch" b ON b."id" = t."branchExtraId"
     WHERE b."customerId" = ANY(${customerIds}::text[])
    UNION
    SELECT t."id" FROM "Attachment" t JOIN "CustomerEdit" e ON e."id" = t."editId"
     WHERE e."customerId" = ANY(${customerIds}::text[])`;
  return rows.map((r) => r.id);
}

/**
 * The condition, for the audit row aliased `a`, that selects the PHOTO_VIEW rows
 * of those documents (owner decisions 2026-10-11). Steward only: the page never
 * builds it for anyone else.
 *
 * The query plan, with no schema change: the document ids are one bound array, so
 * Postgres reads the ledger through AuditLog(entityType, entityId, at) — an index
 * probe per document — and the action is checked on the rows found. The cost
 * follows the customer's own documents and their views, not the size of the
 * ledger, for the count and the page alike.
 *
 * An archived customer also matches the views whose after.customerId names him: a
 * merged-away customer's CR and guarantee documents now sit on the winner, and only
 * the view row still names him. No index covers a JSON field, so that arm walks the
 * PHOTO_VIEW rows through AuditLog(action, at). It is added only when an archived
 * customer matched, the one case it can find anything the ids cannot. The views of
 * a merged-away customer's branch and request photos are found under the winner's
 * code, where those branches and requests now are.
 */
export function photoViewsOfDocumentsSql(documentIds: string[], archivedCustomerIds: string[]): Prisma.Sql {
  const named =
    archivedCustomerIds.length > 0
      ? Prisma.sql` OR a."after"->>'customerId' = ANY(${archivedCustomerIds}::text[])`
      : Prisma.empty;
  return Prisma.sql`(a."action" = ${AuditAction.PHOTO_VIEW}::"AuditAction" AND a."entityType" = 'Attachment' AND (a."entityId" = ANY(${documentIds}::text[])${named}))`;
}

/**
 * The customer filter's second question: who printed this customer's printouts
 * (services/prints.ts; a default added with the merge of the credit flow and the
 * audit follow-ups, for the owner to confirm). A PRINT row names what was printed
 * as its own entity: the customer form names the customer (entityType 'Customer'),
 * the credit application names the new-customer request (entityType
 * 'CustomerEdit'). The ids of every request of these customers find the second
 * kind: an application is printed while the request is still a request, the
 * final approval names the new customer on it (lib/create-finalize.ts), and a
 * merge moves the losing customer's requests to the winner (services/duplicates.ts),
 * so an application is found under the code of the customer its request belongs
 * to now. A form printed for a customer later merged away still names that
 * customer, and is found under its own (archived) code. An indexed lookup on
 * CustomerEdit(customerId, state).
 */
export async function customerRequestIds(
  db: Pick<PrismaClient, '$queryRaw'>,
  customerIds: string[]
): Promise<string[]> {
  if (customerIds.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT e."id" FROM "CustomerEdit" e WHERE e."customerId" = ANY(${customerIds}::text[])`;
  return rows.map((r) => r.id);
}

/**
 * The condition, for the audit row aliased `a`, that selects the PRINT rows of
 * these customers' printouts: their customer forms, and the credit applications
 * of their requests (customerRequestIds). Steward only, like
 * photoViewsOfDocumentsSql: the page never builds it for anyone else. Each arm is
 * one bound array read through AuditLog(entityType, entityId, at).
 */
export function printsOfCustomersSql(customerIds: string[], requestIds: string[]): Prisma.Sql {
  const requests =
    requestIds.length > 0
      ? Prisma.sql` OR (a."entityType" = 'CustomerEdit' AND a."entityId" = ANY(${requestIds}::text[]))`
      : Prisma.empty;
  return Prisma.sql`(a."action" = ${AuditAction.PRINT}::"AuditAction" AND ((a."entityType" = 'Customer' AND a."entityId" = ANY(${customerIds}::text[]))${requests}))`;
}

/**
 * The Steward's customer filter as one condition, for the customers a typed code
 * matched (auditCustomersByCode): the views of their documents
 * (photoViewsOfDocumentsSql; only when there is a document, or an archived
 * customer whose views name him) OR the prints of their printouts
 * (printsOfCustomersSql). Null when no customer matched: the page then reads
 * nothing from the ledger.
 */
export async function customerFilterSql(
  db: Pick<PrismaClient, '$queryRaw'>,
  customers: readonly AuditCustomer[]
): Promise<Prisma.Sql | null> {
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return null;
  const [documentIds, requestIds] = await Promise.all([customerDocumentIds(db, ids), customerRequestIds(db, ids)]);
  const archivedIds = customers.filter((c) => c.archived).map((c) => c.id);
  const asked: Prisma.Sql[] = [];
  if (documentIds.length > 0 || archivedIds.length > 0) asked.push(photoViewsOfDocumentsSql(documentIds, archivedIds));
  asked.push(printsOfCustomersSql(ids, requestIds));
  return asked.length === 1 ? asked[0]! : Prisma.sql`(${Prisma.join(asked, ' OR ')})`;
}

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
  const stewardOnly = Prisma.join(STEWARD_ONLY_AUDIT_ACTIONS.map((x) => Prisma.sql`${x}::"AuditAction"`));
  return Prisma.sql`(a."action" NOT IN (${stewardOnly}) AND (
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
  ))`;
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
 * tests/unit/audit-page.test.tsx fails when a writer in app, services, lib,
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
  // Lossless paths (gap 27): a new-customer submit refused as a duplicate.
  'CustomerCreateAttempt',
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
