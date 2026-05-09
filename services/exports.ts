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

  // Per-role base scope
  const branchWhere: Prisma.BranchWhereInput = { deletedAt: null };
  if (me.role === Role.SUPERVISOR) {
    const reports = await prisma.user.findMany({
      where: { supervisorId: me.id, ownedRouteId: { not: null } },
      select: { ownedRouteId: true },
    });
    branchWhere.routeId = { in: reports.map((r) => r.ownedRouteId!).filter(Boolean) };
  } else if (me.role === Role.MANAGER) {
    const managed = await prisma.region.findMany({
      where: { managers: { some: { id: me.id } } },
      select: { id: true },
    });
    if (managed.length > 0) branchWhere.regionId = { in: managed.map((r) => r.id) };
  }

  if (filters.regionIds?.length) branchWhere.regionId = { in: filters.regionIds };
  if (filters.routeIds?.length) branchWhere.routeId = { in: filters.routeIds };
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

  // We export one row per branch (mirrors import shape)
  const rows = await prisma.branch.findMany({
    where: { ...branchWhere, customer: customerWhere },
    orderBy: [{ regionId: 'asc' }, { branchCode: 'asc' }],
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
