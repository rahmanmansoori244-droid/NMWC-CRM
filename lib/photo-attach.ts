/**
 * What the photo slot (components/nmwc/PhotoCaptureSlot.tsx) and the photo
 * routes and service must agree on.
 */
import type { Prisma } from '@prisma/client';

/**
 * A photo that is live and on no slot: the one condition every claim of a photo
 * re-asserts in its own WHERE, at the moment it writes — the attach into a
 * customer or branch slot (services/photos.ts), a new-customer request's claim
 * (services/creates.ts) and that request's bind at its final approval
 * (lib/create-finalize.ts). A check read before the write is not enough: in
 * the gap a Remove can soft-delete the photo or another claim can take it
 * (N06). Each caller adds its own `editId` condition. Finalize's hash dedupe
 * (app/api/photos/finalize) hands back only a photo that meets it, with
 * `editId: null`, so what it answers is one these claims can take (production
 * walk 2026-10-09).
 */
export const UNWIRED_LIVE = {
  deletedAt: null,
  customerId: null,
  branchId: null,
  branchExtraId: null,
} as const satisfies Prisma.AttachmentWhereInput;

/**
 * The attach refusal when the photo was removed, or taken by another slot or a
 * new-customer request, after the attach checked it and before it could claim
 * it (N06). A photo is still there only if it landed on the slot asked for,
 * which is answered ok.
 */
export const PHOTO_CONFLICT_MESSAGE = 'This photo was just removed or used elsewhere. Take it again.';

/**
 * The Remove refusal when the photo was wired to a slot, re-parented or claimed
 * after Remove read it (X-PHOTO-1): what the checks passed on is no longer the
 * photo's state, so nothing is removed.
 */
export const PHOTO_CHANGED_MESSAGE = 'This photo changed while it was being removed. Reload the page and try again.';

/**
 * The attach refusal, under the same code as the Remove one above
 * (`PHOTO_CHANGED`), when the customer or branch the photo was sent to changed
 * after the attach checked it and before it took the customer's lock: removed,
 * merged into another customer, or its branch moved to another customer. The
 * checks passed on a target that is no longer there, so nothing is written.
 */
export const PHOTO_TARGET_CHANGED_MESSAGE =
  'This customer or branch changed while the photo was being attached. Reload the page and try again.';

/**
 * The Remove answer for a photo that is already removed — by another Remove, or
 * replaced on its slot — given only to a caller who passed every check a Remove
 * of it makes, so it says nothing to anyone else (code `PHOTO_GONE`). The one
 * refusal on which the photo slot clears: every other one, "not found" from the
 * scope check included, means the server kept the photo.
 */
export const PHOTO_GONE_MESSAGE = 'This photo was already removed.';

/**
 * The Remove refusal, to the salesman, of a photo of his own new-customer
 * request while the request is with the approvers (SUBMITTED): removed, the
 * approvers were left reviewing a removed photo (launch browser suite). He may
 * still remove one while the request is a draft or sent back to him; the
 * approvers and the Steward are not refused.
 */
export const PHOTO_IN_REVIEW_MESSAGE =
  'This photo is on your new-customer request, which is with the approvers, so it cannot be removed now. If it must change, ask them to send the request back.';

/**
 * Presign and finalize's refusal of a role that cannot attach a photo, or of a
 * GUARANTEE document from anyone but a salesman (ENH-3; lib/permissions.ts
 * canUploadPhoto). No screen offers a photo slot to those roles or that kind,
 * and a role change made in the app revokes the session (services/users.ts), so
 * a phone mid-upload is signed out (401) rather than refused here; a scripted
 * caller is refused here. The slot shows its own "Could not get upload URL." /
 * "Finalize failed." for any refusal.
 */
export const PHOTO_ROLE_REFUSED_MESSAGE = 'Your role cannot upload this photo.';

/**
 * The attach refusal for a photo that is already on ANOTHER slot, said by
 * services/photos.ts. An attach of a photo to the slot it is already on is not
 * refused: it is answered ok and writes nothing, so the slot's re-send of an
 * attach that got no answer learns that the first one landed (post-merge review
 * of 30ec23a). The slot shows this refusal as a failure, whatever try it was.
 *
 * Production walk 2026-10-09: it said "Attachment already wired to a slot." and
 * left him nothing to do. Retry upload sends the photo again, and finalize now
 * gives a photo that is on a slot or a request a row of its own, which this
 * slot can take — so that is what it tells him.
 */
export const ALREADY_ATTACHED_MESSAGE =
  'This photo is already used elsewhere. Tap Retry upload to send it again as a new photo.';

/**
 * The attach refusal for a photo of another kind than the slot (NEW-PHOTO-001:
 * a signboard photo cannot stand in the shop-front slot). Finalize no longer
 * hands back a photo of another kind for the same picture (production walk
 * 2026-10-09), so a slot meets this only through a client that is not the app's
 * own; said plainly all the same, as the check stays.
 */
export const PHOTO_OTHER_SLOT_MESSAGE = 'This photo was taken for a different slot. Take it again here.';

/**
 * How long a presigned upload URL is valid (app/api/photos/presign). The slot's
 * longest wait for R2 after the body has gone (postBodyDeadlineMs in
 * components/nmwc/PhotoCaptureSlot.tsx) is kept shorter than this; a test pins it.
 */
export const PRESIGN_EXPIRES_S = 600;
