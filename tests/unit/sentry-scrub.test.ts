/**
 * B6: the Sentry scrubber is a data-protection control, so it is tested rather
 * than asserted. Every runtime (server, client, Edge) shares this function —
 * `sentry.edge.config.ts` had no scrubbing at all until 2026-09-14, which is
 * exactly the kind of drift a single tested implementation prevents.
 */
import { describe, it, expect } from 'vitest';
import { scrub, scrubEvent } from '@/lib/sentry-scrub';
import type { ErrorEvent, Event as SentryEvent } from '@sentry/nextjs';

describe('scrub', () => {
  it('redacts Omani phone numbers in every written form', () => {
    expect(scrub('called +96891234567 twice')).toBe('called [phone] twice');
    expect(scrub('96891234567')).toBe('[phone]');
    expect(scrub('91234567')).toBe('[phone]');
  });

  it('redacts commercial-registration and customer-code style digit runs', () => {
    // A bare 8-12 digit run is indistinguishable from a phone; both are personal
    // data here, so the pattern deliberately catches CR numbers too.
    expect(scrub('CR 1234567890 on file')).toBe('CR [phone] on file');
  });

  it('redacts e-mail addresses', () => {
    expect(scrub('contact ali.said@example.com now')).toBe('contact [email] now');
  });

  it('leaves short numbers and ordinary text alone', () => {
    expect(scrub('route C4 visit 3 of 7')).toBe('route C4 visit 3 of 7');
  });
});

describe('scrubEvent', () => {
  const event = (): ErrorEvent =>
    ({
      request: {
        url: 'https://nmwc-cm.vercel.app/customers?phone=91234567&q=Al+Nahda&token=abc123',
        headers: { authorization: 'Bearer secret-token', cookie: 'session=abc', 'user-agent': 'x' },
        cookies: { session: 'abc' },
        data: 'primaryPhone=96891234567&contactPerson=Ali',
      },
      exception: {
        values: [{ type: 'Error', value: 'Unique constraint failed: primaryPhoneNorm=+96891234567' }],
      },
      breadcrumbs: [
        { message: 'submitted 91234567', data: { email: 'ali@example.com', route: 'C4' } },
      ],
      user: { id: 'u1', ip_address: '10.0.0.1' },
    }) as unknown as ErrorEvent;

  it('drops credentials entirely', () => {
    const e = scrubEvent(event());
    expect(e.request?.headers?.authorization).toBeUndefined();
    expect(e.request?.headers?.cookie).toBeUndefined();
    expect(e.request?.cookies).toBeUndefined();
    // a non-sensitive header survives, so debugging still works
    expect(e.request?.headers?.['user-agent']).toBe('x');
  });

  it('redacts sensitive query parameters wholesale and scrubs the rest of the URL', () => {
    const url = scrubEvent(event()).request!.url!;
    expect(url).toContain('phone=%5Bredacted%5D');
    expect(url).toContain('token=%5Bredacted%5D');
    expect(url).not.toContain('91234567');
    expect(url).not.toContain('abc123');
    // The path stays, or the report is useless.
    expect(url).toContain('/customers');
    // `q` USED to be asserted here as "a harmless search term". It is not: it is
    // the customer search box, where a salesman types a shop's legal name or its
    // phone number, and it is the single most personal string this application
    // puts in a URL. SEC-14d redacts it.
    expect(url).not.toContain('Al+Nahda');
    expect(url).toContain('q=%5Bredacted%5D');
  });

  it('scrubs the request body, the exception message and breadcrumbs', () => {
    const e = scrubEvent(event());
    expect(e.request?.data).not.toContain('96891234567');
    // the leading "+" is consumed by the pattern, so nothing of the number survives
    expect(e.exception?.values?.[0]?.value).toBe(
      'Unique constraint failed: primaryPhoneNorm=[phone]'
    );
    expect(e.breadcrumbs?.[0]?.message).toBe('submitted [phone]');
    expect(e.breadcrumbs?.[0]?.data?.email).toBe('[email]');
    expect(e.breadcrumbs?.[0]?.data?.route).toBe('C4');
  });

  it('drops the IP address but keeps the user id', () => {
    const e = scrubEvent(event());
    expect(e.user?.ip_address).toBeUndefined();
    expect(e.user?.id).toBe('u1');
  });

  it('survives a malformed URL and an event with nothing in it', () => {
    const bad = { request: { url: 'not a url 91234567' } } as unknown as ErrorEvent;
    expect(scrubEvent(bad).request?.url).toBe('not a url [phone]');
    expect(() => scrubEvent({} as ErrorEvent)).not.toThrow();
  });
});

