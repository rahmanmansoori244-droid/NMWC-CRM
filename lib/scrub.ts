/**
 * One personal-data scrubber for every outbound text channel.
 *
 * The same two regexes were copied into `lib/logger.ts`, `sentry.server.config.ts`
 * and `instrumentation-client.ts`, while `sentry.edge.config.ts` had none and
 * `lib/heartbeat.ts` wrote cron error strings to the database and to the bearer
 * health payload with no scrubbing at all (B6, 2026-09-14). Copies drift; a
 * single tested function does not.
 *
 * Zero dependencies, so it is safe in the Edge runtime, in the browser bundle
 * and in Node.
 */

/**
 * Omani telephone numbers, and any bare digit run long enough to identify.
 *
 * The previous pattern was `/\+?968\d{8}\b|\b\d{8,12}\b/` and the comment above
 * it claimed "in any written form". That was false, and the unit test happened
 * not to catch it: `+968 2444 5555` — the exact spaced form used by this repo's
 * own go-live fixture — survived untouched, as did the dashed form and
 * Arabic-Indic numerals, all three of which `lib/phone.ts` deliberately accepts
 * from users. Seven-digit commercial-registration numbers also survived, and the
 * repo's go-live fixtures use seven digits while the test used ten.
 *
 * F19 (2026-09-29): lib/phone.ts now also accepts Persian digits (U+06F0–U+06F9),
 * so every arm that covers Arabic-Indic digits covers them too, mixed or alone,
 * and the country code 968, with the 00 that may come before it, is matched
 * digit by digit in all three digit sets. The 00 was matched in ASCII only at
 * first: typed in Arabic-Indic or Persian digits before a 4+4 number, it let arm 5
 * start one digit inside it and take the second 0, the 968 and the first half, so
 * the last four digits went out as typed (review of phase 2, second pass).
 *
 * A phone form accepted there and not redacted here reaches Sentry and the logs
 * from free text (notes, messages, paths) — and some are not redacted: the
 * NOT-covered list below says which, and tests/unit/sentry-scrub.test.ts checks
 * each entry of it against lib/phone.ts. lib/phone.ts used to say that every form
 * it accepts is redacted here, and this list left several out (review of phase 2).
 *
 * What is covered now, arm by arm ("Arabic" below means either block; a
 * "separator" is a space, tab, non-breaking space, thin space U+2009, narrow
 * no-break space U+202F or dash, and in arm 1 a parenthesis too):
 *   1. the country-code form — 968, after an optional + or 00, each digit of the
 *      00 and the 968 in ASCII, Arabic-Indic or Persian, mixed or alone — with up
 *      to two separator characters between any pair of the eight digits — two
 *      rather than one so that `+968 (9123) 4567` is covered, where a space and a
 *      bracket sit together;
 *   2. a bare mobile (first digit 7 or 9) written 4+4 with one separator;
 *   3. a contiguous run of 7 to 12 ASCII digits (CR numbers included);
 *   4. a contiguous Arabic run of 7 or more;
 *   5. Arabic written 4+4 with one separator.
 * The non-ASCII characters are written as escapes: three kinds of space and two
 * blocks of look-alike digits cannot be reviewed as glyphs.
 *
 * What is NOT covered, stated rather than implied — the number in each of these
 * passes isValidPhoneFormat, and scrubString leaves it as it went in:
 *   - a number split across a line break, or by more than two separator
 *     characters between the same pair of digits;
 *   - a bare number (no country code) written other than contiguous or 4+4 with
 *     one separator: grouped 2-2-2-2, 3-3-2 or 4-2-2, two separators between the
 *     halves, the first half in brackets, or a separator between every digit;
 *   - a bare 4+4 number in ASCII digits whose first digit is not 7 or 9 — a
 *     landline such as `2444 5555`: arm 2 takes the mobile ranges only (arm 5 takes
 *     any Arabic 4+4), and widening it to landlines would redact more ordinary
 *     figures, which is the owner's call;
 *   - a bare number that mixes ASCII and Arabic digits, contiguous or 4+4 with one
 *     half in each: arm 3 takes ASCII only, arms 4 and 5 Arabic only, and arm 2's
 *     `\b` needs an ASCII digit at each end;
 *   - a bare ASCII number glued to a letter or an underscore (`tel91234567`,
 *     `id_9123 4567`): arms 2 and 3 open and close on `\b`, the boundary that keeps
 *     a digit run inside a longer word, such as a hex hash, from being redacted;
 *   - any other Unicode space as a separator (U+2000–U+2008, U+200A, U+205F,
 *     U+3000 and the rest): lib/phone.ts accepts every `\s`, and the classes here
 *     list their spaces one by one.
 * The separator classes are spelled out rather than using `\s` on purpose — `\s`
 * matches a newline, which would let the pattern weld digits from two unrelated
 * log lines into one "phone number".
 *
 * One regex literal, never `new RegExp(someString)`: a pattern assembled at
 * runtime is exactly the kind of change that looks safe in review and is not.
 */
export const PHONE_PATTERN =
  /(?:\+|[0\u0660\u06F0]{2})?[ \t\u00A0\u2009\u202F\-]?[9\u0669\u06F9][6\u0666\u06F6][8\u0668\u06F8](?:[ \t\u00A0\u2009\u202F()\-]{0,2}[0-9\u0660-\u0669\u06F0-\u06F9]){8}|\b[79][0-9\u0660-\u0669\u06F0-\u06F9]{3}[ \t\u00A0\u2009\u202F\-][0-9\u0660-\u0669\u06F0-\u06F9]{4}\b|\b\d{7,12}\b|[\u0660-\u0669\u06F0-\u06F9]{4}[ \t\u00A0\u2009\u202F\-][\u0660-\u0669\u06F0-\u06F9]{4}|[\u0660-\u0669\u06F0-\u06F9]{7,}/g;

