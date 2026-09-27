import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { r2, R2_BUCKET } from '@/lib/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { bearerMatches } from '@/lib/cron-auth';
import { loadHeartbeatReport } from '@/lib/heartbeat';
import { evaluateHealth, isProductionDeployment, r2Configured, type CheckState } from '@/lib/health';

/**
 * GAP-01 + B-12 (audit 2026-05-10): minimal-information health endpoint.
 *
 * The public response stays minimal — `{ "status": "ok" }` — but it is no
 * longer unconditionally 200: B5 (enterprise assessment, 2026-09-14) found the
 * anonymous probe returned 200 with the database down, so an uptime monitor
 * pointed at it could never see an outage. It now runs one `SELECT 1` and
 * answers 503 `{ "status": "degraded" }` when that fails. Nothing else is
 * disclosed to anonymous callers.
 *
 * With `Authorization: Bearer <HEALTH_BEARER>` (an external monitor) the
 * detailed payload is returned: DB and R2 checks plus the per-job cron
 * heartbeats (lib/heartbeat.ts) — "stale" / "never ran" / "failed" are the
 * dead-man alarms for the scheduled jobs. The status code is 503 when a check
 * fails or a CRITICAL job alarms, so the monitor needs no body parsing; a
 * warning-tier job that alarms is listed in `warnings` and the answer stays 200
 * with status `warn` (item 11, lib/health.ts).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One retry after this pause before the database counts as down. */
const DB_RETRY_MS = 750;

/**
 * Item 11: one pooler hiccup used to be enough to answer 503, and to page. A
 * database that is really down fails twice; one that blinked answers the retry,
 * and the blink is still logged so a pattern of them is visible.
 */
async function dbOk(): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (err) {
      if (attempt >= 2) {
        logger.warn({ err: (err as Error).message }, 'health.db.fail');
        return false;
      }
      logger.info({ err: (err as Error).message }, 'health.db.retry');
      await new Promise((r) => setTimeout(r, DB_RETRY_MS));
    }
  }
}

export async function GET(req: Request) {
  const bearer = req.headers.get('authorization');
  const monitorToken = process.env.HEALTH_BEARER;
  // B-16 posture: constant-time compare, and a short token never unlocks details.
  const isMonitor = !!monitorToken && monitorToken.length >= 20 && bearerMatches(bearer, monitorToken);

  // A caller that PRESENTED a credential and was not recognised must be told so,
  // not quietly downgraded to the anonymous answer.
  //
  // The monitor OPERATIONS.md §5d configures is told to alert on a non-200. The
  // anonymous body is `200 {"status":"ok"}` whenever the database answers — so a
  // mistyped or rotated HEALTH_BEARER, or an unset one, made the monitor green
  // forever while every heartbeat could read `never`, `stale` or `failed`. The
  // nightly dump broken by a rotated password, the retention sweep dead, the SLA
  // sweep never firing: all invisible, with no field in the response saying "you
  // were treated as anonymous". That is precisely the silent-failure class B5 and
  // B3 exist to end, reintroduced one level above them.
  if (bearer !== null) {
    if (!monitorToken || monitorToken.length < 20) {
      logger.warn({}, 'health.monitor_token_unusable');
      return NextResponse.json({ error: 'MONITOR_NOT_CONFIGURED' }, { status: 401 });
    }
    if (!isMonitor) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    }
  }

  if (!isMonitor) {
    const ok = await dbOk();
    return NextResponse.json({ status: ok ? 'ok' : 'degraded' }, { status: ok ? 200 : 503 });
  }

  const checks: Record<string, CheckState> = {
    app: 'ok',
    db: 'pending',
    // Item 12: never left `pending` — that read as healthy with no R2 at all.
    r2: r2Configured() ? 'pending' : 'unconfigured',
    // Whether the heartbeats were READ at all. Without this, a failed heartbeat
    // query produced an empty alarm list, which is indistinguishable from "no
    // alarms" — so the probe answered 200 ok while nothing was being evaluated.
    heartbeats: 'pending',
  };

  checks.db = (await dbOk()) ? 'ok' : 'fail';

  if (checks.r2 === 'pending') {
    try {
      await r2().send(new HeadBucketCommand({ Bucket: R2_BUCKET }), {
        // REL-05: a health probe must never be the slowest thing in the system.
        abortSignal: AbortSignal.timeout(5_000),
      });
      checks.r2 = 'ok';
    } catch (err) {
      checks.r2 = 'fail';
      logger.warn({ err: (err as Error).message }, 'health.r2.fail');
    }
  }

  // Heartbeats need the database; when it is down they are reported as unknown
  // rather than masking the DB failure behind a second error.
  let heartbeats: Awaited<ReturnType<typeof loadHeartbeatReport>> | null = null;
  if (checks.db === 'ok') {
    try {
      heartbeats = await loadHeartbeatReport();
      checks.heartbeats = 'ok';
    } catch (err) {
      // Not swallowed into an empty alarm list: a dead man nobody can read is a
      // failure in its own right, and it does not self-announce the way a
      // database outage does.
      checks.heartbeats = 'fail';
      logger.warn({ err: (err as Error).message }, 'health.heartbeats.fail');
    }
  }
  // Items 11 + 12: lib/health.ts decides what pages (503) and what is only reported.
  const verdict = evaluateHealth({ checks, jobs: heartbeats, production: isProductionDeployment() });

  return NextResponse.json(
    {
      status: verdict.status,
      service: 'nmwc-cm',
      version: process.env.npm_package_version ?? 'unknown',
      // B1: production served a four-month-old build for weeks and nothing said
      // so — the only reason anyone noticed was a 404 on a route that should have
      // existed. This is the answer to "is production running the code I think it
      // is", and `npm run smoke -- --expect-commit <sha>` asserts it. Behind the
      // monitor bearer rather than on the anonymous probe, because the commit a
      // private deployment runs is nobody else's business.
      commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'unknown',
      deployedEnv: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
      checks,
      // Everything worth a look that does not page: warning-tier jobs that alarm,
      // and an unconfigured dependency off production.
      warnings: verdict.warnings,
      cron: {
        // Critical jobs only — these, and a failed check, are what answer 503.
        alarms: verdict.criticalJobs,
        jobs: heartbeats,
      },
    },
    { status: verdict.httpStatus }
  );
}