/**
 * SEC-14d — the two halves the earlier control missed.
 *
 * (1) The pattern claimed Omani mobiles "in any written form" and matched almost
 *     none of them: the spaced form this repo's own go-live fixture uses, the
 *     dashed form, and Arabic-Indic numerals all survived, and lib/phone.ts
 *     proves the system deliberately accepts all three. Seven-digit CR numbers
 *     survived too, while the test above used ten.
 * (2) The scrubber ran on `beforeSend` only. Sentry routes performance
 *     transactions to `beforeSendTransaction`, which nothing set, so ~1 request
 *     in 10 shipped its full URL to a processor outside Oman unredacted.
 */
describe('the written forms a salesman actually types', () => {
  it.each([
    ['+968 2444 5555', 'spaced, the form used by this repo own go-live fixture'],
    ['+968\u00a02444\u00a05555', 'non-breaking spaces, what a paste from Word gives'],
    ['968-9123-4567', 'dashed'],
    ['+968 (9123) 4567', 'parenthesised'],
    ['\u0669\u0661\u0662\u0663\u0664\u0665\u0666\u0667', 'Arabic-Indic, contiguous'],
    ['\u0669\u0661\u0662\u0663 \u0664\u0665\u0666\u0667', 'Arabic-Indic, four plus four'],
  ])('redacts %s (%s)', (input) => {
    expect(scrub(input)).not.toMatch(/[0-9\u0660-\u0669]{4}/);
    expect(scrub(input)).toContain('[phone]');
  });

  it('redacts a seven-digit CR number, the length the go-live fixtures use', () => {
    // The old pattern started at eight, and the old test happened to use ten.
    expect(scrub('CR 1234567 on file')).toBe('CR [phone] on file');
  });

  it('still leaves ordinary text alone', () => {
    // The over-redaction guard. A pattern that eats these is worse than useless,
    // because it makes every report unreadable and someone turns it off.
    expect(scrub('route C4 visit 3 of 7')).toBe('route C4 visit 3 of 7');
    expect(scrub('total 9000 - 1000')).toBe('total 9000 - 1000');
    expect(scrub('2026-09-15T08:00:00Z')).toContain('2026');
    expect(scrub('lat 23.5880 lng 58.3829')).toContain('23.5880');
  });

  it.each([
    'R2 key 2026/09/15/usr_abc/SHOP/12345678-a8ae-47e3-9652-fad123456789.jpg',
    'key 2026/09/15/u1/CR/0f0e0d0c-1b2a-4c3d-8e9f-001122334455.png',
    'attachment cmf3x9k2a0000abcdefghijkl updated',
  ])('leaves an identifier this system minted itself intact: %s', (line) => {
    // About one UUID in 43 has an all-decimal first group, so roughly 3.4% of
    // photograph object keys carried an 8-digit run the phone pattern ate. That
    // key is the ONLY evidence in the photo.finalize.key_mismatch warning, which
    // records a signed-in user finalizing against somebody else's presign prefix.
    // Redacting a server-minted id protects nobody and destroys the log line.
    expect(scrub(line)).toBe(line);
  });

  it('still redacts a real number sitting beside an identifier', () => {
    // The guard must not become a hole: parking the UUID does not park the rest.
    expect(scrub('uuid 12345678-1234-1234-1234-123456789012 and phone 91234567')).toBe(
      'uuid 12345678-1234-1234-1234-123456789012 and phone [phone]'
    );
  });

  it.each([
    'Transaction already closed: 20000ms',
    'promoted 3308 of 3312 rows in 1842 ms',
    'P2028: transaction timed out after 5000',
    'connect ETIMEDOUT 10.0.0.1:5432',
    'batch cmf3x9k2a0000abcd finished, 20129 rows',
    'dump 505432 bytes, 6825 rows, 25 tables',
    'migration 20260914150000_audit_immutability applied',
    'sla escalate: 12 edits, 3 breached, took 4210ms',
    'HTTP 503 from https://nmwc-cm.vercel.app/api/health',
  ])('leaves the operator diagnostic %s intact', (line) => {
    // These matter more than a log line. lib/heartbeat.ts scrubs a failed cron
    // job's error with scrubAndTruncate BEFORE writing it to
    // CronHeartbeat.lastDetail, and the bearer health payload reads it back — so
    // that string is the ONLY diagnostic an operator gets for a job that failed
    // overnight. A pattern that reduces it to "[phone]" costs a recovery.
    expect(scrub(line)).toBe(line);
  });
});