/**
 * E-mail addresses. The pattern was `/[\w.+-]+@[\w-]+\.[\w.-]+/g`, which took
 * quadratic time on a long run of those characters with no address in it: it
 * tried a match from every position of the run, read to the end of the run
 * each time, and gave all of it back. A URL reaches here through the Sentry
 * scrubber (lib/sentry-scrub.ts) without signing in, and 14 KB of query string
 * cost about a second of CPU (adversarial pass after phase 2, finding 5).
 *
 * Now each run is matched once, with the domain optional, and kept as it is
 * unless the domain is there. The run is never given back, because the optional
 * part can always be empty. What is redacted is exactly what the old pattern
 * redacted: tests/unit/sentry-scrub.test.ts holds it to the old pattern on a
 * seeded random corpus.
 */
const EMAIL_SCAN = /[\w.+-]+(@[\w-]+\.[\w.-]+)?/g;

export function scrubEmails(s: string): string {
  return s.replace(EMAIL_SCAN, (run: string, domain: string | undefined) =>
    domain ? '[email]' : run
  );
}

/**
 * Replace phone numbers and e-mail addresses with placeholders.
 *
 * The digit-run pattern deliberately also catches commercial-registration
 * numbers and customer codes: in this dataset a 7–12 digit run is personal or
 * commercially identifying either way, and over-redacting a log line costs
 * nothing next to leaking a customer's phone number to a third-party service.
 */
/**
 * Identifiers this system mints itself, which must survive the digit-run rule.
 *
 * A UUID's first group is eight hex characters, and roughly one in 43 of them is
 * eight DECIMAL digits — so about 3.4% of photograph object keys contained a run
 * the phone pattern ate, turning `2026/09/15/<user>/SHOP/12345678-a8ae-…` into
 * `…/[phone]-a8ae-…`. That key is the only evidence in the `photo.finalize
 * .key_mismatch` warning, which records a signed-in user trying to finalize an
 * attachment against somebody else's presign prefix. Redacting a server-minted
 * identifier protects nobody and destroys the log line that matters.
 */
const SELF_MINTED = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bc[a-z0-9]{24}\b/gi;

/**
 * Whole-string test for an identifier this system minted itself.
 *
 * GAP-2 (2026-09-24): `lib/alert.ts` posts to an outgoing webhook, and the rule
 * most likely to be broken by whoever extends it is "no personal data on the
 * wire". Its identifier bag is therefore an ALLOWLIST built on the pattern
 * above — a value is forwarded only when the whole string is a cuid or a UUID —
 * so a legal name, an address, a phone number or a CR number cannot reach a
 * third party through a field called `ids`.
 *
 * `SELF_MINTED` carries the `g` flag, and a global regex remembers `lastIndex`
 * between calls: bare `SELF_MINTED.test(x)` alternates true and false on the
 * same input. Reset it on both sides rather than declaring a second copy of the
 * pattern — copies drifting is what this file exists to prevent.
 */
export function isSelfMintedId(s: string): boolean {
  SELF_MINTED.lastIndex = 0;
  const m = SELF_MINTED.exec(s);
  SELF_MINTED.lastIndex = 0;
  return m !== null && m.index === 0 && m[0].length === s.length;
}

export function scrubString(s: string): string {
  // Park self-minted ids behind a placeholder, scrub, then put them back. Simpler
  // and more obviously correct than trying to express "not inside a UUID" in the
  // phone pattern itself, which is already the most delicate regex in the tree.
  const parked: string[] = [];
  const masked = s.replace(SELF_MINTED, (m) => {
    parked.push(m);
    return ` ${parked.length - 1} `;
  });
  const scrubbed = scrubEmails(masked.replace(PHONE_PATTERN, '[phone]'));
  return scrubbed.replace(/ (\d+) /g, (_m, i: string) => parked[Number(i)] ?? '');
}

/**
 * Item 10 (re-benchmark, 2026-09-24): the `Reference:` an error screen shows is
 * Next's error digest — a hash of the error, usually a run of 7–10 digits, which
 * is exactly what PHONE_PATTERN redacts. Scrubbed, every reference in the logs
 * read "[phone]" and a reference a user quoted could never be found.
 *
 * So a value under the key `digest` is exempt: only at the top level of a log
 * line, only there, and only when it has a digest's shape. The key is the
 * control: `digest` is reserved for Next's `error.digest`, and
 * tests/unit/log-search.test.ts checks every logger call in app/, lib/,
 * services/, components/ and instrumentation.ts — a `digest` key, written out
 * or shorthand, must take its value from an error's `.digest`.
 *
 * An error Next raises itself shows the Reference as `<hash>@E<code>` in the
 * browser while the server knows it as `<hash>`. Both forms pass the shape;
 * digestHash() drops the suffix so both reports carry the same searchable value.
 */
export const DIGEST_KEY = 'digest';
const DIGEST_SHAPE = /^[0-9A-Za-z_-]{1,64}(@E\d{1,6})?$/;

export function isErrorDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_SHAPE.test(value);
}

/** The part of a Reference both the browser and the server know: before any `@E<code>`. */
export function digestHash(digest: string): string {
  const at = digest.indexOf('@');
  return at === -1 ? digest : digest.slice(0, at);
}

/** Scrub, then truncate — truncating first can cut a number in half and defeat the pattern. */
export function scrubAndTruncate(s: string, max: number): string {
  return scrubString(s).slice(0, max);
}
