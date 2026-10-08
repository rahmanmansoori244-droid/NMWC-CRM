// @vitest-environment node
/**
 * N06 / X-PHOTO-1 — photo attach and Remove against each other, and against a
 * new-customer request's claim, on real Postgres.
 *
 * Attach and Remove both read the photo and run every check before their
 * transaction opens. Attach then claimed it with an unconditional update by id,
 * and Remove soft-deleted it the same way, clearing only the slots its early
 * read named (and for a photo on no slot it took no lock at all). Whatever
 * landed in that gap was overwritten: a live slot on a soft-deleted photo
 * (served as 404, still counted as present, blanked 30 days later by photo-gc
 * through the foreign key with no rescore and no audit row), one photo on two
 * slots, or a photo held by a pending new-customer request that is also on a
 * live slot. The photo slot on a phone reaches the first one by itself: an
 * attach unanswered for 30 s, then Remove.
 *
 * Each case holds one action in exactly that gap — at its audit envelope, which
 * both build after the checks and before the transaction — runs the other to
 * the end, then lets the first go on. The same hold lets a merge or an archive
 * land under a waiting attach (its target is read again under the lock), and a
 * second Remove land under a waiting one (PHOTO_GONE, the answer the photo slot
 * clears on — not NOT_FOUND, which the scope check gives for a photo it keeps).
 * The last case fires attach and Remove together with no hold and checks the
 * invariant whatever order they took.
 *
 * GATED; any disposable database; ZZPH rows cleaned per test.
 *   RUN_PHOTO_CONCURRENCY=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/photo-concurrency.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { purgeAuditLog, purgeCustomerEdits } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_PHOTO_CONCURRENCY === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const gate = vi.hoisted(() => ({
  hold: null as null | { reached: () => void; release: Promise<void> },
}));
vi.mock('@/lib/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/audit')>();
  return {
    ...real,
    getAuditEnvelope: async (actorId: string) => {
      const h = gate.hold;
      if (h) {
        gate.hold = null;
        h.reached();
        await h.release;
      }
      return real.getAuditEnvelope(actorId);
    },
  };
});

/** Hold the next attach or Remove in its gap: checks done, no transaction yet. */
function holdInGap() {
  let reached!: () => void;
  let release!: () => void;
  const inGap = new Promise<void>((r) => (reached = r));
  gate.hold = { reached, release: new Promise<void>((r) => (release = r)) };
  return { inGap, release: () => release() };
}

