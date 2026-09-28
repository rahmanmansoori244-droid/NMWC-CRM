/**
 * Auditor recheck 2026-09-27, F21 part 2: one way to bring stored completeness
 * scores back in line with lib/completeness.ts, shared by the customer import's
 * promote and the one-off operator rescore (scripts/ops/rescore-completeness.ts).
 *
 * The promote rescored only the Customer row. A branch the import created kept
 * the column default of 0, and one whose address, visit day, status or route it
 * changed kept the score from before — and Branch.completenessScore is what the
 * dashboard's region and route leaderboards average. Rescoring with one Prisma
 * update per branch would have fixed the numbers and broken two other things:
 * a round trip per branch inside the promote's 20-second transaction, and
 * Prisma's client-side @updatedAt moving on sibling branches the import never
 * touched, which the master export's "updated since" filter reads.
 *
 * So the scores are written in raw SQL, one statement per table:
 *   UPDATE … FROM (VALUES (id, score), …) WHERE "completenessScore" <> v.score
 * Only a row whose score actually changes is written; updatedAt is set by the
 * Prisma client, never by the database, so it stays as it was, and `version` is
 * never bumped — a derived column must not fail an edit form that is open on the
 * customer (the B-05 optimistic lock).
 *
 * The caller holds the customers' row locks (lib/locks.ts) inside its own
 * transaction: the promote takes it at the top of the group, the operator script
 * with lockCustomersAndTemixCodeHolders. Every writer of a scored field that
 * takes the same lock then either finishes before this reads or waits until it
 * commits. No database client of its own, no lib/db or lib/audit: operator
 * scripts import this module.
 */
import { Prisma } from '@prisma/client';
import {
  scoreBranch,
  scoreCustomer,
  type BranchForScore,
  type CustomerForScore,
} from './completeness';

/** Every column lib/completeness.ts scores a customer on, and no other. */
const CUSTOMER_SCORE_FIELDS = {
  channelId: true,
  subChannelId: true,
  primaryPhone: true,
  contactPerson: true,
  crNumber: true,
  crPhotoId: true,
  paymentTerms: true,
  notes: true,
} as const satisfies Record<keyof CustomerForScore, true>;

/** Every column lib/completeness.ts scores a branch on, and no other. */
const BRANCH_SCORE_FIELDS = {
  gpsLat: true,
  gpsLng: true,
  address: true,
  shopPhotoId: true,
  signboardPhotoId: true,
  dayOfVisit: true,
  coolersCount: true,
  standsCount: true,
  emptyBottlesCount: true,
  equipmentConfirmed: true,
  openingHours: true,
  deliveryWindow: true,
  status: true,
} as const satisfies Record<keyof BranchForScore, true>;

/** The read a rescore needs: the scored columns, the stored scores, the live branches. */
export const RESCORE_CUSTOMER_SELECT = {
  id: true,
  completenessScore: true,
  ...CUSTOMER_SCORE_FIELDS,
  branches: {
    where: { deletedAt: null },
    select: { id: true, completenessScore: true, deletedAt: true, ...BRANCH_SCORE_FIELDS },
  },
} satisfies Prisma.CustomerSelect;

type Stored = { id: string; completenessScore: number };
export type RescoreBranch = BranchForScore & Stored & { deletedAt?: Date | null };
export type RescoreCustomer = CustomerForScore & Stored & { branches: RescoreBranch[] };

/** One stored score that is not what lib/completeness.ts makes of its row. */
export type ScoreMove = { id: string; from: number; to: number };

export type RescorePlan = {
  customersScanned: number;
  branchesScanned: number;
  customers: ScoreMove[];
  branches: ScoreMove[];
};

/**
 * Pure: the scores that differ, customer and branch, from rows as read. Only a
 * live branch is scored or counted towards its customer — the read selects live
 * branches only, and an archived one passed in by another caller is ignored the
 * same way.
 */
export function planRescore(customers: readonly RescoreCustomer[]): RescorePlan {
  const plan: RescorePlan = {
    customersScanned: 0,
    branchesScanned: 0,
    customers: [],
    branches: [],
  };
  for (const c of customers) {
    const live = c.branches.filter((b) => b.deletedAt == null);
    plan.customersScanned += 1;
    plan.branchesScanned += live.length;
    for (const b of live) {
      const to = scoreBranch(b);
      if (to !== b.completenessScore) {
        plan.branches.push({ id: b.id, from: b.completenessScore, to });
      }
    }
    const to = scoreCustomer(c, live);
    if (to !== c.completenessScore) {
      plan.customers.push({ id: c.id, from: c.completenessScore, to });
    }
  }
  return plan;
}

/**
 * Rows per statement. A VALUES row is two bind parameters and Postgres takes at
 * most 65,535 in one statement; a page of the operator script's customers stays
 * far below this, so in practice there is one statement per table.
 */
const ROWS_PER_STATEMENT = 5_000;

function valuesOf(moves: readonly ScoreMove[]): Prisma.Sql {
  return Prisma.join(moves.map((m) => Prisma.sql`(${m.id}::text, ${m.to}::int)`));
}

/**
 * Writes a plan's scores, and nothing else, on the rows whose stored score still
 * differs. Returns how many rows each table actually changed.
 */
export async function writeRescore(
  tx: Prisma.TransactionClient,
  plan: Pick<RescorePlan, 'customers' | 'branches'>
): Promise<{ customers: number; branches: number }> {
  let branches = 0;
  for (let i = 0; i < plan.branches.length; i += ROWS_PER_STATEMENT) {
    const rows = valuesOf(plan.branches.slice(i, i + ROWS_PER_STATEMENT));
    branches +=
      await tx.$executeRaw`UPDATE "Branch" AS b SET "completenessScore" = v.score FROM (VALUES ${rows}) AS v(id, score) WHERE b."id" = v.id AND b."completenessScore" <> v.score`;
  }
  let customers = 0;
  for (let i = 0; i < plan.customers.length; i += ROWS_PER_STATEMENT) {
    const rows = valuesOf(plan.customers.slice(i, i + ROWS_PER_STATEMENT));
    customers +=
      await tx.$executeRaw`UPDATE "Customer" AS c SET "completenessScore" = v.score FROM (VALUES ${rows}) AS v(id, score) WHERE c."id" = v.id AND c."completenessScore" <> v.score`;
  }
  return { customers, branches };
}

/**
 * Rescores these customers and their live branches from the rows as they stand
 * inside the caller's transaction, which must hold the customers' row locks.
 * Archived customers are not filtered out: the caller chooses the customers.
 */
export async function rescoreCustomerTx(
  tx: Prisma.TransactionClient,
  customerIds: readonly string[]
): Promise<{ plan: RescorePlan; written: { customers: number; branches: number } }> {
  const ids = [...new Set(customerIds)];
  if (ids.length === 0) {
    const plan = planRescore([]);
    return { plan, written: { customers: 0, branches: 0 } };
  }
  const rows = await tx.customer.findMany({
    where: { id: { in: ids } },
    select: RESCORE_CUSTOMER_SELECT,
  });
  const plan = planRescore(rows);
  const written = await writeRescore(tx, plan);
  return { plan, written };
}
