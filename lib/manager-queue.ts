/**
 * Owner decision 3 (2026-10-07): which requests a MANAGER's approval queue holds
 * at the Supervisor step. A request is in it only when he manages the region of
 * every branch in its scope (lib/permissions.ts requestScopeBranches): the
 * branches it changes, plus its home branch for a customer-level change. That is
 * the rule approve and reject apply (canActOnStep), so a card in the queue can
 * always be decided, and a request about another region's branch of a customer
 * with branches in several regions is not his to see there or to decide.
 *
 * Written as one `where`, so every place that shows a Manager his queue takes the
 * very same scope: /approvals (the list and its count), the Work page's stale
 * list, and the dashboard's "Pending approval" (lib/insights/load.ts).
 *   - a customer whose live branches are all in his regions: every request on it
 *     is in scope, in SQL;
 *   - a customer that also has live branches elsewhere: its pending requests at
 *     this step are read (only these few) and judged one by one with the same
 *     helper the decision uses; the ones he covers are named by id;
 *   - a new customer (CREATE): every draft branch's route in his regions — one
 *     route per request today, so this is the rule it always had.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { managesEveryBranch, requestScopeBranches } from './permissions';
import { parseSubmitGate } from './edit-scope';

/**
 * The Supervisor step, as the Supervisor-step queues read it. pendingRole NULL is
 * a row a pre-Phase-1 deploy submitted after the backfill: a single-step
 * Supervisor edit by construction (app/(app)/approvals/page.tsx).
 */
export const SUPERVISOR_STEP_OR: Prisma.CustomerEditWhereInput[] = [{ pendingRole: 'SUPERVISOR' }, { pendingRole: null }];

export async function managerQueueWhere(
  db: Pick<PrismaClient, 'customerEdit'>,
  managedRegionIds: string[],
  stepOr: Prisma.CustomerEditWhereInput[]
): Promise<Prisma.CustomerEditWhereInput> {
  const inMine: Prisma.BranchWhereInput = { regionId: { in: managedRegionIds }, deletedAt: null };
  const elsewhere: Prisma.BranchWhereInput = { regionId: { notIn: managedRegionIds }, deletedAt: null };
  const mixed = await db.customerEdit.findMany({
    where: {
      state: 'SUBMITTED',
      OR: stepOr,
      AND: [{ customer: { branches: { some: inMine } } }, { customer: { branches: { some: elsewhere } } }],
    },
    select: {
      id: true,
      fieldChanges: true,
      branchId: true,
      submitGate: true,
      submittedBy: { select: { ownedRouteId: true, ownedRoute: { select: { regionId: true } } } },
      customer: {
        select: {
          branches: {
            where: { deletedAt: null },
            select: { id: true, regionId: true, routeId: true, deletedAt: true },
          },
        },
      },
    },
  });
  const covered = mixed
    .filter((e) =>
      managesEveryBranch(
        managedRegionIds,
        requestScopeBranches({
          branches: e.customer?.branches ?? [],
          fieldChanges: e.fieldChanges,
          branchId: e.branchId,
          homeBranchIds: parseSubmitGate(e.submitGate)?.branchIds,
          submitterRouteId: e.submittedBy.ownedRouteId,
          submitterRegionId: e.submittedBy.ownedRoute?.regionId,
        })
      )
    )
    .map((e) => e.id);
  const regionOr: Prisma.CustomerEditWhereInput[] = [
    { customer: { branches: { some: inMine, none: elsewhere } } },
    ...(covered.length > 0 ? [{ id: { in: covered } }] : []),
    {
      // final-hunt #7/#15: the draft's CURRENT route region (not the frozen
      // EditBranchDraft.regionId snapshot), as the approve gate reads it.
      branchDrafts: {
        some: { route: { regionId: { in: managedRegionIds } } },
        every: { route: { regionId: { in: managedRegionIds } } },
      },
    },
  ];
  return { state: 'SUBMITTED', AND: [{ OR: stepOr }, { OR: regionOr }] };
}

/**
 * The ids in a Manager's queue at the Supervisor step: managerQueueWhere, for a
 * count taken in SQL elsewhere (the dashboard's "Pending approval",
 * lib/insights/load.ts), so that count is the queue's.
 */
export async function managerQueueIds(
  db: Pick<PrismaClient, 'customerEdit'>,
  managedRegionIds: string[]
): Promise<string[]> {
  const where = await managerQueueWhere(db, managedRegionIds, SUPERVISOR_STEP_OR);
  const rows = await db.customerEdit.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}
