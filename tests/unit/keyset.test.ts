// @vitest-environment node
/**
 * lib/keyset.ts pages the customer master export and the field-update report
 * (benchmark item 28). A wrong cursor loses or repeats rows silently; a wrong stop
 * loops for ever — so both edges are pinned here.
 */
import { describe, it, expect, vi } from 'vitest';
import { afterCursor, keysetPages } from '@/lib/keyset';

const rows = (codes: string[]) => codes.map((branchCode) => ({ branchCode }));

async function collect<T>(it: AsyncIterable<T[]>) {
  const pages: T[][] = [];
  for await (const p of it) pages.push(p);
  return pages;
}

describe('keysetPages', () => {
  it('starts with no cursor, then continues from the last code of each page', async () => {
    const data = ['A1', 'A2', 'B1', 'B2', 'C1'];
    const fetch = vi.fn(async (cursor: string | undefined) => {
      const from = cursor ? data.indexOf(cursor) + 1 : 0;
      return rows(data.slice(from, from + 2));
    });
    const pages = await collect(keysetPages(fetch, 2));
    expect(pages.flat().map((r) => r.branchCode)).toEqual(data);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([undefined, 'A2', 'B2']);
  });

  it('stops on a short page, and on an empty one when the total is a multiple of the page size', async () => {
    const data = ['A1', 'A2', 'B1', 'B2'];
    const fetch = vi.fn(async (cursor: string | undefined) => {
      const from = cursor ? data.indexOf(cursor) + 1 : 0;
      return rows(data.slice(from, from + 2));
    });
    const pages = await collect(keysetPages(fetch, 2));
    expect(pages.map((p) => p.length)).toEqual([2, 2]);
    // One extra, empty fetch proves there is nothing more; no empty page is yielded.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('yields nothing for an empty result', async () => {
    expect(await collect(keysetPages(async () => [], 2000))).toEqual([]);
  });
});

describe('afterCursor', () => {
  it('is nothing for the first page, and the row after the cursor for the next', () => {
    expect(afterCursor(undefined)).toEqual({});
    expect(afterCursor('A2')).toEqual({ cursor: { branchCode: 'A2' }, skip: 1 });
  });
});
