/**
 * Part C integration support (RUN_ACCOUNTABILITY=1): a small synthetic world —
 * two regions, a route in the first, a Supervisor, his salesman on the route, a
 * Manager of the first region, a Steward, and a customer with one shop on the
 * route — written under a `test:<suite>` change context (so the 'sql' report on
 * /status stays clean), and removed again, history and sign-in events included,
 * in the owner's maintenance window.
 *
 * Every row carries the suite's suffix. Never production: the caller's
 * beforeAll checks DATABASE_URL and DIRECT_URL before anything is written.
 */
import type { PrismaClient } from '@prisma/client';
import { contextClient, src } from '@/lib/change-context';
import { resolveChain, stepDeadline } from '@/lib/approval-chains';
import { purgeAuditLog, purgeCustomerEdits, purgeHistory, withAuditMaintenance } from './audit';

export const PROD_MARKER = 'ep-sweet-haze';

export function assertNotProductionEnv(): void {
  for (const k of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if ((process.env[k] ?? '').includes(PROD_MARKER)) throw new Error(`ABORT: ${k} points at production`);
  }
}

export type World = {
  sfx: string;
  regionA: string;
  regionB: string;
  route: string;
  sup: string;
  salesman: string;
  manager: string;
  steward: string;
  customer: string;
  branch: string;
  /** Every user id the suite made (extra ones are pushed by the suite). */
  users: string[];
  customers: string[];
  branches: string[];
  routes: string[];
  regions: string[];
  attachments: string[];
};

export async function buildWorld(prisma: PrismaClient, suite: string): Promise<World> {
  const sfx = `zz${suite.replace(/[^a-z]/g, '').slice(0, 6)}${Date.now().toString(36)}`;
  const SFX = sfx.toUpperCase();
  const db = contextClient(prisma, { actorId: null, source: src.test(suite) });
  const regionA = (await db.region.create({ data: { code: `${SFX}A`, name: `Part C A ${sfx}` } })).id;
  const regionB = (await db.region.create({ data: { code: `${SFX}B`, name: `Part C B ${sfx}` } })).id;
  const route = (await db.route.create({ data: { code: `${SFX}R`, name: `Part C route ${sfx}`, regionId: regionA } })).id;
  const sup = (await db.user.create({ data: { username: `${sfx}.sup`, fullName: 'ZZ Sup', role: 'SUPERVISOR', passwordHash: 'x' } })).id;
  const salesman = (
    await db.user.create({
      data: { username: `${sfx}.s`, fullName: 'ZZ Salesman', role: 'SALESMAN', passwordHash: 'x', ownedRouteId: route, supervisorId: sup },
    })
  ).id;
  const manager = (
    await db.user.create({
      data: { username: `${sfx}.m`, fullName: 'ZZ Manager', role: 'MANAGER', passwordHash: 'x', managedRegions: { connect: { id: regionA } } },
    })
  ).id;
  const steward = (await db.user.create({ data: { username: `${sfx}.stw`, fullName: 'ZZ Steward', role: 'STEWARD', passwordHash: 'x' } })).id;
  const customer = (await db.customer.create({ data: { nmwcCode: `${SFX}-C`, legalName: `ZZ Part C ${sfx}`, paymentTerms: 'CASH' } })).id;
  const branch = (
    await db.branch.create({
      data: {
        customerId: customer,
        branchCode: `${SFX}-C-01`,
        branchName: 'ZZ shop',
        routeId: route,
        regionId: regionA,
        address: 'ZZ Way 1, synthetic',
        status: 'ACTIVE',
      },
    })
  ).id;
  return {
    sfx,
    regionA,
    regionB,
    route,
    sup,
    salesman,
    manager,
    steward,
    customer,
    branch,
    users: [sup, salesman, manager, steward],
    customers: [customer],
    branches: [branch],
    routes: [route],
    regions: [regionA, regionB],
    attachments: [],
  };
}

