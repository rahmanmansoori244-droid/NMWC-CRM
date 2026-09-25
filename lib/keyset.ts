/**
 * Keyset pagination over branches, for reads too large to hold or to fetch in one
 * query (benchmark item 28: the customer master export and the field-update report).
 *
 * Each page starts AFTER the last branchCode of the previous one (branchCode is
 * unique), never at an offset: an offset query re-reads every earlier row, so a
 * deep page costs as much as the whole table. `fetchPage` must order by branchCode
 * last and apply `{ cursor: { branchCode }, skip: 1 }` when given a cursor.
 */
export async function* keysetPages<T extends { branchCode: string }>(
  fetchPage: (cursor: string | undefined) => Promise<T[]>,
  pageSize: number
): AsyncGenerator<T[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    if (page.length > 0) yield page;
    if (page.length < pageSize) return;
    cursor = page[page.length - 1]!.branchCode;
  }
}

/** The Prisma arguments for a page after `cursor` (nothing for the first page). */
export function afterCursor(
  cursor: string | undefined
): { cursor: { branchCode: string }; skip: number } | Record<never, never> {
  return cursor ? { cursor: { branchCode: cursor }, skip: 1 } : {};
}
