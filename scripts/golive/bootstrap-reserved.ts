/**
 * Which reserved sign-in names the go-live bootstrap would CREATE
 * (scripts/golive/bootstrap-accounts.ts). Pure, so it is tested without a
 * database (tests/unit/reserved-username-renames.test.ts).
 *
 * Code review 2026-11-10, finding 25. The second round refused the whole file
 * when it held any reserved name (lib/demo-accounts.ts), before connecting —
 * also a name whose account already exists, which the bootstrap has always
 * skipped ("exists as ..."). A re-run with an older file then created none of
 * the other Managers. Third round: an account that exists is skipped as before;
 * only a reserved name the run would newly create stops the run, before
 * anything is written.
 */
import { reservedUsernameRefusal } from '../../lib/demo-accounts';

type Named = { username?: unknown } | null | undefined;

/** The bootstrap's own normalisation of a username (bootstrap-accounts.ts make()). */
export const bootstrapUsername = (u: Named): string => String(u?.username ?? '').toLowerCase().trim();

/** Every reserved name in the file, as the file spells it. */
export function reservedInFile(cfg: { steward?: Named; managers?: Named[] }): string[] {
  return [cfg.steward, ...(cfg.managers ?? [])]
    .map((u) => String(u?.username ?? ''))
    .filter((name) => reservedUsernameRefusal(name));
}

/**
 * The reserved names this run would create: not an account already (any role,
 * active or not, as make() checks), and for the Steward only when no active
 * Steward exists (otherwise the Steward entry is skipped whole).
 */
export function reservedToCreate(
  cfg: { steward?: Named; managers?: Named[] },
  existingUsernames: ReadonlySet<string>,
  activeStewardExists: boolean
): string[] {
  const candidates = [...(activeStewardExists ? [] : [cfg.steward]), ...(cfg.managers ?? [])];
  return candidates
    .filter((u) => reservedUsernameRefusal(String(u?.username ?? '')))
    .filter((u) => !existingUsernames.has(bootstrapUsername(u)))
    .map((u) => String(u?.username ?? ''));
}
