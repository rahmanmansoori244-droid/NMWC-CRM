/**
 * Keyset pagination for reads too large to hold or fetch in one query (benchmark
 * item 28: the customer master export and the field-update report).
 *
 * Each next page is fetched with a STRICT predicate on the key of the last row AS
 * IT WAS READ — never with Prisma's `cursor` + `skip: 1`. That pair re-reads the
 * cursor row's CURRENT values and then skips one row by position, so if the
 * boundary row was archived, re-scored or re-regioned between two pages, it
 * silently dropped the next row or jumped over thousands. With a value predicate,
 * a row that changes mid-read can at worst be missed or repeated itself; no other
 * row moves. (Found by the adversarial review of the first version.)
 *
 * `fetchPage(last)` gets undefined for the first page, then the last row of the
 * previous page, and must order by the same key it filters on.
 */
export async function* keysetPages<T>(
  fetchPage: (last: T | undefined) => Promise<T[]>,
  pageSize: number
): AsyncGenerator<T[]> {
  let last: T | undefined;
  for (;;) {
    const page = await fetchPage(last);
    if (page.length > 0) yield page;
    if (page.length < pageSize) return;
    last = page[page.length - 1];
  }
}
