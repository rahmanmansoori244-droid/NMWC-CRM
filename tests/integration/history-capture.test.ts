// @vitest-environment node
/**
 * The dated history is written by the DATABASE (gaps 5, 6, 17, 24; migration
 * 20261013100100_history_foundation, docs/HISTORY.md), on Postgres:
 *
 *   - every captured change writes exactly one row, with the writer's source,
 *     actor and the names of the changed fields; a change to an unwatched column
 *     (the score, the version) writes nothing, and neither does a no-op update;
 *   - a write with no change context is recorded under source 'sql';
 *   - an effective day or instant is honoured, clamped never to precede the
 *     record's previous row, and refused in the future;
 *   - a hard delete leaves a DELETE tombstone with the last values;
 *   - a manager's region `set` (DELETE then INSERT) is one row with the final set;
 *   - a new route's owner chain starts with "nobody" (its CREATE row); a route
 *     hand-over is a release then a take on that chain;
 *   - the history refuses UPDATE, DELETE, TRUNCATE and a direct INSERT, except in
 *     the owner's maintenance window — which is what fixture clean-up uses;
 *   - an AuditLog row carries the same source and transaction id.
 *
 *   RUN_HISTORY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/history-capture.test.ts
 *
 * Synthetic rows only, tagged with this run's suffix; everything is deleted again,
 * history included, in the owner's maintenance window.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { setChangeContext, src, withChangeContext } from '@/lib/change-context';
import { purgeHistory, REMOTE_TX, withAuditMaintenance } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_HISTORY === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzhc${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();
const TEST_SOURCE = src.test('history-capture');

describe.skipIf(!ENABLED)('the dated history is written by the database', () => {
  let db: PrismaClient;
  const ids = {
    region: `${sfx}-g`,
    region2: `${sfx}-g2`,
    route1: `${sfx}-r1`,
    route2: `${sfx}-r2`,
    actor: `${sfx}-u-actor`,
    mgr: `${sfx}-u-mgr`,
    s1: `${sfx}-u-s1`,
    s2: `${sfx}-u-s2`,
    customer: `${sfx}-c`,
    branch: `${sfx}-b`,
    branch2: `${sfx}-b2`,
  };
  const auditIds: string[] = [];

  const rows = (
    table:
      | 'branchHistory'
      | 'customerHistory'
      | 'userHistory'
      | 'routeOwnerHistory'
      | 'routeHistory'
      | 'regionHistory',
    where: Record<string, unknown>
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db[table] as any).findMany({ where, orderBy: { id: 'asc' } }) as Promise<
      Array<Record<string, any>>
    >;
  const ctx = (source = TEST_SOURCE, actorId: string | null = ids.actor) => ({ actorId, source });
  const write = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, c = ctx()) =>
    withChangeContext(db, c, fn, REMOTE_TX);

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD))
      throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
    await write(async (tx) => {
      await tx.region.createMany({
        data: [
          { id: ids.region, code: `G${SFX}`, name: `History G ${sfx}` },
          { id: ids.region2, code: `H${SFX}`, name: `History H ${sfx}` },
        ],
      });
      await tx.route.createMany({
        data: [
          { id: ids.route1, code: `R1${SFX}`, name: `History R1 ${sfx}`, regionId: ids.region },
          { id: ids.route2, code: `R2${SFX}`, name: `History R2 ${sfx}`, regionId: ids.region },
        ],
      });
      await tx.user.create({
        data: {
          id: ids.actor,
          username: `act.${sfx}`,
          fullName: `Actor ${sfx}`,
          role: 'STEWARD',
          passwordHash: 'x',
        },
      });
      await tx.user.create({
        data: {
          id: ids.mgr,
          username: `mgr.${sfx}`,
          fullName: `Manager ${sfx}`,
          role: 'MANAGER',
          passwordHash: 'x',
        },
      });
      await tx.user.create({
        data: {
          id: ids.s1,
          username: `s1.${sfx}`,
          fullName: `Salesman 1 ${sfx}`,
          role: 'SALESMAN',
          passwordHash: 'x',
          ownedRouteId: ids.route1,
        },
      });
      await tx.user.create({
        data: {
          id: ids.s2,
          username: `s2.${sfx}`,
          fullName: `Salesman 2 ${sfx}`,
          role: 'SALESMAN',
          passwordHash: 'x',
        },
      });
      await tx.customer.create({
        // CREDIT: the suite writes a credit limit and term days below, which a cash
        // customer may not carry (Customer_credit_terms_only_credit, gap 31).
        data: { id: ids.customer, nmwcCode: `C${SFX}`, legalName: `History customer ${sfx}`, paymentTerms: 'CREDIT' },
      });
      await tx.branch.createMany({
        data: [
          {
            id: ids.branch,
            customerId: ids.customer,
            branchCode: `C${SFX}-01`,
            branchName: 'Main',
            regionId: ids.region,
            routeId: ids.route1,
            address: 'History probe address',
          },
          {
            id: ids.branch2,
            customerId: ids.customer,
            branchCode: `C${SFX}-02`,
            branchName: 'Second',
            regionId: ids.region,
            routeId: ids.route1,
            address: 'History probe address 2',
          },
        ],
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await withAuditMaintenance(db, async (tx) => {
      await tx.auditLog.deleteMany({
        where: {
          OR: [{ id: { in: auditIds } }, { actorId: { in: [ids.actor, ids.mgr, ids.s1, ids.s2] } }],
        },
      });
      await tx.branch.deleteMany({ where: { id: { in: [ids.branch, ids.branch2] } } });
      await tx.customer.deleteMany({ where: { id: ids.customer } });
      await tx.user.updateMany({
        where: { id: { in: [ids.actor, ids.mgr, ids.s1, ids.s2] } },
        data: { ownedRouteId: null },
      });
      await tx.$executeRaw`DELETE FROM "_ManagerRegions" WHERE "B" = ${ids.mgr}`;
      await tx.user.deleteMany({ where: { id: { in: [ids.actor, ids.mgr, ids.s1, ids.s2] } } });
      await tx.route.deleteMany({ where: { id: { in: [ids.route1, ids.route2] } } });
      await tx.region.deleteMany({ where: { id: { in: [ids.region, ids.region2] } } });
    });
    // Last: the deletes above wrote DELETE tombstones (and the deferred region
    // trigger ran at that commit).
    await purgeHistory(db, {
      customerIds: [ids.customer],
      branchIds: [ids.branch, ids.branch2],
      userIds: [ids.actor, ids.mgr, ids.s1, ids.s2],
      routeIds: [ids.route1, ids.route2],
      regionIds: [ids.region, ids.region2],
    });
    const left = await db.branchHistory.count({
      where: { branchId: { in: [ids.branch, ids.branch2] } },
    });
    await db.$disconnect();
    expect(left).toBe(0);
  });

  it('a create is one CREATE row per record, under the writer’s source and actor', async () => {
    const b = await rows('branchHistory', { branchId: ids.branch });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      changeKind: 'CREATE',
      source: TEST_SOURCE,
      sourceKind: 'test',
      actorId: ids.actor,
      routeId: ids.route1,
      hasGps: false,
    });
    expect(b[0]!.changedFields).toEqual([]);
    expect(await rows('customerHistory', { customerId: ids.customer })).toHaveLength(1);
    expect((await rows('regionHistory', { regionId: ids.region }))[0]).toMatchObject({
      changeKind: 'CREATE',
      source: TEST_SOURCE,
    });
    expect((await rows('routeHistory', { routeId: ids.route1 }))[0]).toMatchObject({
      changeKind: 'CREATE',
      regionId: ids.region,
    });
    // A new route's owner chain starts with the route — nobody holds it — and a
    // salesman created holding it takes it in the same instant (id orders them).
    const owners = await rows('routeOwnerHistory', { routeId: ids.route1 });
    expect(owners.map((o) => [o.changeKind, o.ownerId])).toEqual([
      ['CREATE', null],
      ['UPDATE', ids.s1],
    ]);
    expect(owners[0]!.validFrom.getTime()).toBe(owners[1]!.validFrom.getTime());
    expect(owners[0]).toMatchObject({ source: TEST_SOURCE, actorId: ids.actor });
    // A route nobody took: its chain is the one "nobody" row, so "who held it" answers nobody, not nothing.
    expect((await rows('routeOwnerHistory', { routeId: ids.route2 })).map((o) => [o.changeKind, o.ownerId])).toEqual([
      ['CREATE', null],
    ]);
    const [held] = await db.$queryRaw<
      Array<{ owner_id: string | null }>
    >`SELECT owner_id FROM nmwc_route_owner_on(${ids.route2}, CURRENT_DATE + 1)`;
    expect(held).toEqual({ owner_id: null });
  });

  it('a watched change is one row naming the field; an unwatched or no-op update writes nothing', async () => {
    const before = (await rows('branchHistory', { branchId: ids.branch })).length;
    await write(
      (tx) => tx.branch.update({ where: { id: ids.branch }, data: { dayOfVisit: 'SUN' } }),
      ctx(src.edit(`${sfx}-e1`))
    );
    await write((tx) =>
      tx.branch.update({
        where: { id: ids.branch },
        data: { completenessScore: 42, version: { increment: 1 } },
      })
    );
    await write((tx) =>
      tx.branch.update({ where: { id: ids.branch }, data: { dayOfVisit: 'SUN' } })
    );
    const after = await rows('branchHistory', { branchId: ids.branch });
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({
      changeKind: 'UPDATE',
      changedFields: ['dayOfVisit'],
      dayOfVisit: 'SUN',
      source: `edit:${sfx}-e1`,
      sourceKind: 'edit',
      actorId: ids.actor,
    });
  });

  it('a personal field is recorded by name only — the history has no column for its value', async () => {
    await write((tx) =>
      tx.branch.update({
        where: { id: ids.branch },
        data: { address: 'A new probe address', gpsLat: 23.6, gpsLng: 58.4 },
      })
    );
    const last = (await rows('branchHistory', { branchId: ids.branch })).at(-1)!;
    expect(last.changedFields).toEqual(['address', 'gps']);
    expect(last.hasGps).toBe(true);
    expect(Object.keys(last)).not.toContain('address');
    expect(Object.keys(last)).not.toContain('gpsLat');
    await write((tx) =>
      tx.customer.update({
        where: { id: ids.customer },
        data: { legalName: `Renamed ${sfx}`, creditLimit: 750, paymentTermDays: 30 },
      })
    );
    const c = (await rows('customerHistory', { customerId: ids.customer })).at(-1)!;
    expect(c.changedFields).toEqual(['creditLimit', 'paymentTermDays', 'legalName']);
    expect(String(c.creditLimit)).toBe('750');
    expect(Object.keys(c)).not.toContain('legalName');
  });

  it('a user’s role, a route’s switch and a region’s name each write their own row', async () => {
    await write((tx) => tx.user.update({ where: { id: ids.s2 }, data: { role: 'SUPERVISOR' } }));
    expect((await rows('userHistory', { userId: ids.s2 })).at(-1)).toMatchObject({
      changedFields: ['role'],
      role: 'SUPERVISOR',
    });
    await write((tx) =>
      tx.user.update({
        where: { id: ids.s2 },
        data: { role: 'SALESMAN', lastLoginAt: new Date(), sessionsRevokedAt: new Date() },
      })
    );
    expect((await rows('userHistory', { userId: ids.s2 })).at(-1)).toMatchObject({
      changedFields: ['role'],
      role: 'SALESMAN',
    });
    // Sign-in and session stamps alone are not history.
    const n = (await rows('userHistory', { userId: ids.s2 })).length;
    await write((tx) =>
      tx.user.update({
        where: { id: ids.s2 },
        data: { lastLoginAt: new Date(), passwordHash: 'y' },
      })
    );
    expect(await rows('userHistory', { userId: ids.s2 })).toHaveLength(n);
    await write((tx) => tx.route.update({ where: { id: ids.route2 }, data: { isActive: false } }));
    expect((await rows('routeHistory', { routeId: ids.route2 })).at(-1)).toMatchObject({
      changedFields: ['isActive'],
      isActive: false,
    });
    await write((tx) =>
      tx.region.update({ where: { id: ids.region2 }, data: { name: `History H2 ${sfx}` } })
    );
    expect((await rows('regionHistory', { regionId: ids.region2 })).at(-1)).toMatchObject({
      changedFields: ['name'],
      name: `History H2 ${sfx}`,
    });
  });

  it('a write with no change context is recorded as source sql, by the login that made it', async () => {
    await db.branch.update({ where: { id: ids.branch2 }, data: { dayOfVisit: 'MON' } });
    const [{ me }] = await db.$queryRaw<{ me: string }[]>`SELECT session_user::text AS me`;
    expect((await rows('branchHistory', { branchId: ids.branch2 })).at(-1)).toMatchObject({
      source: 'sql',
      sourceKind: 'sql',
      actorId: null,
      dbUser: me,
      changedFields: ['dayOfVisit'],
    });
    const report = await db.$queryRaw<Array<{ table_name: string; n: bigint }>>`
      SELECT table_name, n FROM nmwc_history_unattributed((now() AT TIME ZONE 'UTC') - interval '1 hour')`;
    expect(report.some((r) => r.table_name === 'BranchHistory' && Number(r.n) >= 1)).toBe(true);
  });

  it('an effective day is the start of that Oman day; earlier than the record’s last row it is clamped; the future is refused', async () => {
    // Move the record's rows back in time (owner maintenance), so a past
    // effective day is not clamped.
    await withAuditMaintenance(
      db,
      (tx) =>
        tx.$executeRaw`UPDATE "CustomerHistory" SET "validFrom" = '2026-01-01 00:00:00' WHERE "customerId" = ${ids.customer}`
    );
    await withChangeContext(
      db,
      { actorId: null, source: src.temixDaily(`${sfx}-f1`, 7), effectiveFrom: '2026-06-01' },
      (tx) => tx.customer.update({ where: { id: ids.customer }, data: { paymentTermDays: 45 } })
    );
    const loaded = (await rows('customerHistory', { customerId: ids.customer })).at(-1)!;
    expect(loaded.validFrom.toISOString()).toBe('2026-05-31T20:00:00.000Z');
    expect(loaded.effectiveRequested.toISOString()).toBe('2026-05-31T20:00:00.000Z');
    expect(loaded.sourceKind).toBe('temix-daily');
    // An instant with its offset, earlier than that row: clamped to it, the ask kept.
    await withChangeContext(
      db,
      { actorId: null, source: TEST_SOURCE, effectiveFrom: '2026-03-01T09:00:00+04:00' },
      (tx) => tx.customer.update({ where: { id: ids.customer }, data: { paymentTermDays: 60 } })
    );
    const clamped = (await rows('customerHistory', { customerId: ids.customer })).at(-1)!;
    expect(clamped.validFrom.toISOString()).toBe('2026-05-31T20:00:00.000Z');
    expect(clamped.effectiveRequested.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(clamped.recordedAt.getTime()).toBeGreaterThan(Date.now() - 600_000);
    // The future: refused by the database itself (the TS side refuses it earlier).
    await expect(
      db.$transaction([
        db.$executeRaw`SELECT set_config('nmwc.effective_from', '2999-01-01', true)`,
        db.customer.update({ where: { id: ids.customer }, data: { paymentTermDays: 61 } }),
      ])
    ).rejects.toThrow(/in the future/);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: ids.customer } })).paymentTermDays
    ).toBe(60);
  });

  it('a manager’s region set (delete, then insert) is ONE row with the final, sorted set', async () => {
    await write(
      (tx) =>
        tx.user.update({
          where: { id: ids.mgr },
          data: { managedRegions: { set: [{ id: ids.region2 }, { id: ids.region }] } },
        }),
      ctx(src.users('account', ids.mgr))
    );
    let h = await rows('userHistory', { userId: ids.mgr });
    expect(h.at(-1)).toMatchObject({
      changedFields: ['regionIds'],
      regionIds: [ids.region, ids.region2].sort(),
      source: `users:account:${ids.mgr}`,
    });
    const n = h.length;
    await write((tx) =>
      tx.user.update({
        where: { id: ids.mgr },
        data: { managedRegions: { set: [{ id: ids.region }] } },
      })
    );
    h = await rows('userHistory', { userId: ids.mgr });
    expect(h).toHaveLength(n + 1);
    expect(h.at(-1)!.regionIds).toEqual([ids.region]);
    // The same set again writes nothing.
    await write((tx) =>
      tx.user.update({
        where: { id: ids.mgr },
        data: { managedRegions: { set: [{ id: ids.region }] } },
      })
    );
    expect(await rows('userHistory', { userId: ids.mgr })).toHaveLength(n + 1);
  });

  it('a route hand-over is a release then a take, in one instant, ordered by id', async () => {
    await write(
      async (tx) => {
        await tx.user.update({ where: { id: ids.s1 }, data: { ownedRouteId: null } });
        await tx.user.update({ where: { id: ids.s2 }, data: { ownedRouteId: ids.route1 } });
      },
      ctx(src.users('account', ids.s2))
    );
    const owners = await rows('routeOwnerHistory', { routeId: ids.route1 });
    expect(owners.map((o) => o.ownerId)).toEqual([null, ids.s1, null, ids.s2]);
    expect(owners[2]!.validFrom.getTime()).toBe(owners[3]!.validFrom.getTime());
    expect(owners[3]!.source).toBe(`users:account:${ids.s2}`);
    const [o] = await db.$queryRaw<
      Array<{ owner_id: string | null }>
    >`SELECT owner_id FROM nmwc_route_owner_on(${ids.route1}, CURRENT_DATE + 1)`;
    expect(o!.owner_id).toBe(ids.s2);
  });

  it('a hard delete (the owner) leaves a DELETE tombstone with the last values', async () => {
    await withAuditMaintenance(db, async (tx) => {
      await setChangeContext(tx, ctx());
      await tx.branch.delete({ where: { id: ids.branch2 } });
    });
    const last = (await rows('branchHistory', { branchId: ids.branch2 })).at(-1)!;
    expect(last).toMatchObject({
      changeKind: 'DELETE',
      dayOfVisit: 'MON',
      routeId: ids.route1,
      source: TEST_SOURCE,
    });
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM nmwc_branches_at((now() AT TIME ZONE 'UTC')) WHERE branch_id = ${ids.branch2}`;
    expect(n).toBe(0);
  });

  it('the history refuses UPDATE, DELETE, TRUNCATE and a direct INSERT; the owner’s maintenance window may delete', async () => {
    const one = (await rows('branchHistory', { branchId: ids.branch }))[0]!;
    await expect(
      db.branchHistory.update({ where: { id: one.id }, data: { source: 'tampered' } })
    ).rejects.toThrow(/append-only/);
    await expect(db.branchHistory.delete({ where: { id: one.id } })).rejects.toThrow(/append-only/);
    await expect(
      db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL lock_timeout = '2000ms'`),
        db.$executeRawUnsafe(`TRUNCATE "BranchHistory"`),
      ])
    ).rejects.toThrow(/append-only|lock timeout/);
    await expect(
      db.branchHistory.create({
        data: {
          changeKind: 'UPDATE',
          changedFields: [],
          validFrom: new Date(),
          recordedAt: new Date(),
          source: 'forged',
          sourceKind: 'forged',
          txId: 1n,
          dbUser: 'x',
          branchId: ids.branch,
          branchCode: 'x',
          customerId: ids.customer,
          routeId: ids.route1,
          regionId: ids.region,
          status: 'ACTIVE',
          coolersCount: 0,
          standsCount: 0,
          emptyBottlesCount: 0,
          equipmentConfirmed: false,
          hasGps: false,
        },
      })
    ).rejects.toThrow(/direct INSERT|permission denied/);
    // The owner's maintenance window gets through (rolled back here by throwing).
    await expect(
      withAuditMaintenance(db, async (tx) => {
        const r = await tx.branchHistory.deleteMany({ where: { id: one.id } });
        expect(r.count).toBe(1);
        throw new Error('ROLL_BACK');
      })
    ).rejects.toThrow('ROLL_BACK');
    expect(await db.branchHistory.count({ where: { id: one.id } })).toBe(1);
  });

  const APP_URL = process.env.NMWC_APP_URL ?? '';
  it.skipIf(!APP_URL)(
    'the runtime role writes the master and is recorded by name, but cannot write the history',
    async () => {
      if (APP_URL.includes(PROD)) throw new Error('ABORT: production');
      const app = new PrismaClient({ datasourceUrl: APP_URL });
      try {
        await withChangeContext(app, ctx(src.edit(`${sfx}-app`)), (tx) =>
          tx.branch.update({ where: { id: ids.branch }, data: { dayOfVisit: 'TUE' } })
        );
        expect((await rows('branchHistory', { branchId: ids.branch })).at(-1)).toMatchObject({
          dbUser: 'nmwc_app',
          source: `edit:${sfx}-app`,
        });
        await expect(
          app.$executeRawUnsafe(`UPDATE "BranchHistory" SET "source" = "source" WHERE false`)
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.$executeRawUnsafe(`DELETE FROM "BranchHistory" WHERE false`)
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.$executeRawUnsafe(
            `INSERT INTO "BranchHistory" SELECT * FROM "BranchHistory" WHERE false`
          )
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.$queryRawUnsafe(`SELECT setval('"BranchHistory_id_seq"', 1)::text`)
        ).rejects.toThrow(/permission denied/);
        // Reading it, and the as-of functions, are allowed.
        expect(await app.branchHistory.count({ where: { branchId: ids.branch } })).toBeGreaterThan(
          0
        );
      } finally {
        await app.$disconnect();
      }
    }
  );

  it('an audit row written under a context carries its source, and the transaction id of the change beside it', async () => {
    const { auditId, txId } = await write(
      async (tx) => {
        await tx.branch.update({ where: { id: ids.branch }, data: { dayOfVisit: 'WED' } });
        const a = await tx.auditLog.create({
          data: {
            actorId: ids.actor,
            action: 'UPDATE',
            entityType: 'Branch',
            entityId: ids.branch,
            reason: 'history-capture probe',
          },
        });
        const [{ t }] = await tx.$queryRaw<{ t: bigint }[]>`SELECT txid_current() AS t`;
        return { auditId: a.id, txId: t };
      },
      ctx(src.edit(`${sfx}-e2`))
    );
    auditIds.push(auditId);
    const a = await db.auditLog.findUniqueOrThrow({ where: { id: auditId } });
    expect(a.source).toBe(`edit:${sfx}-e2`);
    expect(a.txId).toBe(txId);
    expect((await rows('branchHistory', { branchId: ids.branch })).at(-1)!.txId).toBe(txId);
  });
});
