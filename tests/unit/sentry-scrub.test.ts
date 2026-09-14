/**
 * B6: the Sentry scrubber is a data-protection control, so it is tested rather
 * than asserted. Every runtime (server, client, Edge) shares this function —
 * `sentry.edge.config.ts` had no scrubbing at all until 2026-09-14, which is
 * exactly the kind of drift a single tested implementation prevents.
 */
import { describe, it, expect } from 'vitest';
import { scrub, scrubEvent } from '@/lib/sentry-scrub';
import type { ErrorEvent } from '@sentry/nextjs';

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
    // the path and a harmless search term stay, or the report is useless
    expect(url).toContain('/customers');
    expect(url).toContain('Al+Nahda');
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
