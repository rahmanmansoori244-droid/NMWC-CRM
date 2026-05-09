/**
 * Thin wrappers around exceljs for parsing import workbooks.
 * Used by the Steward import pages for both Customer and Account masters.
 */
import ExcelJS from 'exceljs';

export type ParsedRow = Record<string, string | number | null>;

export type ParsedSheet = {
  name: string;
  headers: string[];
  rows: ParsedRow[];
};

export async function parseWorkbook(buffer: ArrayBuffer | Uint8Array): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs accepts a Uint8Array; ts-strict typing on Buffer is over-narrow here.
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(u8 as any);
  const sheets: ParsedSheet[] = [];
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
        } else if (typeof v === 'object' && 'text' in (v as object)) {
          obj[h] = String((v as { text: string }).text);
        } else if (typeof v === 'object' && 'result' in (v as object)) {
          obj[h] = String((v as { result: unknown }).result ?? '');
        } else {
          obj[h] = String(v);
        }
      });
      rows.push(obj);
    });
    sheets.push({ name: ws.name, headers, rows });
  });
  return sheets;
}

export function buildWorkbook(rows: Record<string, unknown>[], sheetName = 'Sheet1') {
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
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  return wb;
}
