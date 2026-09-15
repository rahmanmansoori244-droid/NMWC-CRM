import NextAuth from 'next-auth';
import {
  NextResponse,
  type NextRequest,
  type NextFetchEvent,
  type NextMiddleware,
} from 'next/server';
import { maintenanceResponse } from './lib/maintenance';
import { authConfig } from './auth.config';

/**
 * Auth.js v5 middleware (Edge runtime). Two responsibilities:
 *
 *   1. Auth gating + AUTH-09 force-change redirect via the `authorized`
 *      callback in `auth.config.ts`.
 *   2. B-13 (Senior-audit 2026-05-10, second pass): per-request CSP nonce.
 *      A 16-byte base64 nonce is generated on every request, exposed via
 *      the `x-nonce` request header (Next.js picks this up automatically
 *      when `app/layout.tsx` calls `headers()` — the framework then stamps
 *      the same nonce onto its own inline RSC bootstrap scripts), and
 *      written into a per-request `Content-Security-Policy` response
 *      header that uses `'nonce-<n>' 'strict-dynamic'` instead of
 *      `'unsafe-inline'`. `'strict-dynamic'` lets nonce'd scripts load
 *      further scripts without each one needing its own nonce.
 *
 * The static fallback CSP in `next.config.ts` is the strictest possible
 * — `script-src 'self'` only — so a missed middleware pass cannot quietly
 * soften the policy. Real responses always go through middleware first
 * because the matcher excludes only static framework assets.
 */

const { auth } = NextAuth(authConfig);

const r2AccountId = process.env.R2_ACCOUNT_ID ?? '*';

// `next dev` serves a webpack runtime that evaluates source-mapped modules via
// eval(); without 'unsafe-eval' the browser throws EvalError in main-app.js and
// NOTHING hydrates — every client component (login, enrichment form, photo
// slots) is dead in local development, which is how the go-live browser walk
// found it. Production bundles need no eval, so the directive is dev-only.
const DEV_SCRIPT_SRC = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";

function buildCsp(nonce: string): string {
  return (
    `default-src 'self'; ` +
    `img-src 'self' blob: data:; ` +
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV_SCRIPT_SRC}; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `font-src 'self' data:; ` +
    `connect-src 'self' https://${r2AccountId}.r2.cloudflarestorage.com https://*.ingest.sentry.io https://*.ingest.de.sentry.io; ` +
    `frame-ancestors 'none';`
  );
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const withAuth = auth((req) => {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Forward to RSC + route handlers so layout.tsx can read it via headers().
  // Next.js automatically stamps this nonce onto its own inline RSC
  // bootstrap scripts when the root layout calls `headers()`.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  // Setting the CSP also on the request header tells Next.js to embed it as
  // a meta tag fallback for RSC payloads (per Next.js docs).
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', csp);
  return response;
});

/**
 * REL-02: the maintenance gate runs BEFORE auth.
 *
 * It has to. The case it exists for is "the database is being restored", and
 * the auth handler reads a session — so gating after it would mean the closed
 * sign is the one thing that needs the thing that is down. This check is an
 * environment-variable read and nothing else.
 */
export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const closed = maintenanceResponse(req);
  if (closed) return closed;
  // The auth() wrapper is overloaded for route handlers as well as middleware,
  // and TypeScript picks the route-handler overload for a (request, event)
  // call. The runtime shape is the middleware one.
  return (withAuth as unknown as NextMiddleware)(req, event);
}

export const config = {
  // Skip framework assets so the nonce overhead doesn't run for every JS/CSS
  // chunk. The CSP applies via the static next.config.ts fallback for those.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
