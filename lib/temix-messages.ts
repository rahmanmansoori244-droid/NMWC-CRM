/**
 * Follow-up 1, H11 (bug hunt round 2, F4): what Generate answers when its batch
 * committed but the file could not be built or recorded afterwards (a database
 * blip in the guarantee count or in the file's record). The batch is saved and
 * its customers are marked uploaded, so it must never read as a failure (it
 * said "Nothing was saved", and a retry then found nothing pending). No file
 * goes back: a file is handed over only once it is recorded (gap 14), and the
 * batch's Download builds and records its own.
 *
 * It lives here, not in services/temix.ts: that file is 'use server', and a
 * 'use server' file may export only async functions (next build refuses a
 * string; tests/unit/use-server-exports.test.ts keeps it that way).
 */
export const TEMIX_FILE_NOT_RETURNED =
  'The batch was saved and its customers are marked uploaded, but the file could not be made just now. Download it from Batch history below.';
