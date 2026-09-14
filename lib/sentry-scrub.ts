/**
 * B6 (enterprise assessment, 2026-09-14): one personal-data scrubber shared by
 * all three Sentry runtimes.
 *
 * The server and client configs each carried their own copy of this logic and
 * the EDGE config carried none at all — so anything thrown in `middleware.ts`
 * (which runs on the Edge runtime and sees every request URL and cookie) was
 * shipped to Sentry unredacted. Sentry is a processor outside Oman; the less
 * personal data reaches it, the smaller the transfer we have to justify in
 * `docs/compliance/DATA-RESIDENCY-REGISTER.md`.
 *
 * Keep the patterns in step with `lib/logger.ts` — they are deliberately the
 * same two: Omani mobile numbers (and any bare 8–12 digit run, which also
 * catches commercial-registration numbers and customer codes) and e-mail
 * addresses.
 */
import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { scrubString } from './scrub';

/** Query-string keys whose VALUE is replaced wholesale rather than pattern-scrubbed. */
const SENSITIVE_PARAM = /phone|crNumber|email|password|token|secret|key/i;

/** Re-exported so the Sentry configs and their tests import a single name. */
export const scrub = scrubString;

function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.forEach((_v, k) => {
      if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, '[redacted]');
    });
    return scrub(u.toString());
  } catch {
    return scrub(url);
  }
}

/**
 * Strip credentials and redact personal data from an event, in place.
 * Returns the event so it can be used directly as `beforeSend`.
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  if (event.request?.headers) {
    delete event.request.headers['authorization'];
    delete event.request.headers['cookie'];
  }
  if (event.request?.cookies) delete event.request.cookies;
  if (typeof event.request?.url === 'string') event.request.url = scrubUrl(event.request.url);
  if (typeof event.request?.data === 'string') event.request.data = scrub(event.request.data);
  if (event.exception?.values) {
    for (const v of event.exception.values) {
      if (typeof v.value === 'string') v.value = scrub(v.value);
    }
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (typeof b.message === 'string') b.message = scrub(b.message);
      if (b.data && typeof b.data === 'object') {
        for (const [k, val] of Object.entries(b.data)) {
          if (typeof val === 'string') (b.data as Record<string, unknown>)[k] = scrub(val);
        }
      }
    }
  }
  // An IP address is personal data and we have no use for it.
  if (event.user) delete event.user.ip_address;
  return event;
}
