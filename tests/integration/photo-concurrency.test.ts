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
 * the end, then lets the first go on. The last case fires attach and Remove
 * together with no hold and checks the invariant whatever order they took.
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

describe.skipIf(!ENABLED)('photo attach and Remove on real Postgres (N06, X-PHOTO-1)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let photos: typeof import('@/services/photos');
  let UNWIRED_LIVE: typeof import('@/lib/photo-attach').UNWIRED_LIVE;
  const tag = randomUUID().slice(0, 8);
  const ids = { region: '', route: '', sales: `ZZPH-sales-${tag}`, cust: '', b1: '', b2: '' };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    photos = await import('@/services/photos');
    ({ UNWIRED_LIVE } = await import('@/lib/photo-attach'));
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
