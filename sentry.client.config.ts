import * as Sentry from '@sentry/nextjs';

const PHONE_PATTERN = /\+?968\d{8}\b|\b\d{8,12}\b/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
function scrub(s: string): string {
  return s.replace(PHONE_PATTERN, '[phone]').replace(EMAIL_PATTERN, '[email]');
}

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  environment: process.env.NODE_ENV,
  beforeSend(event) {
    if (event.request?.cookies) delete event.request.cookies;
    if (typeof event.request?.url === 'string') {
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
    if (event.exception?.values) {
      for (const v of event.exception.values) {
        if (typeof v.value === 'string') v.value = scrub(v.value);
      }
    }
    return event;
  },
});
