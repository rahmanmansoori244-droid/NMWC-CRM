// @vitest-environment node
/**
 * Owner decision 3 (2026-10-07): a Manager's approval queue holds a request
 * only when he manages the region of every branch it is about
 * (lib/manager-queue.ts). The same rows against Postgres:
 * tests/integration/scope-gate.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { managerQueueIds, managerQueueWhere, SUPERVISOR_STEP_OR } from '@/lib/manager-queue';

const STEP_OR: Prisma.CustomerEditWhereInput[] = [{ pendingRole: 'SUPERVISOR' }, { pendingRole: null }];
const MINE = ['g1'];
const inMine = { regionId: { in: MINE }, deletedAt: null };
const elsewhere = { regionId: { notIn: MINE }, deletedAt: null };
const b = (id: string, regionId: string, routeId: string) => ({ id, regionId, routeId, deletedAt: null });
/** A customer with b1 (g1, route t1) and b2 (g2, route t2). */
const branches = [b('b1', 'g1', 't1'), b('b2', 'g2', 't2')];
const pending = (id: string, fields: string[], over: Record<string, unknown> = {}) => ({
  id,
  fieldChanges: fields.map((field) => ({ field, before: null, after: 'x' })),
  branchId: null,
  submitGate: { v: 1, branchIds: ['b1'] },
  submittedBy: { ownedRouteId: 't1' },
  customer: { branches },
  ...over,
});
const dbWith = (rows: unknown[]) => {
  const findMany = vi.fn(async () => rows);
  return { db: { customerEdit: { findMany } } as unknown as Pick<PrismaClient, 'customerEdit'>, findMany };
};

describe('managerQueueWhere', () => {
  it('reads only the pending requests on customers that also have branches elsewhere', async () => {
    const { db, findMany } = dbWith([]);
    await managerQueueWhere(db, MINE, STEP_OR);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect((findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toEqual({
      state: 'SUBMITTED',
      OR: STEP_OR,
      AND: [{ customer: { branches: { some: inMine } } }, { customer: { branches: { some: elsewhere } } }],
    });
  });

  it('one where: his customers in SQL, and each mixed request he covers by id', async () => {
    const { db } = dbWith([
      pending('e-his-branch', ['branch.b1.openingHours']),
      pending('e-their-branch', ['branch.b2.openingHours'], { submitGate: { v: 1, branchIds: ['b2'] }, submittedBy: { ownedRouteId: 't2' } }),
      pending('e-customer-level', ['customer.notes']),
      pending('e-their-customer-level', ['customer.notes'], { submitGate: { v: 1, branchIds: ['b2'] }, submittedBy: { ownedRouteId: 't2' } }),
      pending('e-both', ['branch.b1.address', 'branch.b2.address'], { submitGate: null }),
      pending('e-their-close', ['branch.b2.status'], { branchId: 'b2', submitGate: null }),
    ]);
    expect(await managerQueueWhere(db, MINE, STEP_OR)).toEqual({
      state: 'SUBMITTED',
      AND: [
        { OR: STEP_OR },
        {
          OR: [
            { customer: { branches: { some: inMine, none: elsewhere } } },
            { id: { in: ['e-his-branch', 'e-customer-level'] } },
            {
              branchDrafts: {
                some: { route: { regionId: { in: MINE } } },
                every: { route: { regionId: { in: MINE } } },
              },
            },
          ],
        },
      ],
    });
  });

  it('no mixed request of his: no id list', async () => {
    const { db } = dbWith([pending('e-their-branch', ['branch.b2.openingHours'])]);
    const where = await managerQueueWhere(db, MINE, STEP_OR);
    expect(JSON.stringify(where)).not.toContain('e-their-branch');
  });

  it('a customer-level request with no usable record, from a salesman moved to a route with no branch of it: his route’s region decides', async () => {
    const moved = (id: string, regionId: string) =>
      pending(id, ['customer.notes'], { submitGate: null, submittedBy: { ownedRouteId: 't9', ownedRoute: { regionId } } });
    // b1 (g1) has the lowest id, so the old fallback put both in g1.
    const { db, findMany } = dbWith([moved('e-moved-to-g1', 'g1'), moved('e-moved-to-g2', 'g2')]);
    const where = await managerQueueWhere(db, MINE, STEP_OR);
    expect(JSON.stringify(where)).toContain('e-moved-to-g1');
    expect(JSON.stringify(where)).not.toContain('e-moved-to-g2');
    // The read selects what that needs.
    const select = (findMany.mock.calls[0] as unknown as [{ select: { submittedBy: unknown } }])[0].select;
    expect(select.submittedBy).toEqual({ select: { ownedRouteId: true, ownedRoute: { select: { regionId: true } } } });
  });
});

describe('managerQueueIds', () => {
  it('the ids of the very `where` the queue uses, at the Supervisor step', async () => {
    const findMany = vi.fn(async (args: { select: Record<string, unknown> }) =>
      'fieldChanges' in args.select ? [pending('e-his-branch', ['branch.b1.openingHours'])] : [{ id: 'e-1' }, { id: 'e-2' }]
    );
    const db = { customerEdit: { findMany } } as unknown as Pick<PrismaClient, 'customerEdit'>;
    expect(await managerQueueIds(db, MINE)).toEqual(['e-1', 'e-2']);
    expect(findMany).toHaveBeenCalledTimes(2);
    const [, second] = findMany.mock.calls as unknown as Array<[{ where: unknown; select: unknown }]>;
    expect(second![0]).toEqual({ where: await managerQueueWhere(dbWith([pending('e-his-branch', ['branch.b1.openingHours'])]).db, MINE, SUPERVISOR_STEP_OR), select: { id: true } });
  });
});
