/**
 * Reads what the customer's History page shows (lib/customer-history.ts
 * assembles it; docs/HISTORY.md §11). Read-only, about fourteen indexed queries
 * in three rounds, and nothing is written: page views are audited nowhere in
 * this app (only photo views and printouts are), so opening History records
 * nothing, and the page shows no photo.
 *
 * What it reads: the history tables (CustomerHistory, BranchHistory,
 * AttachmentHistory, UserHistory) and nmwc_customer_route_intervals, plus the
 * live tables for labels. Never AuditLog: its before/after values and typed
 * reasons can hold personal values, and the history stores those by name only.
 *
 * Access: the Data Steward only (lib/permissions.ts canSeeCustomerHistory). The
 * page checks it before calling; this checks again and answers null, as for an
 * unknown customer or a ?shop= that was never this customer's.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { canSeeCustomerHistory, type SessionUser } from './permissions';
import { DECISION_BOUND_KINDS } from './credit-documents';
import {
  READ_CAP,
  assembleCustomerHistory,
  buildLookups,
  collectLookupIds,
  type CustomerHistoryView,
  type RouteIntervalRow,
} from './customer-history';

/** Every history column the page reads (not dbUser). */
const META = {
  id: true,
  changeKind: true,
  changedFields: true,
  validFrom: true,
  recordedAt: true,
  effectiveRequested: true,
  actorId: true,
  source: true,
  sourceKind: true,
  txId: true,
} as const;

const CUSTOMER_ROW = {
  ...META,
  nmwcCode: true,
  paymentTerms: true,
  creditLimit: true,
  paymentTermDays: true,
  temixCode: true,
  status: true,
  channelId: true,
  subChannelId: true,
  crPhotoId: true,
  deletedAt: true,
  mergedIntoId: true,
} satisfies Prisma.CustomerHistorySelect;

const BRANCH_ROW = {
  ...META,
  branchId: true,
  branchCode: true,
  customerId: true,
  routeId: true,
  regionId: true,
  dayOfVisit: true,
  status: true,
  deletedAt: true,
  coolersCount: true,
  standsCount: true,
  emptyBottlesCount: true,
  equipmentConfirmed: true,
  shopPhotoId: true,
  signboardPhotoId: true,
} satisfies Prisma.BranchHistorySelect;

const NEWEST_FIRST = [{ validFrom: 'desc' as const }, { id: 'desc' as const }];