/**
 * A salesman's update request waiting at the Supervisor step, as submitEdit
 * leaves it: the frozen single-step UPDATE chain, the stage's SLA clock, and a
 * gate frozen with no branch (so the approval's mandatory-field check, which
 * needs real photos, has nothing to check: this suite is about who decides).
 */
export async function submittedUpdate(prisma: PrismaClient, w: World, openingHours: string): Promise<string> {
  const chain = resolveChain('UPDATE', 'CASH');
  const now = new Date();
  const db = contextClient(prisma, { actorId: w.salesman, source: src.test('accountability') });
  const live = await prisma.branch.findUniqueOrThrow({ where: { id: w.branch }, select: { openingHours: true } });
  const e = await db.customerEdit.create({
    data: {
      target: 'CUSTOMER',
      customerId: w.customer,
      state: 'SUBMITTED',
      submittedById: w.salesman,
      submittedAt: now,
      process: 'UPDATE',
      approvalChain: chain as never,
      paymentTermsAtSubmit: 'CASH',
      currentStepIndex: 0,
      cycle: 1,
      pendingRole: chain[0]!.role,
      stageEnteredAt: now,
      slaDueAt: stepDeadline(now, chain[0]!.slaHours),
      fieldChanges: [{ field: `branch.${w.branch}.openingHours`, before: live.openingHours, after: openingHours }] as never,
      attachmentChanges: [] as never,
      submitGate: { v: 1, branchIds: [] } as never,
    },
  });
  return e.id;
}

/** Everything the world wrote, in an order the foreign keys accept; history last. */
export async function tearDownWorld(prisma: PrismaClient, w: World, extra: { editIds?: string[] } = {}): Promise<void> {
  const edits = await prisma.customerEdit.findMany({
    where: { OR: [{ customerId: { in: w.customers } }, { submittedById: { in: w.users } }, { id: { in: extra.editIds ?? [] } }] },
    select: { id: true },
  });
  const editIds = edits.map((e) => e.id);
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: w.users } }, { editId: { in: editIds } }] } });
  if (editIds.length) await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
  await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: w.users } }, { entityId: { in: [...w.users, ...w.customers, ...w.branches, ...editIds] } }] } });
  await prisma.rateLimit.deleteMany({ where: { key: { contains: w.sfx } } });
  for (const id of w.users) await prisma.rateLimit.deleteMany({ where: { key: { contains: id } } });
  const db = contextClient(prisma, { actorId: null, source: src.test('accountability') });
  await db.customer.updateMany({ where: { id: { in: w.customers } }, data: { crPhotoId: null } });
  await db.branch.updateMany({ where: { id: { in: w.branches } }, data: { shopPhotoId: null, signboardPhotoId: null } });
  await db.attachment.deleteMany({ where: { OR: [{ id: { in: w.attachments } }, { capturedById: { in: w.users } }] } });
  await db.branch.deleteMany({ where: { id: { in: w.branches } } });
  await db.customer.deleteMany({ where: { id: { in: w.customers } } });
  await prisma.passwordHistory.deleteMany({ where: { userId: { in: w.users } } });
  await db.user.updateMany({ where: { id: { in: w.users } }, data: { ownedRouteId: null, supervisorId: null } });
  for (const id of w.users) {
    await db.user.update({ where: { id }, data: { managedRegions: { set: [] } } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: w.users } } });
  await db.route.deleteMany({ where: { id: { in: w.routes } } });
  await db.region.deleteMany({ where: { id: { in: w.regions } } });
  // Last: the deletes above wrote DELETE tombstones (docs/HISTORY.md), and the
  // sign-in events of the world's accounts go with them (purgeHistory, userIds).
  await purgeHistory(prisma, {
    customerIds: w.customers,
    branchIds: w.branches,
    userIds: w.users,
    routeIds: w.routes,
    regionIds: w.regions,
    attachmentIds: w.attachments,
    editIds,
  });
}

/** The owner's maintenance window, for a suite that must remove a ledger row it made. */
export { withAuditMaintenance };