describe.skipIf(!ENABLED)('photo attach scope under a real customer lock', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let mover: import('@prisma/client').PrismaClient;
  let photos: typeof import('@/services/photos');
  const tag = randomUUID().slice(0, 8);
  const ids = { regionA: '', regionB: '', routeA: '', routeB: '', sales: `ZZPS-sales-${tag}`, manager: `ZZPS-mgr-${tag}`, customer: '', branch: '', sibling: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    const { PrismaClient } = await import('@prisma/client');
    mover = new PrismaClient();
    photos = await import('@/services/photos');
    for (const side of ['A', 'B'] as const) {
      const region = await prisma.region.create({ data: { name: `ZZPS ${side} ${tag}`, code: `ZZPS-${side}-${tag}` } });
      ids[`region${side}`] = region.id;
      const route = await prisma.route.create({ data: { name: `ZZPS ${side} ${tag}`, code: `ZZPS-RT-${side}-${tag}`, regionId: region.id } });
      ids[`route${side}`] = route.id;
    }
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'Synthetic photo salesman', role: 'SALESMAN', ownedRouteId: ids.routeA } });
    await prisma.user.create({ data: { id: ids.manager, username: ids.manager, passwordHash: 'x', fullName: 'Synthetic photo manager', role: 'MANAGER', managedRegions: { connect: { id: ids.regionA } } } });
  });

  beforeEach(async () => {
    if (!ENABLED) return;
    gate.hold = null; // No audit-envelope mock barrier: PostgreSQL proves the wait below.
    const n = randomUUID().slice(0, 8);
    const customer = await prisma.customer.create({ data: { nmwcCode: `ZZPS-${tag}-${n}`, legalName: 'Synthetic photo customer', paymentTerms: 'CASH', createdById: ids.sales } });
    ids.customer = customer.id;
    for (const [key, side] of [['branch', 'A'], ['sibling', 'B']] as const) {
      const b = await prisma.branch.create({ data: {
        customerId: ids.customer, branchCode: `ZZPS-${tag}-${n}-${side}`, branchName: `Synthetic ${side}`,
        address: 'Synthetic address', routeId: ids[`route${side}`], regionId: ids[`region${side}`], status: 'ACTIVE',
      } });
      ids[key] = b.id;
    }
  });

  afterEach(async () => {
    if (!prisma || !ids.customer) return;
    await prisma.branch.updateMany({ where: { customerId: ids.customer }, data: { shopPhotoId: null, signboardPhotoId: null } });
    await prisma.customer.update({ where: { id: ids.customer }, data: { crPhotoId: null } });
    await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
    await purgeAuditLog(prisma, { where: { actorId: { in: [ids.sales, ids.manager] } } });
    await prisma.branch.deleteMany({ where: { customerId: ids.customer } });
    await prisma.customer.delete({ where: { id: ids.customer } });
    current = null;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.user.deleteMany({ where: { id: { in: [ids.sales, ids.manager] } } });
      await prisma.route.deleteMany({ where: { id: { in: [ids.routeA, ids.routeB] } } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.regionA, ids.regionB] } } });
    } finally {
      await mover?.$disconnect();
      await prisma.$disconnect();
    }
  });

  async function snapshot(tx: import('@prisma/client').Prisma.TransactionClient) {
    return {
      customer: await tx.customer.findUniqueOrThrow({ where: { id: ids.customer }, include: { branches: { orderBy: { id: 'asc' } } } }),
      photos: await tx.attachment.findMany({ where: { capturedById: ids.sales }, orderBy: { id: 'asc' } }),
      audits: await tx.auditLog.count({ where: { actorId: { in: [ids.sales, ids.manager] } } }),
    };
  }

  const cases = (['MANAGER', 'SALESMAN'] as const).flatMap((role) =>
    (['CR', 'SHOP', 'SIGNBOARD', 'FREE'] as const).flatMap((slot) =>
      [false, true].map((move) => ({ role, slot, move, sibling: false, allowed: !move }))
    )
  );
  // Preserve F04's existing customer-overlap policy for Managers and CR photos.
  // A salesman branch attach still requires that specific branch's route.
  cases.push(
    { role: 'MANAGER', slot: 'SHOP', move: true, sibling: true, allowed: true },
    { role: 'SALESMAN', slot: 'CR', move: true, sibling: true, allowed: true },
    { role: 'SALESMAN', slot: 'SHOP', move: true, sibling: true, allowed: false },
  );
  it.each(cases)('$role $slot after locked route move=$move, sibling=$sibling: allowed=$allowed', async ({ role, slot, move, sibling, allowed }) => {
    current = { id: role === 'MANAGER' ? ids.manager : ids.sales, role, username: role === 'MANAGER' ? ids.manager : ids.sales };
    if (sibling) await prisma.branch.update({ where: { id: ids.sibling }, data: { routeId: ids.routeA, regionId: ids.regionA } });
    const old = await prisma.attachment.create({ data: {
      kind: slot, r2Key: `synthetic-photo-scope/${tag}/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 100,
      capturedById: ids.sales, capturedAt: new Date(),
      ...(slot === 'CR' ? { customerId: ids.customer } : { branchId: ids.branch }),
      ...(slot === 'FREE' ? { branchExtraId: ids.branch } : {}),
    } });
    if (slot === 'CR') await prisma.customer.update({ where: { id: ids.customer }, data: { crPhotoId: old.id } });
    else if (slot !== 'FREE') await prisma.branch.update({ where: { id: ids.branch }, data: slot === 'SHOP' ? { shopPhotoId: old.id } : { signboardPhotoId: old.id } });
    const fresh = await prisma.attachment.create({ data: {
      kind: slot, r2Key: `synthetic-photo-scope/${tag}/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 100,
      capturedById: ids.sales, capturedAt: new Date(),
    } });
    const input = slot === 'CR'
      ? { attachmentId: fresh.id, customerId: ids.customer, slot }
      : { attachmentId: fresh.id, branchId: ids.branch, slot };
    let waiting: ReturnType<typeof photos.attachPhotoAction> | undefined;
    let committed: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await mover.$transaction(async (tx) => {
        const { lockCustomerRow } = await import('@/lib/locks');
        await lockCustomerRow(tx, ids.customer);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        waiting = photos.attachPhotoAction(input);
        const deadline = Date.now() + 10_000;
        let blocked = false;
        while (Date.now() < deadline) {
          await tx.$queryRaw`SELECT 1 FROM pg_stat_clear_snapshot()`;
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%Customer%FOR UPDATE%'
          `;
          if (rows.length) {
            expect(rows.every((row) => row.pid !== pid)).toBe(true);
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked, 'The real attach connection must wait on the mover customer lock').toBe(true);
        // The same customer-first lock and route/region/version update used by
        // import promotion, without invoking its workbook pipeline.
        if (move) await tx.branch.update({ where: { id: ids.branch }, data: { routeId: ids.routeB, regionId: ids.regionB, version: { increment: 1 } } });
        committed = await snapshot(tx);
      }, { timeout: 20_000, maxWait: 10_000 });
      const result = await waiting!;
      if (!allowed) {
        expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
        // No claim, prior-photo deletion, slot/score change or audit survives.
        expect(await snapshot(prisma)).toEqual(committed);
      } else {
        expect(result).toMatchObject({ ok: true });
        const attached = await prisma.attachment.findUniqueOrThrow({ where: { id: fresh.id } });
        expect(attached.deletedAt).toBeNull();
        expect(slot === 'CR' ? attached.customerId : attached.branchId).toBe(slot === 'CR' ? ids.customer : ids.branch);
        if (slot === 'CR') expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.customer } })).crPhotoId).toBe(fresh.id);
        else if (slot === 'FREE') expect(attached.branchExtraId).toBe(ids.branch);
        else {
          const b = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } });
          expect(slot === 'SHOP' ? b.shopPhotoId : b.signboardPhotoId).toBe(fresh.id);
        }
        const previous = await prisma.attachment.findUniqueOrThrow({ where: { id: old.id } });
        if (slot === 'FREE') expect(previous.deletedAt).toBeNull();
        else expect(previous.deletedAt).not.toBeNull();
        expect((await snapshot(prisma)).audits).toBe(committed!.audits + 1);
      }
    } finally {
      await waiting?.catch(() => {});
    }
  });
});

describe.skipIf(!ENABLED)('photo attach and Remove on real Postgres (N06, X-PHOTO-1)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let photos: typeof import('@/services/photos');
  let UNWIRED_LIVE: typeof import('@/lib/photo-attach').UNWIRED_LIVE;
  let PHOTO_TARGET_CHANGED_MESSAGE: string;
  let PHOTO_GONE_MESSAGE: string;
  const tag = randomUUID().slice(0, 8);
  const ids = { region: '', route: '', sales: `ZZPH-sales-${tag}`, cust: '', b1: '', b2: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    photos = await import('@/services/photos');
    ({ UNWIRED_LIVE, PHOTO_TARGET_CHANGED_MESSAGE, PHOTO_GONE_MESSAGE } = await import('@/lib/photo-attach'));
    const region = await prisma.region.create({ data: { name: `ZZPH Region ${tag}`, code: `ZZPH-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({
      data: { name: `ZZPH Route ${tag}`, code: `ZZPH-RT-${tag}`, regionId: region.id },
    });
    ids.route = route.id;
    await prisma.user.create({
      data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'ZZ Photo Sales', role: 'SALESMAN', ownedRouteId: route.id },
    });
  });

  beforeEach(async () => {
    if (!ENABLED) return;
    gate.hold = null;
    const n = randomUUID().slice(0, 6);
    const cust = await prisma.customer.create({
      data: { nmwcCode: `ZZPH-C-${tag}-${n}`, legalName: 'ZZ Photo Co', paymentTerms: 'CASH', createdById: ids.sales },
    });
    ids.cust = cust.id;
    const branch = (i: number) =>
      prisma.branch.create({
        data: {
          customerId: cust.id,
          branchCode: `ZZPH-C-${tag}-${n}-0${i}`,
          branchName: `ZZ Photo Branch ${i}`,
          address: 'ZZ Way 1, Muscat',
          routeId: ids.route,
          regionId: ids.region,
          status: 'ACTIVE',
        },
      });
    ids.b1 = (await branch(1)).id;
    ids.b2 = (await branch(2)).id;
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
  });

  afterEach(async () => {
    if (!prisma || !ids.cust) return;
    gate.hold = null;
    await prisma.branch.updateMany({ where: { customerId: ids.cust }, data: { shopPhotoId: null, signboardPhotoId: null } });
    await prisma.customer.updateMany({ where: { id: ids.cust }, data: { crPhotoId: null } });
    await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
    await purgeCustomerEdits(prisma, { where: { submittedById: ids.sales } });
    await purgeAuditLog(prisma, { where: { actorId: ids.sales } });
    await prisma.branch.deleteMany({ where: { customerId: ids.cust } });
    await prisma.customer.deleteMany({ where: { id: ids.cust } });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await purgeAuditLog(prisma, { where: { actorId: ids.sales } });
      await prisma.user.deleteMany({ where: { id: ids.sales } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  /** A photo as /api/photos/finalize leaves it: the salesman's, on no slot. */
  async function photo(kind: 'SHOP' | 'CR' = 'SHOP') {
    const att = await prisma.attachment.create({
      data: {
        kind,
        r2Key: `zzph/${tag}/${kind}/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById: ids.sales,
        capturedAt: new Date(),
        hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      },
    });
    return att.id;
  }
  const attachShop = (attachmentId: string, branchId: string) =>
    photos.attachPhotoAction({ attachmentId, branchId, slot: 'SHOP' });

  /** No customer or branch slot of this customer names a soft-deleted photo. */
  async function assertNoSlotOnADeletedPhoto() {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT (
        (SELECT count(*) FROM "Customer" c JOIN "Attachment" a ON a."id" = c."crPhotoId"
          WHERE c."id" = ${ids.cust} AND a."deletedAt" IS NOT NULL)
        +
        (SELECT count(*) FROM "Branch" b JOIN "Attachment" a ON a."id" IN (b."shopPhotoId", b."signboardPhotoId")
          WHERE b."customerId" = ${ids.cust} AND a."deletedAt" IS NOT NULL)
      )::int AS n`;
    expect(row.n).toBe(0);
  }

  /** No photo held by a request that is not approved is also wired to a live record. */
  async function assertNoClaimedPhotoWired() {
    const n = await prisma.attachment.count({
      where: {
        capturedById: ids.sales,
        edit: { state: { not: 'APPROVED' } },
        OR: [{ customerId: { not: null } }, { branchId: { not: null } }, { branchExtraId: { not: null } }],
      },
    });
    expect(n).toBe(0);
  }

  it('N06: a Remove lands while an attach waits — the attach is refused and the earlier photo stays', async () => {
    const prev = await photo();
    expect(await attachShop(prev, ids.b1)).toMatchObject({ ok: true });
    const att = await photo();

    const hold = holdInGap();
    const attaching = attachShop(att, ids.b1);
    await hold.inGap;
    expect(await photos.detachPhotoAction({ attachmentId: att })).toMatchObject({ ok: true });
    hold.release();

    expect(await attaching).toMatchObject({ ok: false, code: 'PHOTO_CONFLICT' });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBe(prev);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: prev } })).deletedAt).toBeNull();
    await assertNoSlotOnADeletedPhoto();
  });

  it('X-PHOTO-1: an attach lands while a Remove waits — the Remove is refused and the slot keeps a live photo', async () => {
    const att = await photo();

    const hold = holdInGap();
    const removing = photos.detachPhotoAction({ attachmentId: att });
    await hold.inGap;
    expect(await attachShop(att, ids.b1)).toMatchObject({ ok: true });
    hold.release();

    expect(await removing).toMatchObject({ ok: false, code: 'PHOTO_CHANGED' });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBe(att);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att } })).deletedAt).toBeNull();
    await assertNoSlotOnADeletedPhoto();
  });

  it('N06: one photo sent to two slots — exactly one takes it', async () => {
    const att = await photo();

    const hold = holdInGap();
    const first = attachShop(att, ids.b1);
    await hold.inGap;
    expect(await attachShop(att, ids.b2)).toMatchObject({ ok: true });
    hold.release();

    expect(await first).toMatchObject({ ok: false, code: 'PHOTO_CONFLICT' });
    const holders = await prisma.branch.findMany({ where: { shopPhotoId: att }, select: { id: true } });
    expect(holders).toEqual([{ id: ids.b2 }]);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att } })).branchId).toBe(ids.b2);
  });

  it('N06: a new-customer request claims the photo while an attach waits — the attach is refused', async () => {
    const att = await photo();
    const edit = await prisma.customerEdit.create({
      data: { target: 'CUSTOMER', process: 'CREATE', submittedById: ids.sales, fieldChanges: [], attachmentChanges: [] },
    });

    const hold = holdInGap();
    const attaching = attachShop(att, ids.b1);
    await hold.inGap;
    // services/creates.ts's claim, as it writes it.
    const claimed = await prisma.attachment.updateMany({
      where: { id: { in: [att] }, ...UNWIRED_LIVE, capturedById: ids.sales, OR: [{ editId: null }, { editId: edit.id }] },
      data: { editId: edit.id },
    });
    expect(claimed.count).toBe(1);
    hold.release();

    expect(await attaching).toMatchObject({ ok: false, code: 'PHOTO_CONFLICT' });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBeNull();
    await assertNoClaimedPhotoWired();
  });

  it('the same attach sent again while the first waits: both answered ok, written once', async () => {
    const att = await photo();

    const hold = holdInGap();
    const first = attachShop(att, ids.b1);
    await hold.inGap;
    expect(await attachShop(att, ids.b1)).toMatchObject({ ok: true });
    hold.release();

    expect(await first).toMatchObject({ ok: true });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBe(att);
    const audited = await prisma.auditLog.count({
      where: { actorId: ids.sales, entityType: 'Branch', entityId: ids.b1, reason: 'photo attached' },
    });
    expect(audited).toBe(1);
  });

  // Post-merge review (2026-09-29): attach read its target before any lock and
  // never again. A merge or an archive landing in the gap left the photo claimed
  // onto a tombstoned customer and answered ok, or rescored the tombstone instead
  // of the branch's new owner. The target is read again under the lock now.
  it('the customer is removed (a merge or an archive) while a CR attach waits — refused, nothing written', async () => {
    const att = await photo('CR');

    const hold = holdInGap();
    const attaching = photos.attachPhotoAction({ attachmentId: att, customerId: ids.cust, slot: 'CR' });
    await hold.inGap;
    await prisma.customer.update({ where: { id: ids.cust }, data: { deletedAt: new Date() } });
    hold.release();

    expect(await attaching).toEqual({ ok: false, code: 'PHOTO_CHANGED', message: PHOTO_TARGET_CHANGED_MESSAGE });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.cust } })).crPhotoId).toBeNull();
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: att } })).toMatchObject({
      customerId: null,
      branchId: null,
      deletedAt: null,
    });
    expect(await prisma.auditLog.count({ where: { actorId: ids.sales, entityType: 'Customer', entityId: ids.cust } })).toBe(0);
  });

  it('the branch moves to another customer (a merge) while a shop attach waits — refused, nothing written', async () => {
    const winner = await prisma.customer.create({
      data: { nmwcCode: `ZZPH-W-${tag}-${randomUUID().slice(0, 6)}`, legalName: 'ZZ Photo Winner', paymentTerms: 'CASH', createdById: ids.sales },
    });
    try {
      const att = await photo();

      const hold = holdInGap();
      const attaching = attachShop(att, ids.b1);
      await hold.inGap;
      await prisma.branch.update({ where: { id: ids.b1 }, data: { customerId: winner.id } });
      hold.release();

      expect(await attaching).toEqual({ ok: false, code: 'PHOTO_CHANGED', message: PHOTO_TARGET_CHANGED_MESSAGE });
      expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBeNull();
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att } })).branchId).toBeNull();
    } finally {
      await prisma.branch.update({ where: { id: ids.b1 }, data: { customerId: ids.cust } });
      await prisma.customer.delete({ where: { id: winner.id } });
    }
  });

  it('the branch is removed while a shop attach waits — refused, nothing written', async () => {
    const att = await photo();

    const hold = holdInGap();
    const attaching = attachShop(att, ids.b1);
    await hold.inGap;
    await prisma.branch.update({ where: { id: ids.b1 }, data: { deletedAt: new Date() } });
    hold.release();

    expect(await attaching).toMatchObject({ ok: false, code: 'PHOTO_CHANGED' });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBeNull();
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att } })).branchId).toBeNull();
  });

  // Post-merge review (2026-09-29): the photo slot cleared on NOT_FOUND as if the
  // photo were removed already, and the scope check answers NOT_FOUND too.
  it('two Removes of one photo: the one that waited, and any sent after, are told PHOTO_GONE; one removal is written', async () => {
    const att = await photo();
    expect(await attachShop(att, ids.b1)).toMatchObject({ ok: true });

    const hold = holdInGap();
    const first = photos.detachPhotoAction({ attachmentId: att });
    await hold.inGap;
    expect(await photos.detachPhotoAction({ attachmentId: att })).toEqual({ ok: true });
    hold.release();

    expect(await first).toEqual({ ok: false, code: 'PHOTO_GONE', message: PHOTO_GONE_MESSAGE });
    expect(await photos.detachPhotoAction({ attachmentId: att })).toEqual({ ok: false, code: 'PHOTO_GONE', message: PHOTO_GONE_MESSAGE });
    expect(await prisma.auditLog.count({ where: { actorId: ids.sales, entityType: 'Attachment', entityId: att } })).toBe(1);
  });

  it('a Remove after his route was reassigned is NOT_FOUND from the scope check, and the photo stays on its slot', async () => {
    const att = await photo();
    expect(await attachShop(att, ids.b1)).toMatchObject({ ok: true });
    await prisma.user.update({ where: { id: ids.sales }, data: { ownedRouteId: null } });
    try {
      expect(await photos.detachPhotoAction({ attachmentId: att })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    } finally {
      await prisma.user.update({ where: { id: ids.sales }, data: { ownedRouteId: ids.route } });
    }
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId).toBe(att);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att } })).deletedAt).toBeNull();
  });

  it('attach and Remove fired together, no hold: whatever the order, no slot names a deleted photo', async () => {
    for (let i = 0; i < 6; i++) {
      const att = await photo();
      await Promise.all([attachShop(att, ids.b1), photos.detachPhotoAction({ attachmentId: att })]);
      await assertNoSlotOnADeletedPhoto();
      const slot = (await prisma.branch.findUniqueOrThrow({ where: { id: ids.b1 } })).shopPhotoId;
      if (slot) expect((await prisma.attachment.findUniqueOrThrow({ where: { id: slot } })).deletedAt).toBeNull();
    }
  });
});

