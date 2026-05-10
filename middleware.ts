import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
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

function buildCsp(nonce: string): string {
  return (
    `default-src 'self'; ` +
    `img-src 'self' blob: data:; ` +
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
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

export default auth((req) => {
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

export const config = {
  // Skip framework assets so the nonce overhead doesn't run for every JS/CSS
  // chunk. The CSP applies via the static next.config.ts fallback for those.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