describe('the search term in every carrier that leaks it', () => {
  it('redacts q in a navigation breadcrumb, which is a bare path', () => {
    // `scrubUrl` cannot help here: `data.to` is not a parseable absolute URL, and
    // a legal name is not a digit run, so the pattern scrub never touched it.
    const e = {
      breadcrumbs: [
        { category: 'navigation', data: { to: '/customers?q=Ali+Said+Al+Balushi&status=ACTIVE' } },
      ],
    } as unknown as ErrorEvent;
    const to = scrubEvent(e).breadcrumbs?.[0]?.data?.to as string;
    expect(to).not.toContain('Ali');
    // A non-sensitive parameter survives, or the breadcrumb stops being useful.
    expect(to).toContain('status=ACTIVE');
  });

  it('redacts q in a fetch breadcrumb URL', () => {
    const e = {
      breadcrumbs: [
        { category: 'fetch', data: { url: 'https://nmwc-cm.vercel.app/customers?q=Ali+Said&_rsc=x' } },
      ],
    } as unknown as ErrorEvent;
    const url = scrubEvent(e).breadcrumbs?.[0]?.data?.url as string;
    expect(url).not.toContain('Ali');
    expect(url).toContain('_rsc=x');
  });
});

describe('transaction events go through the same scrubber', () => {
  // ErrorEvent pins type to an error kind, so intersecting it with a transaction
  // type collapses to never. The base Event is the one that carries both.
  type TxEvent = SentryEvent & { type: 'transaction' };

  const tx = (): TxEvent =>
    ({
      type: 'transaction',
      transaction: 'GET /customers?q=Ali+Said&phone=91234567',
      request: { url: 'https://nmwc-cm.vercel.app/customers?q=Ali+Said', query_string: 'q=Ali+Said&status=ACTIVE' },
      contexts: { trace: { data: { 'http.query': 'q=Ali+Said', 'http.method': 'GET' } } },
      spans: [
        { description: 'GET /customers?q=Ali+Said', data: { 'db.statement': 'phone=91234567' } },
      ],
    }) as unknown as TxEvent;

  it('redacts the transaction name', () => {
    const t = scrubEvent(tx());
    expect(t.transaction).not.toContain('Ali');
    expect(t.transaction).not.toContain('91234567');
    // The route itself must survive — that is the whole value of the event.
    expect(t.transaction).toContain('/customers');
  });

  it('redacts the query string, the trace data and every span', () => {
    const t = scrubEvent(tx());
    expect(JSON.stringify(t)).not.toContain('Ali');
    expect(JSON.stringify(t)).not.toContain('91234567');
    expect(t.request?.query_string).toContain('status=ACTIVE');
    expect((t.contexts?.trace?.data as Record<string, unknown>)['http.method']).toBe('GET');
  });

  it('keeps the event type, so the generic signature really is generic', () => {
    const pin: 'transaction' = scrubEvent(tx()).type;
    expect(pin).toBe('transaction');
  });
});

/**
 * The alert webhook URL rides out on Sentry's own fetch instrumentation, not on
 * anything this code logs: every outgoing request becomes a span and a breadcrumb,
 * and Sentry's sanitiser strips the query but keeps the path — where Slack, Teams
 * and Discord keep the secret (adversarial review, 2026-09-24). The shapes below
 * are the ones @sentry/node's fetch integration and the OpenTelemetry HTTP
 * semantic conventions produce.
 */
