import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';

/**
 * B6 (2026-09-14): the Edge runtime had NO `beforeSend` at all, so an error in
 * `middleware.ts` — which sees every request URL, every cookie and the
 * Authorization header — shipped them to Sentry unredacted while the server and
 * client runtimes were carefully scrubbed. Same scrubber as the other two now.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  beforeSend: scrubEvent,
});
