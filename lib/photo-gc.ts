/**
 * GAP-03 / Q4 (Phase 1): sweep for never-attached orphan uploads.
 *
 * /api/photos/finalize creates every Attachment fully unbound (customerId /
 * branchId / branchExtraId / editId all NULL). Binding happens later — at
 * attachPhoto for the UPDATE flow, or at create-draft save / finalize for the
 * CREATE flow. Two client paths leave rows unbound forever with no detach
 * call to soft-delete them:
 *
 *   • PhotoCaptureSlot in unbound mode (no `attachTo`): clear/retake only
 *     resets local state — actuallyClear never calls detachPhotoAction;
 *   • the /customers/new form is abandoned before any draft is saved, so
 *     submitCreateCore never claims (editId) or releases the referenced ids.
 *
 * Without this sweep those rows never gain a `deletedAt` and therefore never
 * enter the 30-day R2 GC pipeline — storage grows unboundedly (the exact
 * failure mode GAP-03 was opened for). Soft-deleting them here (deletedAt +
 * hash=null, the same release shape submitCreateCore uses) hands them to the
 * existing pipeline; nothing is hard-deleted for another GC_GRACE_DAYS.
 */
import type { PrismaClient } from '@prisma/client';

/**
 * How long a fully-unbound upload may sit before it is considered abandoned.
 * Must comfortably exceed any legitimate capture→bind gap: binds normally
 * land within seconds (bound mode) or at the next draft save (create form).
 * A swept photo is not lost — submit/attach fail softly ("photo no longer
 * exists") and the salesman re-captures.
 */
export const ORPHAN_GRACE_DAYS = 7;

/** Per-run cap, mirroring the hard-GC pass — backlog drains across nights. */
export const ORPHAN_BATCH_SIZE = 200;

type CustomerDraftRef = { crPhotoAttachmentId: string | null };
type BranchDraftRef = {
  shopPhotoAttachmentId: string | null;
  signboardPhotoAttachmentId: string | null;
  extraPhotoAttachmentIds: unknown; // Json column: string[] when present
};

/**
 * Every attachment id referenced by a draft photo column. These ids are
 * normally also claimed via Attachment.editId (submitCreateCore stamps both
 * in one transaction), so they never match the all-NULL orphan filter — this
 * set is defense-in-depth so a claim bug can never let the sweep eat a photo
 * a draft still points at. Open edits' GUARANTEE claims have no draft column
 * at all; they are protected purely by their editId stamp.
 */
export function collectDraftReferencedIds(
  customerDrafts: CustomerDraftRef[],
  branchDrafts: BranchDraftRef[]
): Set<string> {
  const ids = new Set<string>();
  for (const d of customerDrafts) {
    if (d.crPhotoAttachmentId) ids.add(d.crPhotoAttachmentId);
  }
  for (const b of branchDrafts) {
    if (b.shopPhotoAttachmentId) ids.add(b.shopPhotoAttachmentId);
    if (b.signboardPhotoAttachmentId) ids.add(b.signboardPhotoAttachmentId);
    if (Array.isArray(b.extraPhotoAttachmentIds)) {
      for (const x of b.extraPhotoAttachmentIds) {
        if (typeof x === 'string' && x) ids.add(x);
      }
    }
  }
  return ids;
}

export type OrphanSweepResult = {
  /** Unbound rows past the grace cutoff found this run (≤ batchSize). */
  scanned: number;
  /** Rows actually soft-deleted. */
  swept: number;
  /** Candidates spared because a draft photo column still references them. */
  skippedProtected: number;
};

/**
 * Soft-delete abandoned never-attached uploads older than ORPHAN_GRACE_DAYS.
 *
 * The final updateMany re-asserts every orphan predicate: a claim (create
 * submit) or attach racing this cron wins — anything wired between the
 * candidate SELECT and the UPDATE simply stops matching and is skipped.
 */
export async function sweepNeverAttachedOrphans(
  db: PrismaClient,
  now: Date,
  batchSize: number = ORPHAN_BATCH_SIZE
): Promise<OrphanSweepResult> {
  const cutoff = new Date(now.getTime() - ORPHAN_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await db.attachment.findMany({
    where: {
      deletedAt: null,
      customerId: null,
      branchId: null,
      branchExtraId: null,
      editId: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    take: batchSize,
  });
  if (candidates.length === 0) {
    return { scanned: 0, swept: 0, skippedProtected: 0 };
  }

  const [customerDrafts, branchDrafts] = await Promise.all([
    db.editCustomerDraft.findMany({
      where: { crPhotoAttachmentId: { not: null } },
      select: { crPhotoAttachmentId: true },
    }),
    db.editBranchDraft.findMany({
      select: {
        shopPhotoAttachmentId: true,
        signboardPhotoAttachmentId: true,
        extraPhotoAttachmentIds: true,
      },
    }),
  ]);
  const draftReferenced = collectDraftReferencedIds(customerDrafts, branchDrafts);
  const sweepIds = candidates.map((c) => c.id).filter((id) => !draftReferenced.has(id));
  if (sweepIds.length === 0) {
    return { scanned: candidates.length, swept: 0, skippedProtected: candidates.length };
  }

  const res = await db.attachment.updateMany({
    where: {
      id: { in: sweepIds },
      deletedAt: null,
      customerId: null,
      branchId: null,
      branchExtraId: null,
      editId: null,
    },
    // hash=null matches every other release site (submitCreateCore,
    // attachPhoto replacement): a soft-deleted row must never satisfy the
    // same-uploader finalize dedupe again.
    data: { deletedAt: now, hash: null },
  });
  return {
    scanned: candidates.length,
    swept: res.count,
    skippedProtected: candidates.length - sweepIds.length,
  };
}
