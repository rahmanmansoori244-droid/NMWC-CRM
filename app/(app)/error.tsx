'use client';

/**
 * UAT-15: an error inside the signed-in app should not take the navigation with it.
 *
 * Until this file existed the only boundaries in the tree were `app/error.tsx`,
 * `app/global-error.tsx` and `app/not-found.tsx`. A throw anywhere in the (app)
 * group therefore unmounted the entire authenticated shell — top bar, sidebar,
 * mobile tab bar — and replaced it with the root error page. A manager whose
 * approvals list failed to load lost every route out of the failure and had to
 * know to edit the address bar.
 *
 * Placed beside `app/(app)/layout.tsx`, Next loads this as the error component
 * for the LayoutRouter rendered inside that layout, so the chrome stays mounted
 * and only the content column is replaced.
 *
 * WHAT THIS DOES NOT CATCH, because it is worth knowing before trusting it:
 *   - anything thrown by `app/(app)/layout.tsx` itself, which is where the
 *     session lookup and the notification count run. Those bubble past this to
 *     the root boundary and still blank the shell. That is irreducible — a
 *     boundary above the layout cannot render the layout's chrome — and it is
 *     the likely shape of a Neon outage. This covers "a page threw", not "the
 *     database is unhappy".
 *   - errors in the root layout, which are `global-error.tsx`'s job.
 *   - `notFound()` and `redirect()`, which Next re-throws through error
 *     boundaries on purpose, so those still reach their own handlers.
 *
 * As with the root boundary, the raw message is never rendered: it can carry a
 * customer's name or phone number out of a Prisma error and onto the screen of
 * whoever is standing next to the user. Only the digest, which support can match
 * to the report.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Both, deliberately: the Sentry client is only live when the DSN was set at
    // build time, and the log line is the fallback when it was not.
    logger.error({ digest: error.digest }, 'app.unhandled');
    Sentry.captureException(error);
  }, [error]);

  return (
    // Sized for the content column, not the viewport: the chrome is still on
    // screen above and beside this.
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <section className="max-w-md rounded-lg bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold text-slate-900">This page could not load.</h1>
        <p className="mt-2 text-sm text-slate-600">
          Nothing you had already submitted is lost. Try again, or use the menu to go
          somewhere else.
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
          {/* No "sign in again" here. The layout validated the session before this
              rendered, so the session is intact and offering to re-authenticate
              would send a working user to the login screen for nothing. */}
          <Link
            href="/home"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Go to Home
          </Link>
        </div>
      </section>
    </main>
  );
}
