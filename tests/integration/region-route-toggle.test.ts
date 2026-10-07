// @vitest-environment node
/**
 * Owner decision 5 (2026-10-07), on Postgres, through the real server actions:
 *
 *   • only the Data Steward switches a region off or on — a Manager of the region
 *     is refused, and the region and the audit trail are untouched;
 *   • a route in a region another ACTIVE Manager shares is switched by the
 *     Steward only; a Manager who manages the region alone keeps the switch, and
 *     a disabled co-manager does not count.
 *
 * tests/unit/region-route-toggle.test.tsx proves the rule and the page; this
 * proves the action's Manager count against the real ManagerRegions join.
 *
 *   RUN_REGION_TOGGLE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/region-route-toggle.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_REGION_TOGGLE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sfx = `rrt${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('owner decision 5: switching regions and shared routes is the Steward’s', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let routes: typeof import('@/services/routes');
  const ids = { solo: '', shared: '', rSolo: '', rShared: '', mA: '', mB: '', stw: '' };
  const as = (id: string, role: string) => {
    current = { id, role, username: id };
  };
  const fd = (id: string) => {
    const f = new FormData();
    f.set('id', id);
    return f;
  };
  const audits = (entityId: string) => prisma.auditLog.count({ where: { entityId } });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    routes = await import('@/services/routes');
    const solo = await prisma.region.create({ data: { code: `S${sfx}`.toUpperCase(), name: `Solo ${sfx}` } });
    const shared = await prisma.region.create({ data: { code: `H${sfx}`.toUpperCase(), name: `Shared ${sfx}` } });
    const rSolo = await prisma.route.create({ data: { code: `RS${sfx}`.toUpperCase(), name: 'Solo 1', regionId: solo.id } });
    const rShared = await prisma.route.create({ data: { code: `RH${sfx}`.toUpperCase(), name: 'Shared 1', regionId: shared.id } });
    // mA manages both; mB shares the second. Neither can sign in (no password).
    const mA = await prisma.user.create({
      data: {
        username: `mga.${sfx}`,
        fullName: 'Manager A',
        role: 'MANAGER',
        passwordHash: 'x',
        managedRegions: { connect: [{ id: solo.id }, { id: shared.id }] },
      },
    });
    const mB = await prisma.user.create({
      data: {
        username: `mgb.${sfx}`,
        fullName: 'Manager B',
        role: 'MANAGER',
        passwordHash: 'x',
        managedRegions: { connect: [{ id: shared.id }] },
      },
    });
    // The session is mocked, so the Steward's row can stay switched off: other
    // suites notify every ACTIVE Steward, which would hold up the clean-up.
    const stw = await prisma.user.create({
      data: { username: `stw.${sfx}`, fullName: 'Steward', role: 'STEWARD', passwordHash: 'x', isActive: false },
    });
    Object.assign(ids, {
      solo: solo.id, shared: shared.id, rSolo: rSolo.id, rShared: rShared.id, mA: mA.id, mB: mB.id, stw: stw.id,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const users = [ids.mA, ids.mB, ids.stw].filter(Boolean);
    const entities = [ids.solo, ids.shared, ids.rSolo, ids.rShared].filter(Boolean);
    await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: users } }, { entityId: { in: [...users, ...entities] } }] } });
    for (const id of [ids.mA, ids.mB]) {
      if (id) await prisma.user.update({ where: { id }, data: { managedRegions: { set: [] } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.route.deleteMany({ where: { id: { in: [ids.rSolo, ids.rShared].filter(Boolean) } } });
    await prisma.region.deleteMany({ where: { id: { in: [ids.solo, ids.shared].filter(Boolean) } } });
    await prisma.$disconnect();
  });

  it('a Manager of the region cannot switch it off — not even one he manages alone', async () => {
    as(ids.mA, 'MANAGER');
    for (const id of [ids.solo, ids.shared]) {
      const res = await routes.toggleRegionActiveAction(fd(id));
      expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect((await prisma.region.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
      expect(await audits(id)).toBe(0);
    }
  });

  it('a Manager cannot switch a route of a region another active Manager shares', async () => {
    as(ids.mA, 'MANAGER');
    const res = await routes.toggleRouteActiveAction(fd(ids.rShared));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect((await prisma.route.findUniqueOrThrow({ where: { id: ids.rShared } })).isActive).toBe(true);
    expect(await audits(ids.rShared)).toBe(0);
  });

  it('a Manager who manages the region alone still switches its route', async () => {
    as(ids.mA, 'MANAGER');
    const res = await routes.toggleRouteActiveAction(fd(ids.rSolo));
    expect(res, JSON.stringify(res)).toEqual({ ok: true, data: undefined });
    expect((await prisma.route.findUniqueOrThrow({ where: { id: ids.rSolo } })).isActive).toBe(false);
  });

  it('a disabled co-manager does not count: the remaining one switches the route', async () => {
    await prisma.user.update({ where: { id: ids.mB }, data: { isActive: false } });
    as(ids.mA, 'MANAGER');
    const res = await routes.toggleRouteActiveAction(fd(ids.rShared));
    expect(res, JSON.stringify(res)).toEqual({ ok: true, data: undefined });
    expect((await prisma.route.findUniqueOrThrow({ where: { id: ids.rShared } })).isActive).toBe(false);
    await prisma.user.update({ where: { id: ids.mB }, data: { isActive: true } });
  });

  it('the Steward switches a shared region and its route, each with an audit row', async () => {
    as(ids.stw, 'STEWARD');
    const region = await routes.toggleRegionActiveAction(fd(ids.shared));
    expect(region, JSON.stringify(region)).toEqual({ ok: true, data: undefined });
    expect((await prisma.region.findUniqueOrThrow({ where: { id: ids.shared } })).isActive).toBe(false);
    const route = await routes.toggleRouteActiveAction(fd(ids.rShared));
    expect(route, JSON.stringify(route)).toEqual({ ok: true, data: undefined });
    expect((await prisma.route.findUniqueOrThrow({ where: { id: ids.rShared } })).isActive).toBe(true);
    const rows = await prisma.auditLog.findMany({
      where: { entityId: { in: [ids.shared, ids.rShared] }, actorId: ids.stw },
      select: { entityType: true, reason: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { entityType: 'Region', reason: 'disabled' },
        { entityType: 'Route', reason: 'enabled' },
      ])
    );
  });
});
