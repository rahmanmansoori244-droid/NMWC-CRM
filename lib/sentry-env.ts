/**
 * DO-07: label telemetry with the environment it actually came from.
 *
 * All three Sentry runtimes read `process.env.NODE_ENV`, which Next sets to
 * "production" for every built deployment — so a Preview deployment's errors
 * arrive tagged "production" and sit in the same stream as the real thing. The
 * repository already knows better elsewhere: `auth.config.ts` and `lib/auth.ts`
 * both branch on VERCEL_ENV precisely because NODE_ENV cannot tell a preview
 * from production.
 *
 * VERCEL_ENV is a server-side variable, so it is mapped into the client bundle
 * at build time by `next.config.ts`; that is why the NEXT_PUBLIC_ reads come
 * first here.
 */

/** "production" | "preview" | "development", from whichever source knows. */
export function sentryEnvironment(): string {
  return (
    process.env.NEXT_PUBLIC_SENTRY_ENV ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    'development'
  );
}

/**
 * The commit a report came from. Without it, "is this fixed?" cannot be
 * answered from a Sentry issue — and this project has already shipped a build
 * that was 74 commits behind what everyone believed was live.
 */
export function sentryRelease(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SENTRY_RELEASE ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    undefined
  );
}
