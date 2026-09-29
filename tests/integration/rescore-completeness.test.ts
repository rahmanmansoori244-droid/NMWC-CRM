// @vitest-environment node
/**
 * scripts/ops/rescore-completeness.ts against Postgres (auditor recheck
 * 2026-09-27, F21 part 2): the one-off repair of the completeness scores the
 * import left stale, run the way an operator runs it — its own client on the
 * owner connection, the whole database, pages of customers.
 *
 *  - the dry run writes nothing, not even a ledger row;
 *  - --apply fixes a score stored as 0 and one stored wrong, writes a STARTING
 *    and a COMPLETED ledger row, and leaves every row's updatedAt and version
 *    as they were (the raw UPDATE of lib/rescore.ts, on real Postgres);
 *  - a customer another transaction holds locked is waited for, not skipped:
 *    what that transaction commits is what gets scored;
 *  - a second run finds nothing to do.
 * The unit half, on an in-memory database: tests/unit/rescore-completeness.test.ts.
 *
 *   RUN_RESCORE=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/rescore-completeness.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { purgeAuditLog } from '../support/audit';
import { run } from '../../scripts/ops/rescore-completeness';
import { scoreBranch, scoreCustomer } from '@/lib/completeness';

const ENABLED = process.env.RUN_RESCORE === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('ops:rescore-completeness against Postgres', () => {
  let prisma: PrismaClient;
  let host = '';
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const P = `ZZRS-${tag}`.toUpperCase();
  const steward = `zz.rescore.${tag}`;
  let stewardId = '';
  let regionId = '';
  let routeId = '';
  // Ids chosen to sort before every cuid, so the first page of the run holds them.
  const ids = {
    a: `0000zzrs${tag}a`,
    b: `0000zzrs${tag}b`,
    a1: `0000zzrs${tag}a1`,
    b1: `0000zzrs${tag}b1`,
  };

  const SCORED = {
    gpsLat: true,
    gpsLng: true,
    address: true,
    shopPhotoId: true,
    signboardPhotoId: true,
    dayOfVisit: true,
    coolersCount: true,
    standsCount: true,
    emptyBottlesCount: true,
    equipmentConfirmed: true,
    openingHours: true,
    deliveryWindow: true,
    status: true,
  } as const;
  const state = async (id: string) =>
    prisma.customer.findUniqueOrThrow({
      where: { id },
      select: {
        completenessScore: true,
        version: true,
        updatedAt: true,
        channelId: true,
        subChannelId: true,
        primaryPhone: true,
        contactPerson: true,
        crNumber: true,
        crPhotoId: true,
        paymentTerms: true,
        notes: true,
        branches: {
          where: { deletedAt: null },
          select: { id: true, completenessScore: true, version: true, updatedAt: true, ...SCORED },
        },
      },
    });
  const ledger = () =>
    prisma.auditLog.findMany({
      where: { actorId: stewardId, entityType: 'CompletenessRescore' },
      orderBy: { at: 'asc' },
      select: { entityId: true, action: true, after: true, reason: true },
    });
  const quiet = () => {
    const out: string[] = [];
    return { out, log: (l: string) => out.push(l) };
  };

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze'))
      throw new Error('ABORT: production');
    host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
    // The script's own client, on the owner connection, as main() builds it.
    prisma = new PrismaClient({ datasourceUrl: url });
    stewardId = (
      await prisma.user.create({
        data: {
          username: steward,
          passwordHash: 'x',
          fullName: 'ZZ Rescore Steward',
          role: 'STEWARD',
        },
      })
    ).id;
    regionId = (await prisma.region.create({ data: { code: `${P}-R`, name: `ZZ RS ${tag}` } })).id;
    routeId = (
      await prisma.route.create({ data: { code: `${P}-RT`, name: `ZZ RS ${tag}`, regionId } })
    ).id;
    // A: stored at 0 with a branch at 0, as the go-live load left an imported branch.
    // B: stored wrong, both ways.
    await prisma.customer.create({
      data: {
        id: ids.a,
        nmwcCode: `${P}-A`,
        legalName: 'ZZ Rescore A',
        contactPerson: 'ZZ A',
        primaryPhone: '+96890000001',
      },
    });
    await prisma.customer.create({
      data: {
        id: ids.b,
        nmwcCode: `${P}-B`,
        legalName: 'ZZ Rescore B',
        contactPerson: 'ZZ B',
        completenessScore: 99,
        version: 4,
      },
    });
    await prisma.branch.create({
      data: {
        id: ids.a1,
        customerId: ids.a,
        branchCode: `${P}-A-01`,
        branchName: 'ZZ A shop',
        address: 'Way 12, Muscat',
        regionId,
        routeId,
      },
    });
    await prisma.branch.create({
      data: {
        id: ids.b1,
        customerId: ids.b,
        branchCode: `${P}-B-01`,
        branchName: 'ZZ B shop',
        address: 'Way 13, Muscat',
        dayOfVisit: 'MON',
        gpsLat: 23.6,
        gpsLng: 58.4,
        regionId,
        routeId,
        completenessScore: 3,
        version: 2,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await purgeAuditLog(prisma, { where: { actorId: stewardId } });
      await prisma.branch.deleteMany({ where: { id: { in: [ids.a1, ids.b1] } } });
      await prisma.customer.deleteMany({ where: { id: { in: [ids.a, ids.b] } } });
      await prisma.route.deleteMany({ where: { id: routeId } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: stewardId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  it('the dry run writes nothing — not a score, not a ledger row — and names no row', async () => {
    const before = [await state(ids.a), await state(ids.b)];
    const { out, log } = quiet();
    expect(await run({ apply: false, actor: steward, chunk: 50 }, prisma, host, log)).toBe(0);
    expect([await state(ids.a), await state(ids.b)]).toEqual(before);
    expect(await ledger()).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('DRY RUN — nothing was written');
    for (const secret of [ids.a, ids.b, `${P}-A`, 'ZZ Rescore A', '+96890000001', `${P}-A-01`]) {
      expect(text).not.toContain(secret);
    }
  }, 180_000);

  it('--apply waits for a customer another transaction holds, scores what it commits, and leaves updatedAt and version alone', async () => {
    const before = { a: await state(ids.a), b: await state(ids.b) };

    // Another writer holds customer A's row lock — as an edit or a photo does —
    // and, before it commits, gives A's branch a visit day (+5).
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${ids.a} FOR UPDATE`;
        locked();
        await released;
        await tx.$executeRaw`UPDATE "Branch" SET "dayOfVisit" = 'SUN' WHERE "id" = ${ids.a1}`;
      },
      { timeout: 170_000, maxWait: 10_000 }
    );
    await lockTaken;

    const { out, log } = quiet();
    const applying = run({ apply: true, actor: steward, chunk: 50 }, prisma, host, (line) => {
      log(line);
      // The run's first page (A and B sort first) goes for the lock right after
      // this line; hold it a moment longer, then commit.
      if (line.startsWith('Applying as')) setTimeout(release, 1_500);
    }).finally(() => release()); // a run that fails early must not leave the holder waiting
    const [code] = await Promise.all([applying, holder]);
    expect(code, out.join('\n')).toBe(0);

    const a = await state(ids.a);
    const b = await state(ids.b);
    // A's branch is scored WITH the day the holder committed: the run waited for
    // the lock and read after it. A run that skipped or raced it scores it without.
    expect(a.branches[0].dayOfVisit).toBe('SUN');
    expect(a.branches[0].completenessScore).toBe(scoreBranch(a.branches[0]));
    expect(a.completenessScore).toBe(scoreCustomer(a, a.branches));
    expect(b.branches[0].completenessScore).toBe(scoreBranch(b.branches[0]));
    expect(b.completenessScore).toBe(scoreCustomer(b, b.branches));
    expect(b.completenessScore).not.toBe(99);

    // The score column only: updatedAt and version are as they were.
    expect([a.version, a.updatedAt]).toEqual([before.a.version, before.a.updatedAt]);
    expect([b.version, b.updatedAt]).toEqual([before.b.version, before.b.updatedAt]);
    expect([b.branches[0].version, b.branches[0].updatedAt]).toEqual([
      before.b.branches[0].version,
      before.b.branches[0].updatedAt,
    ]);

    const rows = await ledger();
    expect(rows.map((r) => [r.action, (r.after as { phase: string }).phase])).toEqual([
      ['UPDATE', 'started'],
      ['UPDATE', 'completed'],
    ]);
    expect(rows[0].entityId).toBe(rows[1].entityId);
    // The counts written; the check after the last page is printed, not
    // recorded (post-merge review of phase 2, finding 7).
    expect(rows[1].after).toMatchObject({
      phase: 'completed',
      customersWritten: expect.any(Number),
      branchesWritten: expect.any(Number),
    });
    expect(rows[1].after).not.toHaveProperty('remaining');
    expect(out.join('\n')).toContain('Checked: 0 stored score(s) still differ (expected 0).');
    const recorded = JSON.stringify(rows);
    for (const secret of [ids.a, ids.b, `${P}-A`, 'ZZ Rescore A', '+96890000001']) {
      expect(recorded).not.toContain(secret);
    }
  }, 180_000);

  it('a second run finds nothing to do', async () => {
    const { out, log } = quiet();
    expect(await run({ apply: false, actor: '', chunk: 50 }, prisma, host, log)).toBe(0);
    expect(out.join('\n')).toContain('Nothing to do');
  }, 180_000);
});
