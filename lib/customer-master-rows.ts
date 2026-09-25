/**
 * The customer master export, one row per branch: its columns and its rows, read a
 * page at a time (benchmark item 28). Kept out of services/exports.ts because a
 * 'use server' module may export only async functions, and the paging is tested
 * on its own (tests/unit/customer-master-export.test.ts).
 *
 * Scope is NOT decided here: the caller passes the role-scoped `where`.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { keysetPages } from '@/lib/keyset';

/** Rows per database page: bounded memory, and few enough round trips (~11 for today's master). */
export const CUSTOMER_MASTER_PAGE_SIZE = 2000;

export const CUSTOMER_MASTER_COLUMNS = [
  'cust_code',
  'cust_name',
  'payment_terms',
  'cr_no',
  'cr_photo',
  'branch_code',
  'branch_name',
  'sales_region',
  'region_code',
  'route',
  'address',
  'area_description',
  'phone',
  'alt_phone',
  'contact_person',
  'contact_role',
  'channel',
  'sub_channel',
  'day_of_visit',
  'opening_hours',
  'delivery_window',
  'gps_lat',
  'gps_lng',
  'gps_captured_at',
  'coolers',
  'stands',
  'empty_bottles',
  'shop_photo',
  'signboard_photo',
  'customer_status',
  'branch_status',
  'completeness_pct',
  'last_edited_at',
] as const;

/**
 * The export rows, a page at a time, in the order they always had (region, then
 * branch code). Each page starts strictly after the (regionId, branchCode) of the
 * last row read (lib/keyset.ts) — never at an offset, so a deep page costs the same
 * as the first. `select`, not `include`: only the columns the file carries.
 */
export async function* customerMasterRows(
  where: Prisma.BranchWhereInput,
  pageSize = CUSTOMER_MASTER_PAGE_SIZE
): AsyncGenerator<Record<string, unknown>> {
  const pages = keysetPages(
    (last: { regionId: string; branchCode: string } | undefined) =>
      prisma.branch.findMany({
        where: last
          ? {
              AND: [
                where,
                {
                  OR: [
                    { regionId: { gt: last.regionId } },
                    { regionId: last.regionId, branchCode: { gt: last.branchCode } },
                  ],
                },
              ],
            }
          : where,
        orderBy: [{ regionId: 'asc' }, { branchCode: 'asc' }],
        take: pageSize,
        select: {
          regionId: true,
          branchCode: true,
          branchName: true,
          address: true,
          areaDescription: true,
          dayOfVisit: true,
          openingHours: true,
          deliveryWindow: true,
          gpsLat: true,
          gpsLng: true,
          gpsCapturedAt: true,
          coolersCount: true,
          standsCount: true,
          emptyBottlesCount: true,
          status: true,
          updatedAt: true,
          shopPhotoId: true,
          signboardPhotoId: true,
          region: { select: { name: true, code: true } },
          route: { select: { code: true } },
          customer: {
            select: {
              nmwcCode: true,
              legalName: true,
              paymentTerms: true,
              crNumber: true,
              crPhotoId: true,
              primaryPhone: true,
              altPhone: true,
              contactPerson: true,
              contactRole: true,
              status: true,
              completenessScore: true,
              channel: { select: { label: true } },
              subChannel: { select: { label: true } },
            },
          },
        },
      }),
    pageSize
  );
  for await (const page of pages) {
    for (const b of page) {
      yield {
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
        shop_photo: b.shopPhotoId ? 'yes' : '',
        signboard_photo: b.signboardPhotoId ? 'yes' : '',
        customer_status: b.customer.status,
        branch_status: b.status,
        completeness_pct: b.customer.completenessScore,
        last_edited_at: b.updatedAt.toISOString(),
      };
    }
  }
}
