import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';
import { sentryEnvironment, sentryRelease } from '@/lib/sentry-env';

/**
 * GAP-02 / CHAIN-12: Sentry beforeSend used to only delete cookie + auth
 * headers. PII still leaked through `event.request.url` (query strings),
 * `event.request.data` (request bodies), `event.exception.values[].value`
 * (Prisma error messages embed the colliding phone / CR / value), and
 * `event.breadcrumbs[]`. All of those are scrubbed with the same patterns the
 * logger uses — B6 (2026-09-14) moved the implementation into
 * `lib/sentry-scrub.ts` so the client and Edge runtimes cannot drift from it.
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
});
