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
