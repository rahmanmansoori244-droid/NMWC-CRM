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
 * What is covered now, arm by arm:
 *   1. the country-code form, with up to two space, tab, non-breaking space, dash
 *      or parenthesis characters between any pair of the eight digits — two
 *      rather than one so that `+968 (9123) 4567` is covered, where a space and
 *      a bracket sit together;
 *   2. a bare mobile written 4+4 with one separator;
 *   3. a contiguous run of 7 to 12 ASCII digits (CR numbers included);
 *   4. a contiguous Arabic-Indic run of 7 or more;
 *   5. Arabic-Indic written 4+4 with one separator.
 *
 * What is NOT covered, stated rather than implied: a number split across a line
 * break, or by more than two separator characters between the same pair of digits.
 * The separator classes are spelled out rather than using `\s` on purpose — `\s`
 * matches a newline, which would let the pattern weld digits from two unrelated
 * log lines into one "phone number".
 *
 * One regex literal, never `new RegExp(someString)`: a pattern assembled at
 * runtime is exactly the kind of change that looks safe in review and is not.
 */
export const PHONE_PATTERN =
  /(?:\+|00)?[ \t \-]?968(?:[ \t ()\-]{0,2}[0-9٠-٩]){8}|\b[79][0-9٠-٩]{3}[ \t \-][0-9٠-٩]{4}\b|\b\d{7,12}\b|[٠-٩]{4}[ \t \-][٠-٩]{4}|[٠-٩]{7,}/g;
export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Replace phone numbers and e-mail addresses with placeholders.
 *
 * The digit-run pattern deliberately also catches commercial-registration
 * numbers and customer codes: in this dataset a 7–12 digit run is personal or
 * commercially identifying either way, and over-redacting a log line costs
 * nothing next to leaking a customer's phone number to a third-party service.
 */
export function scrubString(s: string): string {
  return s.replace(PHONE_PATTERN, '[phone]').replace(EMAIL_PATTERN, '[email]');
}

/** Scrub, then truncate — truncating first can cut a number in half and defeat the pattern. */
export function scrubAndTruncate(s: string, max: number): string {
  return scrubString(s).slice(0, max);
}
