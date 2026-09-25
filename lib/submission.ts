/**
 * Benchmark item 22: a salesman who loses signal at Submit must be able to tell
 * whether it arrived. Owner decisions (2026-09-25):
 *   - no offline queue: say plainly what is known, and offer Try again;
 *   - the phone sends a submission id with every submit, stored on CustomerEdit,
 *     so a retry of a submit that already arrived is answered "Already received"
 *     instead of a red conflict, and is never applied twice;
 *   - all three field forms: customer update, new customer, close / reactivate.
 *
 * This module is shared by the browser and the server: the id, the receipt a
 * retry gets back, and the words the salesman reads. No database access here.
 */
import { z } from 'zod';

/** A submission id: a v4 UUID minted on the phone for one payload. */
export const submissionIdSchema = z.string().uuid();

/**
 * What a submit answers with. `replayed` is true when this submission id had
 * already arrived: nothing was written this time, and the rest describes the
 * request as it stands NOW (it may have been approved or sent back since).
 */
export type SubmitReceipt = {
  editId: string;
  state: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'NEEDS_CORRECTION';
  submittedAt: string | null;
  replayed: boolean;
};

/** A new submission id. crypto.randomUUID needs a secure context; production is https. */
export function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for an insecure context (a LAN dev server): a v4 UUID from random bytes.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const OMAN_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Muscat',
  hour: '2-digit',
  minute: '2-digit',
});
const OMAN_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Muscat',
  day: 'numeric',
  month: 'short',
});

/** "10:42" today, "24 Sep, 10:42" on another day — Oman time, as the salesman reads a clock. */
export function omanWhen(at: Date | string, now: Date = new Date()): string {
  const d = new Date(at);
  const time = OMAN_TIME.format(d);
  return OMAN_DAY.format(d) === OMAN_DAY.format(now) ? time : `${OMAN_DAY.format(d)}, ${time}`;
}

/**
 * The line for a submit that had already arrived: what the request is NOW,
 * because it may have been approved or sent back between the first attempt and
 * this one. Never "nothing more to do" for a draft — it is still unsent — and
 * no approver named: a reactivation is a Manager's, not "your supervisor's".
 */
export function alreadyReceivedMessage(r: SubmitReceipt, now: Date = new Date()): string {
  const at = r.submittedAt ? ` at ${omanWhen(r.submittedAt, now)}` : '';
  switch (r.state) {
    case 'DRAFT':
      return `✓ Already saved${at}. It is still a draft — submit it when ready.`;
    case 'SUBMITTED':
      return `✓ Already received${at} — it is waiting for approval. Nothing more to do.`;
    case 'APPROVED':
      return `✓ Already received${at}, and approved since. Nothing more to do.`;
    case 'NEEDS_CORRECTION':
      return `Already received${at}, and sent back for correction since. Open Work to see why.`;
    case 'REJECTED':
      // No screen shows a salesman a rejection's reason, so none is promised.
      return `Already received${at}, and rejected since — it was not applied.`;
  }
}

/*
 * The failure lines sit in the sticky bar beside the button, on a 320 px phone:
 * each says what is certain and what to do, and no more.
 */

/** Nothing left the phone: it had no network at all. */
export const OFFLINE_MESSAGE =
  'No signal — nothing was sent. Your changes are still here. Tap Try again when you have signal.';

/**
 * This try did not leave the phone — but an earlier try of the same thing got no
 * answer and may have arrived. "Nothing was sent" alone would erase that doubt.
 */
export const OFFLINE_AFTER_UNCONFIRMED_MESSAGE =
  'No signal — this try was not sent, but the one before may have arrived. Tap Try again when you have signal: if it arrived you will see “Already received”.';

/**
 * This try did not leave the phone, and it is not the payload that went
 * unanswered — the salesman changed the form since. That earlier send may still
 * have arrived; a retry of THIS payload cannot answer "Already received" for it,
 * so none is promised: the app says what it finds.
 */
export const OFFLINE_AFTER_EARLIER_MESSAGE =
  'No signal — this was not sent, but an earlier try may have arrived. Tap Try again when you have signal and the app will say what it finds.';

/** Sent, but no answer came back: it may or may not have arrived. */
export const UNCONFIRMED_MESSAGE =
  'No answer — we cannot tell if it arrived. Your changes are still here. Tap Try again: if it arrived you will see “Already received”; it is never sent twice.';

/**
 * Turned away before it was read: the session ended, or a forced password
 * change. Not "sign in again here" — leaving this page loses what only lives on
 * it (the new-customer form keeps its typed text on the phone, but not its
 * branches, points or photos). A sign-in in another tab refreshes the cookie.
 */
export const SIGNED_OUT_MESSAGE =
  'You need to sign in again, so this was not sent. Keep this page open, sign in in another tab, then come back and tap Try again.';

/**
 * The server read it and refused fields. The fields say so where they are, above
 * the sticky bar and often off-screen; this says it where the thumb is, so the
 * red notice from a previous try does not simply vanish and read as success.
 */
export const FIX_FIELDS_MESSAGE = 'Not sent — fix what is marked in red, then submit again.';

/**
 * Submit waits while a photo is still going up: the form leaves after Submit by
 * a document load (lib/navigate.ts), and that load aborts an upload in flight.
 */
export const PHOTO_UPLOADING_MESSAGE = 'Wait — a photo is still uploading.';

/** The app was closed for maintenance: the request was turned away unread. */
export const MAINTENANCE_MESSAGE =
  'The app is closed for maintenance, so this was not sent. Your changes are still here. Tap Try again in a few minutes.';
