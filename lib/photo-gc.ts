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
 *
 * A second clause (sweepStaleEditClaims) releases the other leak: photos
 * CLAIMED by a create request (editId stamped) whose request then died on the
 * vine. Claims are deliberately kept alive while a request can still move —
 * see STALE_CLAIM_STATES for the exact lifecycle reasoning.
 */
import { EditState, Prisma, type PrismaClient } from '@prisma/client';

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

/**
 * How long a create request may sit untouched before its photo claims are
 * released. Measured on CustomerEdit.updatedAt, which only moves when someone
 * acts on the request — so this is "days since anyone touched it", not days
 * since rejection. Two months comfortably exceeds any real correction
 * turnaround (chain SLAs are measured in hours); a salesman resuming an older
 * request sees the swept slots come back empty (the resume page
 * liveness-filters them) and re-captures at the shop they are registering
 * anyway.
 */
export const STALE_CLAIM_GRACE_DAYS = 60;

/**
 * States whose claims may go stale. Deliberately NOT gated on state=REJECTED
 * alone: the Phase 1b engine never writes EditState.REJECTED — a rejection
 * either steps back one approver (state stays SUBMITTED) or returns the
 * request to the salesman as NEEDS_CORRECTION (which the app's own /rejected
 * page presents as "rejected"). The abandoned-request leak therefore lives in
 * DRAFT + NEEDS_CORRECTION today; REJECTED is included so the sweep keeps
 * working if the blueprint's terminal hard-reject ever lands.
 *
 * SUBMITTED is excluded no matter how old — an in-flight request awaiting an
 * approver must keep its photos even if the chain stalls past every SLA.
 * APPROVED is excluded because finalize binds the photos (customerId/branchId
 * set, editId kept only for provenance) — bound rows never match the unbound
 * predicates below anyway.
 */
const STALE_CLAIM_STATES: EditState[] = [
  EditState.DRAFT,
  EditState.NEEDS_CORRECTION,
  EditState.REJECTED,
];

export type StaleClaimSweepResult = {
  /** Stale-claimed rows found this run (≤ batchSize). */
  scanned: number;
  /** Rows actually soft-deleted. */
  swept: number;
};

/**
 * Soft-delete photo claims of create requests abandoned in a resumable (or
 * terminal) state for STALE_CLAIM_GRACE_DAYS.
 *
 * Unlike the never-attached sweep, draft photo columns do NOT protect these
 * rows — the draft of an abandoned request is exactly what we are releasing.
 * The draft columns are bare strings (no FK), so they dangle harmlessly; a
 * resume after the sweep loses the photos but nothing else (the resume page
 * liveness-filters every slot, so dead slots render empty and the mandatory
 * gate names exactly what must be re-captured).
 *
 * Race safety: the stale-check CANNOT live in the attachment updateMany's
 * `edit:` relation filter. Under READ COMMITTED, an UPDATE blocked on a row
 * lock re-evaluates only the TARGET row's predicates against the new version
 * (EvalPlanQual); a cross-table subquery keeps the statement-start snapshot —
 * so a resume committing mid-statement would flip the edit to SUBMITTED and
 * still lose its photos. Instead we lock the parent CustomerEdit rows with
 * SELECT ... FOR UPDATE and re-assert state + idle-age ROW-LOCALLY on the
 * locked rows (EPQ-safe), inside one transaction with the attachment update:
 *   • resume first: FOR UPDATE blocks, then re-checks the committed row —
 *     the touched edit stops matching and its claims are spared;
 *   • sweep first: submitCreateCore's edit-row claim blocks on our lock, and
 *     its attachment re-claim then sees deletedAt set and fails with the
 *     graceful PHOTO_CONFLICT ("refresh and re-check the photo slots").
 * Lock order (edit row → attachments) matches submitCreateCore and the
 * approve/finalize path, so no deadlock is possible.
 */
export async function sweepStaleEditClaims(
  db: PrismaClient,
  now: Date,
  batchSize: number = ORPHAN_BATCH_SIZE
): Promise<StaleClaimSweepResult> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_GRACE_DAYS * 24 * 60 * 60 * 1000);
  return db.$transaction(
    async (tx) => {
      // editId `not: null` is what separates this clause from the
      // never-attached sweep above; the relation filter here only narrows the
      // candidate set — the authoritative stale-check is the locked re-assert
      // below.
      const candidates = await tx.attachment.findMany({
        where: {
          deletedAt: null,
          customerId: null,
          branchId: null,
          branchExtraId: null,
          editId: { not: null },
          edit: {
            state: { in: STALE_CLAIM_STATES },
            updatedAt: { lt: cutoff },
          },
        },
        select: { id: true, editId: true },
        take: batchSize,
      });
      if (candidates.length === 0) {
        return { scanned: 0, swept: 0 };
      }

      const editIds = [...new Set(candidates.map((c) => c.editId as string))].sort();
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CustomerEdit"
        WHERE "id" IN (${Prisma.join(editIds)})
          AND "state"::text IN (${Prisma.join(STALE_CLAIM_STATES)})
          AND "updatedAt" < ${cutoff}
        FOR UPDATE`;
      const locked = new Set(lockedRows.map((r) => r.id));
      const sweepIds = candidates
        .filter((c) => locked.has(c.editId as string))
        .map((c) => c.id);
      if (sweepIds.length === 0) {
        return { scanned: candidates.length, swept: 0 };
      }

      // Attachment-local predicates only (row-local ⇒ EPQ-safe); the parent
      // requests are locked above, so nothing can re-claim or bind these rows
      // before we commit.
      const res = await tx.attachment.updateMany({
        where: {
          id: { in: sweepIds },
          deletedAt: null,
          customerId: null,
          branchId: null,
          branchExtraId: null,
          editId: { not: null },
        },
        data: { deletedAt: now, hash: null },
      });
      return { scanned: candidates.length, swept: res.count };
    },
    { timeout: 15_000 }
  );
}
