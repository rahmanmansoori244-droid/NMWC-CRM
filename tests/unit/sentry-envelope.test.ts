// @vitest-environment node
/**
 * N07 / X-OPS-2 (auditor recheck, 2026-09-27): what actually LEAVES the process.
 *
 * Every earlier scrubber test handed `scrubEvent` an object the test had built
 * itself, and asserted on the fields the test knew about. That is how
 * `contexts.nextjs.request_path` — `/customers?q=<a customer's name>`, put there
 * by `captureRequestError` from the raw request Next passes to
 * `instrumentation.ts` — shipped to Sentry for months: no hand-built event had a
 * `nextjs` context, so nothing looked. The same went for the request headers,
 * where only `authorization` and `cookie` were removed: `referer` carried the
 * search page's full URL, and Vercel's `x-vercel-ip-city`/`-latitude`/`-longitude`
 * headers carried the salesman's approximate location.
 *
 * So this file runs the REAL SDK — `@sentry/nextjs`'s own server `init`, the
 * same `captureRequestError` instrumentation.ts calls, a real span tree — with
 * the app's `scrubEvent` on both hooks and an in-memory transport, and then
 * searches the WHOLE serialized envelope for the planted values. Not named
 * fields: anything the SDK adds next year is searched too.
 *
 * The browser half is tests/unit/sentry-envelope-browser.test.ts (jsdom).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/nextjs';
import { SpanKind, trace } from '@opentelemetry/api';
import { scrubEvent, scrubSpan } from '@/lib/sentry-scrub';
import { serverIntegrations } from '@/lib/sentry-server-integrations';

/**
 * Planted values. Letters only, so no transport encoding (percent, plus, JSON
 * escaping) can disguise one: if the text is in the envelope, `includes` finds it.
 */
const PLANTED = {
  requestPath: 'ZQXPATHSEARCHNAME',
  referer: 'ZQXREFERERNAME',
  nextUrl: 'ZQXNEXTURLNAME',
  city: 'ZQXVERCELCITY',
  latitude: 'ZQXVERCELLAT',
  longitude: 'ZQXVERCELLNG',
  country: 'ZQXVERCELCOUNTRY',
  region: 'ZQXVERCELREGION',
  oidc: 'ZQXOIDCTOKEN',
  cookie: 'ZQXCOOKIEVALUE',
  bearer: 'ZQXBEARERVALUE',
  forwarded: 'ZQXFORWARDEDFOR',
  realIp: 'ZQXREALIP',
  txName: 'ZQXTXNAME',
  target: 'ZQXHTTPTARGET',
  urlFull: 'ZQXURLFULL',
  childName: 'ZQXCHILDSPAN',
  childQuery: 'ZQXCHILDQUERY',
  context: 'ZQXCUSTOMCONTEXT',
  customSpan: 'ZQXCUSTOMSPAN',
  postedPassword: 'ZQXPOSTEDPASSWORD',
  scopedPassword: 'ZQXSCOPEDPASSWORD',
  consoleObject: 'ZQXCONSOLEOBJECT',
  crumbNested: 'ZQXCRUMBNESTED',
  extra: 'ZQXEXTRAVALUE',
  spanArray: 'ZQXSPANARRAY',
} as const;

/**
 * Personal data the scrubber has to RECOGNISE, which the letters above are built
 * not to be: a phone number and an e-mail address, the way a Prisma
 * unique-constraint message quotes them. Only the digits of the number are
 * searched for, so no separator the scrubber leaves behind can hide a leak.
 */
const PERSONAL = {
  phone: '+96897531864',
  phoneDigits: '97531864',
  email: 'zqx.console@example.test',
} as const;

const envelopes: string[] = [];
const decoder = new TextDecoder();

beforeAll(() => {
  // The options the three runtime configs pass, minus the DSN's real value and
  // plus a transport that keeps the envelope instead of sending it. The guard in
  // tests/unit/sentry-scrub-guard.test.ts pins that the real configs wire exactly
  // these functions to exactly these hooks.
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    tracesSampleRate: 1,
    // The very function sentry.server.config.ts passes (pinned by the guard).
    integrations: serverIntegrations(),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    // Post-merge review (2026-09-29): runs on every span of a transaction before
    // the transaction hook, so the cases below also prove it breaks nothing there.
    beforeSendSpan: scrubSpan,
    transport: (options: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(options, async (request) => {
        envelopes.push(typeof request.body === 'string' ? request.body : decoder.decode(request.body));
        return { statusCode: 200 };
      }),
  });
});

