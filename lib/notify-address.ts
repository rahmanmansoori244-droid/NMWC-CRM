/**
 * F1 (2026-10-05): the ONE rule for "is this stored e-mail an address the
 * notification e-mail can be sent to". The e-mail drain sends only to a value
 * that passes it (lib/email/eligibility.ts, SKIPPED_NO_ADDRESS otherwise), so
 * everything that tells the Steward about an address uses it too: the /users
 * badge and scripts/ops/notify-readiness.ts.
 *
 * It lives outside lib/email because nothing but the drain route may import
 * lib/email (tests/unit/email-structure-guard.test.ts); lib/email/config.ts
 * re-exports it. Before the fixer review (2026-10-05) /users showed "E-mail on
 * file" for any non-empty value, while the account import stores the cell after
 * a trim and nothing else: an "n/a" or "name@company" read as on file and was
 * never sent to, and nothing on screen said why.
 */

/** One @, a dot after it, no spaces, nothing that could end a header line. */
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length <= 254 && ADDRESS.test(value);
}

/** What a stored User.email is to the drain: trimmed, then the rule above. */
export type StoredAddressState = 'usable' | 'unusable' | 'none';

export function storedAddressState(stored: string | null | undefined): StoredAddressState {
  const v = (stored ?? '').trim();
  if (v === '') return 'none';
  return isEmailAddress(v) ? 'usable' : 'unusable';
}
