/**
 * The photo a close or reactivation request was sent with (F10, X-STATUS-2).
 *
 * markBranchClosedAction and requestReactivationAction check the photo when the
 * request is SENT: it exists, the salesman captured it, it is on this branch,
 * and it is fresh. Nothing checked it again when the request was DECIDED, so a
 * photo removed after the request was sent (detachPhotoCore lets the salesman
 * who captured it do that) still let the request be approved, with no evidence
 * behind it. The deciding transaction now asks again, under the customer's row
 * lock that Remove also takes, so the two cannot interleave.
 *
 * What is asked again is what cannot change legitimately: the photo is still
 * live, is still the submitter's, and is still wired to that branch. The
 * 24-hour capture-age rule is NOT asked again: it is about when the photo was
 * taken relative to when the request was sent, and re-applying it at decision
 * time would refuse every request that waited a day in the queue.
 *
 * One predicate, `standsAsEvidence`, serves the decision and the two review
 * pages, so what a reviewer is shown as "removed" is exactly what the approval
 * refuses.
 */
import type { Attachment, Prisma } from '@prisma/client';
import { ConflictError } from '@/lib/errors';

/** The request's EVIDENCE attachment ids, in the order sent, without repeats. */
export function evidenceIds(attachmentChanges: unknown): string[] {
  if (!Array.isArray(attachmentChanges)) return [];
  const ids: string[] = [];
  for (const entry of attachmentChanges) {
    if (!entry || typeof entry !== 'object') continue;
    const { action, attachmentId } = entry as { action?: unknown; attachmentId?: unknown };
    if (action !== 'EVIDENCE') continue;
    if (typeof attachmentId !== 'string' || attachmentId.length === 0) continue;
    if (!ids.includes(attachmentId)) ids.push(attachmentId);
  }
  return ids;
}

/** The columns `standsAsEvidence` reads. */
export const EVIDENCE_SELECT = {
  id: true,
  deletedAt: true,
  capturedById: true,
  branchId: true,
  branchExtraId: true,
} as const satisfies Prisma.AttachmentSelect;

export type EvidenceRow = Pick<
  Attachment,
  'id' | 'deletedAt' | 'capturedById' | 'branchId' | 'branchExtraId'
>;

/** Whose request, and for which branch. */
export type EvidenceSubject = { branchId: string | null; submittedById: string };

/**
 * Whether this attachment still stands as the request's evidence: not removed,
 * captured by the person who sent the request, and still on that branch (as its
 * shop or signboard photo, or as one of its extra photos) — the submit-time
 * checks, less the capture-age rule.
 */
export function standsAsEvidence(
  att: EvidenceRow | null | undefined,
  subject: EvidenceSubject
): boolean {
  if (!att || att.deletedAt !== null || !subject.branchId) return false;
  if (att.capturedById !== subject.submittedById) return false;
  return att.branchId === subject.branchId || att.branchExtraId === subject.branchId;
}

export const EVIDENCE_GONE = 'EVIDENCE_GONE';
/** A close request, on the approval page: its reject button is "✗ Reject". */
export const EVIDENCE_REMOVED_MESSAGE =
  'The photo sent with this request has been removed. Reject it so the salesman can send it again with a new photo.';
export const EVIDENCE_NONE_MESSAGE =
  'This request carries no photo evidence. Reject it so the salesman can send it again with a new photo.';
/**
 * A reactivation, on the Reactivations queue. It has no button called Reject:
 * its reject is "Keep closed" (ReactivationDecisionForm), so the refusal names
 * that button, as the queue's own warnings and the Manager guide do.
 */
export const REACTIVATION_EVIDENCE_REMOVED_MESSAGE =
  'The photo sent with this request has been removed. Use Keep closed to reject it, so the salesman can send it again with a new photo.';
export const REACTIVATION_EVIDENCE_NONE_MESSAGE =
  'This request carries no photo evidence. Use Keep closed to reject it, so the salesman can send it again with a new photo.';
/** X-STATUS-1's refusal (services/reactivations.ts), worded for the same button. */
export const REACTIVATION_STATE_CHANGED_MESSAGE =
  'This branch changed since the request was sent (removed, moved to another customer, or no longer closed). Use Keep closed to reject this request.';

/** Which queue decides the request: each names its own reject button. */
export type EvidenceQueue = 'approvals' | 'reactivations';
const REFUSAL: Record<EvidenceQueue, { removed: string; none: string }> = {
  approvals: { removed: EVIDENCE_REMOVED_MESSAGE, none: EVIDENCE_NONE_MESSAGE },
  reactivations: {
    removed: REACTIVATION_EVIDENCE_REMOVED_MESSAGE,
    none: REACTIVATION_EVIDENCE_NONE_MESSAGE,
  },
};

/**
 * Refuse the decision unless every EVIDENCE photo the request was sent with
 * still stands. Call it inside the deciding transaction, after the customer's
 * row lock: Remove takes the same lock, so a removal either committed before
 * this read (and is seen) or waits until the decision has committed.
 *
 * A request with no EVIDENCE entry at all is refused too: every close and
 * reactivation request is sent with one, so a row without one did not come
 * from those actions.
 *
 * `queue` picks the refusal's words: it tells the reviewer which button rejects.
 */
export async function assertStatusEvidence(
  tx: Pick<Prisma.TransactionClient, 'attachment'>,
  input: EvidenceSubject & { attachmentChanges: unknown; queue: EvidenceQueue }
): Promise<void> {
  const refusal = REFUSAL[input.queue];
  const ids = evidenceIds(input.attachmentChanges);
  if (ids.length === 0 || !input.branchId) {
    throw new ConflictError(EVIDENCE_GONE, refusal.none);
  }
  const rows = await tx.attachment.findMany({
    where: { id: { in: ids } },
    select: EVIDENCE_SELECT,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!ids.every((id) => standsAsEvidence(byId.get(id), input))) {
    throw new ConflictError(EVIDENCE_GONE, refusal.removed);
  }
}
