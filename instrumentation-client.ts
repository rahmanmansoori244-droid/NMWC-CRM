/**
 * DO-04: browser error reporting. This file is the reason any of it works.
 *
 * `sentry.client.config.ts` was dead code. Nothing imported it — `instrumentation.ts`
 * loads only the server and edge configs — and the one mechanism that would
 * have injected it, `withSentryConfig` in `next.config.ts`, was never applied.
 * So for the life of this project the browser SDK has never initialised and no
 * client-side error has ever reached Sentry, while three documents recorded
 * that it had.
 *
 * Next.js 15 runs `instrumentation-client.ts` on the client before hydration
 * without any bundler plugin, which is why the fix is a file rename rather than
 * a build-config change.
 *
 * Still deferred (needs an owner to create a Sentry auth token): wrapping the
 * config in `withSentryConfig` to upload source maps. Until that lands, stack
 * traces here are minified.
 */
import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';
import { sentryEnvironment, sentryRelease } from '@/lib/sentry-env';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  // Session replay stays off: it would record the customer master on screen.
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
  environment: sentryEnvironment(),
  release: sentryRelease(),
  beforeSend: scrubEvent,
  // SEC-14d: performance transactions go to a DIFFERENT hook. Without this,
  // ~1 request in 10 shipped its full URL — the customer search term included —
  // to Sentry with no redaction at all.
  beforeSendTransaction: scrubEvent,
});

// Next 15 reports client-side navigation timing through this hook when it is
// exported; without it route changes are invisible in tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
