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
import { digestHash, isErrorDigest, scrubString } from './scrub';

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
 * N07 / X-OPS-2 (auditor recheck, 2026-09-27): request headers are an ALLOWLIST.
 *
 * This removed `authorization` and `cookie` and sent every other header. Two of
 * the rest were personal data on every server error: `referer`, which carries the
 * page the request came from (`/customers?q=<a customer's name>` — the
 * Referrer-Policy sends the full URL to our own origin, and the browser SDK adds
 * `document.referrer` to client events), and Vercel's `x-vercel-ip-city`,
 * `-latitude`, `-longitude` and `-country`, the salesman's approximate location.
 * `x-vercel-oidc-token` went too. A denylist has to know every header that will
 * ever exist; this list only has to know what debugging uses. Compared without
 * case: the browser SDK writes `User-Agent`, Node writes `user-agent`.
 */
const KEPT_HEADERS = new Set([
  'user-agent',
  'accept',
  'content-type',
  'rsc',
  'next-action',
  'next-router-prefetch',
  'x-vercel-id',
]);

function keepAllowedHeaders(headers: Record<string, unknown>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && KEPT_HEADERS.has(name.toLowerCase())) kept[name] = scrubText(value);
  }
  return kept;
}

/**
 * The ids Sentry joins an event to its trace with. Random hex, so nothing personal,
 * and pattern-scrubbing one could break the join: the country-code arm of the phone
 * pattern has no word boundary, and `968` followed by eight decimal digits can occur
 * inside a 32-character hex id.
 */
const TRACE_IDS = new Set(['trace_id', 'span_id', 'parent_span_id']);
/** Sentry normalises an event to depth 3 before this runs; this is only a backstop. */
const MAX_DEPTH = 8;

/** Scrub every string under `value`, in place, whatever the nesting. */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (!value || typeof value !== 'object') return value;
  // Past the backstop the value is dropped rather than sent unread.
  if (depth >= MAX_DEPTH) return '[Object]';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], depth + 1);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (!TRACE_IDS.has(k)) obj[k] = scrubDeep(v, depth + 1);
  }
  return obj;
}

/**
 * N07: `captureRequestError` (instrumentation.ts → @sentry/nextjs) files the raw
 * request path as `contexts.nextjs.request_path`, query string and all — so a
 * failed render of `/customers?q=<name>` sent the name. The route template is what
 * the report needs and what instrumentation.ts already logs; it sits beside it as
 * `router_path`. Without one, the path loses its query and fragment.
 */
function templateNextjsPath(nextjs: Record<string, unknown>): void {
  if (!('request_path' in nextjs)) return;
  const route = nextjs.router_path;
  const path = nextjs.request_path;
  nextjs.request_path =
    typeof route === 'string' && route ? route : typeof path === 'string' ? path.split(/[?#]/)[0] : undefined;
}

/**
 * N07, found by the envelope test (2026-09-28): the root span's name travels a
 * second time, OUTSIDE the event, in the envelope header's `trace.transaction`.
 * The SDK builds that header after this hook returns, from the event's
 * `sdkProcessingMetadata.dynamicSamplingContext` — so scrubbing
 * `event.transaction` alone left a span named `/customers?q=<name>` readable in
 * the header of the very envelope whose body had been cleaned. (The SDK leaves the
 * name out when it knows it to be a raw URL, which is why the server's request
 * spans never showed it; a span named any other way does.) Replaced with a copy,
 * never edited in place: the object can be shared with the span it came from.
 */
function scrubSamplingContext(event: Event): void {
  const meta = event.sdkProcessingMetadata;
  const dsc = meta?.dynamicSamplingContext as Record<string, unknown> | undefined;
  if (!dsc || typeof dsc !== 'object' || typeof dsc.transaction !== 'string') return;
  event.sdkProcessingMetadata = {
    ...meta,
    dynamicSamplingContext: { ...dsc, transaction: scrubText(dsc.transaction) },
  };
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
export function scrubEvent<T extends Event>(event: T, hint?: EventHint): T {
  if (event.request?.headers && typeof event.request.headers === 'object') {
    event.request.headers = keepAllowedHeaders(event.request.headers);
  }
  if (event.request?.cookies) delete event.request.cookies;
  if (typeof event.request?.url === 'string') event.request.url = scrubUrl(event.request.url);
  if (typeof event.request?.data === 'string') event.request.data = scrubText(event.request.data);
  // Transaction events carry the route in `transaction` and the query string in
  // `request.query_string`, neither of which the error path ever populated.
  if (typeof event.transaction === 'string') event.transaction = scrubText(event.transaction);
  scrubSamplingContext(event);
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
  // N07: EVERY context, not only `trace.data`. `nextjs.request_path` carried the
  // search term on every server error, and any context the SDK or a later
  // `setContext` adds is covered without anyone remembering to list it.
  if (event.contexts && typeof event.contexts === 'object') {
    const nextjs = event.contexts.nextjs;
    if (nextjs && typeof nextjs === 'object') templateNextjsPath(nextjs as Record<string, unknown>);
    scrubDeep(event.contexts);
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
  tagDigest(event, hint);
  return event;
}

/**
 * Item 10 (re-benchmark, 2026-09-24: "no log search"): make the reference a user
 * reads off the error screen findable.
 *
 * Every error boundary shows `Reference: <digest>` (app/error.tsx,
 * app/(app)/error.tsx, app/global-error.tsx), and a user is told to quote it.
 * Nothing could look it up. The browser's report of the error and the server's
 * report of the throw that caused it both reach Sentry, but the digest was on
 * neither as anything searchable, and the server's copy is the only one with the
 * real message and stack: production sends the browser a redacted error. As a
 * tag, `digest:<reference>` in Sentry's search returns both.
 *
 * Set AFTER the scrub on purpose. A digest is usually a run of 7–12 digits, which
 * is exactly what the phone pattern redacts; scrubbing it would turn every
 * reference into "[phone]" and match nothing. It is a hash of the error, not
 * personal data, and the shape check keeps anything else out of the tag.
 */
function tagDigest(event: Event, hint?: EventHint): void {
  const digest = (hint?.originalException as { digest?: unknown } | null | undefined)?.digest;
  if (!isErrorDigest(digest)) return;
  // The hash only: the browser's `<hash>@E<code>` and the server's `<hash>` must
  // land on one tag, or the quoted Reference finds half the story.
  event.tags = { ...event.tags, digest: digestHash(digest) };
}
