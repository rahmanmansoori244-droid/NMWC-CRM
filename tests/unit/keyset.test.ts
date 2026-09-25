// @vitest-environment node
/**
 * lib/keyset.ts pages the customer master export and the field-update report
 * (benchmark item 28). The first version used Prisma's cursor + skip:1, which the
 * adversarial review showed drops the NEXT row when the boundary row leaves the
 * filter, and jumps over whole stretches when it moves in the order. These tests
 * pin the value-keyset contract that replaced it, against a fake table whose rows
 * change between pages.
 */
import { describe, it, expect, vi } from 'vitest';
import { keysetPages } from '@/lib/keyset';

type Row = { region: string; code: string; live: boolean };
const key = (r: Row) => `${r.region}|${r.code}`;

/** A page query as the callers build it: live rows strictly after `last`'s key AS READ. */
function tableOf(rows: Row[], pageSize: number) {
  return vi.fn(async (last: Row | undefined) =>
    rows
      .filter((r) => r.live)
      .filter((r) => !last || r.region > last.region || (r.region === last.region && r.code > last.code))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .slice(0, pageSize)
      .map((r) => ({ ...r })) // a page is a snapshot, as a query result is
  );
}

async function readAll(fetch: (last: Row | undefined) => Promise<Row[]>, pageSize: number, between?: (page: number) => void) {
  const out: string[] = [];
  let n = 0;
  for await (const page of keysetPages(fetch, pageSize)) {
    out.push(...page.map((r) => r.code));
    between?.(++n);
  }
  return out;
}

const regionRows = (): Row[] => [
  { region: 'R1', code: 'A1', live: true },
  { region: 'R1', code: 'A2', live: true },
  { region: 'R1', code: 'A3', live: true },
  { region: 'R2', code: 'B1', live: true },
  { region: 'R2', code: 'B2', live: true },
  { region: 'R3', code: 'C1', live: true },
];

describe('keysetPages', () => {
  it('reads every row once, in order, handing each page the last row of the one before', async () => {
    const fetch = tableOf(regionRows(), 2);
    expect(await readAll(fetch, 2)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'C1']);
    expect(fetch.mock.calls.map((c) => c[0]?.code)).toEqual([undefined, 'A2', 'B1', 'C1']);
  });

  it('stops on a short page, and after one empty fetch when the total is a multiple of the page size', async () => {
    const rows = regionRows().slice(0, 4);
    const fetch = tableOf(rows, 2);
    const pages: Row[][] = [];
    for await (const p of keysetPages(fetch, 2)) pages.push(p);
    // Two full pages, and the empty fetch that proves the end is NOT handed on as a page.
    expect(pages.map((p) => p.map((r) => r.code))).toEqual([
      ['A1', 'A2'],
      ['A3', 'B1'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('yields no page at all for an empty result', async () => {
    const pages: Row[][] = [];
    for await (const p of keysetPages(tableOf([], 2000), 2000)) pages.push(p);
    expect(pages).toEqual([]);
  });

  it('a boundary row archived between pages costs only itself — the next row is still read', async () => {
    const rows = regionRows();
    // A2 ends page 1; it is archived before page 2 is read.
    const out = await readAll(tableOf(rows, 2), 2, (page) => {
      if (page === 1) rows.find((r) => r.code === 'A2')!.live = false;
    });
    expect(out).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'C1']);
  });

  it('a boundary row moved to a later region between pages does not skip the rows in between', async () => {
    const rows = regionRows();
    // A2 ends page 1; an import moves it to region R3 before page 2 is read.
    const out = await readAll(tableOf(rows, 2), 2, (page) => {
      if (page === 1) rows.find((r) => r.code === 'A2')!.region = 'R3';
    });
    // Every other row is still there; the moved row may appear again, never the others lost.
    for (const code of ['A1', 'A3', 'B1', 'B2', 'C1']) expect(out, code).toContain(code);
  });
});