export async function loadCustomerHistory(
  user: SessionUser,
  customerId: string,
  opts: { shopId: string | null; page: number }
): Promise<CustomerHistoryView | null> {
  if (!canSeeCustomerHistory(user.role)) return null;

  // Round 1: the customer, its rows, its first row (which survives the cap), the
  // routes that served it, and every shop that was ever its own.
  const [customer, customerRows, birth, intervals, shopGroups] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        nmwcCode: true,
        legalName: true,
        deletedAt: true,
        mergedIntoId: true,
        importBatchId: true,
        createdById: true,
      },
    }),
    prisma.customerHistory.findMany({
      where: { customerId },
      orderBy: NEWEST_FIRST,
      take: READ_CAP + 1,
      select: CUSTOMER_ROW,
    }),
    prisma.customerHistory.findFirst({
      where: { customerId },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      select: CUSTOMER_ROW,
    }),
    prisma.$queryRaw<RouteIntervalRow[]>`SELECT branch_id, branch_code, route_id, route_code, salesman_id, salesman_username, valid_from, valid_to, from_inferred, merged_into_id, note FROM nmwc_customer_route_intervals(${customerId})`,
    prisma.branchHistory.groupBy({ by: ['branchId'], where: { customerId } }),
  ]);
  if (!customer) return null;
  const shopIds = shopGroups.map((g) => g.branchId);
  if (opts.shopId && !shopIds.includes(opts.shopId)) return null;

  // Round 2: every row of those shops (in a shop's view, of that shop) — those
  // from while a shop was another customer's too, which show it moving in or
  // out and are never shown — the customer's credit documents, and the shops'
  // live names.
  const [branchRows, docRows, liveShops] = await Promise.all([
    shopIds.length > 0
      ? prisma.branchHistory.findMany({
          where: { branchId: opts.shopId ? opts.shopId : { in: shopIds } },
          orderBy: NEWEST_FIRST,
          take: READ_CAP + 1,
          select: BRANCH_ROW,
        })
      : [],
    // The credit documents and the guarantee. The CR copy and the shop and
    // signboard photos are already in the customer's and shops' own rows
    // (crPhotoId, shopPhotoId, signboardPhotoId). Extra shop photos (FREE) carry
    // no customerId (services/photos.ts, the FREE slot's claim), so they are not
    // listed in this first version. BASELINE rows are read only to tell a
    // document's first change from its attaching; they are not shown.
    opts.shopId
      ? []
      : prisma.attachmentHistory.findMany({
          where: { customerId, kind: { in: [...DECISION_BOUND_KINDS] } },
          orderBy: NEWEST_FIRST,
          take: READ_CAP + 1,
          select: { ...META, attachmentId: true, kind: true, deletedAt: true },
        }),
    shopIds.length > 0
      ? prisma.branch.findMany({
          where: { id: { in: shopIds } },
          select: { id: true, customerId: true, branchCode: true, branchName: true, deletedAt: true },
        })
      : [],
  ]);

  // Round 3: labels for every id the rows name.
  const ids = collectLookupIds({ customer, customerRows, birth, branchRows, docRows, intervals });
  const [users, userHistory, routes, regions, channels, subChannels, customers, batches, edits] = await Promise.all([
    ids.userIds.length > 0
      ? prisma.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, fullName: true, role: true } })
      : [],
    // The actor's role at the time of each change.
    ids.actorIds.length > 0
      ? prisma.userHistory.findMany({
          where: { userId: { in: ids.actorIds } },
          orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
          select: { userId: true, validFrom: true, role: true, username: true },
        })
      : [],
    ids.routeIds.length > 0
      ? prisma.route.findMany({ where: { id: { in: ids.routeIds } }, select: { id: true, code: true, name: true } })
      : [],
    ids.regionIds.length > 0
      ? prisma.region.findMany({ where: { id: { in: ids.regionIds } }, select: { id: true, code: true, name: true } })
      : [],
    ids.channelIds.length > 0
      ? prisma.channel.findMany({ where: { id: { in: ids.channelIds } }, select: { id: true, label: true } })
      : [],
    ids.subChannelIds.length > 0
      ? prisma.subChannel.findMany({ where: { id: { in: ids.subChannelIds } }, select: { id: true, label: true } })
      : [],
    prisma.customer.findMany({ where: { id: { in: ids.customerIds } }, select: { id: true, nmwcCode: true } }),
    ids.batchIds.length > 0
      ? prisma.importBatch.findMany({ where: { id: { in: ids.batchIds } }, select: { id: true, filename: true, kind: true } })
      : [],
    ids.editIds.length > 0
      ? prisma.customerEdit.findMany({
          where: { id: { in: ids.editIds } },
          select: {
            id: true,
            process: true,
            target: true,
            isReactivation: true,
            state: true,
            submittedById: true,
            reviewedById: true,
            customerId: true,
            originalCustomerId: true,
            submittedBy: { select: { fullName: true } },
          },
        })
      : [],
  ]);

  // A route or region no longer on record keeps its last code in its history.
  const missingRoutes = ids.routeIds.filter((id) => !routes.some((r) => r.id === id));
  const missingRegions = ids.regionIds.filter((id) => !regions.some((r) => r.id === id));
  const [oldRoutes, oldRegions] = await Promise.all([
    missingRoutes.length > 0
      ? prisma.routeHistory.findMany({
          where: { routeId: { in: missingRoutes } },
          orderBy: NEWEST_FIRST,
          select: { routeId: true, code: true, name: true },
        })
      : [],
    missingRegions.length > 0
      ? prisma.regionHistory.findMany({
          where: { regionId: { in: missingRegions } },
          orderBy: NEWEST_FIRST,
          select: { regionId: true, code: true, name: true },
        })
      : [],
  ]);
  const latest = <T extends { code: string; name: string }>(rows: T[], key: (r: T) => string) => {
    const seen = new Map<string, { id: string; code: string; name: string }>();
    for (const r of rows) if (!seen.has(key(r))) seen.set(key(r), { id: key(r), code: r.code, name: r.name });
    return [...seen.values()];
  };

  return assembleCustomerHistory(
    {
      customer,
      customerRows,
      birth,
      intervals,
      shopIds,
      branchRows,
      docRows,
      liveShops,
      lookups: buildLookups({
        users,
        userHistory,
        routes: [...routes, ...latest(oldRoutes, (r) => r.routeId)],
        regions: [...regions, ...latest(oldRegions, (r) => r.regionId)],
        channels,
        subChannels,
        customers,
        batches,
        edits,
      }),
    },
    opts
  );
}
