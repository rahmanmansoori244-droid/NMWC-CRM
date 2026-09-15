'use server';

import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import {
  ForbiddenError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { logger } from '@/lib/logger';
import { buildWorkbook } from '@/lib/excel';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import {
  applyCustomerFilters,
  customerListBranchScope,
  parseCustomerFilters,
  type CustomerFilterParams,
} from '@/lib/customer-filters';

/**
 * P2.3 (2026-05-10) — filtered xlsx export of the /customers list.
 *
 * Re-runs the same Prisma where the page composes (role scope + URL filters)
 * with no pagination, then builds an xlsx mirroring the customer-card view:
 * one row per customer, one branch's address/route/region per row (the
 * caller-scoped primary branch — same logic as the page).
 *
 * Hard-capped at EXPORT_ROW_CAP rows. Anything bigger should narrow the
 * filter set rather than ship a multi-megabyte buffer through a server
 * action response.
 */

const EXPORT_ROW_CAP = 5000;

async function requireExportRole() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  // Same role-set as the existing /api/exports/customers endpoint:
  // SALESMAN cannot export. The role-scope filter still applies on top so
  // each role only sees their own slice.
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

export type FilteredExportResult = {
  /** Base64-encoded xlsx bytes. Encoded so the action result survives the RSC serializer cleanly. */
  base64: string;
  filename: string;
  rowCount: number;
};

export async function exportFilteredCustomersAction(
  formData: FormData
): SafeAction<FilteredExportResult> {
  return runAction(() => exportFilteredCustomersCore(formData));
}

async function exportFilteredCustomersCore(
  formData: FormData
): Promise<FilteredExportResult> {
  const me = await requireExportRole();

  // Filters arrive in a single string field (the URL search params) so the
  // client can pass through whatever the page composed without re-mapping
  // every key.
  const raw = String(formData.get('urlParams') ?? '');
  const usp = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const sp: CustomerFilterParams = {
    q: usp.get('q') ?? undefined,
    status: usp.get('status') ?? undefined,
    region: usp.get('region') ?? undefined,
    route: usp.get('route') ?? undefined,
    channel: usp.get('channel') ?? undefined,
    subChannel: usp.get('subChannel') ?? undefined,
    supervisor: usp.get('supervisor') ?? undefined,
    salesman: usp.get('salesman') ?? undefined,
    paymentTerms: usp.get('paymentTerms') ?? undefined,
    minScore: usp.get('minScore') ?? undefined,
    maxScore: usp.get('maxScore') ?? undefined,
    createdAfter: usp.get('createdAfter') ?? undefined,
    createdBefore: usp.get('createdBefore') ?? undefined,
    editedAfter: usp.get('editedAfter') ?? undefined,
    editedBefore: usp.get('editedBefore') ?? undefined,
  };
  const filters = parseCustomerFilters(sp);

  // Build the role-scoped base where + branchSome (mirrors page logic).
  const meRow = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    select: {
      id: true,
      role: true,
      ownedRouteId: true,
      reports: {
        where: { ownedRouteId: { not: null } },
        select: { ownedRouteId: true },
      },
      managedRegions: { select: { id: true } },
    },
  });

  const baseWhere: Prisma.CustomerWhereInput = { deletedAt: null };
  type BranchSomeWhere = NonNullable<
    NonNullable<Prisma.CustomerWhereInput['branches']>['some']
  >;
  let branchSomeBase: BranchSomeWhere | undefined;
  let scopedBranchWhere: Prisma.BranchWhereInput = { deletedAt: null };

  // SR-EXP-01 / SR-M2 (P1): fail-closed role scope from the SAME shared helper as
  // the /customers list (the query twin of lib/access.canSeeCustomer). Previously
  // this was hand-rolled and the SUPERVISOR-with-no-team-routes branch passed a
  // raw `{ routeId: { in: [] } }` with NO `__none__` sentinel — a URL route/
  // supervisor/salesman filter then OVERRODE that empty scope (mergeStringIn bug)
  // and exported another team's PII. Routing every role through the helper makes
  // an empty-scope Supervisor/Manager/Accountant force-empty like the list page.
  const listScope = customerListBranchScope(meRow.role, {
    ownedRouteId: meRow.ownedRouteId,
    teamRouteIds: meRow.reports.map((r) => r.ownedRouteId).filter((id): id is string => !!id),
    managedRegionIds: meRow.managedRegions.map((r) => r.id),
  });
  if (listScope.forceEmpty) {
    baseWhere.id = '__none__';
    scopedBranchWhere = { id: '__none__' };
  } else if (listScope.branchSome) {
    branchSomeBase = listScope.branchSome;
    scopedBranchWhere = listScope.branchSome;
  } else {
    // org-wide (STEWARD / VIEWER / FINANCE_MANAGER / GM) — no branch scope
    scopedBranchWhere = { deletedAt: null };
  }

  // Resolve supervisor / salesman filter to route-ids if set.
  let routeIdsForSupervisor: string[] = [];
  let routeIdForSalesman: string | null = null;
  if (filters.supervisorId) {
    const reports = await prisma.user.findMany({
      where: { supervisorId: filters.supervisorId, ownedRouteId: { not: null } },
      select: { ownedRouteId: true },
    });
    routeIdsForSupervisor = reports
      .map((r) => r.ownedRouteId)
      .filter((id): id is string => !!id);
  }
  if (filters.salesmanId) {
    const u = await prisma.user.findUnique({
      where: { id: filters.salesmanId },
      select: { ownedRouteId: true },
    });
    routeIdForSalesman = u?.ownedRouteId ?? null;
  }

  const where = applyCustomerFilters(
    baseWhere,
    branchSomeBase,
    filters,
    routeIdsForSupervisor,
    routeIdForSalesman
  );

  const total = await prisma.customer.count({ where });
  if (total > EXPORT_ROW_CAP) {
    throw new ValidationError({
      _form: `Result is ${total} rows. Narrow filters to ${EXPORT_ROW_CAP} or fewer before exporting.`,
    });
  }

  // Pull customers + scope-aware primary branch. We mirror the same scoping
  // the page uses for the "primary branch" view so a Salesman's export
  // shows their branch's address, not some arbitrary first branch.
  const customers = await prisma.customer.findMany({
    where,
    orderBy: { legalName: 'asc' },
    take: EXPORT_ROW_CAP,
    include: {
      channel: { select: { label: true } },
      subChannel: { select: { label: true } },
      branches: {
        where: scopedBranchWhere,
        take: 1,
        orderBy: { createdAt: 'asc' },
        include: {
          region: { select: { name: true, code: true } },
          route: { select: { code: true, name: true } },
        },
      },
    },
  });

  const exportRows = customers.map((c) => {
    const b = c.branches[0];
    return {
      'NMWC code': c.nmwcCode,
      'Legal name': c.legalName,
      Status: c.status,
      Channel: c.channel?.label ?? '',
      'Sub-channel': c.subChannel?.label ?? '',
      Region: b?.region.name ?? '',
      Route: b?.route.code ?? '',
      'Primary phone': c.primaryPhone ?? '',
      'Contact person': c.contactPerson ?? '',
      'CR number': c.crNumber ?? '',
      Address: b?.address ?? '',
      GPS:
        b && b.gpsLat != null && b.gpsLng != null
          ? `${b.gpsLat.toFixed(6)},${b.gpsLng.toFixed(6)}`
          : '',
      'Day of visit': b?.dayOfVisit ?? '',
      'Completeness %': c.completenessScore,
    };
  });

  const wb = await buildWorkbook(exportRows, 'Customers');
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const stamp = new Date().toISOString().slice(0, 10);

  // DG-06/07: no longer best-effort — same reasoning as buildCustomerExport.
  // The throw lands BEFORE the base64 buffer is built, so the filtered PII never
  // crosses the RSC boundary without a ledger row. runAction maps a transient
  // fault to DB_UNAVAILABLE with a retryable message; anything else (in practice
  // only an actorId FK violation) re-throws and the action surfaces as an error
  // rather than a silent unaudited export.
  await writeAudit(null, await getAuditEnvelope(me.id), {
    action: 'EXPORT', // B6: was IMPORT — see services/exports.ts
    entityType: 'Export',
    entityId: `customers-${stamp}`,
    reason: `filtered ${exportRows.length}`,
  });
  logger.info({ count: exportRows.length, by: me.id }, 'export.customers_filtered');

  // Convert ArrayBuffer to base64 for transport across the RSC boundary.
  // Buffer.from accepts ArrayBuffer in node runtime — this server action
  // always runs on the node runtime (Prisma).
  const base64 = Buffer.from(new Uint8Array(buf)).toString('base64');
  return {
    base64,
    filename: `customers-${stamp}.xlsx`,
    rowCount: exportRows.length,
  };
}
