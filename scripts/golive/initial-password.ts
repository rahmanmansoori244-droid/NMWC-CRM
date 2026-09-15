/**
 * SEC-11 — per-account initial passwords for the go-live account load.
 *
 * The gap this closes is ATTRIBUTION, not brute force. Usernames are route codes and
 * names printed on the journey plan, so they are effectively public. When every account
 * is created with the SAME initial secret, anyone who hears it can sign in as a colleague
 * who has not signed in yet, set a password of their own, and from then on every edit,
 * approval and audit row carries that colleague's name. In a system whose value is an
 * append-only audit trail and an approval chain, that is the one failure that cannot be
 * repaired afterwards — and the login rate limit does not help, because the attacker is
 * not guessing, they were told.
 *
 * Shape: 8 digits, no leading zero, never two alike within one build, obvious runs
 * redrawn. Why:
 *   - digits only: the value is read off paper and typed on a phone by people who do not
 *     all read English — no case, no symbols, no keyboard switching.
 *   - 8 long: far out of reach of a login limited to 5 attempts per minute per username
 *     AND per IP, still short enough to read out once and type. It is effectively
 *     single-use: every row the builder writes carries must_change_password=yes, so the
 *     account is pinned to /profile/change-password until the person chooses a 12+
 *     character password of their own (passwordRule, services/users.ts).
 *   - no leading zero: spreadsheets, handwriting and phone keypads all lose it.
 *   - no env override: an override is exactly how "one shared value for everyone" comes
 *     back, and it comes back invisibly — as a setting in somebody's shell rather than a
 *     line in a diff.
 *
 * What this does NOT solve is getting each secret to its own person; see step 8 of
 * docs/GO-LIVE-RUNBOOK.md. No side effects, no I/O beyond the CSPRNG.
 */
import { randomInt } from 'node:crypto';

/** Injectable so the redraw paths are testable; production uses the CSPRNG. */
export type RandomInt = (minInclusive: number, maxExclusive: number) => number;

export const DIGITS = 8;
/** Smallest 8-digit number, so a drawn value can never carry a leading zero. */
const MIN = 10_000_000;
const MAX = 100_000_000; // exclusive
const MAX_ATTEMPTS = 1000;

const cryptoRandomInt: RandomInt = (min, max) => randomInt(min, max);

/**
 * Patterns a person reads as "not a real password" and therefore repeats, writes on a
 * wall, or assumes was a placeholder. Excluding them is free: the rejected set is a
 * vanishing fraction of the 90 million candidates.
 */
export function isWeakSecret(value: string): boolean {
  if (/^(\d)\1+$/.test(value)) return true; // 88888888
  if (/^(\d{2})\1\1\1$/.test(value)) return true; // 12121212
  if (/^(\d{4})\1$/.test(value)) return true; // 43214321
  if (value.includes('12345')) return true; // the value this replaces
  let ascending = true;
  let descending = true;
  for (let i = 1; i < value.length; i++) {
    const step = Number(value[i]) - Number(value[i - 1]);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }
  return ascending || descending; // 12345678 / 87654321
}

/**
 * Returns an issuer that hands out a fresh initial password per call and never repeats
 * one it has already issued. ONE issuer per build run — the whole point is that no two
 * accounts in the same load share a secret, so the call sites must not each make their
 * own. Throws rather than repeating if the random source is stuck.
 */
export function makeInitialPasswordIssuer(rng: RandomInt = cryptoRandomInt): () => string {
  const issued = new Set<string>();
  return () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const value = String(rng(MIN, MAX));
      if (value.length !== DIGITS) continue;
      if (isWeakSecret(value)) continue;
      if (issued.has(value)) continue;
      issued.add(value);
      return value;
    }
    throw new Error(
      `could not draw a distinct initial password in ${MAX_ATTEMPTS} attempts — is the random source stuck?`
    );
  };
}
