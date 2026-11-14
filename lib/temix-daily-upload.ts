/**
 * The daily Temix import, stage 3: which uploaded files are read, and as what.
 *
 * The Temix daily export is taken as .xlsx or .csv (the plan's file handling),
 * up to the Import screen's 4.2 MB (lib/import-file-size.ts). A file is read by
 * what it IS as well as by its name: an .xlsx is a zip, so its bytes start with
 * "PK\x03\x04"; a file named .xlsx that is not one, or a zip named .csv, is
 * refused rather than read as something it is not.
 *
 * PURE: no imports; the upload form uses it too.
 */

export type DailyFileKind = 'xlsx' | 'csv';

/** What the upload box accepts. */
export const DAILY_FILE_ACCEPT = '.xlsx,.csv';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/** The file's kind by its name and its first bytes; null when it is neither. */
export function dailyFileKind(name: string, bytes: Uint8Array): DailyFileKind | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.xlsx')) return isZip(bytes) ? 'xlsx' : null;
  if (lower.endsWith('.csv')) return isZip(bytes) ? null : 'csv';
  return null;
}

/** Why the file is not read, or null. */
export function dailyFileKindRefusal(kind: DailyFileKind | null, size: number): string | null {
  if (size === 0) return 'The file is empty. Nothing was uploaded.';
  if (kind === null) {
    return 'Upload the Temix daily export as an .xlsx workbook or a .csv file (a file must be what its name says). Nothing was uploaded.';
  }
  return null;
}

/** The file name as recorded: its last path part, trimmed, at most 200 characters. */
export function dailyFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const trimmed = base.trim().slice(0, 200);
  return trimmed || 'unnamed';
}

export type UploadTone = 'ok' | 'warn' | 'fail';

/** What an accepted upload answers with (services/temix-daily.ts TemixDailyUploadResult). */
export type DailyUploadAnswer = {
  loadDay: string;
  rows: number;
  rowsWithNotes: number;
  notRead: string[];
  otherSheets: string[];
  sameBytesAs: { loadDay: string; filename: string } | null;
  waitsFor: { loadDay: string; filename: string } | null;
};

const NOT_READ_SHOWN = 20;

/** What the Steward is told after an accepted upload: staged, nothing applied, and what to look at. */
export function uploadMessage(data: DailyUploadAnswer): { tone: UploadTone; lines: string[] } {
  const n = (x: number) => x.toLocaleString('en-US');
  const lines = [`Staged ${n(data.rows)} row${data.rows === 1 ? '' : 's'} for ${data.loadDay}. Nothing is applied to customers yet.`];
  let tone: UploadTone = 'ok';
  if (data.rowsWithNotes > 0) {
    tone = 'warn';
    lines.push(`${n(data.rowsWithNotes)} row${data.rowsWithNotes === 1 ? ' has' : 's have'} a note (counted in the list below).`);
  }
  if (data.sameBytesAs) {
    tone = 'warn';
    lines.push(`This file is exactly the same as the one uploaded for ${data.sameBytesAs.loadDay} ("${data.sameBytesAs.filename}").`);
  }
  if (data.waitsFor) {
    tone = 'warn';
    lines.push(`It waits for the file of ${data.waitsFor.loadDay} ("${data.waitsFor.filename}"), which must be applied or discarded first.`);
  }
  if (data.otherSheets.length > 0) {
    tone = 'warn';
    lines.push(`Only the first sheet was read. Not read: ${data.otherSheets.join(', ')}.`);
  }
  const k = data.notRead.length;
  if (k > 0) {
    const more = k > NOT_READ_SHOWN ? ` and ${n(k - NOT_READ_SHOWN)} more` : '';
    lines.push(`Not read: ${n(k)} column${k === 1 ? ' is' : 's are'} not one of the agreed columns and ${k === 1 ? 'was' : 'were'} ignored: ${data.notRead.slice(0, NOT_READ_SHOWN).join(', ')}${more}.`);
  }
  return { tone, lines };
}
