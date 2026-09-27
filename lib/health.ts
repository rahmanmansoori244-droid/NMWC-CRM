/**
 * The verdict of the bearer /api/health probe, as a pure function so it can be
 * tested by behaviour rather than by reading the route's source.
 *
 * Two defects from the re-benchmark (2026-09-24) are decided here:
 *
 *   Item 11 — "health goes red for minor things". Every heartbeat alarm used to
 *   turn the probe 503, so a monitor paged for a keep-warm ping that failed once
 *   as loudly as for the SLA sweep being dead. Alarms now carry the job's
 *   severity (lib/heartbeat.ts): a critical one answers 503, a warning one is
 *   reported in the body and the probe stays 200 with status `warn`.
 *
 *   Item 12 — "R2 unconfigured reads healthy". With no R2 credentials the check
 *   was skipped, stayed `pending`, and `pending` counted as fine — so production
 *   could lose every photo upload and still answer 200 ok. `unconfigured` is now
 *   its own state: a failure on the production deployment, where photographs are
 *   part of every change request, and a warning anywhere else (a laptop, a CI
 *   build), where nobody is uploading.
 */

export type CheckState = 'ok' | 'fail' | 'pending' | 'unconfigured';
export type HealthStatus = 'ok' | 'warn' | 'degraded';

export type JobVerdictInput = {
  key: string;
  state: string;
  alarm: boolean;
  severity: 'critical' | 'warning';
};

export type HealthVerdict = {
  status: HealthStatus;
  httpStatus: 200 | 503;
  /** Check names that failed, e.g. `db`, `r2`. */
  failedChecks: string[];
  /** Critical jobs that alarm: these page. */
  criticalJobs: string[];
  /** Warning jobs that alarm, and anything else worth a look: reported, never paged. */
  warnings: string[];
};

/**
 * `production` is true only on the deployment real users reach (VERCEL_ENV ===
 * 'production'); see `isProductionDeployment`.
 *
 * `pending` stays neutral on purpose: `heartbeats` is left pending only when the
 * database is down, which is already a failed check of its own.
 */
export function evaluateHealth(input: {
  checks: Record<string, CheckState>;
  jobs: JobVerdictInput[] | null;
  production: boolean;
}): HealthVerdict {
  const failedChecks: string[] = [];
  const warnings: string[] = [];
  for (const [name, state] of Object.entries(input.checks)) {
    if (state === 'fail') failedChecks.push(name);
    else if (state === 'unconfigured') {
      if (input.production) failedChecks.push(name);
      else warnings.push(`${name}:unconfigured`);
    }
  }
  const criticalJobs: string[] = [];
  for (const job of input.jobs ?? []) {
    if (!job.alarm) continue;
    if (job.severity === 'critical') criticalJobs.push(job.key);
    else warnings.push(`${job.key}:${job.state}`);
  }
  const red = failedChecks.length > 0 || criticalJobs.length > 0;
  return {
    status: red ? 'degraded' : warnings.length > 0 ? 'warn' : 'ok',
    httpStatus: red ? 503 : 200,
    failedChecks,
    criticalJobs,
    warnings,
  };
}

/** The deployment real users reach. Previews and local builds are not it. */
export function isProductionDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === 'production';
}

/**
 * Whether every variable `lib/r2.ts` needs is present. The old test looked at two
 * of the three credentials, so a deployment missing only the secret was probed,
 * threw inside `r2()`, and was reported as an R2 outage instead of a
 * configuration gap.
 */
export function r2Configured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}
