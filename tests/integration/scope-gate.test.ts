// @vitest-environment node
/**
 * Owner decisions 2, 3 and 4 (2026-10-07), against Postgres, on a customer with
 * branches in two regions:
 *
 *   (4) a salesman's submit is held complete on what it changes — a phone fix,
 *       or a visit day set on one branch, goes through while another of his
 *       shops still has no GPS or shop photo; a change to that shop does not;
 *   (3) a Manager sees in his queue, and decides, only a request whose branches
 *       are all in his regions (customer-level changes: the submitter's home
 *       branch) — the Managers sharing a region all do, the other region's
 *       Manager does not;
 *   (2) a salesman can neither attach nor remove the CR document of a CREDIT
 *       customer; a Manager can; a CASH customer's is unchanged.
 *
 * UAT-SAFE: creates its own regions, routes, users and customers under a unique
 * tag and deletes them in afterAll.
 *
 *   RUN_SCOPE_GATE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/scope-gate.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';
import { editPayload, type EditPatch } from '../support/edit-payload';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_SCOPE_GATE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('owner decisions 2–4: the submit gate, the approval scope, the CR document (UAT)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let edits: typeof import('@/services/edits');
  let photos: typeof import('@/services/photos');
  let managerQueueWhere: typeof import('@/app/(app)/approvals/manager-queue').managerQueueWhere;
  let CR_LOCKED = '';
  const tag = randomUUID().slice(0, 8);
  const savedGate = process.env.SALESMAN_SUBMIT_GATE;
  const ids = {
    regionA: '',
    regionB: '',
    routeA: '',
    routeB: '',
    sales: '',
    salesB: '',
    mgrA: '',
    mgrA2: '',
    mgrB: '',
    cust: '',
    bA1: '',
    bA2: '',
    bB1: '',
    credit: '',
    cash: '',
    users: [] as string[],
    customers: [] as string[],
  };
  const as = (id: string, role: string) => {
    current = { id, role, username: id };
  };
  const STEP_OR: Prisma.CustomerEditWhereInput[] = [{ pendingRole: 'SUPERVISOR' }, { pendingRole: null }];

  const submit = async (patch: Omit<EditPatch, 'isDraft'>) =>
    edits.submitEditAction(await editPayload(prisma, { isDraft: false, ...patch }));
  const pendingOn = async (customerId: string) =>
    (await prisma.customerEdit.findFirstOrThrow({ where: { customerId, state: 'SUBMITTED' }, select: { id: true } })).id;
  const approve = async (editId: string) => {
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', await freshDecisionToken(prisma, editId));
    return edits.approveEditAction(fd);
  };
  /** The request ids a Manager of `regions` finds in his queue, of this suite's customers. */
  const queueOf = async (regions: string[]) => {
    const where = await managerQueueWhere(prisma, regions, STEP_OR);
    const rows = await prisma.customerEdit.findMany({
      where: { AND: [where, { customerId: { in: ids.customers } }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  };
  const photo = (kind: 'SHOP' | 'CR', capturedById: string, n: string) =>
    prisma.attachment.create({
      data: {
        kind,
        r2Key: `uat/zzsg-${tag}-${n}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById,
        capturedAt: new Date(),
      },
    });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    // The CORE gate (the default): the fixtures below are complete for it.
    process.env.SALESMAN_SUBMIT_GATE = 'CORE';
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    photos = await import('@/services/photos');
    ({ managerQueueWhere } = await import('@/app/(app)/approvals/manager-queue'));
    ({ CR_DOCUMENT_LOCKED_MESSAGE: CR_LOCKED } = await import('@/lib/permissions'));

    const channel = await prisma.channel.findFirstOrThrow({ where: { key: 'GENERAL_TRADE' }, select: { id: true } });
    const rA = await prisma.region.create({ data: { code: `ZZSGA-${tag}`, name: `ZZ SG A ${tag}` } });
    const rB = await prisma.region.create({ data: { code: `ZZSGB-${tag}`, name: `ZZ SG B ${tag}` } });
    ids.regionA = rA.id;
    ids.regionB = rB.id;
    const tA = await prisma.route.create({ data: { code: `ZZSG-TA-${tag}`, name: `ZZ SG TA ${tag}`, regionId: rA.id } });
    const tB = await prisma.route.create({ data: { code: `ZZSG-TB-${tag}`, name: `ZZ SG TB ${tag}`, regionId: rB.id } });
    ids.routeA = tA.id;
    ids.routeB = tB.id;
    const user = async (
      role: 'MANAGER' | 'SALESMAN',
      extra: Omit<Prisma.UserUncheckedCreateInput, 'username' | 'fullName' | 'role' | 'passwordHash'> = {}
    ) => {
      const u = await prisma.user.create({
        data: {
          username: `zzsg-${role.toLowerCase()}-${randomUUID().slice(0, 6)}-${tag}`,
          fullName: `ZZ SG ${role}`,
          role,
          passwordHash: 'x',
          ...extra,
        },
      });
      ids.users.push(u.id);
      return u.id;
    };
    // Two Managers share region A (the four of MCT); one manages region B.
    ids.mgrA = await user('MANAGER', { managedRegions: { connect: { id: rA.id } } });
    ids.mgrA2 = await user('MANAGER', { managedRegions: { connect: { id: rA.id } } });
    ids.mgrB = await user('MANAGER', { managedRegions: { connect: { id: rB.id } } });
    ids.sales = await user('SALESMAN', { ownedRouteId: tA.id, supervisorId: ids.mgrA });
    ids.salesB = await user('SALESMAN', { ownedRouteId: tB.id, supervisorId: ids.mgrB });

    const customer = async (code: string, paymentTerms: 'CASH' | 'CREDIT') => {
      const c = await prisma.customer.create({
        data: {
          nmwcCode: `ZZSG-${code}-${tag}`,
          legalName: `ZZ SG ${code} ${tag}`,
          paymentTerms,
          channelId: channel.id,
          primaryPhone: '+96891234567',
          primaryPhoneNorm: '+96891234567',
          contactPerson: 'Said',
        },
      });
      ids.customers.push(c.id);
      return c.id;
    };
    const branch = async (customerId: string, n: string, routeId: string, regionId: string, complete: boolean) => {
      const b = await prisma.branch.create({
        data: {
          customerId,
          branchCode: `ZZSG-${tag}-${n}`,
          branchName: `ZZ SG branch ${n}`,
          routeId,
          regionId,
          address: 'Way 1, synthetic address',
          dayOfVisit: 'SUN',
          ...(complete ? { gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 8, gpsCapturedAt: new Date() } : {}),
        },
      });
      if (complete) {
        const shop = await photo('SHOP', routeId === tA.id ? ids.sales : ids.salesB, `shop-${n}`);
        await prisma.attachment.update({ where: { id: shop.id }, data: { branchId: b.id } });
        await prisma.branch.update({ where: { id: b.id }, data: { shopPhotoId: shop.id } });
      }
      return b.id;
    };
    // The two-region customer: two shops on route A (one never visited), one on route B.
    ids.cust = await customer('MULTI', 'CASH');
    ids.bA1 = await branch(ids.cust, 'A1', tA.id, rA.id, true);
    ids.bA2 = await branch(ids.cust, 'A2', tA.id, rA.id, false);
    ids.bB1 = await branch(ids.cust, 'B1', tB.id, rB.id, true);
    ids.credit = await customer('CREDIT', 'CREDIT');
    await branch(ids.credit, 'C1', tA.id, rA.id, true);
    ids.cash = await customer('CASH', 'CASH');
    await branch(ids.cash, 'K1', tA.id, rA.id, true);
  });

  afterAll(async () => {
    if (savedGate === undefined) delete process.env.SALESMAN_SUBMIT_GATE;
    else process.env.SALESMAN_SUBMIT_GATE = savedGate;
    if (!prisma) return;
    try {
      const editRows = await prisma.customerEdit.findMany({
        where: { OR: [{ customerId: { in: ids.customers } }, { submittedById: { in: ids.users } }] },
        select: { id: true },
      });
      const editIds = editRows.map((e) => e.id);
      await prisma.notification.deleteMany({ where: { OR: [{ editId: { in: editIds } }, { userId: { in: ids.users } }] } });
      await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
      await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
      await purgeAuditLog(prisma, { where: { actorId: { in: ids.users } } });
      await prisma.rateLimit.deleteMany({
        where: { key: { in: ids.users.flatMap((u) => [`edit:${u}`, `edit-draft:${u}`, `photo:${u}`]) } },
      });
      await prisma.customer.updateMany({ where: { id: { in: ids.customers } }, data: { crPhotoId: null } });
      await prisma.branch.updateMany({ where: { customerId: { in: ids.customers } }, data: { shopPhotoId: null, signboardPhotoId: null } });
      await prisma.attachment.deleteMany({ where: { capturedById: { in: ids.users } } });
      await prisma.branch.deleteMany({ where: { customerId: { in: ids.customers } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
      await prisma.user.updateMany({ where: { id: { in: ids.users } }, data: { ownedRouteId: null, supervisorId: null } });
      for (const id of [ids.mgrA, ids.mgrA2, ids.mgrB]) {
        await prisma.user.update({ where: { id }, data: { managedRegions: { set: [] } } }).catch(() => undefined);
      }
      await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
      await prisma.route.deleteMany({ where: { id: { in: [ids.routeA, ids.routeB] } } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.regionA, ids.regionB] } } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('(4)+(3) a phone fix goes through with his other shop unvisited; only region A’s Managers find and decide it', async () => {
    as(ids.sales, 'SALESMAN');
    const res = await submit({ customerId: ids.cust, customer: { primaryPhone: '+968 9876 5432' } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const editId = await pendingOn(ids.cust);

    expect(await queueOf([ids.regionA])).toEqual([editId]);
    expect(await queueOf([ids.regionB])).toEqual([]);

    as(ids.mgrB, 'MANAGER');
    expect(await approve(editId)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    as(ids.mgrA2, 'MANAGER');
    expect(await approve(editId)).toEqual({ ok: true });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: ids.cust }, select: { primaryPhone: true } });
    expect(c.primaryPhone).toBe('+96898765432');
  });

  it('(4) the visit day set on one shop goes through, and is approved, without the other shop complete', async () => {
    as(ids.sales, 'SALESMAN');
    const res = await submit({ customerId: ids.cust, branches: [{ branchId: ids.bA1, dayOfVisit: 'MON' }] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    as(ids.mgrA, 'MANAGER');
    expect(await approve(await pendingOn(ids.cust))).toEqual({ ok: true });
    const b = await prisma.branch.findUniqueOrThrow({ where: { id: ids.bA1 }, select: { dayOfVisit: true } });
    expect(b.dayOfVisit).toBe('MON');
  });

  it('(4) a change to the unvisited shop is still held to its address, GPS and shop photo', async () => {
    as(ids.sales, 'SALESMAN');
    const res = await submit({ customerId: ids.cust, branches: [{ branchId: ids.bA2, openingHours: '08:00-20:00' }] });
    expect(res.ok).toBe(false);
    const fields = (res as { fields?: Record<string, string> }).fields ?? {};
    expect(Object.keys(fields).sort()).toEqual([`branch.${ids.bA2}.gps`, `branch.${ids.bA2}.shopPhoto`].sort());
    expect(await prisma.customerEdit.count({ where: { customerId: ids.cust, state: 'SUBMITTED' } })).toBe(0);
  });

  it('(3) region B’s branch: region A’s Managers neither find nor decide it', async () => {
    as(ids.salesB, 'SALESMAN');
    const res = await submit({ customerId: ids.cust, branches: [{ branchId: ids.bB1, openingHours: '07:00-19:00' }] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const editId = await pendingOn(ids.cust);
    expect(await queueOf([ids.regionA])).toEqual([]);
    expect(await queueOf([ids.regionB])).toEqual([editId]);
    as(ids.mgrA, 'MANAGER');
    expect(await approve(editId)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    as(ids.mgrB, 'MANAGER');
    expect(await approve(editId)).toEqual({ ok: true });
  });

  it('(2) a salesman cannot attach a credit customer’s CR document; a Manager can; a cash customer’s he can', async () => {
    const mine = await photo('CR', ids.sales, 'cr-sales');
    as(ids.sales, 'SALESMAN');
    expect(await photos.attachPhotoAction({ attachmentId: mine.id, customerId: ids.credit, slot: 'CR' })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: CR_LOCKED,
    });
    const after = await prisma.attachment.findUniqueOrThrow({ where: { id: mine.id } });
    expect(after.customerId).toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.credit } })).crPhotoId).toBeNull();

    const managers = await photo('CR', ids.mgrA, 'cr-mgr');
    as(ids.mgrA, 'MANAGER');
    expect(await photos.attachPhotoAction({ attachmentId: managers.id, customerId: ids.credit, slot: 'CR' })).toEqual({ ok: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.credit } })).crPhotoId).toBe(managers.id);

    as(ids.sales, 'SALESMAN');
    expect(await photos.attachPhotoAction({ attachmentId: mine.id, customerId: ids.cash, slot: 'CR' })).toEqual({ ok: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.cash } })).crPhotoId).toBe(mine.id);
  });

  it('(2) nor remove it, even one he took (as at a new-customer request); a Manager can', async () => {
    const his = await photo('CR', ids.sales, 'cr-his');
    await prisma.$transaction([
      prisma.customer.update({ where: { id: ids.credit }, data: { crPhotoId: null } }),
      prisma.attachment.update({ where: { id: his.id }, data: { customerId: ids.credit } }),
      prisma.customer.update({ where: { id: ids.credit }, data: { crPhotoId: his.id } }),
    ]);
    as(ids.sales, 'SALESMAN');
    expect(await photos.detachPhotoAction({ attachmentId: his.id })).toEqual({ ok: false, code: 'FORBIDDEN', message: CR_LOCKED });
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: his.id } })).deletedAt).toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.credit } })).crPhotoId).toBe(his.id);

    as(ids.mgrA, 'MANAGER');
    expect(await photos.detachPhotoAction({ attachmentId: his.id })).toEqual({ ok: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.credit } })).crPhotoId).toBeNull();
  });
});
