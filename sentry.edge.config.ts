import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';
import { sentryEnvironment, sentryRelease } from '@/lib/sentry-env';

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
  // DO-07: NODE_ENV is "production" on every built deployment, so a Preview
  // deployment used to file its errors alongside real ones.
  environment: sentryEnvironment(),
  release: sentryRelease(),
  beforeSend: scrubEvent,
  // SEC-14d: performance transactions go to a DIFFERENT hook. Without this,
  // ~1 request in 10 shipped its full URL — the customer search term included —
  // to Sentry with no redaction at all.
  beforeSendTransaction: scrubEvent,
});
