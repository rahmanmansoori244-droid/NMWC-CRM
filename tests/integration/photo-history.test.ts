// @vitest-environment node
/**
 * Gap 15 (data audit 2026-10-10, lossless paths; migration 20261014100000) on
 * Postgres: a photo replaced or removed keeps its link to the shop and its
 * fingerprint, for ever.
 *
 *   - AttachmentHistory is written by the database: a CREATE when a photo row is
 *     made, an UPDATE when where it is (customer, shop, extra slot, request), its
 *     kind, its removal or its hash changes — nothing for a width or a byte count
 *     — and a DELETE tombstone with the last link and hash when photo-gc drops
 *     the row;
 *   - Remove (services/photos.ts) soft-deletes WITHOUT wiping the hash, and its
 *     audit row says what was removed and from where;
 *   - the history refuses a direct insert, an update and a delete, except in the
 *     owner's maintenance window.
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/photo-history.test.ts
 *
 * Synthetic ZZ rows only (no R2 object is touched), removed again with their history.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { src, withChangeContext } from '@/lib/change-context';
import { purgeAuditLog, purgeHistory, withAuditMaintenance } from '../support/audit';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzph${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();
const REFUSED = /append-only|refused|insufficient_privilege|permission denied/;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('a photo keeps its link and fingerprint (gap 15)', () => {
  let db: PrismaClient;
  const ids = {
    region: `${sfx}-g`,
    route: `${sfx}-r`,
    steward: `${sfx}-st`,
    customer: `${sfx}-c`,
    branch: `${sfx}-b`,
    photo: `${sfx}-p1`,
    gone: `${sfx}-p2`,
  };
  const write = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, source = src.test('photo-history')) =>
    withChangeContext(db, { actorId: ids.steward, source }, fn);
  const rows = (attachmentId: string) =>
    db.attachmentHistory.findMany({ where: { attachmentId }, orderBy: { id: 'asc' } });
  const photo = (id: string, hash: string) => ({
    id,
    kind: 'SHOP' as const,
    branchId: ids.branch,
    r2Key: `photos/zz/${id}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 1000,
    capturedById: ids.steward,
    capturedAt: new Date(),
    capturedLat: 23.5,
    capturedLng: 58.4,
    hash,
  });

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD)) throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
    await write(async (tx) => {
      await tx.region.create({ data: { id: ids.region, code: `G${SFX}`, name: `Photo G ${sfx}` } });
      await tx.route.create({ data: { id: ids.route, code: `R${SFX}`, name: `Photo R ${sfx}`, regionId: ids.region } });
      await tx.user.create({
        data: { id: ids.steward, username: `st.${sfx}`, fullName: `Photo Steward ${sfx}`, role: 'STEWARD', passwordHash: 'x' },
      });
      await tx.customer.create({ data: { id: ids.customer, nmwcCode: `C${SFX}`, legalName: `Photo customer ${sfx}` } });
      await tx.branch.create({
        data: {
          id: ids.branch,
          customerId: ids.customer,
          branchCode: `C${SFX}-01`,
          branchName: 'Main',
          regionId: ids.region,
          routeId: ids.route,
          address: 'Photo probe address',
        },
      });
    });
    current = { id: ids.steward, role: 'STEWARD', username: `st.${sfx}` };
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await purgeAuditLog(db, { where: { actorId: ids.steward } });
      await write(async (tx) => {
        await tx.branch.updateMany({ where: { id: ids.branch }, data: { shopPhotoId: null } });
        await tx.attachment.deleteMany({ where: { id: { in: [ids.photo, ids.gone] } } });
        await tx.branch.deleteMany({ where: { id: ids.branch } });
        await tx.customer.deleteMany({ where: { id: ids.customer } });
        await tx.user.deleteMany({ where: { id: ids.steward } });
        await tx.route.deleteMany({ where: { id: ids.route } });
        await tx.region.deleteMany({ where: { id: ids.region } });
      });
      await purgeHistory(db, {
        attachmentIds: [ids.photo, ids.gone],
        customerIds: [ids.customer],
        branchIds: [ids.branch],
        userIds: [ids.steward],
        routeIds: [ids.route],
        regionIds: [ids.region],
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('a new photo is recorded with its link and hash; an unwatched change writes nothing', async () => {
    await write((tx) => tx.attachment.create({ data: photo(ids.photo, 'a'.repeat(64)) }));
    await write((tx) => tx.attachment.update({ where: { id: ids.photo }, data: { width: 640, height: 480 } }));
    const r = await rows(ids.photo);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      changeKind: 'CREATE',
      branchId: ids.branch,
      kind: 'SHOP',
      hash: 'a'.repeat(64),
      capturedById: ids.steward,
      source: 'test:photo-history',
    });
    // The capture point is never copied.
    expect(Object.keys(r[0]!)).not.toContain('capturedLat');
  });

  it('Remove soft-deletes it keeping its fingerprint, and both the history and the audit row say from where', async () => {
    const photos = await import('@/services/photos');
    const res = await photos.detachPhotoAction({ attachmentId: ids.photo });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const att = await db.attachment.findUniqueOrThrow({ where: { id: ids.photo } });
    expect(att.deletedAt).not.toBeNull();
    expect(att.hash).toBe('a'.repeat(64));
    const last = (await rows(ids.photo)).at(-1)!;
    expect(last).toMatchObject({
      changeKind: 'UPDATE',
      changedFields: ['deletedAt'],
      branchId: ids.branch,
      hash: 'a'.repeat(64),
      source: `photo:${ids.photo}`,
      actorId: ids.steward,
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityType: 'Attachment', entityId: ids.photo, reason: 'photo removed (soft-delete)' },
    });
    expect(audit.before).toMatchObject({ kind: 'SHOP', branchId: ids.branch, hash: 'a'.repeat(64), capturedById: ids.steward });
  });

  it('when photo-gc drops a row, a DELETE tombstone keeps its last link and hash, under the job', async () => {
    await write((tx) => tx.attachment.create({ data: { ...photo(ids.gone, 'b'.repeat(64)), deletedAt: new Date() } }));
    await withChangeContext(db, { actorId: null, source: src.cron('photo-gc') }, (tx) =>
      tx.attachment.delete({ where: { id: ids.gone } })
    );
    const last = (await rows(ids.gone)).at(-1)!;
    expect(last).toMatchObject({
      changeKind: 'DELETE',
      branchId: ids.branch,
      hash: 'b'.repeat(64),
      source: 'cron:photo-gc',
      actorId: null,
    });
    expect(last.deletedAt).not.toBeNull();
  });

  it('the photo history refuses a direct insert, an update and a delete outside the owner’s maintenance window', async () => {
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "AttachmentHistory" SELECT * FROM "AttachmentHistory" WHERE "attachmentId" = '${ids.photo}' LIMIT 1`)
    ).rejects.toThrow(REFUSED);
    await expect(db.attachmentHistory.updateMany({ where: { attachmentId: ids.photo }, data: { hash: 'forged' } })).rejects.toThrow(REFUSED);
    await expect(db.attachmentHistory.deleteMany({ where: { attachmentId: ids.photo } })).rejects.toThrow(REFUSED);
    const n = await withAuditMaintenance(db, (tx) => tx.attachmentHistory.count({ where: { attachmentId: ids.photo } }));
    expect(n).toBeGreaterThan(0);
  });
});
