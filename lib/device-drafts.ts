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
