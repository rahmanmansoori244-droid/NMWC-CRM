/**
 * Launch fix (returned work): which of a salesman's sent-back requests still
 * wait on him — the one query behind Today's "Needs correction" tile, Work's
 * sent-back rows, /rejected and the edit page's "sent back" banner.
 *
 * An update is never fixed in place: he answers a sent-back update by sending
 * a NEW request (services/edits.ts — every submit is a new row), so the row
 * that was sent back stays NEEDS_CORRECTION for good. That is the record of the
 * decision, and the dashboard counts it so ("A sent-back update or close
 * request stays sent back for good", app/(app)/dashboard/cards.tsx). These
 * lists counted every such row, so the red counter never went down.
 *
 * A sent-back request is ANSWERED once the same salesman has sent a later
 * request of the same kind on the same customer — the same branch, for a close
 * or a reactivation (lib/submission-replay.ts requestKindOf) — whatever became
 * of it. Nothing is written to mark it: the later request is the trail, and
 * services/edits.ts also writes an audit row on the old one when an update
 * answers it. A new-customer request reuses its own row (services/creates.ts),
 * so it leaves these lists by its own state: resubmitted, saved as a draft or
 * withdrawn. A request whose customer has since been archived waits on nobody.
 *
 * Raw SQL for the NOT EXISTS: Prisma cannot compare a row with a later one. The
 * outer read uses CustomerEdit(submittedById, state), the inner one
 * CustomerEdit(customerId, state).
 */
import { Prisma, type PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient;

export type ReturnedFilter = {
  /** Only this customer's. */
  customerId?: string;
  /** Only updates of the customer (not new-customer, close or reactivation requests). */
  updatesOnly?: boolean;
};

function openReturnedWhere(userId: string, f: ReturnedFilter): Prisma.Sql {
  return Prisma.sql`
       e."submittedById" = ${userId}
   AND e."state" = 'NEEDS_CORRECTION'
   ${f.customerId ? Prisma.sql`AND e."customerId" = ${f.customerId}` : Prisma.empty}
   ${
     f.updatesOnly
       ? Prisma.sql`AND e."process" = 'UPDATE' AND e."target" = 'CUSTOMER' AND NOT e."isReactivation"`
       : Prisma.empty
   }
   AND (e."customerId" IS NULL OR c."deletedAt" IS NULL)
   AND NOT EXISTS (
     SELECT 1
       FROM "CustomerEdit" n
      WHERE n."customerId" = e."customerId"
        AND n."submittedById" = e."submittedById"
        AND n."process" = e."process"
        AND n."target" = e."target"
        AND n."isReactivation" = e."isReactivation"
        AND n."branchId" IS NOT DISTINCT FROM e."branchId"
        AND n."state" <> 'DRAFT'
        AND n."submittedAt" > COALESCE(e."reviewedAt", e."submittedAt", e."createdAt"))`;
}

/** The ids of his sent-back requests still waiting on him, latest decision first. */
export async function openReturnedIds(
  db: Db,
  userId: string,
  opts: ReturnedFilter & { take?: number } = {}
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
SELECT e."id"
  FROM "CustomerEdit" e
  LEFT JOIN "Customer" c ON c."id" = e."customerId"
 WHERE ${openReturnedWhere(userId, opts)}
 ORDER BY e."reviewedAt" DESC NULLS LAST, e."id"
 ${opts.take ? Prisma.sql`LIMIT ${opts.take}` : Prisma.empty}`;
  return rows.map((r) => r.id);
}

/** How many of his sent-back requests still wait on him. */
export async function countOpenReturned(db: Db, userId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
SELECT count(*)::int AS "n"
  FROM "CustomerEdit" e
  LEFT JOIN "Customer" c ON c."id" = e."customerId"
 WHERE ${openReturnedWhere(userId, {})}`;
  return row?.n ?? 0;
}

/** Rows read by id, back in the order the ids came in. */
export function inIdOrder<T extends { id: string }>(ids: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}
