// @vitest-environment node
/**
 * Bug hunt round 2, F1: a cell holding an Excel error (#N/A, #REF!, or a formula
 * whose saved result is one) was loaded as the text '#ERROR:<code>'. In cust_code
 * it gathered the shops of several customers into one customer of that code.
 *
 * Now the row is held back at upload, on the column that holds the error, and is
 * never matched, created or promoted; the other rows of the file are checked as
 * if it were not there, and the "Before you promote" check counts it.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '@/lib/excel';
import {
  checkCustomerRow,
  excelErrorCells,
  excelErrorOf,
  fileCollisions,
  fileShopCodes,
  type RowCheckContext,
  type SheetRow,
} from '@/lib/import-row-check';
import { emptySummary, summaryLines } from '@/lib/import-plan';

const ctx = (over: Partial<RowCheckContext> = {}): RowCheckContext => ({
  channelKeys: new Set(['RETAIL']),
  phonesInFile: new Map(),
  crsInFile: new Map(),
  masterPhones: new Map(),
  masterCrs: new Map(),
  ...over,
});

/** A sheet whose row 3 has #N/A in cust_code and row 4 a formula whose result is #REF! in cust_name. */
async function sheetWithErrors(): Promise<Array<{ row: SheetRow; rowNumber: number }>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(['cust_code', 'cust_name', 'branch_code', 'phone', 'cr_no']);
  ws.addRow(['CCT0005', 'Al Noor', '01', '99758980', '1234567']);
  ws.addRow([{ error: '#N/A' }, 'Al Noor', '02', '99758980', '1234567']);
  ws.addRow(['CCT0006', { formula: 'VLOOKUP(A4,X!A:B,2,0)', result: { error: '#REF!' } }, '01', '99758981', '7654321']);
  ws.addRow(['CCT0007', 'Al Wadi', '01', '99758981', '7654321']);
  const [sheet] = await parseWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return sheet!.rows.map((row, i) => ({ row: row as SheetRow, rowNumber: sheet!.rowNumbers[i]! }));
}

describe('an Excel error cell on the customer import', () => {
  it('excelErrorOf reads the parser’s marker, and nothing else', () => {
    expect(excelErrorOf('#ERROR:#N/A')).toBe('#N/A');
    expect(excelErrorOf('#ERROR:#REF!')).toBe('#REF!');
    expect(excelErrorOf('#N/A')).toBeNull();
    expect(excelErrorOf('CCT0005')).toBeNull();
    expect(excelErrorOf(12)).toBeNull();
    expect(excelErrorOf(null)).toBeNull();
  });

  it('holds the row back on the column holding the error, naming the error; the other rows load', async () => {
    const rows = await sheetWithErrors();
    const { phonesInFile, crsInFile } = fileCollisions(rows);
    const c = ctx({ phonesInFile, crsInFile, shopsInFile: fileShopCodes(rows) });
    const [good, codeErr, nameErr, other] = rows.map((r) => checkCustomerRow(r.row, c));

    expect(codeErr!.issues).toContainEqual({
      field: 'cust_code',
      message: 'the cell holds the Excel error #N/A, not a value. This row is not loaded until the cell holds a real value',
    });
    expect(codeErr!.parsed.excelError).toBe(true);
    expect(nameErr!.issues).toContainEqual({
      field: 'cust_name',
      message: 'the cell holds the Excel error #REF!, not a value. This row is not loaded until the cell holds a real value',
    });
    expect(nameErr!.parsed.excelError).toBe(true);

    // Row 2 shares its phone and CR with the #N/A row, and row 5 with the #REF!
    // row, under other customer codes: they are NOT held back because of them.
    expect(good!.issues).toEqual([]);
    expect(good!.parsed.excelError).toBeUndefined();
    expect(other!.issues).toEqual([]);
  });

  it('every one of the 17 columns is screened, whatever its heading is spelled', () => {
    expect(excelErrorCells({ 'TEMIX CODE': '#ERROR:#VALUE!', Route: '#ERROR:#NAME?' })).toEqual([
      { cell: 'route', error: '#NAME?' },
      { cell: 'temix_code', error: '#VALUE!' },
    ]);
    const { issues } = checkCustomerRow(
      { cust_code: 'C1', cust_name: 'Al Noor', credit_limit: '#ERROR:#DIV/0!' },
      ctx()
    );
    expect(issues.map((i) => i.field)).toContain('credit_limit');
  });

  it('a row corrected in the app (the cell replaced by a value) passes again', () => {
    const corrected = { cust_code: 'CCT0008', cust_name: 'Al Noor' };
    expect(checkCustomerRow(corrected, ctx()).issues).toEqual([]);
  });

  it('the "Before you promote" check says how many rows are held back for one', () => {
    const s = emptySummary();
    expect(summaryLines(s, false).some((l) => /Excel error/.test(l.text))).toBe(false);
    s.excelErrorRows = 2;
    const line = summaryLines(s, false).find((l) => /Excel error/.test(l.text));
    expect(line).toEqual({
      tone: 'warn',
      text: 'Excel errors: 2 row(s) are held back because a cell holds an Excel error (such as #N/A or #REF!) instead of a value. They are not loaded, matched or counted above; each row names the cell. The rest of the file loads.',
    });
  });
});
