/**
 * PhotoCaptureSlot's words and limits, defined ONCE for every launch spec
 * (salesman-phone-helpers.ts and field-faults-helpers.ts re-export them).
 *
 * Copied, not imported: components/nmwc/PhotoCaptureSlot.tsx is a 'use client'
 * React component (JSX, lucide icons), which the Playwright runner should not
 * load. Each line names the constant it mirrors there; when the app changes one,
 * change it here only.
 */

/** ATTACH_NO_ANSWER */
export const ATTACH_NO_ANSWER = 'The photo is up, but attaching it got no answer. Tap Retry upload.';
/** UPLOAD_SIGNED_OUT */
export const UPLOAD_SIGNED_OUT =
  'You need to sign in again, so the photo is not sent yet. Keep this page open, sign in in another tab, then tap Retry upload.';
/** SLOW_LINK_MESSAGE */
export const SLOW_LINK_MESSAGE =
  'The connection is too slow to finish sending this photo. Move to better signal, then tap Retry upload.';
/**
 * UPLOAD_NO_CONNECTION (f960612, da545ac): what a slot says when a photo step got no answer on all three
 * tries — a dropped connection of any kind, the R2 PUT's ERR_TIMED_OUT included.
 */
export const UPLOAD_NO_CONNECTION =
  'No connection, so the photo is not sent yet. Keep this page open: the photo is held here until it is sent. Check the signal, then tap Retry upload.';
/** HEIC_PHOTO_MESSAGE: compressImage's HEIC refusal (NEW-PHOTO-012). */
export const HEIC_MESSAGE =
  "Your phone is sending HEIC photos. Open Settings → Camera → Formats and switch to 'Most Compatible' (JPEG).";
/** PHOTO_UNREADABLE_MESSAGE (287bdc0): any other photo the phone could not read or re-encode. */
export const UNREADABLE_PHOTO_MESSAGE = 'This phone could not read this photo. Take it again, or pick another photo.';
/** rateLimitWaitMessage(n), as a pattern. */
export const RATE_WAIT = /Too many photos — trying again in \d+ s/;
/** UPLOAD_STALL_MS: how long the PUT may go without a sign of life. */
export const UPLOAD_STALL_MS = 45_000;
/** RETRY_DELAYS.length: tries per step before "Retry upload". */
export const PHOTO_TRIES = 3;