afterAll(async () => {
  await Sentry.close(2000);
});

beforeEach(() => {
  envelopes.length = 0;
});

/**
 * Every envelope item's PAYLOAD, as parsed JSON, so an assertion can also look at
 * structure. An envelope is one header line, then an item header line and a
 * payload line per item; the leak search below reads all of them, headers included.
 */
function items(): Array<Record<string, unknown>> {
  return envelopes.flatMap((e) => {
    const lines = e.split('\n').filter((l) => l.length > 0);
    const payloads: Array<Record<string, unknown>> = [];
    for (let i = 2; i < lines.length; i += 2) payloads.push(JSON.parse(lines[i]!) as Record<string, unknown>);
    return payloads;
  });
}

function leaked(): string[] {
  const all = envelopes.join('\n');
  return Object.entries({ ...PLANTED, phone: PERSONAL.phoneDigits, email: PERSONAL.email })
    .filter(([, v]) => all.includes(v))
    .map(([k]) => k);
}

describe('an error Next reports through onRequestError', () => {
  it('reaches the transport with no search term, no location and no credential in it', async () => {
    Sentry.captureRequestError(
      new Error('render failed'),
      {
        path: `/customers?q=${PLANTED.requestPath}&status=ACTIVE&_rsc=1x2y`,
        method: 'GET',
        headers: {
          // Same-origin navigation and server-action requests carry the page they
          // came from; Referrer-Policy strict-origin-when-cross-origin sends the
          // whole URL to our own origin.
          referer: `https://nmwc-cm.vercel.app/customers?q=${PLANTED.referer}`,
          'next-url': `/customers?q=${PLANTED.nextUrl}`,
          'x-vercel-ip-city': PLANTED.city,
          'x-vercel-ip-latitude': PLANTED.latitude,
          'x-vercel-ip-longitude': PLANTED.longitude,
          'x-vercel-ip-country': PLANTED.country,
          'x-vercel-ip-country-region': PLANTED.region,
          'x-vercel-oidc-token': PLANTED.oidc,
          'x-forwarded-for': PLANTED.forwarded,
          'x-real-ip': PLANTED.realIp,
          cookie: `authjs.session-token=${PLANTED.cookie}`,
          authorization: `Bearer ${PLANTED.bearer}`,
          'user-agent': 'Mozilla/5.0 (Linux; Android 14) envelope-test',
          accept: 'text/x-component',
          'x-vercel-id': 'iad1::abcde-envelope-test',
        },
      },
      // The fields Sentry's own type declares; Next passes more, which the SDK ignores.
      { routerKind: 'App Router', routePath: '/customers', routeType: 'render' }
    );
    await Sentry.flush(3000);

    const events = items().filter((i) => (i as { exception?: unknown }).exception);
    // Not vacuous: the event really went through the pipeline and out.
    expect(events).toHaveLength(1);
    expect(leaked()).toEqual([]);

    const event = events[0] as {
      contexts?: { nextjs?: Record<string, unknown> };
      request?: { headers?: Record<string, string> };
      transaction?: string;
    };
    // What survives is what debugging needs: the route, never the path.
    expect(event.contexts?.nextjs?.request_path).toBe('/customers');
    expect(event.contexts?.nextjs?.router_path).toBe('/customers');
    expect(event.transaction).toBe('GET /customers');
    expect(event.request?.headers?.['user-agent']).toContain('envelope-test');
    expect(event.request?.headers?.['x-vercel-id']).toBe('iad1::abcde-envelope-test');
  });
});

