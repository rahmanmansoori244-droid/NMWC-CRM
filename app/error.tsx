'use client';

/**
 * GAP-04: branded error boundary. Without this Next.js falls back to its
 * default page that leaks framework version + a digest hash of the error.
 * This page deliberately never renders the raw error message — only a digest
 * the user can share with support.
 */
import { useEffect } from 'react';
import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error({ digest: error.digest }, 'app.unhandled');
    // DO-04: this boundary logged but never reported. The page told the user
    // 'Our team has been notified' while nothing notified anyone.
    Sentry.captureException(error);
  }, [error]);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <section className="max-w-md rounded-lg bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong.</h1>
        <p className="mt-2 text-sm text-slate-600">
          Our team has been notified. You can try again, or sign out and back in.
        </p>
        {error.digest && (
          <p className="mt-3 break-all font-mono text-[11px] text-slate-400">
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Try again
          </button>
          <a
            href="/login"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign in again
          </a>
        </div>
      </section>
    </main>
  );
}
