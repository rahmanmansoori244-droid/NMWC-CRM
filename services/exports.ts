'use server';

import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { buildWorkbookStreamed } from '@/lib/excel';
import { CUSTOMER_MASTER_COLUMNS, customerMasterRows } from '@/lib/customer-master-rows';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

async function requireExport() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (
    session.user.role !== Role.MANAGER &&
    session.user.role !== Role.STEWARD &&
    session.user.role !== Role.VIEWER &&
    session.user.role !== Role.SUPERVISOR
  ) {
    throw new ForbiddenError('Your role cannot export.');
  }
  return session.user;
}

/** Item 28: the largest export one file may hold — see the count check in buildCustomerExport. */
const EXPORT_ROW_CEILING = 60_000;

export type ExportFilters = {
  regionIds?: string[];
  routeIds?: string[];
  statuses?: ('ACTIVE' | 'CLOSED' | 'SUSPENDED')[];
  paymentTerms?: ('CASH' | 'CREDIT')[];
  minCompleteness?: number;
  maxCompleteness?: number;
  updatedSince?: Date;
};

/**
 * The customer master, one row per branch, as .xlsx bytes.
 *
 * Benchmark item 28: this was capped at 25,000 rows with the master at 20,596,
 * because it held every row and every cell in memory (~1 GB at 25k). Rows are
 * now read in keyset pages and written through the streaming workbook writer,
 * so memory is one page plus the finished file. See EXPORT_ROW_CEILING.
 */
export async function buildCustomerExport(filters: ExportFilters) {
  const me = await requireExport();

  // F-01 (Critical): role scope must be intersected with the user's filter,
  // never replaced. Previously a Supervisor could pass `?routeId=DHF-04` and
  // dump Dhofar's master because the role-scope `routeId = { in: teamRoutes }`
  // was overwritten by the user's filter. Now we compute the role-scoped
  // allowed sets first, then narrow by user filters within those.
  const branchWhere: Prisma.BranchWhereInput = { deletedAt: null };

  // Compute allowed sets per role.
  let allowedRouteIds: string[] | null = null;     // null = unrestricted
  let allowedRegionIds: string[] | null = null;
  if (me.role === Role.SUPERVISOR) {
    const reports = await prisma.user.findMany({
      where: { supervisorId: me.id, ownedRouteId: { not: null } },
      select: { ownedRouteId: true },
    });
    allowedRouteIds = reports.map((r) => r.ownedRouteId!).filter(Boolean);
    // Fail-closed: a Supervisor with no team reports gets no rows.
    if (allowedRouteIds.length === 0) allowedRouteIds = ['__none__'];
  } else if (me.role === Role.MANAGER) {
    const managed = await prisma.region.findMany({
      where: { managers: { some: { id: me.id } } },
      select: { id: true },
    });
    allowedRegionIds = managed.map((r) => r.id);
    // RBAC-05-012: Manager with no managed regions gets nothing (fail-closed).
    if (allowedRegionIds.length === 0) allowedRegionIds = ['__none__'];
  }
  // STEWARD and VIEWER have no role scope by design; allowed* stays null.

  // Apply user filters as an INTERSECTION with role scope.
  if (filters.regionIds?.length) {
    const intersected = allowedRegionIds
      ? filters.regionIds.filter((id) => allowedRegionIds!.includes(id))
      : filters.regionIds;
    branchWhere.regionId = { in: intersected.length > 0 ? intersected : ['__none__'] };
  } else if (allowedRegionIds) {
    branchWhere.regionId = { in: allowedRegionIds };
  }
  if (filters.routeIds?.length) {
    const intersected = allowedRouteIds
      ? filters.routeIds.filter((id) => allowedRouteIds!.includes(id))
      : filters.routeIds;
    branchWhere.routeId = { in: intersected.length > 0 ? intersected : ['__none__'] };
  } else if (allowedRouteIds) {
    branchWhere.routeId = { in: allowedRouteIds };
  }
  if (filters.statuses?.length) branchWhere.status = { in: filters.statuses };

  const customerWhere: Prisma.CustomerWhereInput = { deletedAt: null };
  if (filters.paymentTerms?.length) customerWhere.paymentTerms = { in: filters.paymentTerms };
  if (filters.minCompleteness != null) {
    customerWhere.completenessScore = {
      ...(customerWhere.completenessScore as object),
      gte: filters.minCompleteness,
    };
  }
  if (filters.maxCompleteness != null) {
    customerWhere.completenessScore = {
      ...(customerWhere.completenessScore as object),
      lte: filters.maxCompleteness,
    };
  }
  if (filters.updatedSince) customerWhere.updatedAt = { gte: filters.updatedSince };

  // Item 28: the ceiling is what has been MEASURED to build inside the function's
  // 60 s budget on this platform — 60,000 rows in 13 s at 637 MB (2026-09-25),
  // three times the 20,596-row master — not a guess. Beyond it, an export needs a
  // background job (owner decision: a stored export is a new copy of PII at rest).
  const where = { ...branchWhere, customer: customerWhere };
  const totalCount = await prisma.branch.count({ where });
  if (totalCount > EXPORT_ROW_CEILING) {
    throw new ForbiddenError(
      `Export too large: ${totalCount} rows. One file holds up to ${EXPORT_ROW_CEILING.toLocaleString('en-US')} rows — filter by region or route and export in parts.`
    );
  }

  // One row per branch (mirrors the import shape), read a page at a time.
  const { bytes, rowCount } = await buildWorkbookStreamed(
    CUSTOMER_MASTER_COLUMNS,
    customerMasterRows(where),
    'Customer Master'
  );
  const stamp = new Date().toISOString().slice(0, 10);

  // DG-06/07: no longer best-effort. For a read-only export the AuditLog row is
  // the ONLY record that the master left the building — there is no ImportBatch
  // or changed row to fall back on — so a swallowed insert means a full PII
  // export with nothing in the ledger. Letting it throw makes this fail-closed:
  // the caller (app/api/exports/customers/route.ts) logs and returns 500, and
  // the bytes are never sent. No ledger row therefore implies no export.
  await writeAudit(null, await getAuditEnvelope(me.id), {
    // B6: this said IMPORT ("there is no EXPORT in our enum yet") long after
    // EXPORT was added to the enum, so "who exported the customer master" —
    // the first question of any personal-data incident — could not be
    // answered from the ledger.
    action: 'EXPORT',
    entityType: 'Export',
    entityId: stamp,
    reason: `customers ${rowCount}`,
  });
  logger.info({ count: rowCount, by: me.id }, 'export.customers');

  return {
    bytes,
    filename: `nmwc-customer-master-${stamp}.xlsx`,
    rowCount,
  };
}

