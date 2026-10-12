// @vitest-environment node
/**
 * The owner's questions, answered from the dated history on Postgres
 * (migration 20261013100100_history_foundation, docs/HISTORY.md):
 *
 *   - who served customer X on day D (route, region, visit day, salesman then);
 *   - which routes served X, from when to when, and who held each route then;
 *   - X's terms on D; who held route R on D; a user's role and route on D;
 *   - when X was created (its first row);
 *   - "on day D" is the state at the END of that Oman day, so a change loaded or
 *     approved at any time on D counts for D;
 *   - an answer for a time before the first page was recorded is flagged inferred;
 *   - a route opened after the first page is held by nobody until a salesman
 *     takes it, and a shop moved onto it before then is served by that route,
 *     with no salesman — the stretch is not lost;
 *   - a shop moved onto a route effective earlier than the route's own creation
 *     was recorded keeps that stretch too, marked 'holder-unrecorded';
 *   - a customer with no shop on its first page gets an explicit 'no-shop-recorded'
 *     answer for the time before that page, not an empty one.
 *
 * The fixtures are created now and their first rows are then moved back in time
 * as a baseline (as found on 2026-03-01, recorded 2026-04-01), in the owner's
 * maintenance window. The moves after that are made the way the daily Temix file
 * will make them: with an effective day.
 *
 *   RUN_HISTORY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/history-asof.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { src, withChangeContext, type ChangeContext } from '@/lib/change-context';
import { purgeHistory, withAuditMaintenance } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_HISTORY === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzha${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();

describe.skipIf(!ENABLED)('the history answers the owner’s as-of questions', () => {
  let db: PrismaClient;
  const id = {
    region: `${sfx}-g`,
    r1: `${sfx}-r1`,
    r2: `${sfx}-r2`,
    s1: `${sfx}-s1`,
    s2: `${sfx}-s2`,
    s3: `${sfx}-s3`,
    s4: `${sfx}-s4`,
    r3: `${sfx}-r3`,
    r4: `${sfx}-r4`,
    customer: `${sfx}-c`,
    bare: `${sfx}-c2`,
    branch: `${sfx}-b`,
  };
  const name = {
    r1: `R1${SFX}`,
    r2: `R2${SFX}`,
    s1: `s1.${sfx}`,
    s2: `s2.${sfx}`,
    s3: `s3.${sfx}`,
    s4: `s4.${sfx}`,
    r3: `R3${SFX}`,
    r4: `R4${SFX}`,
  };
  const run = <T>(c: ChangeContext, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withChangeContext(db, c, fn);

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD))
      throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
    await run({ actorId: null, source: src.test('history-asof') }, async (tx) => {
      await tx.region.create({ data: { id: id.region, code: `G${SFX}`, name: `As-of G ${sfx}` } });
      await tx.route.createMany({
        data: [
          { id: id.r1, code: name.r1, name: `As-of R1 ${sfx}`, regionId: id.region },
          { id: id.r2, code: name.r2, name: `As-of R2 ${sfx}`, regionId: id.region },
        ],
      });
      await tx.user.createMany({
        data: [
          {
            id: id.s1,
            username: name.s1,
            fullName: `S1 ${sfx}`,
            role: 'SALESMAN',
            passwordHash: 'x',
            ownedRouteId: id.r1,
          },
          {
            id: id.s2,
            username: name.s2,
            fullName: `S2 ${sfx}`,
            role: 'SALESMAN',
            passwordHash: 'x',
            ownedRouteId: id.r2,
          },
          {
            id: id.s3,
            username: name.s3,
            fullName: `S3 ${sfx}`,
            role: 'SALESMAN',
            passwordHash: 'x',
          },
        ],
      });
      await tx.customer.create({
        data: {
          id: id.customer,
          nmwcCode: `C${SFX}`,
          legalName: `As-of customer ${sfx}`,
          paymentTerms: 'CREDIT',
          creditLimit: 500,
          paymentTermDays: 30,
        },
      });
      // A customer with no shop on the first page (its shops went elsewhere before history began).
      await tx.customer.create({ data: { id: id.bare, nmwcCode: `B${SFX}`, legalName: `As-of bare ${sfx}` } });
      await tx.branch.create({
        data: {
          id: id.branch,
          customerId: id.customer,
          branchCode: `C${SFX}-01`,
          branchName: 'Main',
          regionId: id.region,
          routeId: id.r1,
          address: 'As-of probe address',
          dayOfVisit: 'SUN',
        },
      });
    });
    // The first page: as found on 2026-03-01, recorded on 2026-04-01.
    await withAuditMaintenance(db, async (tx) => {
      const set = baselineSql;
      await tx.$executeRawUnsafe(set('BranchHistory', 'branchId'), [id.branch]);
      await tx.$executeRawUnsafe(set('CustomerHistory', 'customerId'), [id.customer, id.bare]);
      await tx.$executeRawUnsafe(set('UserHistory', 'userId'), [id.s1, id.s2, id.s3]);
      await tx.$executeRawUnsafe(set('RouteOwnerHistory', 'routeId'), [id.r1, id.r2]);
      await tx.$executeRawUnsafe(set('RouteHistory', 'routeId'), [id.r1, id.r2]);
      await tx.$executeRawUnsafe(set('RegionHistory', 'regionId'), [id.region]);
    });
    // The daily Temix file moves the shop to R2, effective its load day.
    await run(
      { actorId: null, source: src.temixDaily(`${sfx}-f1`, 3), effectiveFrom: '2026-05-10' },
      (tx) => tx.branch.update({ where: { id: id.branch }, data: { routeId: id.r2 } })
    );
    // R2 changes hands on 2026-06-01.
    await run(
      { actorId: null, source: src.users('account', id.s3), effectiveFrom: '2026-06-01' },
      async (tx) => {
        await tx.user.update({ where: { id: id.s2 }, data: { ownedRouteId: null } });
        await tx.user.update({ where: { id: id.s3 }, data: { ownedRouteId: id.r2 } });
      }
    );
    // New terms late in the evening of 2026-07-15, Oman time (19:30 UTC).
    await run(
      {
        actorId: null,
        source: src.temixDaily(`${sfx}-f2`, 3),
        effectiveFrom: '2026-07-15T23:30:00+04:00',
      },
      (tx) => tx.customer.update({ where: { id: id.customer }, data: { creditLimit: 900 } })
    );
    // A new route R3 is opened on 2026-08-01 and the shop moved onto it the same
    // day, before anyone holds it; S4 (a new account) takes R3 on 2026-08-02.
    await run({ actorId: null, source: src.users('create', id.s4), effectiveFrom: '2026-08-01' }, async (tx) => {
      await tx.route.create({ data: { id: id.r3, code: name.r3, name: `As-of R3 ${sfx}`, regionId: id.region } });
      await tx.user.create({
        data: { id: id.s4, username: name.s4, fullName: `S4 ${sfx}`, role: 'SALESMAN', passwordHash: 'x' },
      });
    });
    await run(
      { actorId: null, source: src.temixDaily(`${sfx}-f3`, 3), effectiveFrom: '2026-08-01' },
      (tx) => tx.branch.update({ where: { id: id.branch }, data: { routeId: id.r3 } })
    );
    await run({ actorId: null, source: src.users('account', id.s4), effectiveFrom: '2026-08-02' }, (tx) =>
      tx.user.update({ where: { id: id.s4 }, data: { ownedRouteId: id.r3 } })
    );
    // R4 is opened at 10:00 Oman on 2026-09-01, and the daily file moves the shop
    // onto it effective that whole day (from 00:00): the first ten hours come
    // before the route's own first row.
    await run(
      { actorId: null, source: src.routes('create-route', name.r4), effectiveFrom: '2026-09-01T10:00:00+04:00' },
      (tx) => tx.route.create({ data: { id: id.r4, code: name.r4, name: `As-of R4 ${sfx}`, regionId: id.region } })
    );
    await run(
      { actorId: null, source: src.temixDaily(`${sfx}-f4`, 3), effectiveFrom: '2026-09-01' },
      (tx) => tx.branch.update({ where: { id: id.branch }, data: { routeId: id.r4 } })
    );
  });

  afterAll(async () => {
    if (!db) return;
    await withAuditMaintenance(db, async (tx) => {
      await tx.branch.deleteMany({ where: { id: id.branch } });
      await tx.customer.deleteMany({ where: { id: { in: [id.customer, id.bare] } } });
      await tx.user.updateMany({
        where: { id: { in: [id.s1, id.s2, id.s3, id.s4] } },
        data: { ownedRouteId: null },
      });
      await tx.user.deleteMany({ where: { id: { in: [id.s1, id.s2, id.s3, id.s4] } } });
      await tx.route.deleteMany({ where: { id: { in: [id.r1, id.r2, id.r3, id.r4] } } });
      await tx.region.deleteMany({ where: { id: id.region } });
    });
    await purgeHistory(db, {
      customerIds: [id.customer, id.bare],
      branchIds: [id.branch],
      userIds: [id.s1, id.s2, id.s3, id.s4],
      routeIds: [id.r1, id.r2, id.r3, id.r4],
      regionIds: [id.region],
    });
    await db.$disconnect();
  });

  type Service = {
    route_code: string;
    region_id: string;
    day_of_visit: string;
    salesman_username: string | null;
    inferred: boolean;
  };
  const servedOn = (day: string) =>
    db.$queryRaw<
      Service[]
    >`SELECT route_code, region_id, day_of_visit::text AS day_of_visit, salesman_username, inferred
      FROM nmwc_customer_service_on(${id.customer}, ${day}::date)`;

  it('who served the customer, day by day: nobody before it existed, then each route and salesman', async () => {
    expect(await servedOn('2026-02-28')).toEqual([]);
    // Before the first page was recorded: the answer is inferred.
    expect(await servedOn('2026-03-15')).toEqual([
      {
        route_code: name.r1,
        region_id: id.region,
        day_of_visit: 'SUN',
        salesman_username: name.s1,
        inferred: true,
      },
    ]);
    expect((await servedOn('2026-05-09'))[0]).toMatchObject({
      route_code: name.r1,
      salesman_username: name.s1,
      inferred: false,
    });
    // The load day counts for itself: the move is effective from the start of 2026-05-10.
    expect((await servedOn('2026-05-10'))[0]).toMatchObject({
      route_code: name.r2,
      salesman_username: name.s2,
      inferred: false,
    });
    expect((await servedOn('2026-05-31'))[0]).toMatchObject({
      route_code: name.r2,
      salesman_username: name.s2,
    });
    expect((await servedOn('2026-06-01'))[0]).toMatchObject({
      route_code: name.r2,
      salesman_username: name.s3,
    });
    // The new route, before anyone took it: served by R3, by nobody — not "no route".
    expect(await servedOn('2026-08-01')).toEqual([
      { route_code: name.r3, region_id: id.region, day_of_visit: 'SUN', salesman_username: null, inferred: false },
    ]);
    expect((await servedOn('2026-08-02'))[0]).toMatchObject({ route_code: name.r3, salesman_username: name.s4 });
  });

  it('which routes served it, from when to when, with the salesman of each stretch', async () => {
    const rows = await db.$queryRaw<
      Array<{
        route_code: string;
        salesman_username: string | null;
        valid_from: Date;
        valid_to: Date | null;
        from_inferred: boolean;
        note: string | null;
      }>
    >`SELECT route_code, salesman_username, valid_from, valid_to, from_inferred, note FROM nmwc_customer_route_intervals(${id.customer})`;
    expect(
      rows.map((r) => [
        r.route_code,
        r.salesman_username,
        r.valid_from.toISOString(),
        r.valid_to?.toISOString() ?? null,
        r.from_inferred,
        r.note,
      ])
    ).toEqual([
      [name.r1, name.s1, '2026-03-01T00:00:00.000Z', '2026-05-09T20:00:00.000Z', true, null],
      [name.r2, name.s2, '2026-05-09T20:00:00.000Z', '2026-05-31T20:00:00.000Z', false, null],
      [name.r2, name.s3, '2026-05-31T20:00:00.000Z', '2026-07-31T20:00:00.000Z', false, null],
      // R3 from its opening: nobody held it for a day, then S4. Nothing of the stretch is lost.
      [name.r3, null, '2026-07-31T20:00:00.000Z', '2026-08-01T20:00:00.000Z', false, null],
      [name.r3, name.s4, '2026-08-01T20:00:00.000Z', '2026-08-31T20:00:00.000Z', false, null],
      // R4: the shop is on it from 00:00 Oman, the route's first row is from 10:00 —
      // that part is kept, with no holder on record, and said so.
      [name.r4, null, '2026-08-31T20:00:00.000Z', '2026-09-01T06:00:00.000Z', false, 'holder-unrecorded'],
      [name.r4, null, '2026-09-01T06:00:00.000Z', null, false, null],
    ]);
  });

  it('a customer with no shop on its first page: "not on record", never an empty answer', async () => {
    const [marker] = await db.$queryRaw<
      Array<{ branch_id: string | null; inferred: boolean; note: string | null }>
    >`SELECT branch_id, inferred, note FROM nmwc_customer_service_on(${id.bare}, ${'2026-03-15'}::date)`;
    expect(marker).toEqual({ branch_id: null, inferred: true, note: 'no-shop-recorded' });
    // After the first page was written, an empty answer is a recorded one.
    expect(
      await db.$queryRaw`SELECT branch_id FROM nmwc_customer_service_on(${id.bare}, ${'2026-04-15'}::date)`
    ).toEqual([]);
    const stretches = await db.$queryRaw<
      Array<{ branch_id: string | null; valid_from: Date; valid_to: Date | null; from_inferred: boolean; note: string | null }>
    >`SELECT branch_id, valid_from, valid_to, from_inferred, note FROM nmwc_customer_route_intervals(${id.bare})`;
    expect(stretches).toEqual([
      {
        branch_id: null,
        valid_from: new Date('2026-03-01T00:00:00Z'),
        valid_to: new Date('2026-04-01T00:00:00Z'),
        from_inferred: true,
        note: 'no-shop-recorded',
      },
    ]);
  });

  it('its terms on a day: a change made late on 2026-07-15 (Oman) counts for the 15th, not the 14th', async () => {
    const terms = (day: string) =>
      db.$queryRaw<
        Array<{
          payment_terms: string;
          credit_limit: string;
          payment_term_days: number;
          inferred: boolean;
        }>
      >`
        SELECT payment_terms::text AS payment_terms, credit_limit::text AS credit_limit, payment_term_days, inferred
        FROM nmwc_customer_terms_on(${id.customer}, ${day}::date)`;
    expect(await terms('2026-03-15')).toEqual([
      { payment_terms: 'CREDIT', credit_limit: '500.000', payment_term_days: 30, inferred: true },
    ]);
    expect((await terms('2026-07-14'))[0]).toMatchObject({
      credit_limit: '500.000',
      inferred: false,
    });
    expect((await terms('2026-07-15'))[0]).toMatchObject({ credit_limit: '900.000' });
    expect(await terms('2026-02-01')).toEqual([]);
  });

  it('who held a route on a day, and a user’s route and region on a day', async () => {
    const owner = (route: string, day: string) =>
      db.$queryRaw<
        Array<{ owner_username: string | null }>
      >`SELECT owner_username FROM nmwc_route_owner_on(${route}, ${day}::date)`;
    expect(await owner(id.r2, '2026-05-20')).toEqual([{ owner_username: name.s2 }]);
    expect(await owner(id.r2, '2026-06-01')).toEqual([{ owner_username: name.s3 }]);
    // A route opened after the first page answers "nobody" until it is taken, not nothing.
    expect(await owner(id.r3, '2026-08-01')).toEqual([{ owner_username: null }]);
    expect(await owner(id.r3, '2026-08-02')).toEqual([{ owner_username: name.s4 }]);
    const user = (u: string, day: string) =>
      db.$queryRaw<
        Array<{
          username: string;
          owned_route_code: string | null;
          owned_route_region_id: string | null;
        }>
      >`
        SELECT username, owned_route_code, owned_route_region_id FROM nmwc_user_on(${u}, ${day}::date)`;
    expect(await user(id.s2, '2026-05-20')).toEqual([
      { username: name.s2, owned_route_code: name.r2, owned_route_region_id: id.region },
    ]);
    expect(await user(id.s2, '2026-06-01')).toEqual([
      { username: name.s2, owned_route_code: null, owned_route_region_id: null },
    ]);
    expect(await user(id.s3, '2026-06-01')).toEqual([
      { username: name.s3, owned_route_code: name.r2, owned_route_region_id: id.region },
    ]);
  });

  it('when it was created: its first row (here the baseline, its createdAt as found)', async () => {
    const [first] = await db.$queryRaw<
      Array<{ change_kind: string; valid_from: Date; from_inferred: boolean }>
    >`
      SELECT change_kind::text AS change_kind, valid_from, from_inferred FROM nmwc_customer_intervals(${id.customer}) LIMIT 1`;
    expect(first).toEqual({
      change_kind: 'BASELINE',
      valid_from: new Date('2026-03-01T00:00:00Z'),
      from_inferred: true,
    });
    // Every later row says what caused it.
    const sources = await db.$queryRaw<
      Array<{ source: string }>
    >`SELECT source FROM nmwc_customer_intervals(${id.customer})`;
    expect(sources.map((s) => s.source)).toEqual([
      src.test('history-asof'),
      src.temixDaily(`${sfx}-f2`, 3),
    ]);
  });

  it('the whole master on a day: the shop on its route, by route', async () => {
    const onRoute = (route: string, day: string) =>
      db.$queryRaw<Array<{ branch_id: string }>>`
        SELECT branch_id FROM nmwc_branches_on(${day}::date) WHERE route_id = ${route} AND deleted_at IS NULL`;
    expect(await onRoute(id.r1, '2026-05-09')).toEqual([{ branch_id: id.branch }]);
    expect(await onRoute(id.r3, '2026-08-01')).toEqual([{ branch_id: id.branch }]);
    expect(await onRoute(id.r1, '2026-05-10')).toEqual([]);
    expect(await onRoute(id.r2, '2026-05-10')).toEqual([{ branch_id: id.branch }]);
  });
});

/** UPDATE of a fixture's history rows into a baseline (owner maintenance only). $1 = the ids. */
function baselineSql(table: string, key: string): string {
  return `UPDATE "${table}" SET "changeKind" = 'BASELINE', "validFrom" = '2026-03-01 00:00:00', "recordedAt" = '2026-04-01 00:00:00'
           WHERE "${key}" = ANY($1::text[])`;
}
