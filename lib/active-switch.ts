/**
 * Code review 2026-11-10, finding 9: the Disable / Enable buttons on /users and
 * /routes said only WHICH record; the server flipped whatever it found. A second
 * click from a screen opened earlier (another Manager acting on the same leaver,
 * or the same admin again after a lost reply) switched a leaver's account back
 * on with its old password, while the banner, built from the stale screen,
 * said "Disabled".
 *
 * Now each click sends the state it WANTS (`active` = "true" | "false"); the
 * server sets exactly that, answers whether anything changed, and writes history
 * and audit rows only when it did. The banner is built from that answer.
 *
 * Pure, with no server imports: the services parse with it and the screens word
 * their banners with it.
 */

/** The form field every Disable / Enable button sends. */
export const ACTIVE_FIELD = 'active';

/** What the server answers a switch: the state now, and whether this click changed it. */
export type ActiveSwitchResult = { isActive: boolean; changed: boolean };

/**
 * The wanted state, or null when the form did not say (an old screen from before
 * this change, or a hand-made request) — the caller refuses then, never guesses.
 */
export function wantedActive(formData: FormData): boolean | null {
  const raw = formData.get(ACTIVE_FIELD);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/** The refusal when the wanted state is missing. */
export const ACTIVE_MISSING =
  'This button did not say whether to switch it on or off. Reload the page and try again.';

/**
 * The /users banner, from the server's answer. `username` is the account's.
 * Unchanged answers say so plainly, so a second click never reads as a change.
 */
export function userSwitchMessage(username: string, r: ActiveSwitchResult): string {
  if (r.changed) {
    return r.isActive
      ? `Enabled "${username}".`
      : `Disabled "${username}". It is on the Disabled tab, where Enable puts it back.`;
  }
  return r.isActive
    ? `"${username}" was already enabled. Nothing changed.`
    : `"${username}" was already disabled. Nothing changed. It is on the Disabled tab.`;
}

/** The /routes answer for a region or a route, from the server's answer. */
export function placeSwitchMessage(kind: 'region' | 'route', r: ActiveSwitchResult): string {
  const state = r.isActive ? 'enabled' : 'disabled';
  return r.changed
    ? `The ${kind} is now ${state}.`
    : `This ${kind} was already ${state}. Nothing changed.`;
}
