'use server';

import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { buildWorkbook } from '@/lib/excel';

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
 * Build the Excel workbook in memory and return its bytes.
 * Synchronous — fits comfortably in a serverless invocation for our scale (~3k rows).
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

  // F-16: hard cap rows. At ~3k customers × ~1.7 branches/customer the export
  // is ~5k rows, well under the cap. Anything bigger needs the streaming path
  // which is v1.1.
  const EXPORT_ROW_CAP = 10000;
  const totalCount = await prisma.branch.count({
    where: { ...branchWhere, customer: customerWhere },
  });
  if (totalCount > EXPORT_ROW_CAP) {
    throw new ForbiddenError(
      `Export too large: ${totalCount} rows. Apply more filters to narrow the result (max ${EXPORT_ROW_CAP}).`
    );
  }

  // We export one row per branch (mirrors import shape)
  const rows = await prisma.branch.findMany({
    where: { ...branchWhere, customer: customerWhere },
    orderBy: [{ regionId: 'asc' }, { branchCode: 'asc' }],
    take: EXPORT_ROW_CAP,
    include: {
      customer: {
        include: { channel: true, subChannel: true },
      },
      region: true,
      route: true,
      shopPhoto: { select: { id: true } },
      signboardPhoto: { select: { id: true } },
    },
  });

  const exportRows = rows.map((b) => ({
    cust_code: b.customer.nmwcCode,
    cust_name: b.customer.legalName,
    payment_terms: b.customer.paymentTerms,
    cr_no: b.customer.crNumber ?? '',
    cr_photo: b.customer.crPhotoId ? 'yes' : '',
    branch_code: b.branchCode,
    branch_name: b.branchName,
    sales_region: b.region.name,
    region_code: b.region.code,
    route: b.route.code,
    address: b.address,
    area_description: b.areaDescription ?? '',
    phone: b.customer.primaryPhone ?? '',
    alt_phone: b.customer.altPhone ?? '',
    contact_person: b.customer.contactPerson ?? '',
    contact_role: b.customer.contactRole ?? '',
    channel: b.customer.channel?.label ?? '',
    sub_channel: b.customer.subChannel?.label ?? '',
    day_of_visit: b.dayOfVisit ?? '',
    opening_hours: b.openingHours ?? '',
    delivery_window: b.deliveryWindow ?? '',
    gps_lat: b.gpsLat ?? '',
    gps_lng: b.gpsLng ?? '',
    gps_captured_at: b.gpsCapturedAt?.toISOString() ?? '',
    coolers: b.coolersCount,
    stands: b.standsCount,
    empty_bottles: b.emptyBottlesCount,
    shop_photo: b.shopPhoto ? 'yes' : '',
    signboard_photo: b.signboardPhoto ? 'yes' : '',
    customer_status: b.customer.status,
    branch_status: b.status,
    completeness_pct: b.customer.completenessScore,
    last_edited_at: b.updatedAt.toISOString(),
  }));

  const wb = buildWorkbook(exportRows, 'Customer Master');
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const stamp = new Date().toISOString().slice(0, 10);

  // Best-effort audit
  await prisma.auditLog
    .create({
      data: {
        actorId: me.id,
        action: 'IMPORT', // there is no EXPORT in our enum yet — IMPORT covers data movement
        entityType: 'Export',
        entityId: stamp,
        reason: `customers ${exportRows.length}`,
      },
    })
    .catch(() => undefined);
  logger.info({ count: exportRows.length, by: me.id }, 'export.customers');

  return {
    bytes: new Uint8Array(buf),
    filename: `nmwc-customer-master-${stamp}.xlsx`,
    rowCount: exportRows.length,
  };
}