describe('the alert webhook URL never reaches Sentry', () => {
  const HOOK = 'https://hooks.example.test/services/T0AB12CD/B0EF34GH/zzSecretTokenzz';
  const PATH = '/services/T0AB12CD/B0EF34GH/zzSecretTokenzz';
  const SECRET_PARTS = [HOOK, PATH, 'zzSecretTokenzz', 'B0EF34GH/zz'];

  const withHook = <T,>(url: string | undefined, fn: () => T): T => {
    const before = process.env.ALERT_WEBHOOK_URL;
    if (url === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = url;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.ALERT_WEBHOOK_URL;
      else process.env.ALERT_WEBHOOK_URL = before;
    }
  };

  const eventCarrying = (url: string, path: string) =>
    ({
      type: 'transaction',
      transaction: 'GET /api/cron/sla-escalate',
      contexts: { trace: { data: { 'url.full': url } } },
      spans: [
        {
          description: `POST ${url}`,
          data: { 'url.full': url, 'http.url': url, 'url.path': path, 'http.target': path, 'http.method': 'POST' },
        },
      ],
      breadcrumbs: [{ category: 'fetch', message: `POST ${url}`, data: { url, method: 'POST', status_code: 200 } }],
      exception: { values: [{ type: 'TypeError', value: `Failed to parse URL from ${url}` }] },
      request: { url, query_string: `note=${path}` },
    }) as unknown as SentryEvent;

  it('redacts the configured URL, its query-less form and its bare path, in every carrier', () => {
    const out = withHook(HOOK, () => JSON.stringify(scrubEvent(eventCarrying(HOOK, PATH))));
    for (const part of SECRET_PARTS) expect(out, `must not carry ${part}`).not.toContain(part);
    expect(out).toContain('[alert-webhook]');
    // What is NOT secret survives, or the event stops being useful.
    expect(out).toContain('/api/cron/sla-escalate');
    expect(out).toContain('POST');
  });

  it('catches the form Sentry actually records — the query stripped off', () => {
    // A bridge that authenticates in the query is covered by the query-pair rule;
    // this is the reverse: the configured URL HAS a query, the recorded one does not.
    const configured = `${HOOK}?thread=ops`;
    const out = withHook(configured, () => JSON.stringify(scrubEvent(eventCarrying(HOOK, PATH))));
    for (const part of SECRET_PARTS) expect(out, `must not carry ${part}`).not.toContain(part);
  });

  it('redacts a secret carried in the QUERY under a key the parameter list does not know', () => {
    // `token`, `key` and `secret` are caught by name; a bridge signing its URL with
    // `?sig=` is not, and the undici span records the query on its own as `url.query`.
    const signed = 'https://bridge.example.com/hook?sig=f00dfacecafebeef1234';
    const event = {
      type: 'transaction',
      spans: [{ description: 'POST', data: { 'url.query': '?sig=f00dfacecafebeef1234' } }],
    } as unknown as SentryEvent;
    const out = withHook(signed, () => JSON.stringify(scrubEvent(event)));
    expect(out).not.toContain('f00dfacecafebeef1234');
  });

  it('redacts a secret carried in the HOSTNAME, which the fetch span records on its own', () => {
    // A Pipedream-style trigger has no path and no query: the host IS the token,
    // and undici's span sets `server.address` to it (review, 2026-09-24).
    const hostToken = 'https://eo2abc3def4ghi5.m.pipedream.net';
    const event = {
      type: 'transaction',
      spans: [
        {
          description: 'POST',
          data: { 'server.address': 'eo2abc3def4ghi5.m.pipedream.net', 'url.full': `${hostToken}/` },
        },
      ],
    } as unknown as SentryEvent;
    const out = withHook(hostToken, () => JSON.stringify(scrubEvent(event)));
    expect(out).not.toContain('eo2abc3def4ghi5');
  });

  it('does not treat a SHORT path or query as the secret, or it would redact everything', () => {
    // `https://bridge.example.com/api?x` added `/api` and `x` as fragments, and every
    // event lost every `/api` and every letter x (review, 2026-09-24). The URL itself
    // is still redacted — here in the query-stripped form Sentry records, which with
    // a host AND a path this short only the origin+path fragment can catch.
    const short = 'https://b.io/api?x';
    const event = {
      transaction: 'GET /api/health',
      breadcrumbs: [{ message: 'fixed the xyz index', data: { url: 'https://b.io/api' } }],
    } as unknown as SentryEvent;
    const out = withHook(short, () => scrubEvent(event));
    expect(out.transaction).toBe('GET /api/health');
    expect(out.breadcrumbs![0]!.message).toBe('fixed the xyz index');
    expect(JSON.stringify(out)).not.toContain('b.io/api');
  });

  it('is a no-op when no webhook is configured — the client and the Edge', () => {
    const out = withHook(undefined, () =>
      JSON.stringify(scrubEvent(eventCarrying('https://nmwc-cm.vercel.app/api/health', '/api/health')))
    );
    expect(out).toContain('/api/health');
    expect(out).not.toContain('[alert-webhook]');
  });
});

