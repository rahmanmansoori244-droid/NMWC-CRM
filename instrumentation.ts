import * as Sentry from '@sentry/nextjs';
import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    // PERF (audit #2): warm the Prisma engine + Neon TLS/auth handshake in the
    // background so a cold lambda's FIRST query doesn't serially pay ~50-200ms
    // of connection setup on top of the user's round trip. Deliberately NOT
    // awaited — overlap with the rest of cold start; $connect is idempotent and
    // a failure just falls back to lazy connect on the first real query.
    import('./lib/db')
      .then(({ prisma }) => prisma.$connect())
      .catch(() => {
        /* first query will connect lazily; never crash startup */
      });
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Item 10 (re-benchmark, 2026-09-24): a reference a user quotes has to find the
 * request it came from.
 *
 * Every error screen shows `Reference: <digest>` and tells the user to quote it.
 * Sentry has it as a tag (lib/sentry-scrub.ts), but Sentry holds only the error;
 * the request's own log lines are in Vercel's runtime logs, grouped per request.
 * This line puts the digest into those logs, so pasting a reference into Vercel →
 * Logs finds the failing request and everything it logged. It goes to stderr
 * through the logger, so Vercel files it — and the request — as an error.
 *
 * The route TEMPLATE, never the path: a real path carries `?q=<a customer's name>`,
 * which no pattern scrubber recognises. No message either — Next already writes
 * the error itself to the same request's log, and a Prisma message can quote a
 * colliding value.
 *
 * Node only: the logger is not loaded into the Edge runtime, and middleware errors
 * still reach Sentry below. A logging failure must never replace the error it was
 * reporting, so it is swallowed.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { logger } = await import('./lib/logger');
      const e = err as { digest?: unknown } | null;
      logger.error(
        {
          digest: e?.digest,
          errName: err instanceof Error ? err.name : typeof err,
          method: request.method,
          route: context.routePath,
          routeType: context.routeType,
        },
        'request.error'
      );
    } catch {
      /* never let the log line cost the report */
    }
  }
  return Sentry.captureRequestError(err, request, context);
};
