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
import type { Event, EventHint } from '@sentry/nextjs';
import { scrubString } from './scrub';

/**
 * Query-string keys whose VALUE is replaced wholesale rather than pattern-scrubbed.
 *
 * `^q$` is the customer search box. A salesman looking for a shop types its legal
 * name or its phone number there, and the term lands in the URL — which is the
 * single most personal string this application puts in a query string. Anchored as
 * its own alternation arm so it matches the parameter named exactly `q` and not
 * every key containing the letter.
 */
const SENSITIVE_PARAM = /phone|crNumber|email|password|token|secret|key|^q$/i;

/** Re-exported so the Sentry configs and their tests import a single name. */
export const scrub = scrubString;

/**
 * Redact sensitive values inside any string that happens to contain query pairs.
 *
 * `scrubUrl` only helps where a field is a parseable absolute URL. The strings
 * that actually leaked the search term are not: a navigation breadcrumb's
 * `data.to` is a bare path, a transaction name is `GET /customers`, and a span
 * description is free text. This runs over the raw string instead.
 */
const QUERY_PAIR = /([?&;]|^)([A-Za-z0-9_.%-]{1,40})=([^&#\s"']*)/g;

function scrubQueryPairs(s: string): string {
  return s.replace(QUERY_PAIR, (m, pre: string, key: string) =>
    SENSITIVE_PARAM.test(key) ? `${pre}${key}=[redacted]` : m
  );
}

/** Query-pair redaction followed by the pattern scrub. Use for any free text. */
const scrubText = (s: string): string => scrub(scrubQueryPairs(s));

function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.forEach((_v, k) => {
      if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, '[redacted]');
    });
    return scrub(u.toString());
  } catch {
    return scrubText(url);
  }
}

/**
 * Strip credentials and redact personal data from an event, in place.
 *
 * Generic, and that is the point of this revision. It was typed to `ErrorEvent`
 * and wired only to `beforeSend`, so it never saw a performance TRANSACTION —
 * Sentry routes those to `beforeSendTransaction`, which nothing set. With
 * `tracesSampleRate` at 0.1 that meant roughly one request in ten shipped its
 * full URL, `?q=<a customer's legal name or phone number>` included, to a
 * processor outside Oman with no redaction at all, in every runtime. Making it
 * generic lets the same function serve both hooks and keeps one place to reason
 * about.
 *
 * NOTE for anyone enabling streaming traces: `traceLifecycle: 'stream'` bypasses
 * `beforeSendTransaction` entirely, so span coverage must be re-verified before
 * that lands.
 */
export function scrubEvent<T extends Event>(event: T, _hint?: EventHint): T {
  if (event.request?.headers) {
    delete event.request.headers['authorization'];
    delete event.request.headers['cookie'];
  }
  if (event.request?.cookies) delete event.request.cookies;
  if (typeof event.request?.url === 'string') event.request.url = scrubUrl(event.request.url);
  if (typeof event.request?.data === 'string') event.request.data = scrubText(event.request.data);
  // Transaction events carry the route in `transaction` and the query string in
  // `request.query_string`, neither of which the error path ever populated.
  if (typeof event.transaction === 'string') event.transaction = scrubText(event.transaction);
  const qs = event.request?.query_string;
  if (typeof qs === 'string') {
    event.request!.query_string = scrubQueryPairs(qs);
  } else if (Array.isArray(qs)) {
    event.request!.query_string = qs.map(([k, v]) =>
      SENSITIVE_PARAM.test(k) ? [k, '[redacted]'] : [k, scrub(v)]
    ) as typeof qs;
  } else if (qs && typeof qs === 'object') {
    for (const [k, v] of Object.entries(qs)) {
      if (typeof v === 'string') {
        (qs as Record<string, string>)[k] = SENSITIVE_PARAM.test(k) ? '[redacted]' : scrub(v);
      }
    }
  }
  const traceData = event.contexts?.trace?.data as Record<string, unknown> | undefined;
  if (traceData) {
    for (const [k, v] of Object.entries(traceData)) {
      if (typeof v === 'string') traceData[k] = scrubText(v);
    }
  }
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) {
      const s = span as { description?: unknown; data?: Record<string, unknown> };
      if (typeof s.description === 'string') s.description = scrubText(s.description);
      if (s.data && typeof s.data === 'object') {
        for (const [k, v] of Object.entries(s.data)) {
          if (typeof v === 'string') s.data[k] = scrubText(v);
        }
      }
    }
  }
  if (event.exception?.values) {
    for (const v of event.exception.values) {
      if (typeof v.value === 'string') v.value = scrub(v.value);
    }
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (typeof b.message === 'string') b.message = scrubText(b.message);
      // scrubText, not scrub: a navigation breadcrumb's `data.to` is a bare path
      // and a fetch breadcrumb's `data.url` an absolute one, and both carry
      // `?q=<customer name>` on 100% of error events. The pattern scrub alone
      // never touched them, because a name is not a digit run.
      if (b.data && typeof b.data === 'object') {
        for (const [k, val] of Object.entries(b.data)) {
          if (typeof val === 'string') (b.data as Record<string, unknown>)[k] = scrubText(val);
        }
      }
    }
  }
  // An IP address is personal data and we have no use for it.
  if (event.user) delete event.user.ip_address;
  return event;
}