// "Every runtime wires both hooks" lived here as a regex over the raw file, which a
// comment quoting `beforeSend: scrubEvent` satisfied. It is now
// tests/unit/sentry-scrub-guard.test.ts: comments stripped, the init call parsed,
// sendDefaultPii and a fourth init site checked too.

/**
 * N07 / X-OPS-2 (auditor recheck, 2026-09-27). The whole-envelope proof is
 * tests/unit/sentry-envelope.test.ts; these pin the rules one at a time.
 */
describe('request headers are an allowlist', () => {
  const withHeaders = (headers: Record<string, string>) =>
    scrubEvent({ request: { headers } } as unknown as ErrorEvent).request!.headers!;

  it('drops the Referer, Vercel geolocation, the OIDC token and anything unknown', () => {
    const out = withHeaders({
      referer: 'https://nmwc-cm.vercel.app/customers?q=Ali+Said',
      'x-vercel-ip-city': 'Muscat',
      'x-vercel-ip-latitude': '23.5880',
      'x-vercel-ip-longitude': '58.3829',
      'x-vercel-ip-country': 'OM',
      'x-vercel-oidc-token': 'eyJhbGciOi.jwt.value',
      'next-url': '/customers?q=Ali+Said',
      'x-some-header-added-next-year': 'anything',
      authorization: 'Bearer secret',
      cookie: 'session=abc',
    });
    expect(out).toEqual({});
  });

  it('keeps what debugging uses, whatever the case of the name', () => {
    const out = withHeaders({
      'User-Agent': 'Mozilla/5.0 (Android 14)',
      Accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      rsc: '1',
      'next-action': '7f3a9c0d1e2b',
      'next-router-prefetch': '1',
      'x-vercel-id': 'iad1::abcde-1695849871234-f00',
      Referer: 'https://nmwc-cm.vercel.app/customers?q=Ali',
    });
    expect(Object.keys(out).sort()).toEqual(
      ['Accept', 'User-Agent', 'content-type', 'next-action', 'next-router-prefetch', 'rsc', 'x-vercel-id'].sort()
    );
    expect(out['User-Agent']).toBe('Mozilla/5.0 (Android 14)');
  });
});

