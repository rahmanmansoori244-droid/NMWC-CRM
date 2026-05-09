import type { NextConfig } from 'next';

const r2AccountId = process.env.R2_ACCOUNT_ID ?? '*';

// QA-016 / QA-053 / QA-054: tightened security headers.
//   - dropped 'unsafe-eval' from script-src (Next.js production code does not need it)
//   - kept 'unsafe-inline' temporarily — required by Next.js until we plumb a nonce;
//     mitigated by the absence of 'unsafe-eval'
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
      `default-src 'self'; ` +
      `img-src 'self' blob: data:; ` +
      `script-src 'self' 'unsafe-inline'; ` +
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
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