describe.skipIf(!ENABLED)('Remove scope under the customer lock on real Postgres', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let mover: import('@prisma/client').PrismaClient;
  let photos: typeof import('@/services/photos');
  const tag = randomUUID().slice(0, 8);
  const ids = { sales: `ZZPR-sales-${tag}`, manager: `ZZPR-manager-${tag}`, regionA: '', regionB: '', routeA: '', routeB: '', customer: '', branch: '', sibling: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    const { PrismaClient } = await import('@prisma/client');
    mover = new PrismaClient();
    photos = await import('@/services/photos');
    for (const side of ['A', 'B'] as const) {
      const region = await prisma.region.create({ data: { name: `ZZPR ${side} ${tag}`, code: `ZZPR-${side}-${tag}` } });
      ids[`region${side}`] = region.id;
      const route = await prisma.route.create({ data: { name: `ZZPR ${side} ${tag}`, code: `ZZPR-RT-${side}-${tag}`, regionId: region.id } });
      ids[`route${side}`] = route.id;
    }
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'Synthetic Remove salesman', role: 'SALESMAN', ownedRouteId: ids.routeA } });
    await prisma.user.create({ data: { id: ids.manager, username: ids.manager, passwordHash: 'x', fullName: 'Synthetic Remove manager', role: 'MANAGER', managedRegions: { connect: { id: ids.regionA } } } });
  });

  beforeEach(async () => {
    gate.hold = null; // PostgreSQL's blocking graph, not the audit mock, is the barrier.
    const n = randomUUID().slice(0, 8);
    const customer = await prisma.customer.create({ data: { nmwcCode: `ZZPR-${tag}-${n}`, legalName: 'Synthetic Remove customer', paymentTerms: 'CASH', createdById: ids.sales } });
    ids.customer = customer.id;
    for (const [key, side] of [['branch', 'A'], ['sibling', 'B']] as const) {
      const branch = await prisma.branch.create({ data: {
        customerId: ids.customer, branchCode: `ZZPR-${tag}-${n}-${side}`, branchName: `Synthetic ${side}`,
        address: 'Synthetic address', routeId: ids[`route${side}`], regionId: ids[`region${side}`], status: 'ACTIVE',
      } });
      ids[key] = branch.id;
    }
  });

  afterEach(async () => {
    if (!prisma || !ids.customer) return;
    await prisma.branch.updateMany({ where: { customerId: ids.customer }, data: { shopPhotoId: null, signboardPhotoId: null } });
    await prisma.customer.update({ where: { id: ids.customer }, data: { crPhotoId: null } });
    await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
    await purgeAuditLog(prisma, { where: { actorId: { in: [ids.sales, ids.manager] } } });
    await prisma.branch.deleteMany({ where: { customerId: ids.customer } });
    await prisma.customer.delete({ where: { id: ids.customer } });
    current = null;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.user.deleteMany({ where: { id: { in: [ids.sales, ids.manager] } } });
      await prisma.route.deleteMany({ where: { id: { in: [ids.routeA, ids.routeB] } } });
      await prisma.region.deleteMany({ where: { id: { in: [ids.regionA, ids.regionB] } } });
    } finally {
      await mover?.$disconnect();
      await prisma.$disconnect();
    }
  });

  async function snapshot(tx: import('@prisma/client').Prisma.TransactionClient) {
    return {
      customer: await tx.customer.findUniqueOrThrow({ where: { id: ids.customer }, include: { branches: { orderBy: { id: 'asc' } } } }),
      photos: await tx.attachment.findMany({ where: { capturedById: ids.sales }, orderBy: { id: 'asc' } }),
      audits: await tx.auditLog.count({ where: { actorId: { in: [ids.sales, ids.manager] } } }),
    };
  }

  const cases = (['MANAGER', 'SALESMAN'] as const).flatMap((role) =>
    (['CR', 'SHOP', 'SIGNBOARD', 'FREE'] as const).flatMap((slot) =>
      (['lost', 'unchanged', 'sibling', 'archived-sibling'] as const).map((scope) => ({ role, slot, scope }))
    )
  );
  it.each(cases)('$role $slot: scope=$scope after the lock wait', async ({ role, slot, scope }) => {
    const actorId = role === 'MANAGER' ? ids.manager : ids.sales;
    current = { id: actorId, role, username: actorId };
    if (scope === 'sibling' || scope === 'archived-sibling') {
      await prisma.branch.update({ where: { id: ids.sibling }, data: {
        routeId: ids.routeA, regionId: ids.regionA,
        deletedAt: scope === 'archived-sibling' ? new Date() : null,
      } });
    }
    const attachment = await prisma.attachment.create({ data: {
      kind: slot, r2Key: `synthetic-remove-scope/${tag}/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 100,
      capturedById: ids.sales, capturedAt: new Date(), hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      ...(slot === 'CR' ? { customerId: ids.customer } : { branchId: ids.branch }),
      ...(slot === 'FREE' ? { branchExtraId: ids.branch } : {}),
    } });
    if (slot === 'CR') await prisma.customer.update({ where: { id: ids.customer }, data: { crPhotoId: attachment.id } });
    else if (slot !== 'FREE') await prisma.branch.update({ where: { id: ids.branch }, data: slot === 'SHOP' ? { shopPhotoId: attachment.id } : { signboardPhotoId: attachment.id } });
    let waiting: ReturnType<typeof photos.detachPhotoAction> | undefined;
    let committed: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await mover.$transaction(async (tx) => {
        const { lockCustomerRow } = await import('@/lib/locks');
        await lockCustomerRow(tx, ids.customer);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        waiting = photos.detachPhotoAction({ attachmentId: attachment.id });
        const deadline = Date.now() + 10_000;
        let blocked = false;
        while (Date.now() < deadline) {
          await tx.$queryRaw`SELECT 1 FROM pg_stat_clear_snapshot()`;
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%Customer%FOR UPDATE%'
          `;
          if (rows.length) {
            expect(rows.every((row) => row.pid !== pid)).toBe(true);
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked, 'The real Remove connection must wait on the mover customer lock').toBe(true);
        // Commit the customer-first route/region move only after Remove's
        // precheck has passed and PostgreSQL proves its lock is waiting.
        if (scope !== 'unchanged') await tx.branch.update({ where: { id: ids.branch }, data: { routeId: ids.routeB, regionId: ids.regionB, version: { increment: 1 } } });
        committed = await snapshot(tx);
        expect(committed.audits).toBe(0);
      }, { timeout: 20_000, maxWait: 10_000 });
      const result = await waiting!;
      if (scope === 'lost' || scope === 'archived-sibling') {
        expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
        // Entire rows, slots, scores, hash and audit count remain unchanged.
        expect(await snapshot(prisma)).toEqual(committed);
      } else {
        // F04 remains customer-level, including a salesman's own capture on
        // an out-of-route branch when a live sibling keeps the customer visible.
        expect(result).toEqual({ ok: true });
        const removed = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
        expect(removed.deletedAt).not.toBeNull();
        expect(removed.hash).toBeNull();
        if (slot === 'CR') expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.customer } })).crPhotoId).toBeNull();
        else if (slot !== 'FREE') {
          const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } });
          expect(slot === 'SHOP' ? branch.shopPhotoId : branch.signboardPhotoId).toBeNull();
        }
        expect((await snapshot(prisma)).audits).toBe(1);
      }
    } finally {
      await waiting?.catch(() => {});
    }
  });
});

