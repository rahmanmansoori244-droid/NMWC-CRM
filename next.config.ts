import type { NextConfig } from 'next';

const r2AccountId = process.env.R2_ACCOUNT_ID ?? '*';

// QA-016 / QA-053 / QA-054: tightened security headers.
//   - dropped 'unsafe-eval' from script-src (Next.js production code does not need it)
//   - B-13: dropped 'unsafe-inline' from script-src as well. Real responses
//     receive a per-request CSP from middleware.ts that uses a nonce; this
//     static block is only the fallback that Next.js applies before
//     middleware runs (e.g. on framework-level redirect responses with no
//     HTML body). Anything that actually serves <script> tags goes through
//     the middleware path and gets the nonce'd CSP.
//   - 'unsafe-inline' remains on style-src — Tailwind's runtime/JIT injects
//     inline <style> blocks; lifting that is a separate piece of work.
//   - narrowed connect-src to our R2 account, not the whole tenant
//   - added Cross-Origin-* hardening
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Content-Security-Policy',
    value:
      // B-13: static fallback is the strictest. Real responses go through
      // middleware.ts which adds a per-request nonce + 'strict-dynamic'.
      `default-src 'self'; ` +
      `img-src 'self' blob: data:; ` +
      `script-src 'self'; ` +
      `style-src 'self' 'unsafe-inline'; ` +
      `font-src 'self' data:; ` +
      `connect-src 'self' https://${r2AccountId}.r2.cloudflarestorage.com https://*.ingest.sentry.io https://*.ingest.de.sentry.io; ` +
      `frame-ancestors 'none';`,
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [],
  },
  typedRoutes: true,
  // PERF (audit #17/#37): client router cache for dynamic pages. Default is 0 —
  // every back/forward or repeat visit re-paid the full Oman round trip + server
  // render. 30s staleness makes the queue→detail→back loop (THE approvals
  // workflow) instant; mutations still bust it via revalidatePath, and 30s is
  // well inside this CRM's freshness needs (SLA clocks tick in hours).
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
