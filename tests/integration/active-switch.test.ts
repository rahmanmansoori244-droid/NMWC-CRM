// @vitest-environment node
/**
 * Code review 2026-11-10, finding 9, on Postgres through the real server actions:
 * Disable / Enable on accounts, routes and regions set the state the click WANTS.
 *
 *   • a double click, or a second admin's click from a stale screen, changes
 *     nothing the second time: the account stays disabled, and there is ONE audit
 *     row and ONE history row (UserHistory / RouteHistory / RegionHistory, written
 *     by the database's triggers) for the one real change;
 *   • two Disables sent at the same moment: exactly one of them changes the
 *     account, the other answers "already disabled";
 *   • Enable on a disabled account enables it, once.
 *
 *   RUN_ACTIVE_SWITCH=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/active-switch.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_ACTIVE_SWITCH === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sfx = `asw${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('finding 9: a switch sets the wanted state, once', () => {
  let prisma: typeof import('@/lib/db').prisma;
  let users: typeof import('@/services/users');
  let routes: typeof import('@/services/routes');
  const ids = { region: '', route: '', stw: '', leaver: '', racer: '' };
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const audits = (entityId: string) => prisma.auditLog.count({ where: { entityId } });
  const userHistory = (userId: string) => prisma.userHistory.count({ where: { userId, changeKind: 'UPDATE' } });

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    users = await import('@/services/users');
    routes = await import('@/services/routes');
    const region = await prisma.region.create({ data: { code: `G${sfx}`.toUpperCase(), name: `Switch ${sfx}` } });
    const route = await prisma.route.create({
      data: { code: `R${sfx}`.toUpperCase(), name: 'Switch 1', regionId: region.id },
    });
    const stw = await prisma.user.create({
      data: { username: `stw.${sfx}`, fullName: 'Steward', role: 'STEWARD', passwordHash: 'x' },
    });
    const leaver = await prisma.user.create({
      data: { username: `lv.${sfx}`, fullName: 'Leaver', role: 'SUPERVISOR', passwordHash: 'x' },
    });
    const racer = await prisma.user.create({
      data: { username: `rc.${sfx}`, fullName: 'Racer', role: 'SUPERVISOR', passwordHash: 'x' },
    });
    Object.assign(ids, { region: region.id, route: route.id, stw: stw.id, leaver: leaver.id, racer: racer.id });
    current = { id: stw.id, role: 'STEWARD', username: stw.username };
  });

  afterAll(async () => {
    if (!prisma) return;
    const all = [ids.stw, ids.leaver, ids.racer].filter(Boolean);
    await purgeAuditLog(prisma, {
      where: { OR: [{ actorId: { in: all } }, { entityId: { in: [...all, ids.route, ids.region] } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: all } } });
    if (ids.route) await prisma.route.deleteMany({ where: { id: ids.route } });
    if (ids.region) await prisma.region.deleteMany({ where: { id: ids.region } });
    await prisma.$disconnect();
  });

  it('an account: Disable twice (a double click, or a stale screen) — disabled once, one audit row, one history row', async () => {
    const historyBefore = await userHistory(ids.leaver);
    const first = await users.toggleUserActiveAction(fd({ userId: ids.leaver, active: 'false' }));
    expect(first, JSON.stringify(first)).toEqual({ ok: true, data: { isActive: false, changed: true } });
    const revokedAt = (await prisma.user.findUniqueOrThrow({ where: { id: ids.leaver } })).sessionsRevokedAt;
    const second = await users.toggleUserActiveAction(fd({ userId: ids.leaver, active: 'false' }));
    expect(second, JSON.stringify(second)).toEqual({ ok: true, data: { isActive: false, changed: false } });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ids.leaver } });
    expect(row.isActive).toBe(false);
    expect(row.sessionsRevokedAt?.getTime()).toBe(revokedAt?.getTime());
    expect(await audits(ids.leaver)).toBe(1);
    expect(await userHistory(ids.leaver)).toBe(historyBefore + 1);
  });

  it('then Enable: enabled once, and a second Enable changes nothing', async () => {
    const auditsBefore = await audits(ids.leaver);
    const historyBefore = await userHistory(ids.leaver);
    expect(await users.toggleUserActiveAction(fd({ userId: ids.leaver, active: 'true' }))).toEqual({
      ok: true,
      data: { isActive: true, changed: true },
    });
    expect(await users.toggleUserActiveAction(fd({ userId: ids.leaver, active: 'true' }))).toEqual({
      ok: true,
      data: { isActive: true, changed: false },
    });
    expect(await audits(ids.leaver)).toBe(auditsBefore + 1);
    expect(await userHistory(ids.leaver)).toBe(historyBefore + 1);
  });

  it('two Disables at the same moment: exactly one changes the account', async () => {
    const results = await Promise.all([
      users.toggleUserActiveAction(fd({ userId: ids.racer, active: 'false' })),
      users.toggleUserActiveAction(fd({ userId: ids.racer, active: 'false' })),
    ]);
    for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);
    const changed = results.map((r) => (r.ok ? r.data.changed : null));
    expect(changed.filter((c) => c === true)).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.racer } })).isActive).toBe(false);
    expect(await audits(ids.racer)).toBe(1);
    expect(await userHistory(ids.racer)).toBe(1);
  });

  it('a route and a region: a second Disable writes no audit and no history row', async () => {
    for (const [action, id, history] of [
      [routes.toggleRouteActiveAction, ids.route, () => prisma.routeHistory.count({ where: { routeId: ids.route, changeKind: 'UPDATE' } })],
      [routes.toggleRegionActiveAction, ids.region, () => prisma.regionHistory.count({ where: { regionId: ids.region, changeKind: 'UPDATE' } })],
    ] as const) {
      const historyBefore = await history();
      expect(await action(fd({ id, active: 'false' }))).toEqual({ ok: true, data: { isActive: false, changed: true } });
      expect(await action(fd({ id, active: 'false' }))).toEqual({ ok: true, data: { isActive: false, changed: false } });
      expect(await audits(id)).toBe(1);
      expect(await history()).toBe(historyBefore + 1);
    }
    expect((await prisma.route.findUniqueOrThrow({ where: { id: ids.route } })).isActive).toBe(false);
    expect((await prisma.region.findUniqueOrThrow({ where: { id: ids.region } })).isActive).toBe(false);
  });

  it('a click that does not say what it wants is refused and writes nothing', async () => {
    const before = await audits(ids.racer);
    const res = await users.toggleUserActiveAction(fd({ userId: ids.racer }));
    expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.racer } })).isActive).toBe(false);
    expect(await audits(ids.racer)).toBe(before);
  });
});