// Launch browser suite: a salesman removed a photo of his own new-customer request
// while it was with the approvers (SUBMITTED), and they reviewed a removed photo.
describe.skipIf(!ENABLED)("a salesman's Remove of a photo on his new-customer request", () => {
  let prisma: import('@prisma/client').PrismaClient;
  let submitter: import('@prisma/client').PrismaClient;
  let photos: typeof import('@/services/photos');
  let PHOTO_IN_REVIEW_MESSAGE: string;
  const tag = randomUUID().slice(0, 8);
  const ids = { region: '', route: '', sales: `ZZPV-sales-${tag}` };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    const { PrismaClient } = await import('@prisma/client');
    submitter = new PrismaClient();
    photos = await import('@/services/photos');
    ({ PHOTO_IN_REVIEW_MESSAGE } = await import('@/lib/photo-attach'));
    const region = await prisma.region.create({ data: { name: `ZZPV Region ${tag}`, code: `ZZPV-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZPV Route ${tag}`, code: `ZZPV-RT-${tag}`, regionId: region.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'Synthetic request salesman', role: 'SALESMAN', ownedRouteId: route.id } });
  });

  beforeEach(() => {
    gate.hold = null;
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
  });

  afterEach(async () => {
    if (!prisma) return;
    await prisma.attachment.deleteMany({ where: { capturedById: ids.sales } });
    await purgeCustomerEdits(prisma, { where: { submittedById: ids.sales } });
    await purgeAuditLog(prisma, { where: { actorId: ids.sales } });
    current = null;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.user.deleteMany({ where: { id: ids.sales } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } finally {
      await submitter?.$disconnect();
      await prisma.$disconnect();
    }
  });

  /** A new-customer request in `state`, holding one shop photo of his. */
  async function requestWithPhoto(state: 'DRAFT' | 'SUBMITTED') {
    const edit = await prisma.customerEdit.create({
      data: { target: 'CUSTOMER', process: 'CREATE', submittedById: ids.sales, fieldChanges: [], attachmentChanges: [], state },
    });
    const att = await prisma.attachment.create({ data: {
      kind: 'SHOP', r2Key: `zzpv/${tag}/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 1000,
      capturedById: ids.sales, capturedAt: new Date(), hash: randomUUID().replace(/-/g, '').padEnd(64, '0'), editId: edit.id,
    } });
    return { edit: edit.id, att: att.id };
  }
  const deletedAt = async (id: string) => (await prisma.attachment.findUniqueOrThrow({ where: { id } })).deletedAt;

  it('with the approvers: refused, and the photo stays; sent back to him: removed', async () => {
    const { edit, att } = await requestWithPhoto('SUBMITTED');
    expect(await photos.detachPhotoAction({ attachmentId: att })).toEqual({ ok: false, code: 'FORBIDDEN', message: PHOTO_IN_REVIEW_MESSAGE });
    expect(await deletedAt(att)).toBeNull();
    await prisma.customerEdit.update({ where: { id: edit }, data: { state: 'NEEDS_CORRECTION' } });
    expect(await photos.detachPhotoAction({ attachmentId: att })).toEqual({ ok: true });
    expect(await deletedAt(att)).not.toBeNull();
  });

  it('sent while the Remove runs: the Remove waits on the request row, then is refused', async () => {
    const { edit, att } = await requestWithPhoto('DRAFT');
    let removing: ReturnType<typeof photos.detachPhotoAction> | undefined;
    try {
      await submitter.$transaction(async (tx) => {
        // The submit's state write (services/creates.ts), not yet committed.
        await tx.customerEdit.update({ where: { id: edit }, data: { state: 'SUBMITTED', submittedAt: new Date() } });
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        removing = photos.detachPhotoAction({ attachmentId: att });
        const deadline = Date.now() + 10_000;
        let blocked = false;
        while (Date.now() < deadline) {
          await tx.$queryRaw`SELECT 1 FROM pg_stat_clear_snapshot()`;
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%CustomerEdit%FOR UPDATE%'
          `;
          if (rows.length) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked, 'The Remove must wait on the request row the submit holds').toBe(true);
      }, { timeout: 20_000, maxWait: 10_000 });
      expect(await removing!).toEqual({ ok: false, code: 'FORBIDDEN', message: PHOTO_IN_REVIEW_MESSAGE });
      expect(await deletedAt(att)).toBeNull();
    } finally {
      await removing?.catch(() => {});
    }
  });
});