describe('every context is scrubbed, not only trace.data', () => {
  it('replaces the raw request path Next files under contexts.nextjs with the route template', () => {
    const e = scrubEvent({
      contexts: {
        nextjs: { request_path: '/customers?q=Ali+Said', router_path: '/customers', router_kind: 'App Router', route_type: 'render' },
      },
    } as unknown as ErrorEvent);
    expect(e.contexts?.nextjs).toEqual({ request_path: '/customers', router_path: '/customers', router_kind: 'App Router', route_type: 'render' });
  });

  it('without a route template, keeps the path and drops the query and fragment', () => {
    const e = scrubEvent({ contexts: { nextjs: { request_path: '/customers/abc?q=Ali#top' } } } as unknown as ErrorEvent);
    expect(e.contexts?.nextjs?.request_path).toBe('/customers/abc');
  });

  it('scrubs strings at any depth in any context, and leaves numbers and booleans alone', () => {
    const e = scrubEvent({
      contexts: {
        state: { lastSearch: '/customers?q=Ali+Said', nested: { list: ['call 91234567', 'ali@example.com'] }, count: 3, ok: true },
      },
    } as unknown as ErrorEvent);
    expect(e.contexts?.state).toEqual({
      lastSearch: '/customers?q=[redacted]',
      nested: { list: ['call [phone]', '[email]'] },
      count: 3,
      ok: true,
    });
  });

  it('never rewrites the trace ids Sentry joins events on', () => {
    // The country-code arm of the phone pattern has no word boundary, so `968`
    // plus eight digits inside a hex id would otherwise become "[phone]".
    const ids = { trace_id: 'ab96812345678cdef0123456789abcde', span_id: '9681234567812345', parent_span_id: 'f96812345678aaaa' };
    const e = scrubEvent({ contexts: { trace: { ...ids, data: { 'http.target': '/customers?q=Ali' } } } } as unknown as SentryEvent);
    expect(e.contexts?.trace).toMatchObject(ids);
    expect(e.contexts?.trace?.data?.['http.target']).toBe('/customers?q=[redacted]');
  });
});

describe('the sampling context the envelope header is built from', () => {
  it('has its transaction name scrubbed, its ids kept, and the shared original left alone', () => {
    const dsc = { trace_id: 'ab96812345678cdef0123456789abcde', public_key: 'k', transaction: 'lookup /customers?q=Ali+Said' };
    const e = scrubEvent({ sdkProcessingMetadata: { dynamicSamplingContext: dsc, other: 1 } } as unknown as SentryEvent);
    expect(e.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: { trace_id: 'ab96812345678cdef0123456789abcde', public_key: 'k', transaction: 'lookup /customers?q=[redacted]' },
      other: 1,
    });
    // The span that produced it may hand the same object to the next event.
    expect(dsc.transaction).toBe('lookup /customers?q=Ali+Said');
  });
});

describe('item 10: the Reference on the error screen is searchable in Sentry', () => {
  // Every error boundary shows `Reference: <digest>`. The server's report is the
  // only one with the real message; tagging both reports with the digest is what
  // lets a quoted reference find it.
  const withDigest = (digest: unknown) => Object.assign(new Error('boom'), { digest });

  it('tags the event with the digest of the error that caused it', () => {
    const out = scrubEvent({ exception: { values: [{ value: 'boom' }] } } as ErrorEvent, {
      originalException: withDigest('2847590223'),
    });
    expect(out.tags?.digest).toBe('2847590223');
  });

  it('is not scrubbed as a phone number, which a 7-12 digit digest otherwise would be', () => {
    expect(scrub('2847590223')).toBe('[phone]');
    const out = scrubEvent({} as ErrorEvent, { originalException: withDigest('2847590223') });
    expect(out.tags?.digest).toBe('2847590223');
  });

  it('an error Next raised itself is tagged by its hash, the part the server also knows', () => {
    // The browser shows `<hash>@E<code>`; the server's report has `<hash>`. One tag
    // value for both, so a quoted Reference finds the server's report too.
    const out = scrubEvent({} as ErrorEvent, { originalException: withDigest('2847590223@E394') });
    expect(out.tags?.digest).toBe('2847590223');
  });

  it('keeps the tags the event already had', () => {
    const out = scrubEvent({ tags: { runtime: 'node' } } as unknown as ErrorEvent, {
      originalException: withDigest('abc123'),
    });
    expect(out.tags).toEqual({ runtime: 'node', digest: 'abc123' });
  });

  it('tags nothing when there is no digest, or when it is not digest-shaped', () => {
    for (const hint of [undefined, {}, { originalException: new Error('x') }, { originalException: 'str' }]) {
      expect(scrubEvent({} as ErrorEvent, hint as never).tags?.digest).toBeUndefined();
    }
    // Anything that is not a short hash stays out of a tag, whatever it carries.
    for (const bad of ['ali.said@example.com', 'has space', 'x'.repeat(65), 42]) {
      expect(scrubEvent({} as ErrorEvent, { originalException: withDigest(bad) }).tags?.digest).toBeUndefined();
    }
  });
});
