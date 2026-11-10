/**
 * What Promote would do with a staged customer batch, read from the database as
 * it is now (code review 2026-11-10, finding 1).
 *
 * The confirmation before Promote said only "This creates customer + branch
 * records". It now says how many customers and shops will be created, how many
 * Temix-owned fields refreshed, how many CRM values differ from the sheet (kept,
 * or replaced when the batch's overwrite option is on), how many rows carry
 * credit cells that will not be applied and why, and how many rows are expected
 * to be rejected.
 *
 * READS ONLY: the batch's clean rows, the routes and channels, the customers
 * they name and the shops they name, in chunks. No audit log is read, so a
 * customer that may take its first Temix code from this file is counted as
 * doing so. Every decision is lib/import-plan.ts planGroup, which the promote's
 * own rules were moved into. It is a check, not a lock: Promote decides again
 * from the records as they are at that moment.
 */
import { ImportRowState, type Prisma, type PrismaClient } from '@prisma/client';
import {
  addGroup,
  emptySummary,
  planGroup,
  summaryBranchOf,
  type PlanCustomer,
  type PlanRow,
  type PlanShop,
  type PromoteSummary,
} from './import-plan';
import { normalizeTemixCode } from './temix-code';

type Db = Prisma.TransactionClient | PrismaClient;

/** Rows read per query: well under PostgreSQL's 32,767 bind parameters. */
export const SUMMARY_CHUNK = 2000;

function chunks<T>(list: readonly T[], size = SUMMARY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function loadPromoteSummary(db: Db, batchId: string, overwrite: boolean): Promise<PromoteSummary> {
  const [cleanRows, routes, channels] = await Promise.all([
    db.importRow.findMany({
      where: { batchId, state: ImportRowState.CLEAN },
      select: { parsed: true },
      orderBy: { rowNumber: 'asc' },
    }),
    db.route.findMany({ select: { id: true, code: true, regionId: true } }),
    db.channel.findMany({ select: { id: true, key: true } }),
  ]);
  const routeByCode = new Map(routes.map((r) => [r.code.toUpperCase(), { id: r.id, regionId: r.regionId }]));
  const channelIdByKey = new Map(channels.map((c) => [c.key.toUpperCase(), c.id]));

  // Grouped as the promote groups them: by cust_code, in sheet order.
  const groups = new Map<string, PlanRow[]>();
  for (const row of cleanRows) {
    const p = row.parsed as unknown as PlanRow | null;
    if (!p?.custCode) continue;
    if (p.temixCode) p.temixCode = normalizeTemixCode(p.temixCode) || null;
    const g = groups.get(p.custCode) ?? [];
    g.push(p);
    groups.set(p.custCode, g);
  }

  // The customers the file names, by their exact customer code.
  const customers = new Map<string, PlanCustomer>();
  for (const codes of chunks([...groups.keys()])) {
    const found = await db.customer.findMany({
      where: { nmwcCode: { in: codes } },
      select: {
        id: true,
        nmwcCode: true,
        deletedAt: true,
        temixCode: true,
        temixSyncState: true,
        lastTemixUploadAt: true,
        paymentTerms: true,
        legalName: true,
        primaryPhone: true,
        primaryPhoneNorm: true,
        crNumber: true,
        crNumberNorm: true,
        creditLimit: true,
        paymentTermDays: true,
        contactPerson: true,
        channelId: true,
        subChannelId: true,
        subChannel: { select: { channelId: true } },
        status: true,
        _count: { select: { branches: { where: { deletedAt: null } } } },
      },
    });
    for (const c of found) {
      const { nmwcCode, subChannel, _count, ...rest } = c;
      customers.set(nmwcCode, {
        ...rest,
        recordedCode: c.temixCode ? normalizeTemixCode(c.temixCode) : null,
        subChannelChannelId: subChannel?.channelId ?? null,
        liveBranches: _count.branches,
      });
    }
  }

  // The shops the file names: each row's code composed under its customer, and
  // the code as the sheet gave it (a code that is another customer's is refused).
  const shopCodes = new Set<string>();
  for (const [custCode, rows] of groups) {
    rows.forEach((p, i) => {
      const shop = summaryBranchOf(custCode, p, i, routeByCode);
      shopCodes.add(shop.branchCode);
      if (shop.sheetCode) shopCodes.add(shop.sheetCode);
    });
  }
  const shopByCode = new Map<string, PlanShop>();
  for (const codes of chunks([...shopCodes])) {
    const found = await db.branch.findMany({
      where: { branchCode: { in: codes } },
      select: {
        branchCode: true,
        customerId: true,
        deletedAt: true,
        branchName: true,
        routeId: true,
        regionId: true,
        address: true,
        dayOfVisit: true,
        status: true,
      },
    });
    for (const { branchCode, ...shop } of found) shopByCode.set(branchCode, shop);
  }

  const summary = emptySummary();
  for (const [custCode, rows] of groups) {
    addGroup(
      summary,
      planGroup({
        custCode,
        overwrite,
        rows,
        existing: customers.get(custCode) ?? null,
        shopByCode,
        routeByCode,
        channelIdByKey,
      })
    );
  }
  return summary;
}
