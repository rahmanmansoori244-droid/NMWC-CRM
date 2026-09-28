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
 * (N06). Each caller adds its own `editId` condition.
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
 */
export const ALREADY_ATTACHED_MESSAGE = 'Attachment already wired to a slot.';

/**
 * How long a presigned upload URL is valid (app/api/photos/presign). The slot's
 * longest wait for R2 after the body has gone (postBodyDeadlineMs in
 * components/nmwc/PhotoCaptureSlot.tsx) is kept shorter than this; a test pins it.
 */
export const PRESIGN_EXPIRES_S = 600;
