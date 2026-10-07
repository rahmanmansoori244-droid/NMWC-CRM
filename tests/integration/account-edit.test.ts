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
 * And the independent review's findings (2026-10-07):
 *   • a salesman's new-customer requests that are not in review (a draft, one
 *     sent back) hold a route change back — sent again, services/creates.ts
 *     would file them under his new route — unless the Steward withdraws them
 *     with it; a withdrawn one cannot be sent again;
 *   • his request in review stays with the region it was sent from: a Manager
 *     of his NEW region cannot decide it, another Manager of the old (shared)
 *     region can; a Supervisor-role supervisor change is said;
 *   • security review: that request, sent back to him after the move, cannot be
 *     saved or sent again from his new route (it was re-filed there); he
 *     withdraws it, and the Steward was told so when he moved him;
 *   • a shared region: a salesman moves between its Managers freely;
 *   • a switched-off route or region is refused on the server; region codes
 *     with "_" do not read as a change; a Manager keeps a supervisor an import
 *     gave him; a region keeps its only active Accountant; the e-mail is edited
 *     for any role; the leaver keeps his sign-in name unless the joiner takes it.
 *
 *   RUN_ACCOUNT_EDIT=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/account-edit.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, purgeEditApprovals } from '../support/audit';
import { freshDecisionToken } from '../support/decision-token';

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
      A4: '',
      A5: '',
      C: '',
      U1: '',
      U2: '',
      mS: '',
      supS: '',
      accA: '',
      mU: '',
      leaver5: '',
    };
    let channelId = '';
    let subChannelId = '';
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
      // The review's fixtures: a switched-off route (A4) and region (C), a route
      // for a second hand-over (A5), two regions whose codes sort differently by
      // locale and by code unit, a second Manager of A (the shared-region case), a
      // Supervisor-role account, region A's Accountant, a Manager an import gave a
      // supervisor, and A5's salesman.
      const A4 = await prisma.route.create({
        data: { code: code('A4'), name: 'A4', regionId: A.id, isActive: false },
      });
      const A5 = await route('A5', A.id);
      const C = await prisma.region.create({
        data: { code: code('EC'), name: `Edit C ${sfx}`, isActive: false },
      });
      const U1 = await prisma.region.create({ data: { code: code('ZZ'), name: `U1 ${sfx}` } });
      const U2 = await prisma.region.create({
        data: { code: `Z_Z${sfx}`.toUpperCase(), name: `U2 ${sfx}` },
      });
      const mS = await mgr('mgs', [A.id]);
      const supS = await prisma.user.create({
        data: {
          username: `sups.${sfx}`,
          fullName: 'Supervisor S',
          role: 'SUPERVISOR',
          passwordHash: 'x',
        },
      });
      const accA = await prisma.user.create({
        data: {
          username: `acca.${sfx}`,
          fullName: 'Accountant A',
          role: 'ACCOUNTANT',
          passwordHash: 'x',
          managedRegions: { connect: [{ id: A.id }] },
        },
      });
      const mU = await prisma.user.create({
        data: {
          username: `mgu.${sfx}`,
          fullName: 'Manager U',
          role: 'MANAGER',
          passwordHash: 'x',
          supervisorId: mB.id,
          managedRegions: { connect: [{ id: U1.id }, { id: U2.id }] },
        },
      });
      const leaver5 = await prisma.user.create({
        data: {
          username: code('A5').toLowerCase(),
          fullName: 'Second Leaver',
          role: 'SALESMAN',
          passwordHash: 'x',
          ownedRouteId: A5.id,
          supervisorId: mA.id,
        },
      });
      const ch = await prisma.channel.findFirst({
        where: { isActive: true, subChannels: { some: { isActive: true } } },
        include: { subChannels: { where: { isActive: true }, take: 1 } },
      });
      if (!ch) throw new Error('No channel/sub-channel seeded.');
      channelId = ch.id;
      subChannelId = ch.subChannels[0]!.id;
      Object.assign(ids, {
        A4: A4.id,
        A5: A5.id,
        C: C.id,
        U1: U1.id,
        U2: U2.id,
        mS: mS.id,
        supS: supS.id,
        accA: accA.id,
        mU: mU.id,
        leaver5: leaver5.id,
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
      // The review's new-customer requests, and what their submits wrote.
      if (ids.busy) {
        const eds = (
          await prisma.customerEdit.findMany({
            where: { submittedById: ids.busy },
            select: { id: true },
          })
        ).map((e) => e.id);
        if (eds.length) {
          await prisma.notification.deleteMany({ where: { editId: { in: eds } } });
          await purgeEditApprovals(prisma, { where: { editId: { in: eds } } });
          await prisma.editBranchDraft.deleteMany({ where: { editId: { in: eds } } });
          await prisma.editCustomerDraft.deleteMany({ where: { editId: { in: eds } } });
          await purgeAuditLog(prisma, { where: { entityId: { in: eds } } });
          await purgeCustomerEdits(prisma, { where: { id: { in: eds } } });
        }
        await prisma.attachment.deleteMany({ where: { capturedById: ids.busy } });
        await prisma.rateLimit.deleteMany({ where: { key: { contains: ids.busy } } });
      }
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
          ids.mS,
          ids.supS,
          ids.accA,
          ids.mU,
          ids.leaver5,
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
        where: {
          id: { in: [ids.A1, ids.A2, ids.A3, ids.A4, ids.A5, ids.B1].filter(Boolean) },
        },
      });
      await prisma.region.deleteMany({
        where: { id: { in: [ids.A, ids.B, ids.C, ids.U1, ids.U2].filter(Boolean) } },
      });
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

    it('a salesman left with no route can still be edited without one', async () => {
      as(ids.stw, 'STEWARD');
      const res = await users.updateUserAccountAction(
        fd({ userId: ids.leaver, role: 'SALESMAN', supervisorId: ids.mA, phone: '+968 9555 0000' })
      );
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { changed: ['phone'] } });
      expect(await user(ids.leaver)).toMatchObject({ ownedRouteId: null, phone: '+968 9555 0000' });
    });

    // ── The independent review (2026-10-07) ─────────────────────────────────
    it('review: a switched-off route or region is refused on the server, unless the account has it already', async () => {
      as(ids.stw, 'STEWARD');
      const route = await users.updateUserAccountAction(
        fd({ userId: ids.busy, role: 'SALESMAN', ownedRouteId: ids.A4, supervisorId: ids.mA })
      );
      expect(route, JSON.stringify(route)).toMatchObject({
        ok: false,
        fields: { ownedRouteId: expect.stringMatching(/switched off/) },
      });
      expect((await user(ids.busy)).ownedRouteId).toBe(ids.A3);
      const created = await users.createUserAction(
        fd({
          username: `off.${sfx}`,
          fullName: 'Off Route',
          role: 'SALESMAN',
          password: PASSWORD,
          ownedRouteId: ids.A4,
          supervisorId: ids.mA,
        })
      );
      expect(created, JSON.stringify(created)).toMatchObject({
        ok: false,
        fields: { ownedRouteId: expect.stringMatching(/switched off/) },
      });

      const region = await users.updateUserAccountAction(
        fd({ userId: ids.mX, role: 'MANAGER', regionId: [ids.B, ids.C] })
      );
      expect(region, JSON.stringify(region)).toMatchObject({
        ok: false,
        fields: { regionIds: expect.stringMatching(/switched off/) },
      });
      // One he has already (it was switched off since) he keeps.
      await prisma.user.update({
        where: { id: ids.mX },
        data: { managedRegions: { connect: [{ id: ids.C }] } },
      });
      const kept = await users.updateUserAccountAction(
        fd({ userId: ids.mX, role: 'MANAGER', regionId: [ids.B, ids.C], phone: '+968 9111 2222' })
      );
      expect(kept, JSON.stringify(kept)).toMatchObject({ ok: true, data: { changed: ['phone'] } });
    });

    it('review: region codes with "_" are compared in one order, and a Manager keeps the supervisor an import gave him', async () => {
      as(ids.stw, 'STEWARD');
      const before = await auditCount(ids.mU);
      const res = await users.updateUserAccountAction(
        fd({ userId: ids.mU, role: 'MANAGER', regionId: [ids.U1, ids.U2], phone: '+968 9333 4444' })
      );
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, data: { changed: ['phone'] } });
      const u = await user(ids.mU);
      // Not signed out: the regions did not change.
      expect(u.sessionsRevokedAt).toBeNull();
      expect(u.supervisorId).toBe(ids.mB);
      expect(await auditCount(ids.mU)).toBe(before + 1);
      expect((await lastAudit(ids.mU))?.after).toEqual({ changed: ['phone'] });
    });

    it('review: the leaver keeps his sign-in name when the joiner signs in with a name of his own', async () => {
      as(ids.stw, 'STEWARD');
      const off = await users.toggleUserActiveAction(fd({ userId: ids.leaver5 }));
      expect(off, JSON.stringify(off)).toEqual({ ok: true, data: undefined });
      const res = await users.createUserAction(
        fd({
          username: `own.${sfx}`,
          fullName: 'Own Name Joiner',
          role: 'SALESMAN',
          password: PASSWORD,
          ownedRouteId: ids.A5,
          // Region A's other Manager: the shared-region case below has Manager A give A up.
          supervisorId: ids.mS,
        })
      );
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const notes = res.ok ? (res.data?.notes ?? []).join(' ') : '';
      expect(notes).toMatch(/Route .* was taken from Second Leaver's disabled account\./);
      expect(notes).not.toMatch(/sign-in name is now/);
      expect(await user(ids.leaver5)).toMatchObject({
        username: code('A5').toLowerCase(),
        ownedRouteId: null,
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { username: `own.${sfx}` } })).ownedRouteId
      ).toBe(ids.A5);
    });

    it('review: the e-mail is edited for any role — stored lower-case, named in the audit row, refused when another account holds it', async () => {
      as(ids.stw, 'STEWARD');
      const same = {
        userId: ids.busy,
        role: 'SALESMAN',
        ownedRouteId: ids.A3,
        supervisorId: ids.mA,
      };
      const address = `Busy.${sfx}@Example.test`;
      const set = await users.updateUserAccountAction(fd({ ...same, contactAddress: address }));
      expect(set, JSON.stringify(set)).toMatchObject({ ok: true, data: { changed: ['email'] } });
      expect((await user(ids.busy)).email).toBe(address.toLowerCase());
      const row = await lastAudit(ids.busy);
      expect(row?.after).toEqual({ changed: ['email'] });
      expect(JSON.stringify(row).toLowerCase()).not.toContain(`busy.${sfx}@`);

      const clash = await users.updateUserAccountAction(
        fd({
          userId: ids.mB,
          role: 'MANAGER',
          regionId: [ids.B],
          contactAddress: address.toUpperCase(),
        })
      );
      expect(clash, JSON.stringify(clash)).toMatchObject({
        ok: false,
        fields: { contactAddress: expect.stringMatching(/already used by another account/) },
      });
      expect((await user(ids.mB)).email).toBeNull();

      const cleared = await users.updateUserAccountAction(
        fd({ ...same, clearContactAddress: 'on' })
      );
      expect(cleared, JSON.stringify(cleared)).toMatchObject({
        ok: true,
        data: { changed: ['email'] },
      });
      expect((await user(ids.busy)).email).toBeNull();
    });

    it('review: a region keeps its only active Accountant', async () => {
      as(ids.stw, 'STEWARD');
      const regions = await users.updateUserAccountAction(
        fd({ userId: ids.accA, role: 'ACCOUNTANT', regionId: [ids.B] })
      );
      expect(regions, JSON.stringify(regions)).toMatchObject({
        ok: false,
        fields: {
          regionIds: expect.stringMatching(new RegExp(`only active Accountant of ${code('EA')}`)),
        },
      });
      const role = await users.updateUserAccountAction(fd({ userId: ids.accA, role: 'VIEWER' }));
      expect(role, JSON.stringify(role)).toMatchObject({
        ok: false,
        fields: { role: expect.stringMatching(/only active Accountant/) },
      });
      expect((await user(ids.accA)).managedRegions.map((r) => r.id)).toEqual([ids.A]);

      const second = await users.createUserAction(
        fd({
          username: `acca2.${sfx}`,
          fullName: 'Accountant A2',
          role: 'ACCOUNTANT',
          password: PASSWORD,
          regionId: [ids.A],
        })
      );
      expect(second.ok, JSON.stringify(second)).toBe(true);
      const moved = await users.updateUserAccountAction(
        fd({ userId: ids.accA, role: 'ACCOUNTANT', regionId: [ids.B] })
      );
      expect(moved, JSON.stringify(moved)).toMatchObject({
        ok: true,
        data: { changed: ['regions'] },
      });
    });

    // A new-customer request of the busy salesman's on his route, through the
    // real action, with photo rows he captured (no file is needed to submit).
    let photos = 0;
    const photo = async (kind: 'CR' | 'SHOP' | 'SIGNBOARD') =>
      (
        await prisma.attachment.create({
          data: {
            kind,
            r2Key: `uat/account-edit-${sfx}-${kind.toLowerCase()}-${++photos}.jpg`,
            mimeType: 'image/jpeg',
            bytes: 1000,
            capturedById: ids.busy,
            capturedAt: new Date(),
          },
        })
      ).id;
    async function newCustomer(n: number, isDraft = false, editId?: string) {
      as(ids.busy, 'SALESMAN');
      const digits = String((parseInt(sfx.slice(2), 36) * 7 + n) % 1_000_000).padStart(6, '0');
      const creates = await import('@/services/creates');
      return creates.submitCreateAction({
        ...(editId ? { editId } : {}),
        isDraft,
        customer: {
          legalName: `ZZ Account Edit Shop ${n} ${sfx}`,
          paymentTerms: 'CASH',
          channelId,
          subChannelId,
          primaryPhone: `9${n}${digits}`,
          contactPerson: 'ZZ Contact',
          crNumber: `7${n}${digits}`,
          crPhotoAttachmentId: isDraft ? undefined : await photo('CR'),
        },
        branches: [
          {
            branchName: `ZZ Branch ${n}`,
            address: `ZZ Street ${n}, ${sfx}`,
            gpsLat: 23.6,
            gpsLng: 58.4,
            dayOfVisit: 'MON',
            coolersCount: 0,
            standsCount: 0,
            emptyBottlesCount: 0,
            shopPhotoAttachmentId: isDraft ? undefined : await photo('SHOP'),
            signboardPhotoAttachmentId: isDraft ? undefined : await photo('SIGNBOARD'),
          },
        ],
      });
    }
    const editIdOf = (res: { ok: boolean }) => {
      expect(res.ok, JSON.stringify(res)).toBe(true);
      return (res as { ok: true; data: { editId: string } }).data.editId;
    };
    const create = { inReview: '', sentBack: '', draft: '' };

    it('review: a draft or a sent-back new-customer request holds his route change back, unless it is withdrawn with it', async () => {
      create.inReview = editIdOf(await newCustomer(1));
      create.sentBack = editIdOf(await newCustomer(2));
      as(ids.mA, 'MANAGER');
      const back = new FormData();
      back.set('editId', create.sentBack);
      back.set('reason', 'The CR photo is unreadable, take it again.');
      back.set('decisionToken', await freshDecisionToken(prisma, create.sentBack));
      const edits = await import('@/services/edits');
      const rej = await edits.rejectEditAction(back);
      expect(rej.ok, JSON.stringify(rej)).toBe(true);
      create.draft = editIdOf(await newCustomer(3, true));
      const stateOf = (id: string) =>
        prisma.customerEdit.findUniqueOrThrow({
          where: { id },
          select: { state: true, decisionCategory: true, reviewedById: true },
        });
      expect((await stateOf(create.sentBack)).state).toBe('NEEDS_CORRECTION');
      expect((await stateOf(create.draft)).state).toBe('DRAFT');

      as(ids.stw, 'STEWARD');
      const move = {
        userId: ids.busy,
        role: 'SALESMAN',
        ownedRouteId: ids.B1,
        supervisorId: ids.mB,
      };
      const refused = await users.updateUserAccountAction(fd(move));
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        fields: {
          withdrawCreates: expect.stringMatching(
            new RegExp(
              `2 new-customer request\\(s\\) started on route ${code('A3')} that are not in review`
            )
          ),
        },
      });
      expect((await user(ids.busy)).ownedRouteId).toBe(ids.A3);
      expect((await stateOf(create.sentBack)).state).toBe('NEEDS_CORRECTION');

      const res = await users.updateUserAccountAction(fd({ ...move, withdrawCreates: 'on' }));
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const notes = res.ok ? res.data.notes.join(' ') : '';
      expect(notes).toMatch(/1 request\(s\) in review\. They stay with the same approvers/);
      // Security review: the one in review is a new customer; sent back after
      // the move, he cannot send it again from B1, and the Steward is told so.
      expect(notes).toMatch(
        new RegExp(
          `New-customer requests among them \\(1\\): if one is sent back to him, he cannot send it again from his new route — he withdraws it on Needs correction, and the salesman of ${code('A3')} adds the shop afresh\\.`
        )
      );
      expect(notes).toMatch(
        /2 new-customer request\(s\) Busy Salesman had started on route .* were withdrawn/
      );
      expect(await user(ids.busy)).toMatchObject({ ownedRouteId: ids.B1, supervisorId: ids.mB });
      for (const id of [create.sentBack, create.draft]) {
        expect(await stateOf(id)).toMatchObject({
          state: 'REJECTED',
          decisionCategory: 'withdrawn',
          reviewedById: ids.stw,
        });
        expect(
          await prisma.auditLog.findFirst({
            where: { entityId: id, reason: 'withdrawn with an account edit', actorId: ids.stw },
          })
        ).not.toBeNull();
      }
      // The one in review is untouched, and still filed under route A3.
      expect((await stateOf(create.inReview)).state).toBe('SUBMITTED');
      expect(
        await prisma.editBranchDraft.findMany({
          where: { editId: create.inReview },
          select: { routeId: true },
        })
      ).toEqual([{ routeId: ids.A3 }]);

      // Sent again from route B1, the withdrawn one is refused, and nothing is
      // filed under B1.
      const again = await newCustomer(2, true, create.sentBack);
      expect(again, JSON.stringify(again)).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
      expect(
        await prisma.editBranchDraft.count({
          where: { routeId: ids.B1, edit: { submittedById: ids.busy } },
        })
      ).toBe(0);
    });

    it('review: his request in review stays with its region — not his new region’s Manager; a Supervisor-role supervisor change is said', async () => {
      const edits = await import('@/services/edits');
      const approve = async () => {
        const f = new FormData();
        f.set('editId', create.inReview);
        f.set('decisionToken', await freshDecisionToken(prisma, create.inReview));
        return edits.approveEditAction(f);
      };
      // Manager B is now his supervisor, and manages his new region — not the shop's.
      as(ids.mB, 'MANAGER');
      expect(await approve()).toMatchObject({ ok: false, code: 'FORBIDDEN' });

      as(ids.stw, 'STEWARD');
      const toSup = await users.updateUserAccountAction(
        fd({ userId: ids.busy, role: 'SALESMAN', ownedRouteId: ids.B1, supervisorId: ids.supS })
      );
      expect(toSup.ok, JSON.stringify(toSup)).toBe(true);
      expect(toSup.ok ? toSup.data.notes.join(' ') : '').toMatch(
        /1 of Busy Salesman's requests wait at the Supervisor step.*Supervisor S now can, wherever the customer is/
      );
      const back = await users.updateUserAccountAction(
        fd({ userId: ids.busy, role: 'SALESMAN', ownedRouteId: ids.B1, supervisorId: ids.mB })
      );
      expect(back.ok ? back.data.notes.join(' ') : JSON.stringify(back)).toMatch(
        /Supervisor S can no longer decide them/
      );

      // The second Manager of region A — not his supervisor, never was — decides it.
      as(ids.mS, 'MANAGER');
      const ok = await approve();
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      expect(
        await prisma.customerEdit.findUniqueOrThrow({
          where: { id: create.inReview },
          select: { state: true, pendingRole: true },
        })
      ).toEqual({ state: 'SUBMITTED', pendingRole: 'ACCOUNTANT' });
    });

    // Security review (launch candidate): that request, sent back to him after
    // the move, was rebuilt on route B1 when he sent it again, so region B's
    // approvers decided it and finalize put the shop on B1. Now it is refused,
    // its drafts stay on A3, and he withdraws it.
    it('review: his new-customer request sent back after the move cannot be sent again from his new route; he withdraws it', async () => {
      const edits = await import('@/services/edits');
      const reject = async () => {
        const f = new FormData();
        f.set('editId', create.inReview);
        f.set('reason', 'The shop photo is blurred, take it again.');
        f.set('decisionToken', await freshDecisionToken(prisma, create.inReview));
        return edits.rejectEditAction(f);
      };
      const row = () =>
        prisma.customerEdit.findUniqueOrThrow({
          where: { id: create.inReview },
          select: { state: true, branchDrafts: { select: { routeId: true } } },
        });
      // Region A's Accountant sends it back a step, and a Manager of A on to him.
      const accA2 = await prisma.user.findUniqueOrThrow({ where: { username: `acca2.${sfx}` } });
      as(accA2.id, 'ACCOUNTANT');
      const toSupervisor = await reject();
      expect(toSupervisor.ok, JSON.stringify(toSupervisor)).toBe(true);
      as(ids.mS, 'MANAGER');
      const toHim = await reject();
      expect(toHim.ok, JSON.stringify(toHim)).toBe(true);
      expect(await row()).toEqual({
        state: 'NEEDS_CORRECTION',
        branchDrafts: [{ routeId: ids.A3 }],
      });
      expect((await user(ids.busy)).ownedRouteId).toBe(ids.B1);

      // Sent again, or saved as a draft, from route B1: refused, and nothing moves.
      for (const isDraft of [false, true]) {
        const res = await newCustomer(1, isDraft, create.inReview);
        expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: 'EDIT_LOCKED' });
        expect(res.ok ? '' : res.message).toMatch(
          new RegExp(`started on route ${code('A3')}, and you now work route ${code('B1')}`)
        );
      }
      expect(await row()).toEqual({
        state: 'NEEDS_CORRECTION',
        branchDrafts: [{ routeId: ids.A3 }],
      });
      expect(
        await prisma.editBranchDraft.count({
          where: { routeId: ids.B1, edit: { submittedById: ids.busy } },
        })
      ).toBe(0);

      // Withdraw still works from Needs correction, so he is not stuck with it.
      const creates = await import('@/services/creates');
      const gone = await creates.withdrawCreateAction({ editId: create.inReview });
      expect(gone, JSON.stringify(gone)).toMatchObject({ ok: true });
      expect((await row()).state).toBe('REJECTED');
    });

    it('review: a shared region — a salesman moves between its two Managers, and the first may then give the region up', async () => {
      as(ids.stw, 'STEWARD');
      const made = await users.createUserAction(
        fd({
          username: `shared.${sfx}`,
          fullName: 'Shared Region Salesman',
          role: 'SALESMAN',
          password: PASSWORD,
          ownedRouteId: ids.A2,
          supervisorId: ids.mA,
        })
      );
      expect(made.ok, JSON.stringify(made)).toBe(true);
      const sh = await prisma.user.findUniqueOrThrow({ where: { username: `shared.${sfx}` } });
      // While he reports to Manager A, Manager A keeps region A.
      const early = await users.updateUserAccountAction(
        fd({ userId: ids.mA, role: 'MANAGER', regionId: [ids.B] })
      );
      expect(early).toMatchObject({
        ok: false,
        fields: { regionIds: expect.stringMatching(/work in/) },
      });

      const moved = await users.updateUserAccountAction(
        fd({ userId: sh.id, role: 'SALESMAN', ownedRouteId: ids.A2, supervisorId: ids.mS })
      );
      expect(moved, JSON.stringify(moved)).toMatchObject({
        ok: true,
        data: { changed: ['supervisor'], notes: [] },
      });
      const gave = await users.updateUserAccountAction(
        fd({ userId: ids.mA, role: 'MANAGER', regionId: [ids.B] })
      );
      expect(gave, JSON.stringify(gave)).toMatchObject({
        ok: true,
        data: { changed: ['regions'] },
      });
      expect((await user(ids.mA)).sessionsRevokedAt).toBeInstanceOf(Date);
    });
  }
);