describe('a performance transaction', () => {
  it('reaches the transport with no search term in its name, its trace data, its spans or its contexts', async () => {
    // Spans made the way Next makes them: through the OpenTelemetry API, which
    // Sentry's provider exports. Next names the request span `GET <req.url>` and
    // renames it to the route only once it has resolved one, so the unrenamed
    // shape — query string and all — is the one to prove.
    const tracer = trace.getTracer('next.js', '0.0.1');
    Sentry.withScope((scope) => {
      scope.setContext('lastSearch', { href: `/customers?q=${PLANTED.context}`, nested: { again: `?q=${PLANTED.context}` } });
      tracer.startActiveSpan(
        `GET /customers?q=${PLANTED.txName}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.method': 'GET',
            'http.target': `/customers?q=${PLANTED.target}`,
            'next.span_type': 'BaseServer.handleRequest',
          },
        },
        (span) => {
          tracer.startActiveSpan(
            `fetch GET https://api.example.test/lookup?q=${PLANTED.childName}`,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                'http.method': 'GET',
                'http.url': `https://api.example.test/lookup?q=${PLANTED.urlFull}`,
                'url.query': `?q=${PLANTED.childQuery}`,
              },
            },
            (child) => child.end()
          );
          span.end();
        }
      );
    });
    await Sentry.flush(3000);

    const transactions = items().filter((i) => i.type === 'transaction');
    expect(transactions).toHaveLength(1);
    expect(leaked()).toEqual([]);
    // Not vacuous: the child span and the custom context are in the envelope,
    // only their search terms are not.
    const tx = transactions[0] as { spans?: Array<{ data?: Record<string, unknown> }>; contexts?: Record<string, unknown> };
    expect(tx.spans?.[0]?.data?.['http.url']).toBe('https://api.example.test/lookup?q=[redacted]');
    expect(tx.contexts?.lastSearch).toEqual({ href: '/customers?q=[redacted]', nested: { again: '?q=[redacted]' } });
  });
});

describe('a span named by hand', () => {
  it('leaves its name out of the envelope HEADER as well as the body, for the error and the transaction', async () => {
    // The request spans above are named from a URL, and the SDK keeps a URL-named
    // span out of the envelope header's sampling context by itself. A span named
    // any other way goes into that header as `trace.transaction` — after
    // beforeSend has run, from the event's processing metadata. Before the fix
    // this was the one carrier left: the body said [redacted], the header did not.
    Sentry.startSpan({ name: `lookup /customers?q=${PLANTED.customSpan}` }, () => {
      Sentry.captureException(new Error('lookup failed'));
    });
    await Sentry.flush(3000);

    const headers = envelopes.map((e) => JSON.parse(e.split('\n')[0]!) as { trace?: { transaction?: string } });
    // Not vacuous: both envelopes carry the sampling context, and its name.
    expect(headers).toHaveLength(2);
    for (const h of headers) expect(h.trace?.transaction).toBe('lookup /customers?q=[redacted]');
    expect(leaked()).toEqual([]);
  });
});

