// @vitest-environment node
/**
 * Launch fix (2026-10-08): in the production build, webpack's server runtime hands
 * lib/excel.ts's `await import('node:stream')` a namespace with ONLY `default`
 * (Node's Stream export is a function, and webpack copies named properties only
 * for object exports). The destructured PassThrough was undefined, so every
 * streamed export (/api/exports/customers and /api/exports/changes) answered 500
 * "Export failed". Plain Node, where these unit tests run, has the named export,
 * so nothing failed here. This test gives lib/excel.ts the bundled shape.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:stream', async () => {
  const actual = await vi.importActual<typeof import('node:stream')>('node:stream');
  // What the webpack runtime's fake namespace holds for a function export: the
  // module as `default`, and no named PassThrough (undefined, as in the bundle;
  // vitest would otherwise throw on reading a missing export).
  return { default: actual, PassThrough: undefined };
});

async function* rows() {
  yield { name: 'Al Noor Trading', phone: '+96898765432' };
}

describe('streamed workbook under the bundled node:stream shape', () => {
  it('still builds a workbook the parser reads back', async () => {
    const { buildWorkbookStreamed, parseWorkbook } = await import('@/lib/excel');
    const { bytes, rowCount } = await buildWorkbookStreamed(['name', 'phone'], rows(), 'Test');
    expect(rowCount).toBe(1);
    const [sheet] = await parseWorkbook(bytes);
    expect(sheet!.rows.map((r) => r.name)).toEqual(['Al Noor Trading']);
  });
});
