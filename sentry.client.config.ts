import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';

/**
 * Browser runtime. Session replay stays off (it would record the customer
 * master on screen). The shared scrubber (B6, 2026-09-14) also drops
 * `user.ip_address` and redacts breadcrumbs, which this config did not do
 * before.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  environment: process.env.NODE_ENV,
  beforeSend: scrubEvent,
});
