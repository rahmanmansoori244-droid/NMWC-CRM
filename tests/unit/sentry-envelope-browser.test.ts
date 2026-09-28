// @vitest-environment jsdom
/**
 * N07, the browser half of tests/unit/sentry-envelope.test.ts: the real browser
 * SDK, its default integrations, the app's scrubber on every hook
 * instrumentation-client.ts sets, and the whole serialized envelope searched for
 * planted values.
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
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '@/lib/sentry-scrub';

const PLANTED = {
  pageUrl: 'ZQXPAGEURLNAME',
  referrer: 'ZQXREFERRERNAME',
  navigation: 'ZQXNAVIGATIONNAME',
  context: 'ZQXBROWSERCONTEXT',
  spanName: 'ZQXBROWSERSPAN',
  spanAttr: 'ZQXBROWSERATTR',
  consoleArg: 'ZQXBROWSERCONSOLE',
  clickLabel: 'ZQXCLICKLEGALNAME',
  clickTitle: 'ZQXCLICKSEARCHTERM',
  standaloneAttr: 'ZQXSTANDALONEATTR',
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
    // The other two hooks instrumentation-client.ts sets, wired the same way.
    beforeSendSpan: scrubSpan,
    beforeBreadcrumb: scrubBreadcrumb,
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

/**
 * Post-merge review (2026-09-29): the SDK's own click breadcrumb names the
 * element with its aria-label and title VALUES. The approvals checkbox's label
 * is "Select edit for <legal name>", and a saved view's title is its query.
 */
describe('a click on a control labelled with a customer name', () => {
  type Crumb = { category?: string; message?: string };
  const clicks = (list: Crumb[] | undefined) => (list ?? []).filter((b) => b.category === 'ui.click').map((b) => b.message);

  it('is recorded without the label, and reaches the transport without it', async () => {
    envelopes.length = 0;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'mt-1 h-5 w-5 rounded border-slate-300';
    box.setAttribute('aria-label', `Select edit for ${PLANTED.clickLabel} LLC`);
    const view = document.createElement('button');
    view.type = 'button';
    view.title = `q=${PLANTED.clickTitle}&status=ACTIVE`;
    view.textContent = 'My shops';
    document.body.append(box, view);
    box.click();
    view.click();

    // Scrubbed as recorded (beforeBreadcrumb): the scope holds no label, so no
    // later event, whichever hook it goes through, can be the first to carry one.
    const held = clicks(Sentry.getIsolationScope().getScopeData().breadcrumbs);
    // Not vacuous: the SDK really recorded both clicks.
    expect(held).toHaveLength(2);
    expect(held.join('\n')).not.toContain('ZQX');

    Sentry.captureException(new Error('bulk approve failed'));
    await Sentry.flush(3000);

    const errorEvents = payloads().filter((p) => p.exception) as Array<{ breadcrumbs?: Crumb[] }>;
    expect(errorEvents).toHaveLength(1);
    expect(leaked()).toEqual([]);
    // What survives is which control it was.
    const sent = clicks(errorEvents[0]!.breadcrumbs);
    expect(sent[0]).toBe('input.mt-1.h-5.w-5.rounded.border-slate-300[aria-label][type="checkbox"]');
    expect(sent[1]).toMatch(/button\[type="button"\]\[title\]$/);
  });
});

describe('a span sent on its own, as the INP web vital is', () => {
  it('has its name and attributes cleaned by beforeSendSpan, but its envelope header is out of reach', async () => {
    envelopes.length = 0;
    // The name the SDK gives an INP span: the clicked element, label and all.
    // A name the scrubber changes and nothing else plants, so the header check
    // below is about THIS span and not an earlier one.
    const name = `input.h-5[aria-label="Select edit for ${PLANTED.clickLabel} Standalone"][type="checkbox"]`;
    Sentry.startInactiveSpan({
      name,
      attributes: { 'lcp.element': `a.block[aria-label="${PLANTED.standaloneAttr} · NMWC-018702"]` },
      experimental: { standalone: true },
    }).end();
    await Sentry.flush(3000);

    const spanEnvelopes = envelopes.filter((e) => e.includes('"type":"span"'));
    expect(spanEnvelopes).toHaveLength(1);
    const [header, ...rest] = spanEnvelopes[0]!.split('\n').filter((l) => l.startsWith('{'));
    const spans = rest.map((l) => JSON.parse(l) as Record<string, unknown>).filter((p) => 'span_id' in p) as Array<{
      description?: string;
      data?: Record<string, unknown>;
    }>;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.description).toBe('input.h-5[aria-label][type="checkbox"]');
    expect(spans[0]!.data?.['lcp.element']).toBe('a.block[aria-label]');
    expect(JSON.stringify(spans)).not.toContain('ZQX');

    // The SDK builds the header's trace.transaction from the span's name BEFORE
    // beforeSendSpan runs. This is why instrumentation-client.ts turns the INP span
    // off (enableInp: false) instead of relying on the hook. If this assertion ever
    // fails, the SDK has changed and that decision can be looked at again.
    expect((JSON.parse(header!) as { trace?: { transaction?: string } }).trace?.transaction).toBe(name);
  });
});
