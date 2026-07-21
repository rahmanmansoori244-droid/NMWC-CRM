import * as Sentry from '@sentry/nextjs';

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

export const onRequestError = Sentry.captureRequestError;
