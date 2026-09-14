/**
 * One personal-data scrubber for every outbound text channel.
 *
 * The same two regexes were copied into `lib/logger.ts`, `sentry.server.config.ts`
 * and `sentry.client.config.ts`, while `sentry.edge.config.ts` had none and
 * `lib/heartbeat.ts` wrote cron error strings to the database and to the bearer
 * health payload with no scrubbing at all (B6, 2026-09-14). Copies drift; a
 * single tested function does not.
 *
 * Zero dependencies, so it is safe in the Edge runtime, in the browser bundle
 * and in Node.
 */

/** Omani mobile numbers in any written form, and any bare 8–12 digit run. */
export const PHONE_PATTERN = /\+?968\d{8}\b|\b\d{8,12}\b/g;
export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Replace phone numbers and e-mail addresses with placeholders.
 *
 * The digit-run pattern deliberately also catches commercial-registration
 * numbers and customer codes: in this dataset an 8–12 digit run is personal or
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
