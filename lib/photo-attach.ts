/**
 * What the photo slot (components/nmwc/PhotoCaptureSlot.tsx) and the photo
 * routes and service must agree on.
 */

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
