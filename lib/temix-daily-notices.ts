/**
 * The daily Temix import, stage 6: finalize's ONE writer of notices. Called by
 * services/temix-daily-apply.ts finalize, inside the transaction that takes a
 * file from FINALIZING to LOADED, so the notices and the LOADED state are
 * committed together or not at all.
 *
 * It reads what lib/temix-daily-finalize.ts planFinalize needs (the file's
 * codes, every customer's codes and flags, the open spells, the switched-off
 * routes still holding shops, and for the names: the file's cust_name on rows
 * whose customer the apply found, the CRM's legal name, and the marks already
 * listed), then writes what the plan returns:
 *   - TemixChange notice rows (applied = false), codes and ids only;
 *   - TemixNoticeSeen marks (a keyed hash, never the name).
 * Nothing else: no customer, shop, route, history row or notification. Under
 * an advisory lock of its own, and only for a FINALIZING file with no row
 * PENDING, so a half-loaded file lists no one as missing. Running it again
 * for the same file, or for another file with the same rows, writes nothing:
 * the spells it opened are open, the names it listed are marked.
 */
import { Prisma } from '@prisma/client';
import { loadSwitchedOffRoutesHoldingShops } from './temix-daily-check-load';
import { loadDayDate, loadLatestSpellRows } from './temix-daily-day-load';
import { FINALIZE_KINDS, nameKey, openSpellsOf, planFinalize, type FinalizeKind } from './temix-daily-finalize';

type Tx = Prisma.TransactionClient;

export type FinalizeNoticesResult = {
  written: number;
  byKind: Partial<Record<FinalizeKind, number>>;
  /** False when there is no key to hash names with: no name was compared. */
  namesChecked: boolean;
};

const CHUNK = 1000;

export async function writeFinalizeNotices(
  tx: Tx,
  file: { id: string; loadDay: string },
  opts: { key?: Buffer | null } = {}
): Promise<FinalizeNoticesResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('nmwc:temix-daily:finalize', 42))`;
  const f = await tx.temixDailyFile.findUnique({ where: { id: file.id }, select: { state: true } });
  if (!f || f.state !== 'FINALIZING') throw new Error('temix-daily finalize: the file is not finalizing');
  const pending = await tx.temixDailyRow.count({ where: { fileId: file.id, outcome: 'PENDING' } });
  if (pending > 0) throw new Error('temix-daily finalize: rows of the file are still pending');

  const key = opts.key === undefined ? nameKey() : opts.key;
  const [rows, customers, open, inactiveRoutes] = await Promise.all([
    tx.temixDailyRow.findMany({ where: { fileId: file.id }, select: { id: true, rowNumber: true, custCodeKey: true, customerId: true } }),
    tx.customer.findMany({ select: { id: true, nmwcCode: true, temixCode: true, deletedAt: true, mergedIntoId: true, isTest: true } }),
    loadLatestSpellRows(tx).then(openSpellsOf),
    loadSwitchedOffRoutesHoldingShops(tx),
  ]);

  // The names, only when they can be hashed: the file's name on a found customer's row, and the CRM's.
  let nameRows: Array<{ rowId: string; rowNumber: number; customerId: string; name: string | null }> = [];
  let crmNames = new Map<string, string>();
  let seen = new Set<string>();
  if (key) {
    nameRows = await tx.$queryRaw<typeof nameRows>(Prisma.sql`
      SELECT r."id" AS "rowId", r."rowNumber", r."customerId", r."parsed"->>'custName' AS "name"
        FROM "TemixDailyRow" r
       WHERE r."fileId" = ${file.id} AND r."customerId" IS NOT NULL AND r."parsed" IS NOT NULL`);
    const ids = [...new Set(nameRows.map((r) => r.customerId))];
    if (ids.length > 0) {
      const [names, marks] = await Promise.all([
        tx.customer.findMany({ where: { id: { in: ids } }, select: { id: true, legalName: true } }),
        tx.temixNoticeSeen.findMany({ where: { customerId: { in: ids }, kind: 'NAME_DIFFERS' }, select: { customerId: true, valueHash: true } }),
      ]);
      crmNames = new Map(names.map((c) => [c.id, c.legalName]));
      seen = new Set(marks.map((m) => `${m.customerId}|${m.valueHash}`));
    }
  }

  const plan = planFinalize({
    rows,
    customers: customers.map((c) => ({
      id: c.id,
      nmwcCode: c.nmwcCode,
      temixCode: c.temixCode,
      live: c.deletedAt === null && c.mergedIntoId === null,
      isTest: c.isTest,
    })),
    open,
    inactiveRoutes,
    names: { key, rows: nameRows, crmNames, seen },
  });

  const loadDay = loadDayDate(file.loadDay);
  for (let i = 0; i < plan.notices.length; i += CHUNK) {
    await tx.temixChange.createMany({
      data: plan.notices.slice(i, i + CHUNK).map((n) => ({
        fileId: file.id,
        rowId: n.rowId,
        loadDay,
        kind: n.kind,
        applied: false,
        customerId: n.customerId,
        branchId: null,
        field: n.field,
        fromValue: null,
        toValue: n.toValue,
        detailCode: n.detailCode,
      })),
    });
  }
  for (let i = 0; i < plan.seen.length; i += CHUNK) {
    await tx.temixNoticeSeen.createMany({
      data: plan.seen.slice(i, i + CHUNK).map((s) => ({ customerId: s.customerId, kind: 'NAME_DIFFERS', valueHash: s.valueHash, firstFileId: file.id })),
    });
  }

  const byKind: FinalizeNoticesResult['byKind'] = {};
  for (const n of plan.notices) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  for (const k of FINALIZE_KINDS) if (!byKind[k]) delete byKind[k];
  return { written: plan.notices.length, byKind, namesChecked: plan.namesChecked };
}
