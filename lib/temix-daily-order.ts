/**
 * The daily Temix import: which file may be staged and which may be applied, by
 * load day (the plan's safety rules; stage 3 stages, stage 5 applies).
 *
 *  - SAME FILE: the same bytes (SHA-256) are staged once per load day; a
 *    discarded file frees its day (the database says so too:
 *    TemixDailyFile_sha_day_live_unique). The same bytes on a LATER day are
 *    staged with a warning naming the earlier file (sameBytesAsFileId); the
 *    apply asks for a tick before it uses them.
 *  - ORDER: files are taken in the order of their load day, then of their
 *    upload. A file is not applied while an earlier one is neither LOADED nor
 *    DISCARDED (applyBlockedBy), and a file can never be applied once a file of
 *    a later load day has been applied or is being applied (overtakenBy). A
 *    file is not staged for a load day earlier than a file already staged or
 *    loaded (stagingRefusal): it could only ever be discarded.
 *
 * The load day is the Oman day of the upload, fixed when the file is staged
 * (the database refuses a future one). Whether the owner wants the apply day
 * instead is his open question; nothing here assumes the answer beyond what the
 * schema already does.
 *
 * PURE: no database.
 */

export type DailyFileState = 'STAGED' | 'CHECKED' | 'APPLYING' | 'FINALIZING' | 'LOADED' | 'DISCARDED';

export type DailyFileForOrder = {
  id: string;
  filename: string;
  /** The Oman load day, 'YYYY-MM-DD'. */
  loadDay: string;
  uploadedAt: Date;
  state: DailyFileState;
  fileSha256: string;
};

/**
 * The calendar day of a DATE column (TemixDailyFile.loadDay) as Prisma returns
 * it: midnight UTC of that day, so its day is its UTC parts. Not for an instant
 * (an upload time): that is lib/tz.ts omanDateISO.
 */
export function dateColumnDay(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

const FINISHED: readonly DailyFileState[] = ['LOADED', 'DISCARDED'];
const APPLIED_OR_APPLYING: readonly DailyFileState[] = ['APPLYING', 'FINALIZING', 'LOADED'];

/** A file is finished once LOADED or DISCARDED. */
export function isFinished(state: DailyFileState): boolean {
  return FINISHED.includes(state);
}

/** a before b: by load day, then upload time, then id (a total order). */
export function comesBefore(a: DailyFileForOrder, b: DailyFileForOrder): boolean {
  if (a.loadDay !== b.loadDay) return a.loadDay < b.loadDay;
  const ta = a.uploadedAt.getTime();
  const tb = b.uploadedAt.getTime();
  if (ta !== tb) return ta < tb;
  return a.id < b.id;
}

/** The refusal of a new upload on `loadDay` with `sha256`, or null when it may be staged. */
export function stagingRefusal(
  upload: { loadDay: string; sha256: string },
  others: readonly DailyFileForOrder[]
): string | null {
  const live = others.filter((f) => f.state !== 'DISCARDED');
  const same = live.find((f) => f.fileSha256 === upload.sha256 && f.loadDay === upload.loadDay);
  if (same) {
    return `This exact file was already uploaded for ${upload.loadDay} ("${same.filename}"). The same file is taken once per day. Nothing was uploaded.`;
  }
  const later = live
    .filter((f) => f.loadDay > upload.loadDay)
    .sort((a, b) => (a.loadDay < b.loadDay ? 1 : -1))[0];
  if (later) {
    return `A file for a later day, ${later.loadDay} ("${later.filename}"), is already uploaded, so a file for ${upload.loadDay} could never be applied after it. Nothing was uploaded.`;
  }
  return null;
}

/** The latest earlier-day file with the same bytes (the warning), or null. */
export function sameBytesEarlier(
  upload: { loadDay: string; sha256: string },
  others: readonly DailyFileForOrder[]
): DailyFileForOrder | null {
  const hits = others.filter(
    (f) => f.state !== 'DISCARDED' && f.fileSha256 === upload.sha256 && f.loadDay < upload.loadDay
  );
  hits.sort((a, b) => (comesBefore(a, b) ? 1 : -1));
  return hits[0] ?? null;
}

/** The earliest unfinished file that must be applied or discarded before `file`, or null. */
export function applyBlockedBy(
  file: DailyFileForOrder,
  others: readonly DailyFileForOrder[]
): DailyFileForOrder | null {
  const before = others.filter((f) => f.id !== file.id && !isFinished(f.state) && comesBefore(f, file));
  before.sort((a, b) => (comesBefore(a, b) ? -1 : 1));
  return before[0] ?? null;
}

/** A file of a later load day already applied or being applied, so `file` never can be; or null. */
export function overtakenBy(
  file: DailyFileForOrder,
  others: readonly DailyFileForOrder[]
): DailyFileForOrder | null {
  const later = others.filter(
    (f) => f.id !== file.id && APPLIED_OR_APPLYING.includes(f.state) && f.loadDay > file.loadDay
  );
  later.sort((a, b) => (comesBefore(a, b) ? -1 : 1));
  return later[0] ?? null;
}
