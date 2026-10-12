/**
 * Gap 8 (data audit 2026-10-10, lossless paths): a customer merged away is not
 * gone. Its code still turns up — on a printout, an old export, a Temix record —
 * and searching for it, or opening its old page, must lead to the customer it
 * was merged into, not to "not found".
 *
 * Customer.mergedIntoId is set by the merge (services/duplicates.ts) and filled
 * for earlier merges from their MERGE audit rows (migration 20261014100000). A
 * survivor can itself be merged later, so the chain is followed, a few links at
 * most, to the live customer at its end.
 *
 * Scope is the caller's: these return ids and codes; the page decides whether
 * the viewer may see the survivor before naming it.
 */
import type { PrismaClient } from '@prisma/client';

type Reader = Pick<PrismaClient, 'customer'>;

/** Merges of merges followed at most (a longer chain is a data problem, not a lookup). */
export const MERGE_CHAIN_LIMIT = 10;

export type Survivor = { id: string; nmwcCode: string; legalName: string };

/**
 * The live customer a merged customer ended up in, or null: the customer is
 * live itself, was archived without a merge, or the chain ends in one that is.
 */
export async function survivorOf(client: Reader, customerId: string): Promise<Survivor | null> {
  let id = customerId;
  for (let step = 0; step <= MERGE_CHAIN_LIMIT; step += 1) {
    const c = await client.customer.findUnique({
      where: { id },
      select: { id: true, nmwcCode: true, legalName: true, deletedAt: true, mergedIntoId: true },
    });
    if (!c) return null;
    if (!c.deletedAt) return step === 0 ? null : { id: c.id, nmwcCode: c.nmwcCode, legalName: c.legalName };
    if (!c.mergedIntoId || c.mergedIntoId === c.id) return null;
    id = c.mergedIntoId;
  }
  return null;
}

export type MergedMatch = { id: string; code: string; survivor: Survivor };

/**
 * Customers merged away whose customer code or Temix code is exactly what was
 * searched for (any case), each with the live customer it ended up in. A search
 * term that is not a whole code matches nothing here: this is for "I have this
 * code", not a fuzzy search.
 */
export async function mergedCodeMatches(client: Reader, q: string, limit = 5): Promise<MergedMatch[]> {
  const term = q.trim();
  if (term.length < 2 || term.length > 64) return [];
  const merged = await client.customer.findMany({
    where: {
      mergedIntoId: { not: null },
      deletedAt: { not: null },
      OR: [
        { nmwcCode: { equals: term, mode: 'insensitive' } },
        { temixCode: { equals: term, mode: 'insensitive' } },
      ],
    },
    select: { id: true, nmwcCode: true },
    orderBy: { nmwcCode: 'asc' },
    take: limit,
  });
  const out: MergedMatch[] = [];
  for (const m of merged) {
    const survivor = await survivorOf(client, m.id);
    if (survivor) out.push({ id: m.id, code: m.nmwcCode, survivor });
  }
  return out;
}
