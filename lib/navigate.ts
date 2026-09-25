/**
 * A full-document navigation that replaces the current history entry (item 22).
 *
 * After a field submit over fetch — not a server action — the router's cache
 * still holds the pages seen before it. A client navigation there, or Back
 * afterwards, showed the customer or Work list as it was before the submit
 * (a server action's revalidatePath cleared that cache; a route handler's does
 * not). A document load fetches the page fresh in one request and leaves no
 * stale cache behind; replacing the entry keeps Back from returning to the
 * filled form (UXI-005). Dynamic pages are no-store, so there is no bfcache.
 *
 * One module, so tests can observe it: jsdom cannot spy on location.replace.
 */
export function hardReplace(url: string): void {
  window.location.replace(url);
}
