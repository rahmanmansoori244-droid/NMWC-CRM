/**
 * The daily Temix import, stage 5: THE ONE PLACE OUTSIDE SHOP CREATION THAT
 * WRITES A SHOP'S ROUTE.
 *
 * The owner's rule (2026-11-12): routes are moved in Temix, and the daily file
 * brings each move into the CRM. The Import screen never moves a shop that
 * exists (tests/unit/import-shop-route-guard.test.ts, unchanged); request
 * approvals carry no route; this function is the only writer of Branch.routeId
 * and Branch.regionId on a shop that already exists, and
 * services/temix-daily-apply.ts its only caller
 * (tests/unit/temix-daily-route-writer-guard.test.ts).
 *
 * One move, inside the caller's transaction, whose change context the caller
 * has set for this row (src.temixDaily(file, row), effectiveFrom = the load
 * day), so the BranchHistory row the database writes is dated the load day:
 *
 *  1. Branch: routeId, and regionId = the target route's region (the database's
 *     branch_region_consistency_check says the same), version + 1 and
 *     lastEditedById. Nothing else: not the visit day, not the status, not the
 *     customer (THE CLOSED WRITE SET, tests/unit/temix-daily-write-set.test.ts).
 *     Optimistic: written only while the shop is still on the route, at the
 *     version and live as read, so a save that landed in between makes this
 *     move fail (VERSION_CONFLICT, recorded as a CONFLICT row by the caller)
 *     and the row is tried again on the next slice.
 *  2. One AuditLog UPDATE row on the Branch: route and region before and
 *     after, with the file's lineage (file, staged row, row number, load day,
 *     exact code or route-map entry).
 *  3. One ledger row (TemixChange ROUTE_MOVE, applied): the route ids from and
 *     to. source and txId are stamped by the database, so the ledger, the
 *     history row and the audit row join on txId.
 *
 * Nothing is queued for Temix (the move came FROM Temix; sending it back would
 * echo it), and nobody is notified: the salesman's, the manager's and the
 * dashboards' lists read Branch.routeId and regionId live and follow at once.
 */
import { AuditAction, type Prisma } from '@prisma/client';
import { ConflictError } from './errors';
import { writeAudit, type AuditEnvelope } from './audit';

export type ShopToMove = {
  id: string;
  customerId: string;
  version: number;
  routeId: string;
  regionId: string;
};

export type MoveTarget = { routeId: string; regionId: string };

export type MoveLineage = {
  fileId: string;
  rowId: string;
  rowNumber: number;
  /** The file's Oman load day, 'YYYY-MM-DD'. */
  loadDay: string;
  /** How the row's route code reached the CRM route. */
  via: 'EXACT' | 'MAP';
  /** The route-map entry, when via is MAP. */
  routeMapEntryId: string | null;
};

/** The reason of every move's audit row: 'temix-daily <file> row <n>'. */
export function moveAuditReason(fileId: string, rowNumber: number): string {
  return `temix-daily ${fileId} row ${rowNumber}`;
}

/** Moves one shop to `to`, with its audit and ledger rows. Throws ConflictError if the shop changed since it was read. */
export async function moveShopToRoute(
  tx: Prisma.TransactionClient,
  env: AuditEnvelope,
  shop: ShopToMove,
  to: MoveTarget,
  lineage: MoveLineage
): Promise<{ ledgerId: bigint }> {
  const actorId = env.actorId;
  const written = await tx.branch.updateMany({
    where: { id: shop.id, version: shop.version, routeId: shop.routeId, deletedAt: null },
    data: { routeId: to.routeId, regionId: to.regionId, version: { increment: 1 }, lastEditedById: actorId },
  });
  if (written.count === 0) {
    throw new ConflictError(
      'VERSION_CONFLICT',
      'A shop was changed by someone else while the daily file was being applied. Its row is tried again on the next slice.',
      {
        actorId,
        entityType: 'Branch',
        entityId: shop.id,
        path: 'temix-daily.move',
        fields: ['routeId', 'regionId'],
        expectedVersion: shop.version,
      }
    );
  }
  await writeAudit(tx, env, {
    action: AuditAction.UPDATE,
    entityType: 'Branch',
    entityId: shop.id,
    before: { routeId: shop.routeId, regionId: shop.regionId },
    after: {
      routeId: to.routeId,
      regionId: to.regionId,
      lineage: {
        fileId: lineage.fileId,
        rowId: lineage.rowId,
        rowNumber: lineage.rowNumber,
        loadDay: lineage.loadDay,
        via: lineage.via,
        ...(lineage.routeMapEntryId ? { routeMapEntryId: lineage.routeMapEntryId } : {}),
      },
    },
    reason: moveAuditReason(lineage.fileId, lineage.rowNumber),
  });
  const ledger = await tx.temixChange.create({
    data: {
      fileId: lineage.fileId,
      rowId: lineage.rowId,
      loadDay: new Date(`${lineage.loadDay}T00:00:00Z`),
      kind: 'ROUTE_MOVE',
      applied: true,
      customerId: shop.customerId,
      branchId: shop.id,
      field: 'routeId',
      fromValue: shop.routeId,
      toValue: to.routeId,
      detailCode: lineage.via === 'MAP' ? 'VIA_ROUTE_MAP' : 'VIA_EXACT_CODE',
    },
    select: { id: true },
  });
  return { ledgerId: ledger.id };
}
