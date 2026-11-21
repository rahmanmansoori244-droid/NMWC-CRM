import type { NextConfig } from 'next';
import { buildCsp } from './lib/csp';


// QA-016 / QA-053 / QA-054: tightened security headers, plus Cross-Origin-*
// hardening. The Content-Security-Policy below is the static fallback Next
// applies before middleware runs (e.g. on a framework-level redirect with no HTML
// body); anything that actually serves <script> tags goes through middleware and
// gets the nonce'd policy instead. Both come from lib/csp.ts, which carries the
// per-directive reasoning and the three things not to do to it.
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
    // SEC-14b: one builder, lib/csp.ts — this string and the per-request one in
    // middleware.ts were hand-duplicated and had drifted. Called with no nonce,
    // so script-src is exactly 'self'.
    value: buildCsp(),
  },
];

const nextConfig: NextConfig = {
  // DO-07: VERCEL_ENV and VERCEL_GIT_COMMIT_SHA exist only on the server.
  // Map them into the client bundle at build time so browser reports carry the
  // same environment and release as server reports — otherwise a Preview
  // deployment files its errors as "production" and no report names a commit.
  env: {
    NEXT_PUBLIC_SENTRY_ENV: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
  // DG-06: which directories are linted is no longer set here. Next 16 removed
  // `next lint`, the build's own lint pass and this file's `eslint.dirs` option;
  // package.json's `lint` script runs the ESLint CLI over the same list
  // (app components lib services scripts), and the build script runs
  // `npm run lint` before `prisma migrate deploy`. The reasons for the list (services/
  // holds the AuditLog writes the guard bans; scripts/ for hygiene; tests/ and
  // prisma/ left out so a test-fixture or seed lint error cannot fail a production
  // deploy) are pinned in tests/unit/csp.test.ts; the lint-before-migrate order in
  // tests/unit/ci-gates-guard.test.ts.

  // Launch fix: the /import template download (app/(app)/import/template/route.ts)
  // reads these two files at run time; listed so its function always ships them.
  outputFileTracingIncludes: {
    '/import/template': ['./docs/import-templates/*.xlsx'],
  },
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
    // The import uploads travel through server actions, whose body limit
    // defaults to 1 MB. The real customer master is ~1.7 MB and the importer's
    // own ceiling (MAX_IMPORT_BYTES, lib/import-file-size.ts) is 4.2 MB, just
    // under the 4.5 MB Vercel itself allows — without this the go-live file is
    // refused before the importer ever sees it. 8 MB leaves room for multipart
    // overhead while staying far below anything a zip-bomb needs.
    serverActions: {
      bodySizeLimit: '8mb',
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
