/**
 * The form copies kept in this browser's localStorage, per user (UXI-002): the
 * enrichment form's `nmwc:draft:<userId>:<customerId>` (EnrichmentForm) and the
 * new-customer form's `nmwc:create:<userId>:<editId|new>` (CreateCustomerForm).
 *
 * Launch review (a shared or lost phone): they hold customer names, phones,
 * contacts and addresses, and nothing removed them at Sign out. The next person
 * on that phone could read every one of them in the browser's storage. Sign out
 * now deletes the signing-out user's own copies (SignOutButton); another user's
 * are left alone, so a colleague's unsent work on a shared phone is not lost.
 *
 * Every storage call is guarded: a browser that refuses storage has nothing
 * stored, and must still be able to sign out.
 */
export const DEVICE_DRAFT_PREFIXES = ['nmwc:draft:', 'nmwc:create:'] as const;

function ownKeys(userId: string): string[] {
  if (!userId) return [];
  const mine = DEVICE_DRAFT_PREFIXES.map((p) => `${p}${userId}:`);
  const keys: string[] = [];
  try {
    const store = window.localStorage;
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k && mine.some((p) => k.startsWith(p))) keys.push(k);
    }
  } catch {
    return [];
  }
  return keys;
}

/** How many form copies this user has in this browser. */
export function countDeviceDrafts(userId: string): number {
  return ownKeys(userId).length;
}

/** Deletes this user's form copies from this browser; returns how many went. */
export function clearDeviceDrafts(userId: string): number {
  let removed = 0;
  for (const k of ownKeys(userId)) {
    try {
      window.localStorage.removeItem(k);
      removed += 1;
    } catch {
      /* Sign out goes ahead; see above. */
    }
  }
  return removed;
}

/**
 * Sign out is a round trip, and on a slow connection the form stays on screen
 * for seconds after the copies are deleted: an autosave already due, or a photo
 * or GPS fix landing in that time, wrote the copy straight back (launch review).
 * Sign out announces itself first; each form that keeps a copy listens, and from
 * then on writes nothing on that page. A page opened later starts afresh.
 */
const SIGNING_OUT = 'nmwc:signing-out';

/** Sign out is on its way: no form writes its copy from now on. */
export function announceSignOut(): void {
  window.dispatchEvent(new Event(SIGNING_OUT));
}

/** `stop` runs when Sign out is announced; returns the unsubscribe (an effect's cleanup). */
export function onSignOut(stop: () => void): () => void {
  window.addEventListener(SIGNING_OUT, stop);
  return () => window.removeEventListener(SIGNING_OUT, stop);
}
