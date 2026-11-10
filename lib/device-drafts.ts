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
 * Code review 2026-11-10, finding 5: a copy never expired, so a change left
 * unsent came back weeks later inside an unrelated edit; and the edit form wrote
 * one for every customer merely opened, so Sign out counted "unsent forms" that
 * held nothing. A copy is now kept for DEVICE_DRAFT_MAX_AGE_DAYS from the last
 * time its content changed, and the count is of copies that hold unsent work.
 *
 * Every storage call is guarded: a browser that refuses storage has nothing
 * stored, and must still be able to sign out.
 */
import { draftChangedPaths } from './enrichment-draft';

export const DEVICE_DRAFT_PREFIXES = ['nmwc:draft:', 'nmwc:create:'] as const;

/**
 * How long unsent work stays on the phone, counted from the last change to it
 * (`savedAt`) — opening the form again does not make a copy younger. Seven days
 * is what the salesman guide has always said (scripts/build-role-guides.ts:
 * "it stays on your phone for 7 days").
 */
export const DEVICE_DRAFT_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a copy saved at `savedAt` (the phone's clock, ms) is past its keep
 * time. A copy with no readable save time has an unknown age, and is kept: the
 * forms have always written one, so only a damaged copy lacks it.
 */
export function deviceDraftExpired(savedAt: unknown, now: number = Date.now()): boolean {
  return (
    typeof savedAt === 'number' &&
    Number.isFinite(savedAt) &&
    now - savedAt > DEVICE_DRAFT_MAX_AGE_DAYS * DAY_MS
  );
}

/**
 * A copy's age in words, by the phone's own clock: "just now", "5 minutes ago",
 * "2 hours ago", "3 days ago". Null when the save time is unknown.
 */
export function draftAgeText(savedAt: unknown, now: number = Date.now()): string | null {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  const seconds = Math.max(0, now - savedAt) / 1000;
  const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return ago(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return ago(Math.floor(seconds / 3600), 'hour');
  return ago(Math.floor(seconds / 86_400), 'day');
}

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

/**
 * Whether the copy under `key` holds unsent work. A copy that cannot be read or
 * judged counts: asking once too often before Sign out deletes it is the safe
 * side.
 */
function holdsUnsentWork(key: string): boolean {
  try {
    const d: unknown = JSON.parse(window.localStorage.getItem(key) ?? '');
    if (!d || typeof d !== 'object' || Array.isArray(d)) return true;
    const copy = d as Record<string, unknown>;
    if (deviceDraftExpired(copy.savedAt)) return false;
    if (key.startsWith('nmwc:draft:')) {
      // The edit form: what it changes from the values it started from. None
      // readable (no base) means nothing says it holds no change.
      const changed = draftChangedPaths(copy);
      return changed === null || changed.length > 0;
    }
    // The new-customer form writes a copy only for something typed or sent.
    return true;
  } catch {
    return true;
  }
}

/** How many form copies holding unsent work this user has in this browser. */
export function countDeviceDrafts(userId: string): number {
  return ownKeys(userId).filter(holdsUnsentWork).length;
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
 * Deletes this user's copies that are past their keep time; returns how many
 * went. Run when a form opens, after it has dealt with its own copy (which it
 * tells him about): names, phones and addresses of work abandoned on other
 * customers do not stay on the phone for good. Another user's are left alone.
 */
export function sweepExpiredDeviceDrafts(userId: string, now: number = Date.now()): number {
  let removed = 0;
  for (const k of ownKeys(userId)) {
    try {
      const d: unknown = JSON.parse(window.localStorage.getItem(k) ?? '');
      if (!d || typeof d !== 'object') continue;
      if (!deviceDraftExpired((d as { savedAt?: unknown }).savedAt, now)) continue;
      window.localStorage.removeItem(k);
      removed += 1;
    } catch {
      /* An unreadable copy has no age to judge: left for Sign out. */
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
