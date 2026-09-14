/**
 * B2 / SEC-02 (enterprise assessment, 2026-09-14) — Manager user-administration
 * is REGION-SCOPED, end to end through the real server actions:
 *
 *   • a Manager cannot create a VIEWER (org-wide read + export) at all;
 *   • a Manager cannot create a salesman on a route outside their regions, nor
 *     route one to a supervisor/manager outside their regions;
 *   • a Manager cannot disable, reset or re-role a salesman in another region;
 *   • the happy path inside their own region still works, and the Steward is
 *     unaffected.
 *
 * DB-backed, self-cleaning (unique suffix, deletes everything it created).
 *
 *   RUN_USER_ADMIN_SCOPE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/user-admin-region-scope.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_USER_ADMIN_SCOPE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sfx = `uas${Date.now().toString(36)}`;
const PASSWORD = 'Region-Scope-Test-2026!';

describe.skipIf(!ENABLED)('B2 / SEC-02: Manager user administration is region-scoped', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let users: typeof import('@/services/users');
  const ids = {
    regionA: '',
    regionB: '',
    routeA: '',
    routeA2: '',
    routeB: '',
    mgrA: '',
    mgrB: '',
    stw: '',
    salesmanB: '',
    created: [] as string[],
  };
  const as = (id: string, role: string) => {
    current = { id, role, username: id };
  };
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    users = await import('@/services/users');
    const hash = await bcrypt.hash(PASSWORD, 12);
    const A = await prisma.region.create({ data: { code: `UA${sfx}`.toUpperCase(), name: `Scope A ${sfx}` } });
    const B = await prisma.region.create({ data: { code: `UB${sfx}`.toUpperCase(), name: `Scope B ${sfx}` } });
    const rA = await prisma.route.create({ data: { code: `RA${sfx}`.toUpperCase(), name: 'A1', regionId: A.id } });
    const rA2 = await prisma.route.create({ data: { code: `RC${sfx}`.toUpperCase(), name: 'A2', regionId: A.id } });
    const rB = await prisma.route.create({ data: { code: `RB${sfx}`.toUpperCase(), name: 'B1', regionId: B.id } });
    const mgrA = await prisma.user.create({
      data: { username: `mgra.${sfx}`, fullName: 'Manager A', role: 'MANAGER', passwordHash: hash, managedRegions: { connect: { id: A.id } } },
    });
    const mgrB = await prisma.user.create({
      data: { username: `mgrb.${sfx}`, fullName: 'Manager B', role: 'MANAGER', passwordHash: hash, managedRegions: { connect: { id: B.id } } },
    });
    const stw = await prisma.user.create({
      data: { username: `stw.${sfx}`, fullName: 'Steward', role: 'STEWARD', passwordHash: hash },
    });
    const salesmanB = await prisma.user.create({
      data: { username: `sb.${sfx}`, fullName: 'Salesman B', role: 'SALESMAN', passwordHash: hash, supervisorId: mgrB.id, ownedRouteId: rB.id },
    });
    Object.assign(ids, {
      regionA: A.id, regionB: B.id, routeA: rA.id, routeA2: rA2.id, routeB: rB.id,
      mgrA: mgrA.id, mgrB: mgrB.id, stw: stw.id, salesmanB: salesmanB.id,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const created = await prisma.user.findMany({
      where: { username: { endsWith: sfx } },
      select: { id: true },
    });
    const all = [...new Set([...created.map((u) => u.id), ids.mgrA, ids.mgrB, ids.stw, ids.salesmanB])].filter(Boolean);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: all } }, { entityId: { in: all } }] } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: all } } });
    await prisma.user.updateMany({ where: { id: { in: all } }, data: { ownedRouteId: null, supervisorId: null } });
    for (const id of [ids.mgrA, ids.mgrB]) {
      await prisma.user.update({ where: { id }, data: { managedRegions: { set: [] } } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: all } } });
    await prisma.route.deleteMany({ where: { id: { in: [ids.routeA, ids.routeA2, ids.routeB] } } });
    await prisma.region.deleteMany({ where: { id: { in: [ids.regionA, ids.regionB] } } });
    await prisma.$disconnect();
  });

  it('Manager A cannot create a VIEWER (org-wide read + export)', async () => {
    as(ids.mgrA, 'MANAGER');
    const res = await users.createUserAction(
      fd({ username: `viewer.${sfx}`, fullName: 'Viewer', role: 'VIEWER', password: PASSWORD })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fields?.role).toMatch(/Steward/);
    expect(await prisma.user.findUnique({ where: { username: `viewer.${sfx}` } })).toBeNull();
  });

  it('Manager A cannot create a salesman on a route in region B, nor route one to Manager B', async () => {
    as(ids.mgrA, 'MANAGER');
    const onB = await users.createUserAction(
      fd({ username: `sx1.${sfx}`, fullName: 'Salesman X', role: 'SALESMAN', password: PASSWORD, ownedRouteId: ids.routeB, supervisorId: ids.mgrA })
    );
    expect(onB.ok).toBe(false);
    if (!onB.ok) expect(onB.fields?.ownedRouteId, JSON.stringify(onB)).toMatch(/not in a region you manage/);

    const toB = await users.createUserAction(
      fd({ username: `sx2.${sfx}`, fullName: 'Salesman X', role: 'SALESMAN', password: PASSWORD, ownedRouteId: ids.routeA, supervisorId: ids.mgrB })
    );
    expect(toB.ok).toBe(false);
    if (!toB.ok) expect(toB.fields?.supervisorId, JSON.stringify(toB)).toMatch(/outside the regions you manage/);
    expect(await prisma.user.count({ where: { username: { in: [`sx1.${sfx}`, `sx2.${sfx}`] } } })).toBe(0);
  });

  it('Manager A CAN create a salesman on a route in region A reporting to themself', async () => {
    as(ids.mgrA, 'MANAGER');
    const res = await users.createUserAction(
      fd({ username: `sa.${sfx}`, fullName: 'Salesman A', role: 'SALESMAN', password: PASSWORD, ownedRouteId: ids.routeA, supervisorId: ids.mgrA })
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { username: `sa.${sfx}` } });
    expect(u.ownedRouteId).toBe(ids.routeA);
    expect(u.supervisorId).toBe(ids.mgrA);
    expect(u.mustChangePassword).toBe(true);
    ids.created.push(u.id);
  });

  it('Manager A cannot disable, reset or re-role the salesman of region B; Manager B can', async () => {
    as(ids.mgrA, 'MANAGER');
    const toggle = await users.toggleUserActiveAction(fd({ userId: ids.salesmanB }));
    expect(toggle.ok).toBe(false);
    if (!toggle.ok) expect(toggle.code).toBe('FORBIDDEN');
    const reset = await users.resetPasswordAction(fd({ userId: ids.salesmanB, password: 'Another-Strong-Pass-2026!' }));
    expect(reset.ok).toBe(false);
    if (!reset.ok) expect(reset.code).toBe('FORBIDDEN');
    const rerole = await users.updateUserRoleAction(fd({ userId: ids.salesmanB, newRole: 'SUPERVISOR' }));
    expect(rerole.ok).toBe(false);
    if (!rerole.ok) expect(rerole.code).toBe('FORBIDDEN');
    const still = await prisma.user.findUniqueOrThrow({ where: { id: ids.salesmanB } });
    expect(still.isActive).toBe(true);
    expect(still.role).toBe('SALESMAN');

    as(ids.mgrB, 'MANAGER');
    const ok = await users.resetPasswordAction(fd({ userId: ids.salesmanB, password: 'Another-Strong-Pass-2026!' }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it('Manager A cannot move their own salesman onto a route in region B', async () => {
    as(ids.mgrA, 'MANAGER');
    const saId = ids.created[0]!;
    // promote to SUPERVISOR then back to SALESMAN on the other region's route
    const up = await users.updateUserRoleAction(fd({ userId: saId, newRole: 'SUPERVISOR' }));
    expect(up.ok, JSON.stringify(up)).toBe(true);
    const back = await users.updateUserRoleAction(fd({ userId: saId, newRole: 'SALESMAN', ownedRouteId: ids.routeB }));
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.fields?.ownedRouteId).toMatch(/not in a region you manage/);
    const home = await users.updateUserRoleAction(fd({ userId: saId, newRole: 'SALESMAN', ownedRouteId: ids.routeA2 }));
    expect(home.ok, JSON.stringify(home)).toBe(true);
  });

  it('a Manager with NO regions administers nobody (fail-closed)', async () => {
    // A fresh Manager (not mgrA — loadScope is React-cache-memoised per user id
    // inside one process, so mutating mgrA's regions mid-run would read stale).
    const hash = await bcrypt.hash(PASSWORD, 12);
    const mgrC = await prisma.user.create({
      data: { username: `mgrc.${sfx}`, fullName: 'Manager C (no regions)', role: 'MANAGER', passwordHash: hash },
    });
    as(mgrC.id, 'MANAGER');
    const res = await users.createUserAction(
      fd({ username: `sz.${sfx}`, fullName: 'Salesman Z', role: 'SALESMAN', password: PASSWORD, ownedRouteId: ids.routeA })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message, JSON.stringify(res)).toMatch(/no managed regions/);
    const reset = await users.resetPasswordAction(
      fd({ userId: ids.salesmanB, password: 'Another-Strong-Pass-2027!' })
    );
    expect(reset.ok).toBe(false);
    if (!reset.ok) expect(reset.code).toBe('FORBIDDEN');
  });

  it('the Steward is org-wide: can create a VIEWER and administer either region', async () => {
    as(ids.stw, 'STEWARD');
    const v = await users.createUserAction(
      fd({ username: `sv.${sfx}`, fullName: 'Viewer', role: 'VIEWER', password: PASSWORD })
    );
    expect(v.ok, JSON.stringify(v)).toBe(true);
    const t = await users.toggleUserActiveAction(fd({ userId: ids.salesmanB }));
    expect(t.ok, JSON.stringify(t)).toBe(true);
    await users.toggleUserActiveAction(fd({ userId: ids.salesmanB })); // re-enable
  });
});
