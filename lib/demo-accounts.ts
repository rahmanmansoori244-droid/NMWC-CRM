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
