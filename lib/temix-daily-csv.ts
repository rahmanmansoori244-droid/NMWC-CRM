/**
 * The daily Temix import, stage 3: reading a daily file saved as CSV.
 *
 * The plan takes the Temix daily export as .xlsx or .csv. The workbook reader
 * (lib/excel.ts parseWorkbook) reads .xlsx only, and a CSV reader that guesses
 * types would turn a code such as 0012 into the number 12, which is exactly the
 * look-alike shop code the import holds back. So this reader keeps EVERY cell as
 * the text it was written as, and guesses nothing:
 *
 *  - the bytes must be UTF-8 (a byte-order mark is dropped); anything else is
 *    refused with a reason, never decoded by a guessed code page, because an
 *    Arabic name read in the wrong one is silently wrong;
 *  - fields follow RFC 4180: separated by the delimiter, a field in double
 *    quotes may hold the delimiter, a line break and "" for one quote; a record
 *    ends at CRLF, LF or CR;
 *  - the delimiter is the comma, unless the heading line has none and has
 *    semicolons (Excel's CSV in some regional settings) or tabs;
 *  - the first record is the headings. A blank heading's column is not read,
 *    as in the workbook reader, and a heading repeated (ignoring capitals) is
 *    recorded so the caller refuses the file;
 *  - a record whose cells are all blank is skipped, and every other record
 *    keeps its own number (the heading line is 1), as the workbook reader does.
 *
 * PURE: no imports, no database.
 */

/** The most data rows a daily file may carry (the workbook reader's cap). */
export const MAX_DAILY_ROWS = 50_000;

export type CsvSheet = {
  name: string;
  headers: string[];
  rows: Array<Record<string, string | null>>;
  rowNumbers: number[];
  duplicateHeadings: Array<{ heading: string; first: string; again: string }>;
};

export class CsvReadError extends Error {}

/** The text of a UTF-8 file, without its byte-order mark; throws CsvReadError on other bytes. */
export function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new CsvReadError(
      'The CSV file is not in UTF-8. Save it again as "CSV UTF-8 (Comma delimited)" or upload the .xlsx export.'
    );
  }
  return text;
}

const QUOTE = '"';

/** The delimiter the heading line uses: a comma, else a semicolon, else a tab. */
export function csvDelimiter(text: string): ',' | ';' | '\t' {
  let inQuotes = false;
  const count = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of text) {
    if (ch === QUOTE) inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) count[ch]++;
  }
  if (count[','] > 0) return ',';
  if (count[';'] > 0) return ';';
  if (count['\t'] > 0) return '\t';
  return ',';
}

/** Every record of the text, each a list of fields as written (quotes removed). */
export function csvRecords(text: string, delimiter: string = csvDelimiter(text)): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = '';
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === QUOTE) {
        if (text[i + 1] === QUOTE) {
          field += QUOTE;
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === QUOTE && field === '' && !quotedField) {
      inQuotes = true;
      quotedField = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new CsvReadError('The CSV file ends inside a quoted cell: a closing " is missing.');
  // The last record, unless the text ended with its line break.
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

/** A column's letter, as a spreadsheet names it (1 -> A, 27 -> AA). */
function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** A CSV file as the sheet the daily import reads (one sheet, named after the file). */
export function parseCsv(bytes: Uint8Array, name = 'CSV'): CsvSheet {
  const records = csvRecords(decodeUtf8(bytes));
  const head = records[0] ?? [];
  const columns: Array<{ index: number; name: string; letter: string }> = [];
  const duplicateHeadings: CsvSheet['duplicateHeadings'] = [];
  head.forEach((cell, index) => {
    const heading = cell.trim();
    if (!heading) return;
    const letter = columnLetter(index + 1);
    const same = columns.find((c) => c.name.toLowerCase() === heading.toLowerCase());
    if (same) {
      duplicateHeadings.push({ heading, first: same.letter, again: letter });
      return;
    }
    columns.push({ index, name: heading, letter });
  });
  const rows: CsvSheet['rows'] = [];
  const rowNumbers: number[] = [];
  for (const [r, record] of records.entries()) {
    if (r === 0) continue;
    if (record.every((c) => c.trim() === '')) continue;
    const row: Record<string, string | null> = {};
    for (const c of columns) {
      const v = record[c.index] ?? '';
      row[c.name] = v === '' ? null : v;
    }
    rows.push(row);
    rowNumbers.push(r + 1);
    if (rows.length > MAX_DAILY_ROWS) {
      throw new CsvReadError(
        `The file has too many rows (more than ${MAX_DAILY_ROWS.toLocaleString('en-US')}).`
      );
    }
  }
  return { name, headers: columns.map((c) => c.name), rows, rowNumbers, duplicateHeadings };
}
