/**
 * Owner decision 3 (2026-10-07): which requests a MANAGER's approval queue holds
 * at the Supervisor step. A request is in it only when he manages the region of
 * every branch in its scope (lib/permissions.ts requestScopeBranches): the
 * branches it changes, plus its home branch for a customer-level change. That is
 * the rule approve and reject apply (canActOnStep), so a card in the queue can
 * always be decided, and a request about another region's branch of a customer
 * with branches in several regions is not his to see there or to decide.
 *
 * Written as one `where`, so the list and its count take the very same scope:
 *   - a customer whose live branches are all in his regions: every request on it
 *     is in scope, in SQL;
 *   - a customer that also has live branches elsewhere: its pending requests at
 *     this step are read (only these few) and judged one by one with the same
 *     helper the decision uses; the ones he covers are named by id;
 *   - a new customer (CREATE): every draft branch's route in his regions — one
 *     route per request today, so this is the rule it always had.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { managesEveryBranch, requestScopeBranches } from '@/lib/permissions';
import { parseSubmitGate } from '@/lib/edit-scope';

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
      submittedBy: { select: { ownedRouteId: true } },
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