// Launch browser suite: on a switched-off route his enrichments, closes and
// reactivations are refused, but his photos still went onto, and came off, the
// route's live branches and CASH customers' CR slots. A Manager is not asked.
describe.skipIf(!ENABLED)('photos on a switched-off route', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let photos: typeof import('@/services/photos');
  let ROUTE_INACTIVE_MESSAGE: string;
  const tag = randomUUID().slice(0, 8);
  const ids = { region: '', route: '', sales: `ZZPO-sales-${tag}`, manager: `ZZPO-mgr-${tag}`, cust: '', branch: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    photos = await import('@/services/photos');
    ({ ROUTE_INACTIVE_MESSAGE } = await import('@/lib/errors'));
    const region = await prisma.region.create({ data: { name: `ZZPO Region ${tag}`, code: `ZZPO-${tag}` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZPO Route ${tag}`, code: `ZZPO-RT-${tag}`, regionId: region.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.sales, username: ids.sales, passwordHash: 'x', fullName: 'Synthetic off-route salesman', role: 'SALESMAN', ownedRouteId: route.id } });
    await prisma.user.create({ data: { id: ids.manager, username: ids.manager, passwordHash: 'x', fullName: 'Synthetic off-route manager', role: 'MANAGER', managedRegions: { connect: { id: region.id } } } });
    const cust = await prisma.customer.create({ data: { nmwcCode: `ZZPO-C-${tag}`, legalName: 'Synthetic off-route customer', paymentTerms: 'CASH', createdById: ids.sales } });
    ids.cust = cust.id;
    const branch = await prisma.branch.create({ data: {
      customerId: cust.id, branchCode: `ZZPO-C-${tag}-01`, branchName: 'Synthetic off-route branch',
      address: 'Synthetic address', routeId: route.id, regionId: region.id, status: 'ACTIVE',
    } });
    ids.branch = branch.id;
  });

  beforeEach(async () => {
    gate.hold = null;
    current = { id: ids.sales, role: 'SALESMAN', username: ids.sales };
    await prisma.route.update({ where: { id: ids.route }, data: { isActive: true } });
  });

  afterEach(async () => {
    if (!prisma) return;
    await prisma.route.update({ where: { id: ids.route }, data: { isActive: true } });
    await prisma.branch.updateMany({ where: { id: ids.branch }, data: { shopPhotoId: null, signboardPhotoId: null } });
    await prisma.customer.updateMany({ where: { id: ids.cust }, data: { crPhotoId: null } });
    await prisma.attachment.deleteMany({ where: { capturedById: { in: [ids.sales, ids.manager] } } });
    await purgeAuditLog(prisma, { where: { actorId: { in: [ids.sales, ids.manager] } } });
    current = null;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.branch.deleteMany({ where: { id: ids.branch } });
      await prisma.customer.deleteMany({ where: { id: ids.cust } });
      await prisma.user.deleteMany({ where: { id: { in: [ids.sales, ids.manager] } } });
      await prisma.route.deleteMany({ where: { id: ids.route } });
      await prisma.region.deleteMany({ where: { id: ids.region } });
    } finally {
      await prisma.$disconnect();
    }
  });

  async function photo(kind: 'SHOP' | 'CR', capturedById = ids.sales) {
    const att = await prisma.attachment.create({ data: {
      kind, r2Key: `zzpo/${tag}/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 1000,
      capturedById, capturedAt: new Date(), hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    } });
    return att.id;
  }
  const switchOff = () => prisma.route.update({ where: { id: ids.route }, data: { isActive: false } });
  const refused = { ok: false, code: 'FORBIDDEN', message: '' };

  it('his attach and Remove are refused in its words, and the slots stay as they were', async () => {
    const shop = await photo('SHOP');
    const cr = await photo('CR');
    expect(await photos.attachPhotoAction({ attachmentId: shop, branchId: ids.branch, slot: 'SHOP' })).toEqual({ ok: true });
    expect(await photos.attachPhotoAction({ attachmentId: cr, customerId: ids.cust, slot: 'CR' })).toEqual({ ok: true });
    await switchOff();
    const off = { ...refused, message: ROUTE_INACTIVE_MESSAGE };
    expect(await photos.detachPhotoAction({ attachmentId: shop })).toEqual(off);
    expect(await photos.detachPhotoAction({ attachmentId: cr })).toEqual(off);
    const next = await photo('SHOP');
    expect(await photos.attachPhotoAction({ attachmentId: next, branchId: ids.branch, slot: 'SHOP' })).toEqual(off);
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).shopPhotoId).toBe(shop);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.cust } })).crPhotoId).toBe(cr);
    const live = await prisma.attachment.count({ where: { id: { in: [shop, cr, next] }, deletedAt: null } });
    expect(live).toBe(3);
  });

  // The slot re-sends an attach or Remove that got no answer. One that landed
  // before the switch-off is told so — not refused for the route.
  it('a re-send of his attach or Remove that already landed gets the answer it would on a live route', async () => {
    const { PHOTO_GONE_MESSAGE } = await import('@/lib/photo-attach');
    const shop = await photo('SHOP');
    const cr = await photo('CR');
    expect(await photos.attachPhotoAction({ attachmentId: shop, branchId: ids.branch, slot: 'SHOP' })).toEqual({ ok: true });
    expect(await photos.attachPhotoAction({ attachmentId: cr, customerId: ids.cust, slot: 'CR' })).toEqual({ ok: true });
    expect(await photos.detachPhotoAction({ attachmentId: cr })).toEqual({ ok: true });
    await switchOff();
    expect(await photos.attachPhotoAction({ attachmentId: shop, branchId: ids.branch, slot: 'SHOP' })).toEqual({ ok: true });
    expect(await photos.detachPhotoAction({ attachmentId: cr })).toEqual({ ok: false, code: 'PHOTO_GONE', message: PHOTO_GONE_MESSAGE });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).shopPhotoId).toBe(shop);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ids.cust } })).crPhotoId).toBeNull();
  });

  it('a Manager still attaches and removes there', async () => {
    await switchOff();
    current = { id: ids.manager, role: 'MANAGER', username: ids.manager };
    const shop = await photo('SHOP', ids.manager);
    expect(await photos.attachPhotoAction({ attachmentId: shop, branchId: ids.branch, slot: 'SHOP' })).toEqual({ ok: true });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).shopPhotoId).toBe(shop);
    expect(await photos.detachPhotoAction({ attachmentId: shop })).toEqual({ ok: true });
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: ids.branch } })).shopPhotoId).toBeNull();
  });
});
