// @vitest-environment node
/**
 * Owner decision 8 (2026-10-07), on Postgres, through the real server actions:
 * the Data Steward's Edit account on /users (services/users.ts
 * updateUserAccountAction), the create form's regions, and the leaver/joiner
 * hand-over of a route.
 *
 *   • only the Steward edits an account;
 *   • a Manager or Accountant is created with at least one region;
 *   • a route is never taken from an ACTIVE salesman; once the leaver is
 *     disabled, the joiner is created onto his route with the route code as his
 *     sign-in name, the leaver's sign-in name is retired with the route (REASSIGN
 *     row), and the leaver's request in review stays his, still in review;
 *   • a moved salesman's sign-in name follows the new route's code, his sessions
 *     are left alone, and his supervisor must cover the new route's region;
 *   • a Manager keeps every region an active salesman of his works in, and an
 *     account with reports keeps a supervising role;
 *   • a change of regions or role ends the sessions; a role change clears the
 *     route and supervisor; the phone is named in the audit row, never copied;
 *   • a save that changes nothing writes nothing.
 *
 *   RUN_ACCOUNT_EDIT=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/account-edit.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_ACCOUNT_EDIT === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sfx = `ae${Date.now().toString(36)}`;
const PASSWORD = 'Account-Edit-Test-2026!';
const code = (p: string) => `${p}${sfx}`.toUpperCase();

describe.skipIf(!ENABLED)(
  'owner decision 8: the Steward edits accounts and hands routes over',
  () => {
    let prisma: import('@prisma/client').PrismaClient;
    let users: typeof import('@/services/users');
    let omanDateISO: typeof import('@/lib/tz').omanDateISO;
    const ids = {
      A: '',
      B: '',
      A1: '',
      A2: '',
      A3: '',
      B1: '',
      mA: '',
      mB: '',
      mX: '',
      stw: '',
      leaver: '',
      busy: '',
      joiner: '',
      edit: '',
    };
    const as = (id: string, role: string) => {
      current = { id, role, username: id };
    };
    const fd = (o: Record<string, string | string[]>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) {
        for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
      }
      return f;
    };
    const user = (id: string) =>
      prisma.user.findUniqueOrThrow({
        where: { id },
        include: { managedRegions: { select: { id: true } } },
      });
    const lastAudit = (entityId: string, action = 'UPDATE') =>
      prisma.auditLog.findFirst({
        where: { entityId, action: action as 'UPDATE' },
        orderBy: { at: 'desc' },
      });
    const auditCount = (entityId: string) => prisma.auditLog.count({ where: { entityId } });

    beforeAll(async () => {
      if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze'))
        throw new Error('ABORT: production');
      ({ prisma } = await import('@/lib/db'));
      users = await import('@/services/users');
      ({ omanDateISO } = await import('@/lib/tz'));
      const A = await prisma.region.create({ data: { code: code('EA'), name: `Edit A ${sfx}` } });
      const B = await prisma.region.create({ data: { code: code('EB'), name: `Edit B ${sfx}` } });
      const route = (c: string, regionId: string) =>
        prisma.route.create({ data: { code: code(c), name: c, regionId } });
      const [A1, A2, A3, B1] = await Promise.all([
        route('A1', A.id),
        route('A2', A.id),
        route('A3', A.id),
        route('B1', B.id),
      ]);
      const mgr = (u: string, regionIds: string[]) =>
        prisma.user.create({
          data: {
            username: `${u}.${sfx}`,
            fullName: `Manager ${u}`,
            role: 'MANAGER',
            passwordHash: 'x',
            managedRegions: { connect: regionIds.map((id) => ({ id })) },
          },
        });
      const mA = await mgr('mga', [A.id]);
      const mB = await mgr('mgb', [B.id]);
      const mX = await mgr('mgx', [A.id]);
      // The session is mocked, so the Steward's row can stay switched off: other
      // suites notify every ACTIVE Steward, which would hold up the clean-up.
      const stw = await prisma.user.create({
        data: {
          username: `stw.${sfx}`,
          fullName: 'Steward',
          role: 'STEWARD',
          passwordHash: 'x',
          isActive: false,
        },
      });
      // The leaver signs in with his route's code, as every go-live salesman does.
      const leaver = await prisma.user.create({
        data: {
          username: code('A1').toLowerCase(),
          fullName: 'Leaving Salesman',
          role: 'SALESMAN',
          passwordHash: 'x',
          ownedRouteId: A1.id,
          supervisorId: mA.id,
        },
      });
      const busy = await prisma.user.create({
        data: {
          username: `busy.${sfx}`,
          fullName: 'Busy Salesman',
          role: 'SALESMAN',
          passwordHash: 'x',
          ownedRouteId: A3.id,
          supervisorId: mA.id,
        },
      });
      // A request of the leaver's, in review (no customer: this suite only
      // follows who it belongs to).
      const edit = await prisma.customerEdit.create({
        data: {
          target: 'CUSTOMER',
          state: 'SUBMITTED',
          submittedById: leaver.id,
          submittedAt: new Date(),
          fieldChanges: {},
          attachmentChanges: {},
        },
      });
      Object.assign(ids, {
        A: A.id,
        B: B.id,
        A1: A1.id,
        A2: A2.id,
        A3: A3.id,
        B1: B1.id,
        mA: mA.id,
        mB: mB.id,
        mX: mX.id,
        stw: stw.id,
        leaver: leaver.id,
        busy: busy.id,
        edit: edit.id,
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      if (ids.edit) await prisma.customerEdit.deleteMany({ where: { id: ids.edit } });
      const created = await prisma.user.findMany({
        where: { username: { contains: sfx } },
        select: { id: true },
      });
      const all = [
        ...new Set([
          ...created.map((u) => u.id),
          ids.mA,
          ids.mB,
          ids.mX,
          ids.stw,
          ids.leaver,
          ids.busy,
        ]),
      ].filter(Boolean);
      await prisma.user.updateMany({ where: { id: { in: all } }, data: { isActive: false } });
      await prisma.notification.deleteMany({ where: { userId: { in: all } } });
      await purgeAuditLog(prisma, {
        where: { OR: [{ actorId: { in: all } }, { entityId: { in: all } }] },
      });
      await prisma.passwordHistory.deleteMany({ where: { userId: { in: all } } });
      await prisma.user.updateMany({
        where: { id: { in: all } },
        data: { ownedRouteId: null, supervisorId: null },
      });
      for (const id of all) {
        await prisma.user
          .update({ where: { id }, data: { managedRegions: { set: [] } } })
          .catch(() => undefined);
      }
      await prisma.user.deleteMany({ where: { id: { in: all } } });
      await prisma.route.deleteMany({
        where: { id: { in: [ids.A1, ids.A2, ids.A3, ids.B1].filter(Boolean) } },
      });
      await prisma.region.deleteMany({ where: { id: { in: [ids.A, ids.B].filter(Boolean) } } });
      await prisma.$disconnect();
    });

    it('a Manager cannot edit an account, not even a salesman of his region', async () => {
      as(ids.mA, 'MANAGER');
      const res = await users.updateUserAccountAction(
        fd({ userId: ids.busy, role: 'SALESMAN', ownedRouteId: ids.A2, supervisorId: ids.mA })
      );
      expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect((await user(ids.busy)).ownedRouteId).toBe(ids.A3);
    });

    it('a Manager is created with his regions, never with none', async () => {
      as(ids.stw, 'STEWARD');
      const base = {
        username: `nm.${sfx}`,
        fullName: 'New Manager',
        role: 'MANAGER',
        password: PASSWORD,
      };
      const blind = await users.createUserAction(fd(base));
      expect(blind, JSON.stringify(blind)).toMatchObject({
        ok: false,
        fields: { regionIds: expect.stringMatching(/at least one region/) },
      });
      expect(await prisma.user.findUnique({ where: { username: base.username } })).toBeNull();

      const ok = await users.createUserAction(fd({ ...base, regionId: [ids.A, ids.B] }));
      expect(ok, JSON.stringify(ok)).toEqual({ ok: true, data: undefined });
      const m = await prisma.user.findUniqueOrThrow({
        where: { username: base.username },
        include: { managedRegions: { select: { code: true } } },
      });
      expect(m.managedRegions.map((r) => r.code).sort()).toEqual([code('EA'), code('EB')]);
      const row = await lastAudit(m.id, 'CREATE');
      expect(row?.after).toMatchObject({ role: 'MANAGER', regions: [code('EA'), code('EB')] });
    });

    it('while the leaver is active, nobody is created onto his route', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.createUserAction(
        fd({
          username: code('A1').toLowerCase(),
          fullName: 'Joining Salesman',
          role: 'SALESMAN',
          password: PASSWORD,
          ownedRouteId: ids.A1,
          supervisorId: ids.mA,
        })
      );
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: false,
        fields: {
          ownedRouteId: expect.stringMatching(/Leaving Salesman .* whose account is active/),
        },
      });
      expect((await user(ids.leaver)).ownedRouteId).toBe(ids.A1);
    });

    it('leaver/joiner: disable the leaver, create the joiner onto his route under the route code', async () => {
      as(ids.stw, 'STEWARD');
      const off = await users.toggleUserActiveAction(fd({ userId: ids.leaver }));
      expect(off, JSON.stringify(off)).toEqual({ ok: true, data: undefined });
      const signIn = code('A1').toLowerCase();
      const joiner = {
        username: signIn,
        fullName: 'Joining Salesman',
        role: 'SALESMAN',
        password: PASSWORD,
        ownedRouteId: ids.A1,
      };

      // A supervisor outside the route's region is refused, and nothing moves.
      const wrong = await users.createUserAction(fd({ ...joiner, supervisorId: ids.mB }));
      expect(wrong, JSON.stringify(wrong)).toMatchObject({
        ok: false,
        fields: { supervisorId: expect.stringMatching(/does not manage/) },
      });
      expect(await user(ids.leaver)).toMatchObject({ username: signIn, ownedRouteId: ids.A1 });

      const res = await users.createUserAction(fd({ ...joiner, supervisorId: ids.mA }));
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const retired = `${signIn}.left.${omanDateISO().replace(/-/g, '')}`;
      const notes = res.ok ? (res.data?.notes ?? []) : [];
      expect(notes.join(' ')).toContain(retired);
      expect(notes.join(' ')).toMatch(
        /1 request\(s\) in review\. They stay with the same approvers/
      );

      const j = await prisma.user.findUniqueOrThrow({ where: { username: signIn } });
      ids.joiner = j.id;
      expect(j).toMatchObject({
        ownedRouteId: ids.A1,
        supervisorId: ids.mA,
        role: 'SALESMAN',
        mustChangePassword: true,
      });
      expect(await user(ids.leaver)).toMatchObject({
        username: retired,
        ownedRouteId: null,
        isActive: false,
      });
      const reassign = await lastAudit(ids.leaver, 'REASSIGN');
      expect(reassign).toMatchObject({
        actorId: ids.stw,
        before: { ownedRouteCode: code('A1'), username: signIn },
        after: { ownedRouteCode: null, username: retired },
      });
      // His request in review is untouched: still his, still in review, so the
      // region's Managers decide it as before.
      expect(
        await prisma.customerEdit.findUniqueOrThrow({ where: { id: ids.edit } })
      ).toMatchObject({
        submittedById: ids.leaver,
        state: 'SUBMITTED',
      });
    });

    it('moving a salesman inside the region: the sign-in name follows the code; his sessions stay', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.updateUserAccountAction(
        fd({
          userId: ids.joiner,
          role: 'SALESMAN',
          ownedRouteId: ids.A2,
          supervisorId: ids.mA,
          routeSignIn: 'on',
        })
      );
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: true,
        data: { changed: ['username', 'route'], username: code('A2').toLowerCase() },
      });
      const j = await user(ids.joiner);
      expect(j).toMatchObject({
        username: code('A2').toLowerCase(),
        ownedRouteId: ids.A2,
        sessionsRevokedAt: null,
      });
      expect(await prisma.user.findUnique({ where: { ownedRouteId: ids.A1 } })).toBeNull();
      const row = await lastAudit(ids.joiner);
      expect(row).toMatchObject({
        reason: 'account_edit',
        before: { username: code('A1').toLowerCase(), route: code('A1') },
        after: { username: code('A2').toLowerCase(), route: code('A2') },
      });
    });

    it('a route an active salesman works is refused', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.updateUserAccountAction(
        fd({ userId: ids.joiner, role: 'SALESMAN', ownedRouteId: ids.A3, supervisorId: ids.mA })
      );
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: false,
        fields: { ownedRouteId: expect.stringMatching(/Busy Salesman/) },
      });
      expect((await user(ids.joiner)).ownedRouteId).toBe(ids.A2);
      expect((await user(ids.busy)).ownedRouteId).toBe(ids.A3);
    });

    it('a route in another region needs a supervisor of that region', async () => {
      as(ids.stw, 'STEWARD');
      const keep = await users.updateUserAccountAction(
        fd({ userId: ids.joiner, role: 'SALESMAN', ownedRouteId: ids.B1, supervisorId: ids.mA })
      );
      expect(keep, JSON.stringify(keep)).toMatchObject({
        ok: false,
        fields: { supervisorId: expect.stringMatching(/does not manage/) },
      });
      expect((await user(ids.joiner)).ownedRouteId).toBe(ids.A2);
      const moved = await users.updateUserAccountAction(
        fd({ userId: ids.joiner, role: 'SALESMAN', ownedRouteId: ids.B1, supervisorId: ids.mB })
      );
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      // Not ticked: the sign-in name stays.
      expect(await user(ids.joiner)).toMatchObject({
        ownedRouteId: ids.B1,
        supervisorId: ids.mB,
        username: code('A2').toLowerCase(),
      });
    });

    it('a Manager keeps every region his active salesmen work in; other region edits end his sessions', async () => {
      as(ids.stw, 'STEWARD');
      const strand = await users.updateUserAccountAction(
        fd({ userId: ids.mB, role: 'MANAGER', regionId: [ids.A] })
      );
      expect(strand, JSON.stringify(strand)).toMatchObject({
        ok: false,
        fields: { regionIds: expect.stringMatching(/work in/) },
      });
      expect((await user(ids.mB)).managedRegions.map((r) => r.id)).toEqual([ids.B]);

      const none = await users.updateUserAccountAction(fd({ userId: ids.mX, role: 'MANAGER' }));
      expect(none, JSON.stringify(none)).toMatchObject({
        ok: false,
        fields: { regionIds: expect.stringMatching(/at least one region/) },
      });

      const res = await users.updateUserAccountAction(
        fd({ userId: ids.mX, role: 'MANAGER', regionId: [ids.B] })
      );
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { changed: ['regions'] } });
      const x = await user(ids.mX);
      expect(x.managedRegions.map((r) => r.id)).toEqual([ids.B]);
      expect(x.sessionsRevokedAt).toBeInstanceOf(Date);
      expect(await lastAudit(ids.mX)).toMatchObject({
        before: { regions: [code('EA')] },
        after: { regions: [code('EB')] },
      });
    });

    it('an account somebody reports to keeps a supervising role', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.updateUserAccountAction(fd({ userId: ids.mB, role: 'VIEWER' }));
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: false,
        fields: { role: expect.stringMatching(/report to/) },
      });
      expect((await user(ids.mB)).role).toBe('MANAGER');
    });

    it('the phone: named in the audit row and never copied; an empty box keeps it; a save of nothing records nothing', async () => {
      as(ids.stw, 'STEWARD');
      const same = {
        userId: ids.joiner,
        role: 'SALESMAN',
        ownedRouteId: ids.B1,
        supervisorId: ids.mB,
      };
      const set = await users.updateUserAccountAction(fd({ ...same, phone: '+968 9123 4567' }));
      expect(set, JSON.stringify(set)).toMatchObject({ ok: true, data: { changed: ['phone'] } });
      expect((await user(ids.joiner)).phone).toBe('+968 9123 4567');
      const row = await lastAudit(ids.joiner);
      expect(row?.after).toEqual({ changed: ['phone'] });
      expect(JSON.stringify(row)).not.toContain('9123');

      const before = await auditCount(ids.joiner);
      const nothing = await users.updateUserAccountAction(fd({ ...same, phone: '' }));
      expect(nothing, JSON.stringify(nothing)).toMatchObject({ ok: true, data: { changed: [] } });
      expect(await auditCount(ids.joiner)).toBe(before);
      expect((await user(ids.joiner)).phone).toBe('+968 9123 4567');

      const cleared = await users.updateUserAccountAction(fd({ ...same, clearPhone: 'on' }));
      expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
      expect((await user(ids.joiner)).phone).toBeNull();
    });

    it('a role change clears the route and the supervisor, ends the sessions, and is audited', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.updateUserAccountAction(fd({ userId: ids.joiner, role: 'VIEWER' }));
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: true,
        data: { changed: ['role', 'route', 'supervisor'] },
      });
      const j = await user(ids.joiner);
      expect(j).toMatchObject({ role: 'VIEWER', ownedRouteId: null, supervisorId: null });
      expect(j.sessionsRevokedAt).toBeInstanceOf(Date);
      expect(await lastAudit(ids.joiner)).toMatchObject({
        before: { role: 'SALESMAN', route: code('B1'), supervisor: `mgb.${sfx}` },
        after: { role: 'VIEWER', route: null, supervisor: null },
      });
    });

    it('a disabled account is not given a route (X-IMPORTS-2)', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.updateUserAccountAction(
        fd({ userId: ids.leaver, role: 'SALESMAN', ownedRouteId: ids.A1, supervisorId: ids.mA })
      );
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: false,
        fields: { ownedRouteId: expect.stringMatching(/disabled/) },
      });
      expect((await user(ids.leaver)).ownedRouteId).toBeNull();
    });
  }
);
