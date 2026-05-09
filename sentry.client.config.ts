import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  environment: process.env.NODE_ENV,
  // Strip PII at the client too as defense in depth
  beforeSend(event) {
    if (event.request?.cookies) delete event.request.cookies;
    return event;
  },
});