/** A server action's body as the browser posts it: multipart, one part per field. */
function multipartBody(password: string): string {
  const part = (name: string, value: string) =>
    `------zqxboundary\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  return `${part('1_username', 'salesman.envelope')}${part('1_password', password)}------zqxboundary--\r\n`;
}

describe('a request body', () => {
  it('is never recorded: a password posted to the server is not kept on the scope and not in the envelope', async () => {
    // A real HTTP server, so the SDK's own server instrumentation sees the request.
    // The body is read through a 'data' listener, the one the SDK patches to
    // record bodies, which is how Next's stream pipeline reads a server action.
    const seen: { body?: string; request?: { method?: string; data?: unknown } } = {};
    const server = http.createServer((req, res) => {
      void (async () => {
        seen.body = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        seen.request = Sentry.getIsolationScope().getScopeData().sdkProcessingMetadata.normalizedRequest as typeof seen.request;
        // loginAction's unguarded lookup after signIn(), timing out.
        Sentry.captureException(new Error('sign-in lookup failed'));
        res.end('done');
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = multipartBody(PLANTED.postedPassword);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/login',
            headers: { 'content-type': 'multipart/form-data; boundary=----zqxboundary', 'next-action': 'envelope-test' },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          }
        );
        req.on('error', reject);
        req.end(body);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Sentry.flush(3000);

    // Not vacuous: the server received the password, and the SDK handled the request.
    expect(seen.body).toContain(PLANTED.postedPassword);
    expect(seen.request?.method).toBe('POST');
    // The first line: the SDK never kept the body.
    expect(seen.request?.data).toBeUndefined();
    const events = items().filter((i) => (i as { exception?: unknown }).exception) as Array<{ request?: Record<string, unknown> }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.request?.method).toBe('POST');
    expect(events[0]!.request).not.toHaveProperty('data');
    expect(leaked()).toEqual([]);
  });

  it('a body that reaches an event some other way is dropped outright, not pattern-scrubbed', async () => {
    // The second line: whatever put it on the scope, the scrubber removes it. A
    // password is not a phone number or an e-mail address, so a scrubber that only
    // redacts those sent it on.
    Sentry.withIsolationScope((scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: 'POST',
          url: 'https://nmwc-cm.vercel.app/login',
          headers: { 'content-type': 'multipart/form-data; boundary=----zqxboundary' },
          data: multipartBody(PLANTED.scopedPassword),
        },
      });
      Sentry.captureException(new Error('sign-in lookup failed'));
    });
    await Sentry.flush(3000);

    const events = items().filter((i) => (i as { exception?: unknown }).exception) as Array<{ request?: Record<string, unknown> }>;
    expect(events).toHaveLength(1);
    // Not vacuous: the request data reached this event, and only the body is gone.
    expect(events[0]!.request?.method).toBe('POST');
    expect(events[0]!.request).not.toHaveProperty('data');
    expect(leaked()).toEqual([]);
  });
});

describe('console breadcrumbs, breadcrumb data, span data and extras', () => {
  it('reach the transport with no raw console arguments and every nested string scrubbed', async () => {
    Sentry.withIsolationScope(() => {
      // What Next does with a server error once it has reported it:
      // console.error(' ⨯', err). The SDK records the call as a breadcrumb whose
      // `data.arguments` holds the raw Error, message and stack, while its
      // `message` is the formatted text.
      console.error(' ⨯', new Error(`Unique constraint failed: primaryPhoneNorm=${PERSONAL.phone} email=${PERSONAL.email}`));
      // An object argument formats as "[object Object]": its fields exist only in `data.arguments`.
      console.warn('customer lookup', { legalName: PLANTED.consoleObject });
      Sentry.addBreadcrumb({ category: 'app.search', message: 'searched', data: { last: { href: `/customers?q=${PLANTED.crumbNested}` } } });
      Sentry.setExtra('lastSearch', { href: `/customers?q=${PLANTED.extra}` });
      Sentry.startSpan({ name: 'render customers' }, () => {
        Sentry.startSpan({ name: 'lookup', attributes: { 'app.paths': [`/customers?q=${PLANTED.spanArray}`] } }, () => undefined);
        Sentry.captureException(new Error('render failed'));
      });
    });
    await Sentry.flush(3000);

    expect(leaked()).toEqual([]);
    const error = items().find((i) => (i as { exception?: unknown }).exception) as {
      breadcrumbs?: Array<{ category?: string; level?: string; message?: string; data?: Record<string, unknown> }>;
      extra?: Record<string, unknown>;
    };
    const tx = items().find((i) => i.type === 'transaction') as { spans?: Array<{ description?: string; data?: Record<string, unknown> }> };
    // Not vacuous: each carrier is in the envelope, only its personal data is not.
    const crumbs = error.breadcrumbs ?? [];
    const logged = crumbs.find((b) => b.category === 'console' && b.level === 'error');
    expect(logged?.message).toContain('Unique constraint failed: primaryPhoneNorm=[phone] email=[email]');
    expect(logged?.data).toEqual({ logger: 'console' });
    expect(crumbs.find((b) => b.category === 'console' && b.level === 'warning')?.data).toEqual({ logger: 'console' });
    expect(crumbs.find((b) => b.category === 'app.search')?.data).toEqual({ last: { href: '/customers?q=[redacted]' } });
    expect(error.extra).toEqual({ lastSearch: { href: '/customers?q=[redacted]' } });
    expect(tx.spans?.find((s) => s.description === 'lookup')?.data?.['app.paths']).toEqual(['/customers?q=[redacted]']);
  });
});
