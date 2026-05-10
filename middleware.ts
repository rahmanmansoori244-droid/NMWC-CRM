import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from './auth.config';

/**
 * B-13: CSP nonce middleware.
 *
 * The previous CSP allowed `script-src 'self' 'unsafe-inline'` because Next.js
 * still emits a small handful of inline bootstrap scripts. `'unsafe-inline'`
 * defeats the bulk of CSP — any reflected/stored XSS sink can run JS.
 *
 * Fix: generate a fresh 16-byte base64 nonce per request, expose it via the
 * `x-nonce` request header (so RSCs can read it from `headers()` and stamp it
 * onto any inline `<Script nonce={...}>`), and ship a per-request CSP that
 * uses `'nonce-<n>'` instead of `'unsafe-inline'`. The static `next.config.ts`
 * fallback also drops `'unsafe-inline'` from script-src so a missed middleware
 * pass cannot quietly soften the policy.
 *
 * style-src still keeps `'unsafe-inline'` for now because Tailwind injects
 * inline `<style>` blocks during dev/HMR and the JIT pipeline doesn't expose
 * a stable per-build hash. Removing it is a separate piece of work.
 *
 * The auth callback in auth.config.ts already does session gating via
 * `authorized({ auth, request })`. We wrap that, then layer the nonce on top
 * by mutating the request headers and adding a `Content-Security-Policy`
 * header to the outgoing response.
 */

const { auth } = NextAuth(authConfig);

const r2AccountId = process.env.R2_ACCOUNT_ID ?? '*';

function buildCsp(nonce: string): string {
  return (
    `default-src 'self'; ` +
    `img-src 'self' blob: data:; ` +
    `script-src 'self' 'nonce-${nonce}'; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `font-src 'self' data:; ` +
    `connect-src 'self' https://${r2AccountId}.r2.cloudflarestorage.com https://*.ingest.sentry.io https://*.ingest.de.sentry.io; ` +
    `frame-ancestors 'none';`
  );
}

function generateNonce(): string {
  // 16 bytes of crypto-strong random, base64-encoded — Edge-runtime safe.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // btoa is available in the Edge runtime.
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export default auth((req) => {
  const nonce = generateNonce();

  // Forward the nonce to RSC + route handlers so any inline <Script> can
  // pick it up via `headers().get('x-nonce')`.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  // Per-request CSP: overrides the static one in next.config.ts so the
  // server response carries a fresh nonce.
  response.headers.set('Content-Security-Policy', buildCsp(nonce));
  return response;
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
