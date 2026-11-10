/**
 * The seeded demo and synthetic accounts, refused at login once
 * DEMO_ACCOUNTS_DISABLED is set (QA-022). Kept here rather than inline in
 * lib/auth.ts so that the go-live account builder can be tested against the same
 * definition instead of a copy of it.
 *
 * It exists as its own module because of a near miss: the go-live builder issued
 * the first Data Steward as `steward`, which this list blocks — production sets
 * DEMO_ACCOUNTS_DISABLED, the account-master import is Steward-only, and a
 * Manager cannot reset a Steward. So on load day the operator would have created
 * the account, been told "Invalid username or password", and had no way forward
 * inside the application: the import refuses to mint a Steward, the bootstrap
 * refuses to mint a second one while the broken one is active, and the fallback
 * `admin` is on this same list. The only escape would have been a direct database
 * write, or switching the flag off — which re-enables the pilot accounts whose
 * passwords are literals in the seed.
 *
 * Do NOT relax these patterns to make a real account work. Rename the account.
 * `steward` and `viewer` are anchored at both ends precisely so that a real
 * username like `data.steward` is unaffected.
 */

/** Usernames belonging to the seeded demo and synthetic users. */
export const DEMO_USERNAME_PATTERN = /^(salesman\.|supervisor\.|manager\.[ab]$|steward$|viewer$)/;

/** The seeded administrator, which is not covered by the pattern above. */
export const DEMO_EXACT = ['admin'];

export function isDemoAccount(username: string): boolean {
  return DEMO_USERNAME_PATTERN.test(username) || DEMO_EXACT.includes(username);
}

/**
 * Code review 2026-11-10, finding 25: the ONE check that refuses a reserved
 * username when an account is CREATED — on /users (services/users.ts
 * createUserCore) and in the account import (services/imports.ts). Before it,
 * nothing stopped a Manager or the Steward creating `supervisor.salalah` or
 * `viewer`; the account was created without complaint and then, in production
 * (DEMO_ACCOUNTS_DISABLED), every sign-in said "Invalid username or password".
 *
 * Refused whatever DEMO_ACCOUNTS_DISABLED says: a name that cannot sign in in
 * production must not be created anywhere, or it is created in UAT and carried
 * over. Accounts that already hold such a name are not touched.
 */
export const RESERVED_USERNAME_MESSAGE =
  'This username is reserved and could never sign in. Names starting "salesman." or "supervisor.", and the names manager.a, manager.b, admin, steward and viewer, belong to the old demo accounts. Choose another username.';

/** The refusal for a reserved username, or null when the name may be used. */
export function reservedUsernameRefusal(username: string): string | null {
  return isDemoAccount(username.trim().toLowerCase()) ? RESERVED_USERNAME_MESSAGE : null;
}
