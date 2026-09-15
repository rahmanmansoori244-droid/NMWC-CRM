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
  // DG-06: `next lint` and the lint pass inside `next build` both default to
  // app/pages/components/lib/src (ESLINT_DEFAULT_DIRS in next/dist/lib/constants.js).
  // services/ and scripts/ were therefore linted by nothing at all — and services/
  // holds 23 of the 31 direct AuditLog writes the guard in eslint.config.mjs bans.
  // A rule that does not run is worse than no rule, so this list is load-bearing:
  // it is what `next lint` reads (next-lint.js: options.dir ?? nextConfig.eslint?.dirs)
  // and what the build's lint pass reads (build/type-check.js hands config.eslint?.dirs
  // to verifyAndLint, which does configLintDirs ?? ESLINT_DEFAULT_DIRS). Listing
  // services/ is what makes that guard real rather than decorative.
  //
  // scripts/ is listed for ordinary hygiene, NOT for the audit guard, which stops at
  // the request-serving tree (the reasoning is in eslint.config.mjs). Linting it opens
  // no new way to break a deploy: tsconfig.json already includes `**/*.ts`, so a broken
  // operator script fails the build's type check today, and these are the files that
  // run against production holding owner credentials.
  //
  // This REPLACES the defaults rather than extending them, so app/components/lib must
  // be re-listed. 'pages' and 'src' are omitted because neither exists in this App
  // Router tree. 'tests' and 'prisma' are omitted on purpose: a lint error in a test
  // fixture or a development seed must not fail a production deploy, and both hold
  // writers that must stay raw.
  eslint: {
    dirs: ['app', 'components', 'lib', 'services', 'scripts'],
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
    // own ceiling (MAX_IMPORT_BYTES) is 5 MB — without this the go-live file is
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
