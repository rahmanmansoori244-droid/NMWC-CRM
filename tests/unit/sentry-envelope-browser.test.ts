// @vitest-environment jsdom
/**
 * N07, the browser half of tests/unit/sentry-envelope.test.ts: the real browser
 * SDK, its default integrations, the app's `scrubEvent` on both hooks, and the
 * whole serialized envelope searched for planted values.
 *
 * The browser's own carriers are different from the server's. The SDK's
 * HttpContext integration copies `location.href` into `request.url` and
 * `document.referrer` into a `Referer` header on every event, and its history
 * instrumentation records each client-side navigation as a breadcrumb — so a
 * salesman who searched for a shop and then hit an error sent the shop's name
 * three ways. `instrumentation-client.ts` initialises `@sentry/nextjs`, whose
 * client build is this SDK with React bindings; the event pipeline is the same.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Sentry from '@sentry/browser';
import { scrubEvent } from '@/lib/sentry-scrub';

const PLANTED = {
  pageUrl: 'ZQXPAGEURLNAME',
  referrer: 'ZQXREFERRERNAME',
  navigation: 'ZQXNAVIGATIONNAME',
  context: 'ZQXBROWSERCONTEXT',
  spanName: 'ZQXBROWSERSPAN',
  spanAttr: 'ZQXBROWSERATTR',
  consoleArg: 'ZQXBROWSERCONSOLE',
} as const;

const envelopes: string[] = [];
const decoder = new TextDecoder();

/** Every JSON line of every envelope: envelope headers, item headers and payloads. */
function payloads(): Array<Record<string, unknown>> {
  return envelopes
    .flatMap((e) => e.split('\n').filter((l) => l.startsWith('{')))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function leaked(): string[] {
  const all = envelopes.join('\n');
  return Object.entries(PLANTED)
    .filter(([, v]) => all.includes(v))
    .map(([k]) => k);
}

beforeAll(() => {
  window.history.replaceState({}, '', `/customers?q=${PLANTED.pageUrl}&status=ACTIVE`);
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    get: () => `${window.location.origin}/customers?q=${PLANTED.referrer}`,
  });
  Sentry.init({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    // 1, not the configs' 0.1, so the transaction case below is not a coin toss.
    tracesSampleRate: 1,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    transport: (options) =>
      Sentry.createTransport(options, async (request) => {
        envelopes.push(typeof request.body === 'string' ? request.body : decoder.decode(request.body));
        return { statusCode: 200 };
      }),
  });
});

afterAll(async () => {
  await Sentry.close(2000);
});

describe('an error in the browser after a search', () => {
  it('reaches the transport with no search term in its URL, its Referer, its breadcrumbs or its contexts', async () => {
    // A client-side navigation after init, so the history instrumentation records it.
    window.history.pushState({}, '', `/customers?q=${PLANTED.navigation}&status=ACTIVE`);
    Sentry.setContext('lastSearch', { href: `/customers?q=${PLANTED.context}` });
    Sentry.captureException(new Error('client render failed'));
    await Sentry.flush(3000);

    const errorEvents = payloads().filter((p) => p.exception) as Array<{
      request?: { url?: string; headers?: Record<string, string> };
      breadcrumbs?: Array<{ category?: string; data?: Record<string, unknown> }>;
    }>;
    // Not vacuous: the event really went through the SDK and out.
    expect(errorEvents).toHaveLength(1);
    expect(leaked()).toEqual([]);

    const event = errorEvents[0]!;
    // What survives is what debugging needs.
    expect(event.request?.url).toContain('/customers?q=%5Bredacted%5D&status=ACTIVE');
    const headerNames = Object.keys(event.request?.headers ?? {}).map((h) => h.toLowerCase());
    expect(headerNames).toContain('user-agent');
    expect(headerNames).not.toContain('referer');
    const nav = event.breadcrumbs?.find((b) => b.category === 'navigation');
    expect(nav?.data?.to).toBe('/customers?q=[redacted]&status=ACTIVE');
  });
});

describe('a browser transaction', () => {
  it('reaches the transport with no search term in its name, its span data, its URL or its Referer', async () => {
    envelopes.length = 0;
    // The HttpContext integration stamps `request.url` and the Referer on
    // transactions too, and they go through the OTHER hook.
    Sentry.startSpan(
      { name: `/customers?q=${PLANTED.spanName}`, attributes: { 'url.full': `${window.location.origin}/customers?q=${PLANTED.spanAttr}` } },
      () => undefined
    );
    await Sentry.flush(3000);

    // The item HEADER says `type: transaction` too; the payload is the one with contexts.
    const transactions = payloads().filter((p) => p.type === 'transaction' && p.contexts) as Array<{
      request?: { headers?: Record<string, string> };
      contexts?: { trace?: { data?: Record<string, unknown> } };
    }>;
    expect(transactions).toHaveLength(1);
    expect(leaked()).toEqual([]);
    const tx = transactions[0]!;
    expect(tx.contexts?.trace?.data?.['url.full']).toBe(`${window.location.origin}/customers?q=[redacted]`);
    expect(Object.keys(tx.request?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('referer');
  });
});

describe('a console call in the browser', () => {
  it('leaves the raw arguments of its breadcrumb out of the envelope', async () => {
    envelopes.length = 0;
    // The breadcrumb's message is "customer save failed [object Object]"; the
    // object's fields exist only in the raw `data.arguments` the SDK keeps.
    console.error('customer save failed', { legalName: PLANTED.consoleArg });
    Sentry.captureException(new Error('client save failed'));
    await Sentry.flush(3000);

    const errorEvents = payloads().filter((p) => p.exception) as Array<{
      breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
    }>;
    expect(errorEvents).toHaveLength(1);
    expect(leaked()).toEqual([]);
    // Not vacuous: the console breadcrumb is there, without its raw arguments.
    const logged = errorEvents[0]!.breadcrumbs?.find((b) => b.category === 'console' && b.message?.startsWith('customer save failed'));
    expect(logged?.data).toEqual({ logger: 'console' });
  });
});
