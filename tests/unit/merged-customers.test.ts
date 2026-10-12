// @vitest-environment node
/**
 * Gap 8 (data audit 2026-10-10, lossless paths): a customer merged away leads to
 * the customer it was merged into (lib/merged-customers.ts), through merges of
 * merges, and to nobody when the chain ends in a customer archived without one.
 */
import { describe, expect, it } from 'vitest';
import { mergedCodeMatches, survivorOf, MERGE_CHAIN_LIMIT } from '@/lib/merged-customers';

type Row = { id: string; nmwcCode: string; legalName: string; temixCode?: string | null; deletedAt: Date | null; mergedIntoId: string | null };

function client(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    customer: {
      findUnique: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null,
      findMany: async ({ where }: { where: { OR: Array<{ nmwcCode?: { equals: string }; temixCode?: { equals: string } }> } }) => {
        const term = (where.OR[0]!.nmwcCode!.equals ?? '').toLowerCase();
        return rows
          .filter((r) => r.mergedIntoId && r.deletedAt)
          .filter((r) => r.nmwcCode.toLowerCase() === term || (r.temixCode ?? '').toLowerCase() === term)
          .map((r) => ({ id: r.id, nmwcCode: r.nmwcCode }));
      },
    },
  } as never;
}

const gone = new Date('2026-10-01T00:00:00Z');

describe('survivorOf', () => {
  it('a merged customer leads to its winner', async () => {
    const c = client([
      { id: 'L', nmwcCode: 'C1', legalName: 'Loser', deletedAt: gone, mergedIntoId: 'W' },
      { id: 'W', nmwcCode: 'C2', legalName: 'Winner', deletedAt: null, mergedIntoId: null },
    ]);
    expect(await survivorOf(c, 'L')).toEqual({ id: 'W', nmwcCode: 'C2', legalName: 'Winner' });
  });

  it('through a merge of the winner itself, to the live customer at the end', async () => {
    const c = client([
      { id: 'A', nmwcCode: 'C1', legalName: 'A', deletedAt: gone, mergedIntoId: 'B' },
      { id: 'B', nmwcCode: 'C2', legalName: 'B', deletedAt: gone, mergedIntoId: 'C' },
      { id: 'C', nmwcCode: 'C3', legalName: 'C', deletedAt: null, mergedIntoId: null },
    ]);
    expect((await survivorOf(c, 'A'))?.id).toBe('C');
  });

  it('a live customer, one archived without a merge, a missing one, or a loop: nobody', async () => {
    const c = client([
      { id: 'live', nmwcCode: 'C1', legalName: 'Live', deletedAt: null, mergedIntoId: null },
      { id: 'arch', nmwcCode: 'C2', legalName: 'Archived', deletedAt: gone, mergedIntoId: null },
      { id: 'x', nmwcCode: 'C3', legalName: 'X', deletedAt: gone, mergedIntoId: 'y' },
      { id: 'y', nmwcCode: 'C4', legalName: 'Y', deletedAt: gone, mergedIntoId: 'x' },
      { id: 'into-arch', nmwcCode: 'C5', legalName: 'Z', deletedAt: gone, mergedIntoId: 'arch' },
    ]);
    expect(await survivorOf(c, 'live')).toBeNull();
    expect(await survivorOf(c, 'arch')).toBeNull();
    expect(await survivorOf(c, 'nope')).toBeNull();
    expect(await survivorOf(c, 'x')).toBeNull();
    expect(await survivorOf(c, 'into-arch')).toBeNull();
    expect(MERGE_CHAIN_LIMIT).toBeGreaterThan(1);
  });
});

describe('mergedCodeMatches', () => {
  const c = client([
    { id: 'L', nmwcCode: 'C100', legalName: 'Loser', temixCode: 'T-9', deletedAt: gone, mergedIntoId: 'W' },
    { id: 'W', nmwcCode: 'C200', legalName: 'Winner', deletedAt: null, mergedIntoId: null },
  ]);

  it('the exact customer or Temix code of a merged customer, any case, names its survivor', async () => {
    expect(await mergedCodeMatches(c, ' c100 ')).toEqual([
      { id: 'L', code: 'C100', survivor: { id: 'W', nmwcCode: 'C200', legalName: 'Winner' } },
    ]);
    expect((await mergedCodeMatches(c, 't-9'))[0]?.survivor.id).toBe('W');
  });

  it('a search that is no whole code (too short, too long) asks nothing', async () => {
    expect(await mergedCodeMatches(c, 'C')).toEqual([]);
    expect(await mergedCodeMatches(c, 'x'.repeat(65))).toEqual([]);
  });
});
