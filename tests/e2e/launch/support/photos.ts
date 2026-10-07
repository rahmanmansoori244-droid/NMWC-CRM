/**
 * Seeded photos: a real object in R2 plus the Attachment row the app would have
 * written, so /api/photos/<id> streams it back with a 200.
 *
 * The key is laid out exactly as app/api/photos/presign/route.ts lays it out —
 * <UTC yyyy/mm/dd>/<capturer's user id>/<KIND>/<uuid>.jpg — and the capturer must
 * be a fixture user: the R2 guard refuses anything else. The key, the day and
 * the attachment id are in the world's registry BEFORE the PUT, so a crash
 * between the PUT and the row still leaves the object findable by the sweep.
 * Attachment.bytes is the real object size (the photo route sends it as
 * Content-Length), and every image has unique bytes (finalize dedupes on hash).
 */
import { randomUUID } from 'node:crypto';
import type { AttachmentKind } from '@prisma/client';
import { db, safeError } from './env';
import { sha256Hex, tinyJpeg, TINY_JPEG_SIZE } from './media';
import { utcYmd } from './oman';
import { newId } from './ids';
import { putFixtureObject } from './r2';
import type { SeededPhoto, World } from './types';

export interface PhotoSpec {
  kind: AttachmentKind;
  /** User key of the capturer (a fixture user). */
  capturedBy: string;
  customerId?: string;
  branchId?: string;
  branchExtraId?: string;
  editId?: string;
  capturedAt?: Date;
  /** Wire the photo into the live slot (customer CR, branch shop / signboard). */
  wire?: 'CR' | 'SHOP' | 'SIGNBOARD';
  lat?: number;
  lng?: number;
}

/** Seeds several photos with one row insert; PUTs run in parallel. */
export async function seedPhotos(w: World, specs: PhotoSpec[]): Promise<SeededPhoto[]> {
  if (specs.length === 0) return [];
  const fixtureIds = w.fixtureUserIds();
  const ymd = utcYmd();
  const planned = specs.map((s, i) => {
    const capturer = w.user(s.capturedBy);
    if (s.wire === 'CR' && (s.kind !== 'CR' || !s.customerId)) throw new Error('a CR wire needs kind CR and customerId');
    if ((s.wire === 'SHOP' || s.wire === 'SIGNBOARD') && (s.kind !== s.wire || !s.branchId))
      throw new Error(`a ${s.wire} wire needs kind ${s.wire} and branchId`);
    const id = newId();
    const r2Key = `${ymd}/${capturer.id}/${s.kind}/${randomUUID()}.jpg`;
    const bytes = tinyJpeg(`${w.sfx}-${i}-${id}`);
    return { s, id, r2Key, bytes, capturedById: capturer.id, sha256: sha256Hex(bytes) };
  });
  w.registry.add('ymds', ymd);
  w.registry.add('r2Keys', ...planned.map((p) => p.r2Key));
  w.registry.add('attachmentIds', ...planned.map((p) => p.id));

  await Promise.all(planned.map((p) => putFixtureObject(p.r2Key, p.bytes, 'image/jpeg', fixtureIds)));

  try {
    await db.attachment.createMany({
      data: planned.map((p) => ({
        id: p.id,
        kind: p.s.kind,
        customerId: p.s.customerId ?? null,
        branchId: p.s.branchId ?? null,
        branchExtraId: p.s.branchExtraId ?? null,
        editId: p.s.editId ?? null,
        r2Key: p.r2Key,
        mimeType: 'image/jpeg',
        bytes: p.bytes.length,
        width: TINY_JPEG_SIZE.width,
        height: TINY_JPEG_SIZE.height,
        capturedById: p.capturedById,
        capturedAt: p.s.capturedAt ?? new Date(),
        capturedLat: p.s.lat ?? 23.5881,
        capturedLng: p.s.lng ?? 58.3829,
        hash: p.sha256,
      })),
    });
    // Live slots, as the attach route leaves them.
    for (const p of planned) {
      if (p.s.wire === 'CR') {
        await db.customer.update({ where: { id: p.s.customerId! }, data: { crPhotoId: p.id } });
      } else if (p.s.wire === 'SHOP') {
        await db.branch.update({ where: { id: p.s.branchId! }, data: { shopPhotoId: p.id } });
      } else if (p.s.wire === 'SIGNBOARD') {
        await db.branch.update({ where: { id: p.s.branchId! }, data: { signboardPhotoId: p.id } });
      }
    }
  } catch (err) {
    throw safeError(err, 'seeding photo rows failed');
  }

  return planned.map((p) => ({
    id: p.id,
    r2Key: p.r2Key,
    kind: p.s.kind,
    bytes: p.bytes,
    size: p.bytes.length,
    sha256: p.sha256,
    capturedById: p.capturedById,
    customerId: p.s.customerId ?? null,
    branchId: p.s.branchId ?? null,
    editId: p.s.editId ?? null,
    wire: p.s.wire ?? null,
  }));
}

/** One seeded photo: an R2 PUT under the capturer's folder and its Attachment row. */
export async function seedPhoto(w: World, spec: PhotoSpec): Promise<SeededPhoto> {
  return (await seedPhotos(w, [spec]))[0]!;
}
