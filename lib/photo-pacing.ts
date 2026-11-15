/**
 * Large-customer photos, part B: which way a page loads its photos.
 *
 * Every photo goes through /api/photos/<id>, which allows one person 60 photos
 * at once and then 1 a second (lib/rate-limit.ts). A page that counts 40
 * photos or fewer renders them as it always has ('direct'): the browser asks
 * for each at once, and a photo joins the paced queue (components/nmwc/
 * photo-queue.ts) only if its first load fails. A page that counts more than
 * 40 renders a placeholder for each ('queued'): the queue starts at most 6 at
 * a time, and after the first refusal one about every 1.1 s.
 *
 * The helpers take the ids the page is about to render, so each screen's count
 * is the photos it really shows.
 */

/** A page with MORE photos than this loads them through the queue. */
export const PHOTO_QUEUE_FROM = 40;

export type PhotoMode = 'direct' | 'queued';

export function photoModeFor(count: number): PhotoMode {
  return count > PHOTO_QUEUE_FROM ? 'queued' : 'direct';
}

type Id = string | null | undefined;
const one = (id: Id): number => (id ? 1 : 0);
const many = (ids: ReadonlyArray<Id> | null | undefined): number => (ids ?? []).filter(Boolean).length;

/** Customer profile: the CR document plus each shown branch's shop and signboard photo. */
export function profilePhotoCount(customer: {
  crPhoto: { id: string } | null;
  branches: ReadonlyArray<{ shopPhoto: { id: string } | null; signboardPhoto: { id: string } | null }>;
}): number {
  return (
    one(customer.crPhoto?.id) +
    customer.branches.reduce((n, b) => n + one(b.shopPhoto?.id) + one(b.signboardPhoto?.id), 0)
  );
}

/**
 * Approval detail: the ids of every PhotoRow on the page, each list exactly as
 * that row renders it (an empty list for a row that is not shown). Ten call
 * sites: the CR document, guarantees, each credit document, the signed
 * application and each branch draft of a new-customer request; the evidence,
 * the CR document on file and each live branch's shop, signboard and other
 * photos of an update.
 */
export function approvalPhotoCount(rows: ReadonlyArray<ReadonlyArray<Id>>): number {
  return rows.reduce((n, ids) => n + many(ids), 0);
}

/** Edit form: the remote photos it opens with (CR document, each shop's shop and signboard photo). */
export function enrichmentPhotoCount(customer: {
  crPhotoId: Id;
  branches: ReadonlyArray<{ shopPhotoId: Id; signboardPhotoId: Id }>;
}): number {
  return (
    one(customer.crPhotoId) +
    customer.branches.reduce((n, b) => n + one(b.shopPhotoId) + one(b.signboardPhotoId), 0)
  );
}

/** New-customer form (a resumed draft): the CR document and each shop's shop, signboard and extra photos. */
export function createFormPhotoCount(form: {
  crPhotoId: Id;
  branches: ReadonlyArray<{ shopPhotoId: Id; signboardPhotoId: Id; extraPhotoIds: ReadonlyArray<Id> }>;
}): number {
  return (
    one(form.crPhotoId) +
    form.branches.reduce(
      (n, b) => n + one(b.shopPhotoId) + one(b.signboardPhotoId) + many(b.extraPhotoIds),
      0
    )
  );
}
