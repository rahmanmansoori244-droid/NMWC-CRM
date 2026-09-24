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

/**
 * The alert webhook URL (lib/alert.ts) is a bearer credential — whoever holds it
 * can post into the owner's channel — and lib/alert.ts keeps it out of every log
 * line. Sentry does not: its fetch instrumentation records each outgoing request
 * as a span and a breadcrumb, and its sanitiser (@sentry/core
 * `getSanitizedUrlStringFromUrlObject`) removes the query string and fragment
 * but KEEPS THE PATH. For Slack, Teams and Discord the path is the whole of the
 * secret, and nothing below it — query-pair redaction, the digit-run pattern —
 * touches a path (adversarial review, 2026-09-24).
 *
 * So every string an event carries is checked for the configured URL, its
 * query-less form and its bare path (a span's `url.path` / `http.target` holds
 * only that). Exact matches of the one configured value: no pattern here has to
 * guess what a webhook looks like. Read on every call, because the scrubber is
 * module state shared by all runtimes and the variable exists only on the server;
 * on the client and the Edge it is absent and this is a no-op.
 */
const MIN_FRAGMENT = 12;

function webhookFragments(): string[] {
  const raw = (typeof process !== 'undefined' ? process.env?.ALERT_WEBHOOK_URL : undefined)?.trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  try {
    const u = new URL(raw);
    out.add(`${u.origin}${u.pathname}`);
    // The bare path and query only when they are long enough to BE a secret. A
    // one-character query or a path like `/api` would otherwise be replaced in every
    // string of every event — `GET /api/health` became `GET [alert-webhook]/health`
    // (review, 2026-09-24). Real webhook paths are 40–200 characters; the full URL
    // and its query-less form above are redacted whatever their length.
    if (u.pathname.length >= MIN_FRAGMENT) out.add(u.pathname);
    if (u.search.length > MIN_FRAGMENT) out.add(u.search.slice(1));
    // The hostname too. Some bridges put the whole credential there — a Pipedream
    // trigger is `https://<token>.m.pipedream.net/` with no auth of its own — and
    // the fetch span records it on its own as `server.address` (review,
    // 2026-09-24). Replacing a well-known host such as hooks.slack.com costs
    // nothing: it appears in an event only because of this very request.
    if (u.hostname.length >= MIN_FRAGMENT) out.add(u.hostname);
  } catch {
    // Unparseable: the raw string is all there is to look for.
  }
  // Longest first, so the whole URL is replaced before a piece of it is.
  return [...out].sort((a, b) => b.length - a.length);
}

function redactWebhook(s: string): string {
  let out = s;
  for (const f of webhookFragments()) {
    if (out.includes(f)) out = out.split(f).join('[alert-webhook]');
  }
  return out;
}

/** Webhook, then query-pair redaction, then the pattern scrub. Use for any free text. */
const scrubText = (s: string): string => scrub(scrubQueryPairs(redactWebhook(s)));

function scrubUrl(rawUrl: string): string {
  const url = redactWebhook(rawUrl);
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
    event.request!.query_string = scrubQueryPairs(redactWebhook(qs));
  } else if (Array.isArray(qs)) {
    event.request!.query_string = qs.map(([k, v]) =>
      SENSITIVE_PARAM.test(k) ? [k, '[redacted]'] : [k, scrub(redactWebhook(v))]
    ) as typeof qs;
  } else if (qs && typeof qs === 'object') {
    for (const [k, v] of Object.entries(qs)) {
      if (typeof v === 'string') {
        (qs as Record<string, string>)[k] = SENSITIVE_PARAM.test(k) ? '[redacted]' : scrub(redactWebhook(v));
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
      if (typeof v.value === 'string') v.value = scrub(redactWebhook(v.value));
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
