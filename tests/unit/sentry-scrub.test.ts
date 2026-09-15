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

describe('every runtime wires both hooks', () => {
  it.each(['sentry.server.config.ts', 'sentry.edge.config.ts', 'instrumentation-client.ts'])(
    '%s sets beforeSend AND beforeSendTransaction',
    async (file) => {
      // The defect was one hook missing in all three runtimes at once, which no
      // behavioural test can see. Only wiring can.
      const { readFileSync } = await import('node:fs');
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/beforeSend:\s*scrubEvent/);
      expect(src).toMatch(/beforeSendTransaction:\s*scrubEvent/);
    }
  );
});
