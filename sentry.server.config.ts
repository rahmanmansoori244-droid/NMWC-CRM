import * as Sentry from '@sentry/nextjs';

/**
 * GAP-02 / CHAIN-12: Sentry beforeSend used to only delete cookie + auth
 * headers. PII still leaked through `event.request.url` (query strings),
 * `event.request.data` (request bodies), `event.exception.values[].value`
 * (Prisma error messages embed the colliding phone / CR / value), and
 * `event.breadcrumbs[]`. Scrub all of those with the same patterns the
 * logger uses.
 */
const PHONE_PATTERN = /\+?968\d{8}\b|\b\d{8,12}\b/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
function scrub(s: string): string {
  return s.replace(PHONE_PATTERN, '[phone]').replace(EMAIL_PATTERN, '[email]');
}

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  beforeSend(event) {
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    if (typeof event.request?.url === 'string') {
      // Strip query string PII; keep the path for debugging.
      try {
        const u = new URL(event.request.url);
        u.searchParams.forEach((_v, k) => {
          if (/phone|crNumber|email|password|token/i.test(k)) {
            u.searchParams.set(k, '[redacted]');
          }
        });
        event.request.url = scrub(u.toString());
      } catch {
        event.request.url = scrub(event.request.url);
      }
    }
    if (event.request?.data && typeof event.request.data === 'string') {
      event.request.data = scrub(event.request.data);
    }
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
    // Don't ship browser fingerprints / IPs we don't need.
    if (event.user) {
      delete event.user.ip_address;
    }
    return event;
  },
});
